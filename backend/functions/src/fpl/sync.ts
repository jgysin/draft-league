import { logger } from "firebase-functions";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { seasonFor } from "../core/league-logic";
import { FplCurrent } from "../core/types";
import { bankDeadlines, recomputeStandings, statsRef } from "../league/standings";
import { BootstrapStatic, EventLive, parseBootstrap, parseLive, passedDeadlines } from "./parse";

const API = "https://fantasy.premierleague.com/api";
const PLAYER_REFRESH_MS = 12 * 3600_000;

export type FetchJson = (path: string) => Promise<unknown>;

export const fetchFpl: FetchJson = async path => {
  const res = await fetch(`${API}${path}`, { headers: { "user-agent": "draft-league/1.0" } });
  if (!res.ok) throw new Error(`FPL ${path} → HTTP ${res.status}`);
  return res.json();
};

/**
 * One pass of the sync loop, run on a schedule:
 *  1. refresh the season calendar (and the player catalog twice a day),
 *  2. bank roster ownership in every league whose next deadline has passed,
 *  3. pull live stats for every started gameweek FPL hasn't finalised,
 *  4. rescore the leagues that were touched.
 */
export async function tick(db: Firestore, fetchJson: FetchJson = fetchFpl, now = new Date()) {
  const boot = parseBootstrap(await fetchJson("/bootstrap-static/") as BootstrapStatic);
  if (!boot.events.length) { logger.warn("bootstrap-static has no events; skipping"); return; }
  const season = seasonFor(new Date(boot.events[0].deadline));
  const curRef = db.collection("fpl").doc("current");
  const prev = (await curRef.get()).data() as (FplCurrent & { playersAt?: number; finalized?: number[] }) | undefined;
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

  const finalized = new Set(sameSeason ? prev?.finalized ?? [] : []);
  const passed = passedDeadlines(boot.events, now);
  const toSync = boot.events.filter(e => passed.includes(e.id) && !finalized.has(e.id));
  for (const ev of toSync) {
    const stats = parseLive(await fetchJson(`/event/${ev.id}/live/`) as EventLive, boot.elementToCode);
    await statsRef(db, season, ev.id).set({ stats, final: ev.dataChecked, updatedAt: FieldValue.serverTimestamp() });
    if (ev.dataChecked) finalized.add(ev.id);
  }

  await curRef.set({
    season, events: boot.events, elementToCode: boot.elementToCode,
    finalized: [...finalized].sort((a, b) => a - b),
    playersAt: refreshPlayers ? now.getTime() : prev?.playersAt ?? 0,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const latest = passed.length ? passed[passed.length - 1] : 0;
  const touched = new Set<string>();
  if (latest) {
    // Banking moves a league past `latest`, so re-running the query walks the backlog.
    for (;;) {
      const page = await db.collection("leagues").where("season", "==", season)
        .where("bankedGw", "<", latest).select().limit(200).get();
      if (page.empty) break;
      for (const d of page.docs) { await bankDeadlines(db, d.id, passed); touched.add(d.id); }
    }
  }
  if (toSync.length)
    for await (const id of leagueIds(db, season)) touched.add(id);
  for (const id of touched) await recomputeStandings(db, id);
  logger.info(`tick ${season}: synced gw ${toSync.map(e => e.id).join(",") || "none"}, rescored ${touched.size} leagues`);
}

async function* leagueIds(db: Firestore, season: string) {
  let q = db.collection("leagues").where("season", "==", season).orderBy("__name__").select().limit(200);
  for (;;) {
    const page = await q.get();
    for (const d of page.docs) yield d.id;
    if (page.size < 200) return;
    q = q.startAfter(page.docs[page.size - 1]);
  }
}
