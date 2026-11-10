import { createHash } from "node:crypto";
import { logger } from "firebase-functions";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { seasonFor } from "../core/league-logic";
import { FplCurrent, PlayerGwStats, Position } from "../core/types";
import { bankDeadlines, currentRef, recomputeStandings, StatsCache, statsRef } from "../league/standings";
import { BootstrapStatic, EventLive, parseBootstrap, parseLive, passedDeadlines } from "./parse";

const API = "https://fantasy.premierleague.com/api";
const PLAYER_REFRESH_MS = 12 * 3600_000;
const LEAGUES_AT_ONCE = 10;

export type FetchJson = (path: string) => Promise<unknown>;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** FPL answers 503 while "the game is updating" and sometimes just hangs: time out, and retry twice. */
export const fetchFpl: FetchJson = async path => {
  for (let attempt = 0; ; attempt++) {
    let retry = true;
    try {
      const res = await fetch(`${API}${path}`,
        { headers: { "user-agent": "draft-league/1.0" }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return await res.json();
      retry = res.status >= 500;
      throw new Error(`FPL ${path} → HTTP ${res.status}`);
    } catch (e) {
      if (!retry || attempt >= 2) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
};

/** Stable fingerprint of a gameweek's stats, so an identical pull is recognised whatever the key order. */
export function statsHash(stats: Record<string, PlayerGwStats>): string {
  const h = createHash("sha1");
  for (const code of Object.keys(stats).sort()) {
    const s = stats[code];
    h.update(`${code}:${s.apps},${s.minutes},${s.goals},${s.assists},${s.cs},${s.yc},${s.rc},${s.og};`);
  }
  return h.digest("hex");
}

/** Run `fn` over `items`, at most `limit` at a time. `fn` must not throw. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** Ids of this season's leagues (optionally only those behind on banking), skipping half-migrated ones. */
async function leagueIds(db: Firestore, season: string, bankedBelow?: number): Promise<string[]> {
  const base = db.collection("leagues").where("season", "==", season);
  let q = (bankedBelow === undefined ? base.orderBy("__name__")
    : base.where("bankedGw", "<", bankedBelow).orderBy("bankedGw").orderBy("__name__")).select("migrating").limit(200);
  const ids: string[] = [];
  for (;;) {
    const page = await q.get();
    for (const d of page.docs) if (!d.get("migrating")) ids.push(d.id);
    if (page.size < 200) return ids;
    q = q.startAfter(page.docs[page.size - 1]);
  }
}

/** Per-tick bookkeeping: leagues that need rescoring and leagues where something threw. */
interface Run { touched: Set<string>; failed: Set<string> }

/** Bank every passed deadline in the leagues that are behind. One league failing never stops the rest. */
async function bankAll(db: Firestore, season: string, passed: number[], run: Run) {
  if (!passed.length) return;
  const ids = await leagueIds(db, season, passed[passed.length - 1]);
  await pooled(ids, LEAGUES_AT_ONCE, async id => {
    try {
      if ((await bankDeadlines(db, id, passed)).length) run.touched.add(id);
    } catch (e) {
      run.failed.add(id);
      logger.error(`league ${id}: banking failed`, e);
    }
  });
}

async function rescore(db: Firestore, ids: Iterable<string>, run: Run,
                       shared: { positions?: Record<string, Position>; stats: StatsCache }) {
  await pooled([...ids], LEAGUES_AT_ONCE, async id => {
    try { await recomputeStandings(db, id, shared); } catch (e) {
      run.failed.add(id);
      logger.error(`league ${id}: rescoring failed`, e);
    }
  });
}

/**
 * One pass of the sync loop, run on a schedule:
 *  1. bank roster ownership from the deadlines already stored, before touching
 *     the network, so an FPL outage at a deadline can't delay it,
 *  2. refresh the season calendar (and the player catalog twice a day) and bank
 *     again in case a deadline moved,
 *  3. pull live stats for every started gameweek that isn't finalised yet,
 *  4. rescore the leagues that were touched; all of them when stats changed.
 * A failed FPL call skips only the stats work. A failed league is logged and
 * retried next tick; a gameweek is only marked finalised once every league has
 * been scored with its final stats.
 */
export async function tick(db: Firestore, fetchJson: FetchJson = fetchFpl, now = new Date()) {
  const curRef = currentRef(db);
  const prev = (await curRef.get()).data() as Partial<FplCurrent> | undefined;
  const run: Run = { touched: new Set(), failed: new Set() };
  const cache = new StatsCache(db);

  if (prev?.season) await bankAll(db, prev.season, passedDeadlines(prev.events, now), run);

  let boot: ReturnType<typeof parseBootstrap> | null = null;
  try {
    boot = parseBootstrap(await fetchJson("/bootstrap-static/") as BootstrapStatic);
    if (!boot.events.length) { logger.warn("bootstrap-static has no events; skipping stats"); boot = null; }
  } catch (e) {
    logger.warn(`FPL is unavailable; skipping stats this tick: ${(e as Error).message}`);
  }
  if (!boot) {
    await rescore(db, run.touched, run, { stats: cache });
    if (run.failed.size && prev) await curRef.update({ retryRescore: true });
    return;
  }

  const season = seasonFor(new Date(boot.events[0].deadline));
  const sameSeason = prev?.season === season;
  const refreshPlayers = !sameSeason || !prev?.playersAt || now.getTime() - prev.playersAt > PLAYER_REFRESH_MS;
  if (refreshPlayers) {
    for (let i = 0; i < boot.players.length; i += 400) {
      const batch = db.batch();
      for (const p of boot.players.slice(i, i + 400)) batch.set(db.collection("players").doc(p.code), p);
      await batch.commit();
    }
    // One compact doc with every player, so the app loads the whole pool in a single read.
    await db.collection("fpl").doc("catalog").set({
      season,
      players: boot.players.map(p => ({ c: p.code, n: p.name, f: p.fullName, p: p.position, t: p.club, s: p.status })),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info(`synced ${boot.players.length} players for ${season}`);
  }

  // The calendar is saved before the stats work so roster moves bank against fresh deadlines.
  const finalized = new Set(sameSeason && Array.isArray(prev?.finalized) ? prev.finalized : []);
  const sorted = () => [...finalized].sort((a, b) => a - b);
  await curRef.set({
    season, events: boot.events, elementToCode: boot.elementToCode, finalized: sorted(),
    playersAt: refreshPlayers ? now.getTime() : prev?.playersAt ?? 0,
    retryRescore: sameSeason && prev?.retryRescore === true,
    updatedAt: FieldValue.serverTimestamp(),
  });
  const passed = passedDeadlines(boot.events, now);
  await bankAll(db, season, passed, run);

  let changed = sameSeason && prev?.retryRescore === true;
  const nowFinal: number[] = [], synced: number[] = [];
  for (const ev of boot.events.filter(e => passed.includes(e.id) && !finalized.has(e.id))) {
    let stats: Record<string, PlayerGwStats>;
    try {
      stats = parseLive(await fetchJson(`/event/${ev.id}/live/`) as EventLive, boot.elementToCode);
    } catch (e) {
      logger.warn(`gameweek ${ev.id} stats unavailable; will retry next tick: ${(e as Error).message}`);
      continue;
    }
    const hash = statsHash(stats), ref = statsRef(db, season, ev.id);
    const old = await ref.get();
    if (!old.exists || old.get("hash") !== hash || old.get("final") !== ev.dataChecked) {
      await ref.set({ stats, final: ev.dataChecked, hash, updatedAt: FieldValue.serverTimestamp() });
      changed = true;
    }
    cache.prime(season, ev.id, { stats, final: ev.dataChecked });
    synced.push(ev.id);
    if (ev.dataChecked) nowFinal.push(ev.id);
  }

  const positions: Record<string, Position> = Object.fromEntries(boot.players.map(p => [p.code, p.position]));
  const targets = changed ? await leagueIds(db, season) : [];
  await rescore(db, new Set([...run.touched, ...targets]), run, { positions, stats: cache });

  // Only a clean pass may retire a gameweek; otherwise it is pulled and scored again next tick.
  if (!run.failed.size) for (const gw of nowFinal) finalized.add(gw);
  if (run.failed.size || nowFinal.length || prev?.retryRescore)
    await curRef.update({ finalized: sorted(), retryRescore: run.failed.size > 0 });
  logger.info(`tick ${season}: synced gw ${synced.join(",") || "none"}, ` +
    `rescored ${run.touched.size + targets.filter(id => !run.touched.has(id)).length} leagues, ${run.failed.size} failed`);
}
