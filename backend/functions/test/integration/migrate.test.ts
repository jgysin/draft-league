import { beforeEach, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { clearDb, db, rejects } from "./setup";
import { bootstrap, live } from "../fixtures/fpl";
import { tick } from "../../src/fpl/sync";
import { migrateLegacy } from "../../src/migrate/legacy";
import * as manage from "../../src/league/manage";
import * as draft from "../../src/league/draft";

const DEADLINES = ["2026-08-14T17:30:00Z", "2026-08-22T10:00:00Z", "2026-08-29T10:00:00Z"];
const NOW = new Date("2026-08-20T00:00:00Z");
const OWNER = "jesse@example.com";
const set = (path: string, data: object) => db.doc(path).set(data);
const fpl = async (path: string) => path === "/bootstrap-static/" ? bootstrap({ deadlines: DEADLINES, checked: [1] })
  : live([{ id: 12, min: 90, g: 1 }, { id: 21, min: 90, g: 2 }]);

/** The website's data, shaped exactly as index.html writes it. */
async function seedWebsite() {
  await set("meta/config", { leagueName: "Utter Lads", commissionerEmail: "sam@example.com",
    scoring: { goal_fwd: 5 }, h2h: true, waivers: false, adminPin: "1234" });
  await set("meta/players", {
    abc12345: { name: "Saka", full: "Bukayo Saka", position: "MID", club: "ARS", code: 1003, nickname: "Starboy" },
    def67890: { name: "Isak", position: "FWD", club: "LIV", nickname: "" },             // no code: match by name
    zzz00000: { name: "Sunday League Legend", position: "FWD", club: "", nickname: "" }, // custom, unmatched
  });
  await set("managers/m1", { name: "Jesse", email: "Jesse@Example.com", admin: false, roster: ["abc12345", "zzz00000"] });
  await set("managers/m2", { name: "Sam", email: "", admin: true, roster: ["def67890"] });
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
  await tick(db, fpl, NOW);

  await expect(migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER })).rejects.toThrow(/Sunday League Legend/);
  const dry = await migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER, dryRun: true });
  expect(dry.unmatched).toEqual([{ legacyId: "zzz00000", name: "Sunday League Legend", club: "" }]);
  expect((await db.doc("leagues/original").get()).exists).toBe(false);
  expect((await db.collection("inviteCodes").get()).empty).toBe(true);

  const r = await migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER, allowUnmatched: true });
  expect(r.teams).toEqual([
    { memberId: "m1", teamName: "Jesse", email: "jesse@example.com", role: "owner", roster: 1 },
    { memberId: "m2", teamName: "Sam", email: null, role: "member", roster: 1 },   // website admin flag ignored
  ]);
  expect(r.legacyAdmins).toEqual(["Sam"]);
  expect(r.skipped).toEqual([]);
  const league = (await db.doc("leagues/original").get()).data()!;
  expect(league).toMatchObject({ name: "Utter Lads", season: "2026-27", h2h: true, bankedGw: 1, memberUids: [], rosterLimit: 0 });
  expect(league).not.toHaveProperty("migrating");
  expect(league.scoring.goal_fwd).toBe(5);
  expect((await db.doc("leagues/original/members/m1").get()).data())
    .toEqual({ teamName: "Jesse", uid: null, role: "owner", roster: ["1003"], joinedAt: null });   // no email on the member
  expect((await db.doc("leagues/original/slots/m1").get()).data()).toEqual({ email: "jesse@example.com", autoClaim: true });
  expect((await db.doc("leagues/original/slots/m2").get()).exists).toBe(false);
  const gw1 = (await db.doc("leagues/original/gameweeks/1").get()).data()!;
  expect(gw1.owners).toEqual({ "1003": "m1", "2002": "m2" });
  expect(gw1).not.toHaveProperty("legacyStats");
  expect((await db.doc("leagues/original/draft/state").get()).data()).toEqual({
    status: "done", order: ["m1", "m2"], rounds: 1, quotas: { GK: 1, DEF: 0, MID: 0, FWD: 0 }, startedAtGw: 0,
    picks: [{ memberId: "m1", playerId: "1003" }, { memberId: "m2", playerId: "2002" }] });
  expect((await db.doc("leagues/original/meta/nicknames").get()).data()).toEqual({ "1003": "Starboy" });
  expect((await db.collection("leagues/original/trades").get()).docs[0].get("status")).toBe("void");
  expect((await db.collection("leagues/original/chat").get()).size).toBe(1);
  expect(r.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  expect((await db.doc(`inviteCodes/${r.inviteCode}`).get()).get("leagueId")).toBe("original");
  await expect(migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER })).rejects.toThrow(/already exists/);

  // The website's data is untouched
  expect((await db.doc("managers/m1").get()).get("roster")).toEqual(["abc12345", "zzz00000"]);

  // Scores come from the official FPL stats and are there as soon as the copy finishes: Saka 1+5, Isak 1+2*5
  const s = (await db.doc("leagues/original/meta/standings").get()).data()!;
  expect(s.totals).toEqual({ m1: 6, m2: 11 });
  expect(s.h2h[0].memberId).toBe("m2");

  // Jesse signs in to the app and lands in the league as owner; the website's "commissioner" gets nothing.
  const jesse = { uid: "jesse-uid", email: "jesse@example.com" }, sam = { uid: "sam-uid", email: "sam@example.com" };
  expect(await manage.claimSlots(db, sam)).toEqual({ claimed: [] });
  expect(await manage.claimSlots(db, jesse)).toEqual({ claimed: ["original"] });
  expect((await db.doc("leagues/original/slots/m1").get()).exists).toBe(false);
  await manage.updateLeague(db, jesse, { leagueId: "original", name: "Renamed" });
  expect((await manage.joinLeague(db, sam, { code: r.inviteCode, memberId: "m2" })).memberId).toBe("m2");
  await rejects(manage.updateLeague(db, sam, { leagueId: "original", name: "Mine now" }), "permission-denied");
  // Squads that have already scored can't be wiped by a draft reset.
  await rejects(draft.resetDraft(db, jesse, { leagueId: "original" }, NOW), "failed-precondition");
});

it("needs an owner email that matches exactly one website manager", async () => {
  await seedWebsite();
  await tick(db, fpl, NOW);
  const run = (ownerEmail: string) => migrateLegacy(db, { leagueId: "original", ownerEmail, allowUnmatched: true, dryRun: true });
  await expect(run("")).rejects.toThrow(/--owner-email is required/);
  await expect(run("not-an-email")).rejects.toThrow(/--owner-email is required/);
  // The website's commissionerEmail is world-writable, so it doesn't count; Sam has no email on his team.
  await expect(run("sam@example.com")).rejects.toThrow(/No website manager has the email sam@example.com.*Jesse <jesse@example.com>/);
  await set("managers/m3", { name: "Imposter", email: "JESSE@example.com", admin: true, roster: [] });
  await expect(run(OWNER)).rejects.toThrow(/2 website managers use jesse@example.com/);
  await expect(migrateLegacy(db, { leagueId: "bad/id", ownerEmail: OWNER })).rejects.toThrow(/league-id/);
  expect((await db.collection("leagues").get()).empty).toBe(true);
});

it("validates or drops everything it copies", async () => {
  await seedWebsite();
  await set("managers/m3", { name: 12345, email: "not an email", admin: "yes", roster: "abc12345" });
  await set("managers/m4", { name: "x".repeat(41), email: { $ne: "" }, roster: ["abc12345", 7, null] });   // Saka is already Jesse's
  await set("gameweeks/abc", { owners: { abc12345: "m1" } });
  await set("gameweeks/99", { owners: { abc12345: "m1" } });
  await set("gameweeks/02", { owners: { abc12345: "m1" } });
  await set("gameweeks/2", { owners: { abc12345: "m1", def67890: "stranger", zzz00000: "m2" }, stats: "junk" });
  await set("meta/schedule", { 1: ["m1|m2", "m1|stranger", "m1", "m1|m1", 7], 2: "m1|m2", 3: ["m2|m1"], 99: ["m1|m2"], x: ["m1|m2"] });
  await set("meta/draft", { status: "pwned", order: ["m1", "stranger"], rounds: 1e9, quotas: { GK: -5, DEF: "x", MID: 3 },
    picks: [{ mid: "stranger", pid: "abc12345" }, "junk", { mid: "m2", pid: "def67890" }] });
  await db.collection("txns").doc("t1").set({ ts: Timestamp.now(), text: "y".repeat(900), role: "owner", uid: "evil" });
  await db.collection("txns").doc("t2").set({ ts: "yesterday", text: { html: "<script>" } });
  await db.collection("trades").doc("tr1").set({ ts: Timestamp.now(), from: "m1", to: "m2", give: ["abc12345"], get: "def67890",
    note: "n".repeat(900), status: "hacked", extra: { nested: true } });
  await db.collection("trades").doc("tr2").set({ from: "m1", to: "stranger", give: [], get: [], status: "open" });
  await db.collection("waivers").doc("w1").set({ status: "pending", mid: "stranger", pid: "abc12345" });
  await db.collection("chat").doc("c1").set({ ts: Timestamp.now(), name: { x: 1 }, text: "z".repeat(5000), uid: "evil", memberId: "m1" });
  await tick(db, fpl, NOW);

  const r = await migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER, allowUnmatched: true });
  expect(r.teams.slice(2)).toEqual([
    { memberId: "m3", teamName: "Team m3", email: null, role: "member", roster: 0 },
    { memberId: "m4", teamName: "Team m4", email: null, role: "member", roster: 0 },
  ]);
  expect(r.legacyAdmins).toEqual(["Sam", "Team m3"]);
  expect(r.gameweeks).toEqual([1, 2]);
  for (const what of ["gameweek doc 'abc'", "gameweek doc '99'", "gameweek doc '02'", "schedule entry '2'", "schedule entry '99'",
    "schedule entry 'x'", "4 fixture(s) in schedule week 1", "trade 'tr2' (unknown team)", "waiver claim 'w1'"])
    expect(r.skipped).toContain(what);
  expect(r.skipped.some(s => /Team m4: 1003 is already on another team/.test(s))).toBe(true);

  const doc = async (path: string) => (await db.doc(`leagues/original/${path}`).get()).data();
  expect((await db.collection("leagues/original/gameweeks").get()).docs.map(d => d.id)).toEqual(["1", "2"]);
  expect((await doc("gameweeks/2"))!.owners).toEqual({ "1003": "m1" });
  expect(await doc("meta/schedule")).toEqual({ 1: ["m1|m2"], 3: ["m2|m1"] });
  expect(await doc("draft/state")).toEqual({ status: "done", order: ["m1", "m2", "m3", "m4"], rounds: 15, startedAtGw: 0,
    quotas: { GK: 0, DEF: 0, MID: 3, FWD: 0 }, picks: [{ memberId: "m2", playerId: "2002" }] });
  expect((await doc("members/m4"))).toEqual({ teamName: "Team m4", uid: null, role: "member", roster: [], joinedAt: null });
  expect((await db.collection("leagues/original/slots").get()).docs.map(d => d.id)).toEqual(["m1"]);
  const t1 = (await doc("txns/t1"))!;
  expect(Object.keys(t1).sort()).toEqual(["text", "ts"]);
  expect(t1.text).toHaveLength(500);
  expect((await doc("txns/t2"))!.text).toBe("");
  expect((await doc("txns/t2"))!.ts).toBeInstanceOf(Timestamp);
  const tr1 = (await doc("trades/tr1"))!;
  expect(Object.keys(tr1).sort()).toEqual(["from", "get", "give", "note", "status", "to", "ts"]);
  expect(tr1).toMatchObject({ from: "m1", to: "m2", give: ["1003"], get: [], status: "void" });
  expect(tr1.note).toHaveLength(280);
  expect(await doc("trades/tr2")).toBeUndefined();
  expect((await db.collection("leagues/original/waivers").get()).empty).toBe(true);
  const c1 = (await doc("chat/c1"))!;
  expect(c1).toMatchObject({ uid: null, memberId: null, name: "" });
  expect(c1.text).toHaveLength(1000);
});

it("keeps only the newest 500 chat messages", async () => {
  await seedWebsite();
  await tick(db, fpl, NOW);
  for (let i = 0; i < 520; i += 260) {
    const batch = db.batch();
    for (let j = i; j < i + 260; j++)
      batch.set(db.collection("chat").doc(`old${String(j).padStart(3, "0")}`), { ts: Timestamp.fromMillis(1_700_000_000_000 + j * 1000), name: "Sam", text: `#${j}` });
    await batch.commit();
  }
  const r = await migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER, allowUnmatched: true });
  expect(r.counts.chat).toBe(500);
  const copied = await db.collection("leagues/original/chat").get();
  expect(copied.size).toBe(500);
  const ids = new Set(copied.docs.map(d => d.id));
  expect(ids.has("old519")).toBe(true);
  expect(ids.has("old021")).toBe(true);     // 521 messages with the seeded one: only the oldest 21 are left behind
  expect(ids.has("old020")).toBe(false);
  expect(ids.has("old000")).toBe(false);
});

it("refuses to put one FPL player on the books twice", async () => {
  await seedWebsite();
  await db.doc("meta/players").update({ dup11111: { name: "Bukayo Saka", position: "MID", club: "ARS", nickname: "" } });
  await tick(db, fpl, NOW);
  await expect(migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER, allowUnmatched: true }))
    .rejects.toThrow(/same FPL player: Saka \(1003\) ← (abc12345, dup11111|dup11111, abc12345)/);
  expect((await db.doc("leagues/original").get()).exists).toBe(false);
});

it("is invisible while copying and can be re-run after dying part-way", async () => {
  await seedWebsite();
  await tick(db, fpl, NOW);
  // What a run that crashed mid-copy leaves behind: the flagged league doc and some of its subcollections.
  await set("leagues/original", { name: "Utter Lads", season: "2026-27", inviteCode: "OLDCODE2", memberUids: [], bankedGw: 0, migrating: true });
  await set("inviteCodes/OLDCODE2", { leagueId: "original" });
  await set("leagues/original/members/zombie", { teamName: "Zombie", uid: null, role: "owner", roster: ["2001"], joinedAt: null });
  await set("leagues/original/slots/zombie", { email: "jesse@example.com", autoClaim: true });
  await set("leagues/original/chat/stale", { text: "left over" });

  // Nothing treats the half-copied league as real.
  const jesse = { uid: "jesse-uid", email: "jesse@example.com" };
  await tick(db, fpl, new Date("2026-08-20T00:10:00Z"));
  expect((await db.doc("leagues/original").get()).get("bankedGw")).toBe(0);
  expect((await db.collection("leagues/original/gameweeks").get()).empty).toBe(true);
  expect(await manage.claimSlots(db, jesse)).toEqual({ claimed: [] });
  await rejects(manage.joinLeague(db, jesse, { code: "OLDCODE2", teamName: "J" }), "not-found");

  const r = await migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER, allowUnmatched: true });
  const league = (await db.doc("leagues/original").get()).data()!;
  expect(league).not.toHaveProperty("migrating");
  expect(league).toMatchObject({ bankedGw: 1, inviteCode: r.inviteCode });
  expect((await db.collection("leagues/original/members").get()).docs.map(d => d.id)).toEqual(["m1", "m2"]);
  expect((await db.collection("leagues/original/slots").get()).docs.map(d => d.id)).toEqual(["m1"]);
  expect((await db.doc("leagues/original/chat/stale").get()).exists).toBe(false);
  expect((await db.doc("inviteCodes/OLDCODE2").get()).exists).toBe(false);
  expect(await manage.claimSlots(db, jesse)).toEqual({ claimed: ["original"] });
  await expect(migrateLegacy(db, { leagueId: "original", ownerEmail: OWNER, allowUnmatched: true })).rejects.toThrow(/already exists/);
});
