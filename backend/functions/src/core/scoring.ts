import { DEFAULT_SCORING, Position, PlayerGwStats, Scoring } from "./types";

const GOAL_KEY: Record<Position, keyof Scoring> =
  { GK: "goal_gk", DEF: "goal_def", MID: "goal_mid", FWD: "goal_fwd" };
const CS_KEY: Record<Position, keyof Scoring | null> =
  { GK: "cs_gk", DEF: "cs_def", MID: "cs_mid", FWD: null };

export function statPoints(pos: Position, s: Partial<PlayerGwStats> | undefined,
                           scoring: Partial<Scoring> = DEFAULT_SCORING): number {
  if (!s) return 0;
  const sc = { ...DEFAULT_SCORING, ...scoring };
  const csKey = CS_KEY[pos];
  return (s.apps || 0) * sc.appearance
    + (s.goals || 0) * sc[GOAL_KEY[pos]]
    + (s.assists || 0) * sc.assist
    + (csKey ? (s.cs || 0) * sc[csKey] : 0)
    + (s.yc || 0) * sc.yellow
    + (s.rc || 0) * sc.red
    + (s.og || 0) * sc.own_goal;
}

export interface GwInput {
  gw: number;
  owners: Record<string, string>;                       // playerId -> memberId
  stats: Record<string, Partial<PlayerGwStats>>;        // playerId -> stats
}

export interface Standings {
  /** gw -> memberId -> points */
  gwPoints: Record<string, Record<string, number>>;
  totals: Record<string, number>;
  h2h: H2hRow[] | null;
  awards: Record<string, Awards>;
}

export interface H2hRow { memberId: string; p: number; w: number; d: number; l: number; pts: number; total: number }
export interface Awards {
  best: { memberId: string; pts: number };
  flop: { memberId: string; pts: number };
  top: { playerId: string; pts: number; owner: string | null } | null;
}

/**
 * Score a whole league from banked ownership and real-world stats. Pure, so the
 * app can run the same function for live previews.
 */
export function computeStandings(opts: {
  memberIds: string[];
  positions: Record<string, Position>;   // playerId -> position
  scoring: Partial<Scoring>;
  gameweeks: GwInput[];
  schedule?: Record<string, [string, string][]> | null;
}): Standings {
  const { memberIds, positions, scoring, gameweeks, schedule } = opts;
  const gwPoints: Standings["gwPoints"] = {};
  const totals: Record<string, number> = Object.fromEntries(memberIds.map(m => [m, 0]));
  const awards: Standings["awards"] = {};

  for (const { gw, owners, stats } of [...gameweeks].sort((a, b) => a.gw - b.gw)) {
    const pts: Record<string, number> = Object.fromEntries(memberIds.map(m => [m, 0]));
    let top: Awards["top"] = null;
    for (const [pid, s] of Object.entries(stats)) {
      const pos = positions[pid];
      if (!pos) continue;
      const p = statPoints(pos, s, scoring);
      const owner = owners[pid] ?? null;
      if (owner && owner in pts) pts[owner] += p;
      if (!top || p > top.pts) top = { playerId: pid, pts: p, owner };
    }
    gwPoints[gw] = pts;
    for (const m of memberIds) totals[m] += pts[m];
    if (memberIds.length) {
      const rows = memberIds.map(memberId => ({ memberId, pts: pts[memberId] }));
      awards[gw] = {
        best: rows.reduce((a, b) => b.pts > a.pts ? b : a),
        flop: rows.reduce((a, b) => b.pts < a.pts ? b : a),
        top,
      };
    }
  }

  let h2h: H2hRow[] | null = null;
  if (schedule) {
    const rows: Record<string, H2hRow> = Object.fromEntries(memberIds.map(m =>
      [m, { memberId: m, p: 0, w: 0, d: 0, l: 0, pts: 0, total: totals[m] }]));
    for (const gw of Object.keys(gwPoints)) {
      for (const [a, b] of schedule[gw] || []) {
        if (!rows[a] || !rows[b]) continue;
        const pa = gwPoints[gw][a], pb = gwPoints[gw][b];
        rows[a].p++; rows[b].p++;
        if (pa > pb) { rows[a].w++; rows[a].pts += 3; rows[b].l++; }
        else if (pb > pa) { rows[b].w++; rows[b].pts += 3; rows[a].l++; }
        else { rows[a].d++; rows[b].d++; rows[a].pts++; rows[b].pts++; }
      }
    }
    h2h = Object.values(rows).sort((x, y) => y.pts - x.pts || y.total - x.total);
  }

  return { gwPoints, totals, h2h, awards };
}
