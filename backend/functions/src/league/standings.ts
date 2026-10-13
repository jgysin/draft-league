import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { computeStandings, GwInput } from "../core/scoring";
import { League, LeagueGameweek, Player, PlayerGwStats, Position } from "../core/types";

export const statsRef = (db: Firestore, season: string, gw: number | string) =>
  db.collection("seasons").doc(season).collection("gameweeks").doc(String(gw));

/**
 * Rebuild leagues/{id}/meta/standings from banked ownership and synced stats.
 * Cheap at league sizes (≤20 teams, ≤38 gameweeks), so it always recomputes in
 * full; that keeps scoring changes retroactive.
 */
export async function recomputeStandings(db: Firestore, leagueId: string) {
  const ref = db.collection("leagues").doc(leagueId);
  const [leagueSnap, membersSnap, gwsSnap, schedSnap] = await Promise.all([
    ref.get(), ref.collection("members").get(), ref.collection("gameweeks").get(),
    ref.collection("meta").doc("schedule").get(),
  ]);
  if (!leagueSnap.exists) return null;
  const league = leagueSnap.data() as League;
  const memberIds = membersSnap.docs.map(d => d.id);

  const banked = gwsSnap.docs.map(d => ({ gw: Number(d.id), owners: (d.data() as LeagueGameweek).owners || {} }));
  const statSnaps = banked.length
    ? await db.getAll(...banked.map(b => statsRef(db, league.season, b.gw))) : [];
  const gameweeks: GwInput[] = banked.map((b, i) => ({
    gw: b.gw, owners: b.owners,
    stats: (statSnaps[i]?.exists ? statSnaps[i].get("stats") : {}) as Record<string, PlayerGwStats>,
  }));

  // Only owned players affect team totals, but the top-player award looks at everyone with stats.
  const pids = new Set<string>();
  for (const g of gameweeks) for (const pid of Object.keys(g.stats)) pids.add(pid);
  const playerSnaps = pids.size ? await db.getAll(...[...pids].map(p => db.collection("players").doc(p))) : [];
  const positions: Record<string, Position> = {};
  for (const s of playerSnaps) if (s.exists) positions[s.id] = (s.data() as Player).position;

  let schedule: Record<string, [string, string][]> | null = null;
  if (league.h2h && schedSnap.exists) {
    schedule = {};
    for (const [gw, pairs] of Object.entries(schedSnap.data() as Record<string, string[]>))
      schedule[gw] = pairs.map(p => p.split("|") as [string, string]);
  }

  const standings = computeStandings({ memberIds, positions, scoring: league.scoring, gameweeks, schedule });
  await ref.collection("meta").doc("standings").set({ ...standings, updatedAt: FieldValue.serverTimestamp() });
  return standings;
}

/**
 * Bank ownership for every gameweek whose deadline has passed since the league
 * last banked. Rosters at the moment this runs are what score for that week.
 */
export async function bankDeadlines(db: Firestore, leagueId: string, passed: number[]) {
  const ref = db.collection("leagues").doc(leagueId);
  return db.runTransaction(async tx => {
    const [leagueSnap, members] = await Promise.all([tx.get(ref), tx.get(ref.collection("members"))]);
    if (!leagueSnap.exists) return [];
    const bankedGw = (leagueSnap.get("bankedGw") as number) || 0;
    const todo = passed.filter(gw => gw > bankedGw);
    if (!todo.length) return [];
    const owners: Record<string, string> = {};
    for (const m of members.docs) for (const pid of (m.get("roster") as string[]) || []) owners[pid] = m.id;
    for (const gw of todo)
      tx.set(ref.collection("gameweeks").doc(String(gw)), { owners, bankedAt: FieldValue.serverTimestamp() });
    tx.update(ref, { bankedGw: Math.max(...todo) });
    return todo;
  });
}
