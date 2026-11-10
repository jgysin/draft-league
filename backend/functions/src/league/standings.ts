import { isDeepStrictEqual } from "node:util";
import { logger } from "firebase-functions";
import type { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { computeStandings, GwInput } from "../core/scoring";
import { FplCurrent, League, LeagueGameweek, PlayerGwStats, Position } from "../core/types";
import { passedDeadlines } from "../fpl/parse";
import type { LeagueCtx } from "./access";

export const statsRef = (db: Firestore, season: string, gw: number | string) =>
  db.collection("seasons").doc(season).collection("gameweeks").doc(String(gw));
export const currentRef = (db: Firestore) => db.collection("fpl").doc("current");

export interface GwStats { stats: Record<string, PlayerGwStats>; final: boolean }

/**
 * Season stats docs, each read at most once however many leagues ask for it.
 * The sync primes it with what it just pulled, so a tick never reads back a
 * doc it wrote.
 */
export class StatsCache {
  private docs = new Map<string, Promise<GwStats>>();
  constructor(private db: Firestore) {}
  prime(season: string, gw: number, value: GwStats) { this.docs.set(`${season}/${gw}`, Promise.resolve(value)); }
  get(season: string, gw: number): Promise<GwStats> {
    const key = `${season}/${gw}`;
    let p = this.docs.get(key);
    if (!p) {
      p = statsRef(this.db, season, gw).get().then(s => ({
        stats: ((s.exists && s.get("stats")) || {}) as Record<string, PlayerGwStats>,
        final: s.exists && s.get("final") === true,
      }));
      this.docs.set(key, p);
    }
    return p;
  }
}

/** Player positions from the one-doc catalog: a single read instead of one per player. */
export async function catalogPositions(db: Firestore): Promise<Record<string, Position>> {
  const snap = await db.collection("fpl").doc("catalog").get();
  const out: Record<string, Position> = {};
  const players = snap.exists ? snap.get("players") : null;
  if (Array.isArray(players)) for (const p of players) if (p && typeof p.c === "string") out[p.c] = p.p;
  return out;
}

/** H2H pairs are stored as "a|b" strings; anything else in the doc is ignored rather than trusted. */
export function parseSchedule(data: unknown): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {};
  if (!data || typeof data !== "object") return out;
  for (const [gw, pairs] of Object.entries(data)) {
    if (!Array.isArray(pairs)) continue;
    out[gw] = pairs.filter((p): p is string => typeof p === "string")
      .map(p => p.split("|")).filter(p => p.length === 2 && p[0] && p[1]) as [string, string][];
  }
  return out;
}

/**
 * Rebuild leagues/{id}/meta/standings from banked ownership and synced stats.
 * Cheap at league sizes (≤20 teams, ≤38 gameweeks), so it always recomputes in
 * full; that keeps scoring changes retroactive. The sync passes in the
 * positions and stats it already holds; triggers call it bare and it loads its
 * own. Nothing is written when the result matches what is stored, so listeners
 * only wake up for real changes.
 */
export async function recomputeStandings(db: Firestore, leagueId: string,
                                         shared: { positions?: Record<string, Position>; stats?: StatsCache } = {}) {
  const ref = db.collection("leagues").doc(leagueId);
  const out = ref.collection("meta").doc("standings");
  const [leagueSnap, membersSnap, gwsSnap, schedSnap, storedSnap] = await Promise.all([
    ref.get(), ref.collection("members").get(), ref.collection("gameweeks").get(),
    ref.collection("meta").doc("schedule").get(), out.get(),
  ]);
  if (!leagueSnap.exists) return null;
  const league = leagueSnap.data() as League;
  const memberIds = membersSnap.docs.map(d => d.id);

  const cache = shared.stats ?? new StatsCache(db);
  const banked = gwsSnap.docs.map(d => ({ gw: Number(d.id), owners: (d.data() as LeagueGameweek).owners || {} }))
    .filter(b => Number.isInteger(b.gw));
  const [positions, ...loaded] = await Promise.all([
    shared.positions ?? catalogPositions(db), ...banked.map(b => cache.get(league.season, b.gw))]);
  const gameweeks: GwInput[] = banked.map((b, i) => ({ gw: b.gw, owners: b.owners, ...loaded[i] }));

  const schedule = league.h2h && schedSnap.exists ? parseSchedule(schedSnap.data()) : null;
  const standings = computeStandings({ memberIds, positions, scoring: league.scoring, gameweeks, schedule });

  const { updatedAt: _, ...stored } = storedSnap.data() ?? {};
  // Round-trip through JSON so both sides are plain data with the same key types.
  if (!storedSnap.exists || !isDeepStrictEqual(JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(standings))))
    await out.set({ ...standings, updatedAt: FieldValue.serverTimestamp() });
  return standings;
}

/** Snapshot `rosters` as the owners for each gameweek in `todo` and move the league's marker on. */
function writeBank(tx: Transaction, ref: DocumentReference, rosters: Iterable<[string, unknown]>, todo: number[]) {
  const owners: Record<string, string> = {};
  for (const [memberId, roster] of rosters) for (const pid of roster as string[]) owners[pid] = memberId;
  // Each missed deadline still gets a snapshot, but they all get today's squads: say so.
  if (todo.length > 1)
    logger.warn(`league ${ref.id}: banking gameweeks ${todo.join(", ")} together; earlier deadlines were missed`);
  for (const gw of todo)
    tx.set(ref.collection("gameweeks").doc(String(gw)), { owners, bankedAt: FieldValue.serverTimestamp() });
  tx.update(ref, { bankedGw: Math.max(...todo) });
}

/**
 * Bank ownership for every gameweek whose deadline has passed since the league
 * last banked. Rosters at the moment this runs are what score for that week;
 * `bankIfDue` makes sure no roster move gets in first.
 */
export async function bankDeadlines(db: Firestore, leagueId: string, passed: number[]) {
  const ref = db.collection("leagues").doc(leagueId);
  return db.runTransaction(async tx => {
    const [leagueSnap, members] = await Promise.all([tx.get(ref), tx.get(ref.collection("members"))]);
    if (!leagueSnap.exists || leagueSnap.get("migrating")) return [];
    const bankedGw = (leagueSnap.get("bankedGw") as number) || 0;
    const todo = passed.filter(gw => gw > bankedGw);
    if (!todo.length) return [];
    writeBank(tx, ref, members.docs.map(m => [m.id, m.get("roster") || []]), todo);
    return todo;
  });
}

/**
 * Called inside every roster-changing transaction, after its other reads and
 * before its first write. If a deadline has passed that the scheduled sync has
 * not banked yet, the squads as they stand before this move are banked here,
 * in the same transaction. That makes banking exact however late the sync runs.
 */
export async function bankIfDue(tx: Transaction, db: Firestore, ctx: LeagueCtx, now: Date): Promise<number[]> {
  const todo = await dueGameweeks(tx, db, ctx, now);
  applyBank(tx, ctx, todo);
  return todo;
}

/** The read half of `bankIfDue`, for transactions that have further reads to do before writing. */
export async function dueGameweeks(tx: Transaction, db: Firestore, ctx: LeagueCtx, now: Date): Promise<number[]> {
  const cur = (await tx.get(currentRef(db))).data() as Partial<FplCurrent> | undefined;
  if (!cur || cur.season !== ctx.league.season) return [];
  const bankedGw = ctx.league.bankedGw || 0;
  return passedDeadlines(cur.events, now).filter(gw => gw > bankedGw);
}

/** The write half. `ctx.league.bankedGw` moves on too, so later checks see the banked state. */
export function applyBank(tx: Transaction, ctx: LeagueCtx, todo: number[]) {
  if (!todo.length) return;
  writeBank(tx, ctx.ref, [...ctx.members].map(([id, m]) => [id, m.roster]), todo);
  ctx.league = { ...ctx.league, bankedGw: Math.max(...todo) };
}
