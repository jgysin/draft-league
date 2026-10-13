/**
 * One-off copy of the website's single league (root collections meta/,
 * managers/, gameweeks/, chat/, txns/, trades/, waivers/) into the
 * multi-league layout under leagues/{leagueId}. The legacy data is only read,
 * so the website keeps working until everyone has moved over.
 *
 * Players are re-keyed from the website's random ids to FPL codes, so the
 * player catalog must be synced first (the fplTick function does this).
 */
import type { Firestore, WriteBatch } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { newInviteCode } from "../core/league-logic";
import { DEFAULT_SCORING, Player, Role } from "../core/types";

export interface MigrateOptions { leagueId: string; dryRun?: boolean; allowUnmatched?: boolean }

export interface MigrateReport {
  leagueId: string;
  inviteCode: string;
  teams: { memberId: string; teamName: string; email: string | null; role: Role; roster: number }[];
  gameweeks: number[];
  unmatched: { legacyId: string; name: string; club: string }[];
  counts: Record<string, number>;
}

type LegacyPlayer = { name: string; full?: string; position: string; club?: string; code?: number | string | null; nickname?: string };

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export async function migrateLegacy(db: Firestore, opts: MigrateOptions): Promise<MigrateReport> {
  const target = db.collection("leagues").doc(opts.leagueId);
  if ((await target.get()).exists) throw new Error(`leagues/${opts.leagueId} already exists; pick another --league-id`);

  const [config, registry, draft, schedule, managers, gameweeks, chat, txns, trades, waivers, current, catalog] =
    await Promise.all([
      db.doc("meta/config").get(), db.doc("meta/players").get(), db.doc("meta/draft").get(),
      db.doc("meta/schedule").get(), db.collection("managers").get(), db.collection("gameweeks").get(),
      db.collection("chat").get(), db.collection("txns").get(), db.collection("trades").get(),
      db.collection("waivers").get(), db.doc("fpl/current").get(), db.collection("players").get(),
    ]);
  if (!config.exists) throw new Error("No legacy league found (meta/config is missing).");
  if (!current.exists || catalog.empty) throw new Error("Sync the FPL player catalog first (run fplTick once).");
  const cfg = config.data()!;

  // Map legacy player ids to FPL codes: by stored code, else by name + club.
  const byCode = new Map(catalog.docs.map(d => [d.id, d.data() as Player]));
  const byNameClub = new Map<string, string>();
  for (const [code, p] of byCode) {
    byNameClub.set(`${norm(p.name)}|${p.club.toLowerCase()}`, code);
    byNameClub.set(`${norm(p.fullName)}|${p.club.toLowerCase()}`, code);
  }
  const legacyPlayers = (registry.data() || {}) as Record<string, LegacyPlayer>;
  const idMap = new Map<string, string>();
  const unmatched: MigrateReport["unmatched"] = [];
  for (const [pid, p] of Object.entries(legacyPlayers)) {
    const code = p.code != null && byCode.has(String(p.code)) ? String(p.code)
      : byNameClub.get(`${norm(p.name)}|${(p.club || "").toLowerCase()}`)
        ?? (p.full ? byNameClub.get(`${norm(p.full)}|${(p.club || "").toLowerCase()}`) : undefined);
    if (code) idMap.set(pid, code); else unmatched.push({ legacyId: pid, name: p.name, club: p.club || "" });
  }
  if (unmatched.length && !opts.allowUnmatched && !opts.dryRun)
    throw new Error(`${unmatched.length} players couldn't be matched to FPL: ` +
      unmatched.map(u => `${u.name} (${u.club})`).join(", ") + ". Re-run with --allow-unmatched to drop them.");
  const mapIds = (ids: string[] = []) => ids.map(id => idMap.get(id)).filter((x): x is string => !!x);

  const commissioner = (cfg.commissionerEmail || "").toLowerCase();
  let ownerAssigned = false;
  const teams: MigrateReport["teams"] = managers.docs.map(d => {
    const m = d.data();
    const email = m.email ? String(m.email).toLowerCase() : null;
    let role: Role = m.admin ? "admin" : "member";
    if (email && email === commissioner && !ownerAssigned) { role = "owner"; ownerAssigned = true; }
    return { memberId: d.id, teamName: m.name, email, role, roster: mapIds(m.roster).length };
  });
  if (!ownerAssigned) {
    const first = teams.find(t => t.role === "admin") ?? teams[0];
    if (first) first.role = "owner";
  }

  const gwIds = gameweeks.docs.map(d => Number(d.id)).filter(Number.isFinite).sort((a, b) => a - b);
  const inviteCode = newInviteCode();
  const report: MigrateReport = {
    leagueId: opts.leagueId, inviteCode, teams, gameweeks: gwIds, unmatched,
    counts: { chat: chat.size, txns: txns.size, trades: trades.size, waivers: waivers.size },
  };
  if (opts.dryRun) return report;

  // Writes go in batches of up to 400; order doesn't matter until the league doc exists,
  // and that is written last so the app never sees a half-copied league.
  const writer = new BatchWriter(db);
  const sub = (name: string) => target.collection(name);
  for (const d of managers.docs) {
    const t = teams.find(x => x.memberId === d.id)!;
    writer.set(sub("members").doc(d.id), {
      teamName: t.teamName, uid: null, email: t.email, role: t.role, roster: mapIds(d.get("roster")), joinedAt: null,
    });
  }
  for (const d of gameweeks.docs) {
    const owners: Record<string, string> = {};
    for (const [pid, mid] of Object.entries((d.get("owners") || {}) as Record<string, string>)) {
      const code = idMap.get(pid);
      if (code) owners[code] = mid;
    }
    writer.set(sub("gameweeks").doc(d.id), { owners, bankedAt: FieldValue.serverTimestamp(), legacyStats: d.get("stats") || {} });
  }
  if (draft.exists) {
    const dr = draft.data()!;
    writer.set(sub("draft").doc("state"), {
      status: dr.status, order: dr.order || [], rounds: dr.rounds || 15,
      quotas: { GK: 0, DEF: 0, MID: 0, FWD: 0, ...(dr.quotas || {}) },
      picks: (dr.picks || []).filter((p: any) => idMap.has(p.pid))
        .map((p: any) => ({ memberId: p.mid, playerId: idMap.get(p.pid) })),
    });
  }
  if (schedule.exists) writer.set(sub("meta").doc("schedule"), schedule.data()!);
  const nicknames = Object.fromEntries(Object.entries(legacyPlayers)
    .filter(([pid, p]) => p.nickname && idMap.has(pid)).map(([pid, p]) => [idMap.get(pid)!, p.nickname!]));
  if (Object.keys(nicknames).length) writer.set(sub("meta").doc("nicknames"), nicknames);
  for (const d of chat.docs)
    writer.set(sub("chat").doc(d.id), { uid: null, memberId: null, name: d.get("name") || "", text: d.get("text") || "", ts: d.get("ts") ?? Timestamp.now() });
  for (const d of txns.docs) writer.set(sub("txns").doc(d.id), d.data());
  for (const d of trades.docs) {
    const t = d.data();
    const give = [].concat(t.give || []) as string[], get = [].concat(t.get || []) as string[];
    const ok = mapIds(give).length === give.length && mapIds(get).length === get.length;
    writer.set(sub("trades").doc(d.id), { ...t, give: mapIds(give), get: mapIds(get),
      status: t.status === "open" && !ok ? "void" : t.status });
  }
  for (const d of waivers.docs) {
    const w = d.data();
    if (w.status !== "pending" || !idMap.has(w.pid)) continue;
    writer.set(sub("waivers").doc(d.id), { memberId: w.mid, playerId: idMap.get(w.pid),
      drop: w.drop ? idMap.get(w.drop) ?? null : null, ts: w.ts ?? Timestamp.now() });
  }
  writer.set(db.collection("inviteCodes").doc(inviteCode), { leagueId: opts.leagueId });
  await writer.flush();

  await target.set({
    name: cfg.leagueName || "Draft League", season: current.get("season"), inviteCode,
    memberUids: [], scoring: { ...DEFAULT_SCORING, ...(cfg.scoring || {}) }, h2h: !!cfg.h2h, waivers: !!cfg.waivers,
    bankedGw: gwIds.length ? gwIds[gwIds.length - 1] : 0, createdAt: FieldValue.serverTimestamp(), migratedFrom: "website",
  });
  return report;
}

class BatchWriter {
  private batch: WriteBatch;
  private n = 0;
  private pending: Promise<unknown>[] = [];
  constructor(private db: Firestore) { this.batch = db.batch(); }
  set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData) {
    this.batch.set(ref, data);
    if (++this.n >= 400) { const b = this.batch; this.batch = this.db.batch(); this.n = 0; this.pending.push(b.commit()); }
  }
  async flush() { this.pending.push(this.batch.commit()); await Promise.all(this.pending); }
}
