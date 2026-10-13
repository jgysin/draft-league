import { beforeEach, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { clearDb, db } from "./setup";
import { bootstrap, live } from "../fixtures/fpl";
import { tick } from "../../src/fpl/sync";
import { migrateLegacy } from "../../src/migrate/legacy";
import * as manage from "../../src/league/manage";
import { recomputeStandings } from "../../src/league/standings";

const DEADLINES = ["2026-08-14T17:30:00Z", "2026-08-22T10:00:00Z", "2026-08-29T10:00:00Z"];

/** The website's data, shaped exactly as index.html writes it. */
async function seedWebsite() {
  const set = (path: string, data: object) => db.doc(path).set(data);
  await set("meta/config", { leagueName: "Utter Lads", commissionerEmail: "Jesse@Example.com",
    scoring: { goal_fwd: 5 }, h2h: true, waivers: false, adminPin: "1234" });
  await set("meta/players", {
    abc12345: { name: "Saka", full: "Bukayo Saka", position: "MID", club: "ARS", code: 1003, nickname: "Starboy" },
    def67890: { name: "Isak", position: "FWD", club: "LIV", nickname: "" },             // no code: match by name
    zzz00000: { name: "Sunday League Legend", position: "FWD", club: "", nickname: "" }, // custom, unmatched
  });
  await set("managers/m1", { name: "Jesse", email: "jesse@example.com", admin: false, roster: ["abc12345", "zzz00000"] });
  await set("managers/m2", { name: "Sam", email: "", admin: false, roster: ["def67890"] });
  await set("gameweeks/1", { stats: { abc12345: { played: true, goals: 1 } }, owners: { abc12345: "m1", def67890: "m2" } });
  await set("meta/schedule", { 1: ["m1|m2"], 2: ["m2|m1"] });
  await set("meta/draft", { status: "done", order: ["m1", "m2"], rounds: 1, quotas: { GK: 1 },
    picks: [{ mid: "m1", pid: "abc12345" }, { mid: "m2", pid: "def67890" }] });
  await db.collection("chat").add({ ts: Timestamp.now(), name: "Sam", text: "gg" });
  await db.collection("txns").add({ ts: Timestamp.now(), text: "Jesse signed Saka" });
  await db.collection("trades").add({ ts: Timestamp.now(), from: "m1", to: "m2", give: ["zzz00000"], get: ["def67890"], note: "", status: "open" });
}

beforeEach(clearDb);

it("copies the website league and lets friends claim their teams by email", async () => {
  await seedWebsite();
  const fpl = async (path: string) => path === "/bootstrap-static/" ? bootstrap({ deadlines: DEADLINES, checked: [1] })
    : live([{ id: 12, min: 90, g: 1 }, { id: 21, min: 90, g: 2 }]);
  await tick(db, fpl, new Date("2026-08-20T00:00:00Z"));

  await expect(migrateLegacy(db, { leagueId: "original" })).rejects.toThrow(/Sunday League Legend/);
  const dry = await migrateLegacy(db, { leagueId: "original", dryRun: true });
  expect(dry.unmatched).toEqual([{ legacyId: "zzz00000", name: "Sunday League Legend", club: "" }]);
  expect((await db.doc("leagues/original").get()).exists).toBe(false);

  const r = await migrateLegacy(db, { leagueId: "original", allowUnmatched: true });
  expect(r.teams).toEqual([
    { memberId: "m1", teamName: "Jesse", email: "jesse@example.com", role: "owner", roster: 1 },
    { memberId: "m2", teamName: "Sam", email: null, role: "member", roster: 1 },
  ]);
  const league = (await db.doc("leagues/original").get()).data()!;
  expect(league).toMatchObject({ name: "Utter Lads", season: "2026-27", h2h: true, bankedGw: 1, memberUids: [] });
  expect(league.scoring.goal_fwd).toBe(5);
  expect((await db.doc("leagues/original/members/m1").get()).get("roster")).toEqual(["1003"]);
  expect((await db.doc("leagues/original/gameweeks/1").get()).get("owners")).toEqual({ "1003": "m1", "2002": "m2" });
  expect((await db.doc("leagues/original/draft/state").get()).get("picks")).toEqual(
    [{ memberId: "m1", playerId: "1003" }, { memberId: "m2", playerId: "2002" }]);
  expect((await db.doc("leagues/original/meta/nicknames").get()).data()).toEqual({ "1003": "Starboy" });
  expect((await db.collection("leagues/original/trades").get()).docs[0].get("status")).toBe("void");
  expect((await db.collection("leagues/original/chat").get()).size).toBe(1);
  expect((await db.doc(`inviteCodes/${r.inviteCode}`).get()).get("leagueId")).toBe("original");
  await expect(migrateLegacy(db, { leagueId: "original" })).rejects.toThrow(/already exists/);

  // The website's data is untouched
  expect((await db.doc("managers/m1").get()).get("roster")).toEqual(["abc12345", "zzz00000"]);

  // Jesse signs in to the app and lands in the league as owner
  expect(await manage.claimSlots(db, { uid: "jesse-uid", email: "jesse@example.com" })).toEqual({ claimed: ["original"] });
  await manage.updateLeague(db, { uid: "jesse-uid", email: "jesse@example.com" }, { leagueId: "original", name: "Renamed" });

  // Scores now come from the official FPL stats: Saka 1+5, Isak 1+2*5
  const s = await recomputeStandings(db, "original");
  expect(s!.totals).toEqual({ m1: 6, m2: 11 });
  expect(s!.h2h![0].memberId).toBe("m2");
});
