import { beforeEach, describe, expect, it } from "vitest";
import { clearDb, db, rejects, user } from "./setup";
import { bootstrap, live } from "../fixtures/fpl";
import * as manage from "../../src/league/manage";
import * as draft from "../../src/league/draft";
import * as roster from "../../src/league/roster";
import * as trades from "../../src/league/trades";
import * as waivers from "../../src/league/waivers";
import { recomputeStandings } from "../../src/league/standings";
import { tick } from "../../src/fpl/sync";

const DEADLINES = ["2026-08-14T17:30:00Z", "2026-08-22T10:00:00Z", "2026-08-29T10:00:00Z"];
/** Before GW1's deadline. Every roster-changing call takes the clock, or it would bank against today's date. */
const T0 = new Date("2026-08-01T00:00:00Z");
const AFTER_GW1 = new Date("2026-08-14T18:00:00Z");
const AFTER_GW2 = new Date("2026-08-22T11:00:00Z");

const fakeFpl = (liveByGw: Record<number, ReturnType<typeof live>>, checked: number[] = []) =>
  async (path: string) => {
    if (path === "/bootstrap-static/") return bootstrap({ deadlines: DEADLINES, checked });
    const gw = Number(path.match(/event\/(\d+)/)?.[1]);
    return liveByGw[gw] ?? live([]);
  };
const fplDown = async (path: string): Promise<never> => { throw new Error(`FPL ${path} → HTTP 503`); };

const [A, B, C, D] = [user(1), user(2), user(3), user(4)];
const members = async (leagueId: string) =>
  Object.fromEntries((await db.collection(`leagues/${leagueId}/members`).get()).docs.map(d => [d.get("uid") ?? d.id, { id: d.id, ...d.data() }])) as Record<string, any>;
const leagueDoc = async (leagueId: string) => (await db.doc(`leagues/${leagueId}`).get()).data()!;
const standings = async (leagueId: string) => (await db.doc(`leagues/${leagueId}/meta/standings`).get()).data()!;
const slot = (leagueId: string, memberId: string) => db.doc(`leagues/${leagueId}/slots/${memberId}`).get();

/** League with A (owner) and B joined, players synced, before GW1's deadline. */
async function twoTeamLeague() {
  await tick(db, fakeFpl({}), T0);
  const { leagueId, inviteCode } = await manage.createLeague(db, A, { name: "Lads", teamName: "A FC" }, T0);
  await manage.joinLeague(db, B, { code: inviteCode.toLowerCase(), teamName: "B United" });
  const m = await members(leagueId);
  return { leagueId, inviteCode, a: m.u1.id as string, b: m.u2.id as string };
}

/** The same league after a two-round draft: A has Salah and Isak, B has Saka and Saliba. */
async function drafted() {
  const ctx = await twoTeamLeague();
  await draft.setupDraft(db, A, { leagueId: ctx.leagueId, order: [ctx.a, ctx.b], rounds: 2, quotas: { GK: 0, DEF: 0, MID: 0, FWD: 0 } });
  await draft.startDraft(db, A, { leagueId: ctx.leagueId }, T0);
  for (const [who, pid] of [[A, "2001"], [B, "1003"], [B, "1002"], [A, "2002"]] as const)
    await draft.makePick(db, who, { leagueId: ctx.leagueId, playerId: pid }, T0);
  return ctx;
}

beforeEach(clearDb);

describe("creating a league", () => {
  it("waits for the player data, then takes the season and starting gameweek from it", async () => {
    await rejects(manage.createLeague(db, A, { name: "Early", teamName: "A" }, T0), "unavailable");
    expect((await db.collection("leagues").get()).empty).toBe(true);
    expect((await db.collection("inviteCodes").get()).empty).toBe(true);

    // A season label the wall clock would never produce proves it is copied, not derived.
    await db.doc("fpl/current").set({ season: "2031-32", events: DEADLINES.map((deadline, i) => ({ id: i + 1, deadline })) });
    const { leagueId, inviteCode } = await manage.createLeague(db, A, { name: "Lads", teamName: "A FC" }, new Date("2026-08-23T00:00:00Z"));
    expect(await leagueDoc(leagueId)).toMatchObject({ season: "2031-32", bankedGw: 2, rosterLimit: 0, memberUids: ["u1"], inviteCode });
    expect(inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const owner = (await members(leagueId)).u1;
    expect(owner).toMatchObject({ teamName: "A FC", role: "owner", roster: [] });
    expect(owner).not.toHaveProperty("email");
  });

  it("caps how many leagues one person can be in", async () => {
    await tick(db, fakeFpl({}), T0);
    for (let i = 0; i < manage.MAX_LEAGUES_PER_USER; i++)
      await manage.createLeague(db, A, { name: `League ${i}`, teamName: "A" }, T0);
    await rejects(manage.createLeague(db, A, { name: "One too many", teamName: "A" }, T0), "resource-exhausted");
    await manage.createLeague(db, B, { name: "Someone else's", teamName: "B" }, T0);
  });
});

describe("joining", () => {
  it("joins by code, and a team reserved by email is claimed with the code, not on sign-in", async () => {
    const { leagueId, inviteCode } = await twoTeamLeague();
    const { memberId } = await manage.addSlot(db, A, { leagueId, teamName: "C City", email: "Friend3@Example.com" });
    await rejects(manage.addSlot(db, B, { leagueId, teamName: "nope" }), "permission-denied");
    await rejects(manage.addSlot(db, A, { leagueId, teamName: "Bad", email: "not-an-email" }), "invalid-argument");
    expect((await slot(leagueId, memberId)).data()).toEqual({ email: "friend3@example.com", autoClaim: false });
    expect((await db.doc(`leagues/${leagueId}/members/${memberId}`).get()).data()).not.toHaveProperty("email");

    // Typing someone's email into a league must not pull them into it.
    expect(await manage.claimSlots(db, C)).toEqual({ claimed: [] });
    expect((await leagueDoc(leagueId)).memberUids.sort()).toEqual(["u1", "u2"]);

    expect(await manage.joinLeague(db, C, { code: inviteCode })).toEqual({ leagueId, memberId });
    expect((await leagueDoc(leagueId)).memberUids.sort()).toEqual(["u1", "u2", "u3"]);
    expect((await members(leagueId)).u3.teamName).toBe("C City");
    expect((await slot(leagueId, memberId)).exists).toBe(false);

    // joining again is a no-op; bad codes are a clean error
    await manage.joinLeague(db, B, { code: inviteCode });
    expect(Object.keys(await members(leagueId))).toHaveLength(3);
    await rejects(manage.joinLeague(db, D, { code: "ZZZZZZZZ", teamName: "D" }), "not-found");
    await rejects(manage.joinLeague(db, D, { code: "../x", teamName: "D" }), "not-found");
    await rejects(manage.joinLeague(db, D, { code: "ABC", teamName: "D" }), "not-found");
    await rejects(manage.joinLeague(db, D, { code: null, teamName: "D" }), "invalid-argument");
  });

  it("still accepts the 6-character codes issued before codes got longer", async () => {
    const { leagueId } = await twoTeamLeague();
    await db.doc("inviteCodes/ABC234").set({ leagueId });
    await db.doc(`leagues/${leagueId}`).update({ inviteCode: "ABC234" });
    expect((await manage.joinLeague(db, C, { code: "abc234", teamName: "C" })).leagueId).toBe(leagueId);
  });

  it("lets someone pick a named empty team, but not one reserved for an email", async () => {
    const { leagueId, inviteCode, a } = await twoTeamLeague();
    const open = (await manage.addSlot(db, A, { leagueId, teamName: "Open Team", email: null })).memberId;
    const kept = (await manage.addSlot(db, A, { leagueId, teamName: "Kept Team", email: "friend4@example.com" })).memberId;
    expect((await slot(leagueId, open)).exists).toBe(false);
    const relay = { uid: "apple-user", email: null };   // e.g. Apple private relay: no email to match on

    await rejects(manage.joinLeague(db, relay, { code: inviteCode, memberId: kept }), "permission-denied");
    await rejects(manage.joinLeague(db, relay, { code: inviteCode, memberId: a }), "already-exists");
    await rejects(manage.joinLeague(db, relay, { code: inviteCode, memberId: "nobody" }), "not-found");
    await rejects(manage.joinLeague(db, relay, { code: inviteCode, memberId: "a/b" }), "invalid-argument");
    expect(await manage.joinLeague(db, relay, { code: inviteCode, memberId: open })).toEqual({ leagueId, memberId: open });
    expect((await members(leagueId))["apple-user"]).toMatchObject({ teamName: "Open Team", role: "member" });
    await rejects(manage.joinLeague(db, C, { code: inviteCode, memberId: open }), "already-exists");

    // The person a team is reserved for gets it whichever team they tapped.
    expect((await manage.joinLeague(db, D, { code: inviteCode, memberId: null })).memberId).toBe(kept);
    // Clearing a reservation opens the team up; null leaves it alone.
    const later = (await manage.addSlot(db, A, { leagueId, teamName: "Later", email: "someone@example.com" })).memberId;
    await manage.updateMember(db, A, { leagueId, memberId: later, email: null, teamName: "Later FC" });
    expect((await slot(leagueId, later)).get("email")).toBe("someone@example.com");
    await manage.updateMember(db, A, { leagueId, memberId: later, email: "Other@Example.com" });
    expect((await slot(leagueId, later)).data()).toEqual({ email: "other@example.com", autoClaim: false });
    await manage.updateMember(db, A, { leagueId, memberId: later, email: "" });
    expect((await slot(leagueId, later)).exists).toBe(false);
    expect((await manage.joinLeague(db, C, { code: inviteCode, memberId: later })).memberId).toBe(later);
  });

  it("auto-claims only migrated slots on sign-in, and one broken slot doesn't spoil the rest", async () => {
    const one = await twoTeamLeague();
    const byHand = (await manage.addSlot(db, A, { leagueId: one.leagueId, teamName: "By hand", email: C.email })).memberId;
    const two = await manage.createLeague(db, B, { name: "Migrated", teamName: "B" }, T0);
    const migrated = (await manage.addSlot(db, B, { leagueId: two.leagueId, teamName: "C's old team", email: C.email })).memberId;
    await db.doc(`leagues/${two.leagueId}/slots/${migrated}`).update({ autoClaim: true });   // as the migration writes it

    // Orphans: no league, a league without that team, a league still being copied, and a team already taken.
    const auto = { email: C.email, autoClaim: true };
    await db.doc("leagues/ghost/slots/m1").set(auto);
    await db.doc(`leagues/${one.leagueId}/slots/vanished`).set(auto);
    await db.doc("leagues/half/slots/m1").set(auto);
    await db.doc("leagues/half").set({ name: "Half", migrating: true, memberUids: [], season: "2026-27", bankedGw: 0 });
    await db.doc("leagues/half/members/m1").set({ teamName: "Half", uid: null, role: "member", roster: [], joinedAt: null });
    await db.doc(`leagues/${one.leagueId}/slots/${one.b}`).set(auto);
    await db.doc("stray/x/slots/y").set(auto);

    expect(await manage.claimSlots(db, C)).toEqual({ claimed: [two.leagueId] });
    expect((await members(two.leagueId)).u3).toMatchObject({ teamName: "C's old team" });
    expect((await leagueDoc(two.leagueId)).memberUids.sort()).toEqual(["u2", "u3"]);
    expect((await slot(two.leagueId, migrated)).exists).toBe(false);
    expect((await members(one.leagueId)).u2.uid).toBe("u2");                       // B's team wasn't hijacked
    expect((await db.doc("leagues/half/members/m1").get()).get("uid")).toBeNull();
    expect((await slot(one.leagueId, byHand)).exists).toBe(true);

    expect(await manage.claimSlots(db, C)).toEqual({ claimed: [] });               // nothing left to do
    expect(await manage.claimSlots(db, { uid: "x", email: null })).toEqual({ claimed: [] });
  });

  it("retires the old code when the invite rotates", async () => {
    const { leagueId, inviteCode } = await twoTeamLeague();
    const { inviteCode: next } = await manage.rotateInvite(db, A, { leagueId });
    await rejects(manage.joinLeague(db, C, { code: inviteCode, teamName: "C" }), "not-found");
    await manage.joinLeague(db, C, { code: next, teamName: "C" });
  });

  it("removing a team rotates the invite and tidies up; not during a live draft", async () => {
    const { leagueId, inviteCode, a, b } = await twoTeamLeague();
    await manage.joinLeague(db, C, { code: inviteCode, teamName: "C" });
    const c = (await members(leagueId)).u3.id;
    const spare = (await manage.addSlot(db, A, { leagueId, teamName: "Spare", email: "spare@example.com" })).memberId;
    await draft.setupDraft(db, A, { leagueId, order: [a, b, c, spare], rounds: 1 });

    await rejects(manage.removeMember(db, B, { leagueId, memberId: c }, T0), "permission-denied");
    await rejects(manage.removeMember(db, A, { leagueId, memberId: a }, T0), "failed-precondition");   // the owner
    const res = await manage.removeMember(db, A, { leagueId, memberId: c }, T0);
    expect(res.inviteCode).not.toBe(inviteCode);
    const league = await leagueDoc(leagueId);
    expect(league.inviteCode).toBe(res.inviteCode);
    expect(league.memberUids.sort()).toEqual(["u1", "u2"]);
    expect((await db.doc(`inviteCodes/${inviteCode}`).get()).exists).toBe(false);
    await rejects(manage.joinLeague(db, C, { code: inviteCode, teamName: "C again" }), "not-found");
    expect((await db.doc(`leagues/${leagueId}/draft/state`).get()).get("order")).toEqual([a, b, spare]);

    await manage.removeMember(db, A, { leagueId, memberId: spare }, T0);
    expect((await slot(leagueId, spare)).exists).toBe(false);

    await draft.startDraft(db, A, { leagueId }, T0);
    await rejects(manage.removeMember(db, A, { leagueId, memberId: b }, T0), "failed-precondition");
    await rejects(manage.addSlot(db, A, { leagueId, teamName: "Late" }), "failed-precondition");
    expect(Object.keys(await members(leagueId))).toHaveLength(2);
  });
});

describe("arguments", () => {
  it("rejects ids and player codes that aren't well-formed", async () => {
    const { leagueId, b } = await twoTeamLeague();
    for (const bad of ["a/b", "", "x".repeat(65), 7, null])
      await rejects(roster.addDrop(db, A, { leagueId: bad, add: "1001" }, T0), "invalid-argument");
    for (const bad of ["abc", "10 01", "1001/x", 1001, ""])
      await rejects(roster.addDrop(db, A, { leagueId, add: bad }, T0), "invalid-argument");
    await rejects(roster.addDrop(db, A, { leagueId, memberId: "../x", add: "1001" }, T0), "invalid-argument");
    await rejects(roster.cancelClaim(db, A, { leagueId, claimId: "a/b" }), "invalid-argument");
    await rejects(trades.respondTrade(db, A, { leagueId, tradeId: "a/b/c", action: "accept" }, T0), "invalid-argument");
    await rejects(manage.updateMember(db, A, { leagueId, memberId: "..", teamName: "X" }), "invalid-argument");
    await rejects(draft.setupDraft(db, A, { leagueId, order: [b, "a/b"] }), "invalid-argument");
  });

  it("treats null like a missing argument and insists on real booleans", async () => {
    const { leagueId } = await twoTeamLeague();
    const before = await leagueDoc(leagueId);
    await manage.updateLeague(db, A, { leagueId, name: null, scoring: null, h2h: null, waivers: null, rosterLimit: null });
    expect(await leagueDoc(leagueId)).toEqual(before);
    for (const bad of ["true", 1, 0, "no"]) {
      await rejects(manage.updateLeague(db, A, { leagueId, waivers: bad }), "invalid-argument");
      await rejects(manage.updateLeague(db, A, { leagueId, h2h: bad }), "invalid-argument");
    }
    for (const bad of [41, -1, 2.5, "3"]) await rejects(manage.updateLeague(db, A, { leagueId, rosterLimit: bad }), "invalid-argument");
    await manage.updateLeague(db, A, { leagueId, waivers: false, rosterLimit: 40, scoring: { goal_fwd: 7, assist: null } });
    expect(await leagueDoc(leagueId)).toMatchObject({ waivers: false, rosterLimit: 40, scoring: { goal_fwd: 7, assist: 3 } });

    await roster.addDrop(db, A, { leagueId, memberId: null, add: "1001", drop: null }, T0);
    expect((await members(leagueId)).u1.roster).toEqual(["1001"]);
    await roster.addDrop(db, A, { leagueId, drop: "1001", add: null }, T0);
    await draft.setupDraft(db, A, { leagueId, order: null, rounds: null, quotas: null });
    expect((await db.doc(`leagues/${leagueId}/draft/state`).get()).data()).toMatchObject({ rounds: 15, quotas: { GK: 2, DEF: 5, MID: 5, FWD: 3 } });
    await rejects(draft.setupDraft(db, A, { leagueId, rounds: "3" }), "invalid-argument");
  });

  it("only stores nicknames for real players", async () => {
    const { leagueId } = await twoTeamLeague();
    await rejects(manage.setNickname(db, B, { leagueId, playerId: "424242", nickname: "Ghost" }), "not-found");
    await rejects(manage.setNickname(db, B, { leagueId, playerId: "__proto__", nickname: "x" }), "invalid-argument");
    await rejects(manage.setNickname(db, B, { leagueId, playerId: "1003", nickname: 5 }), "invalid-argument");
    await manage.setNickname(db, B, { leagueId, playerId: "1003", nickname: " Starboy " });
    expect((await db.doc(`leagues/${leagueId}/meta/nicknames`).get()).data()).toEqual({ "1003": "Starboy" });
    await manage.setNickname(db, B, { leagueId, playerId: "1003", nickname: null });
    expect((await db.doc(`leagues/${leagueId}/meta/nicknames`).get()).data()).toEqual({});
  });
});

describe("draft", () => {
  it("runs a snake draft with turn order and position limits", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await draft.setupDraft(db, A, { leagueId, order: [b, a], rounds: 2, quotas: { GK: 1, DEF: 1, MID: 1, FWD: 1 } });
    await rejects(draft.makePick(db, B, { leagueId, playerId: "1003" }, T0), "failed-precondition"); // not live
    await draft.startDraft(db, A, { leagueId }, T0);
    await rejects(roster.addDrop(db, A, { leagueId, add: "1001" }, T0), "failed-precondition");      // locked

    await rejects(draft.makePick(db, B, { leagueId, playerId: "424242" }, T0), "not-found");
    await draft.makePick(db, B, { leagueId, playerId: "1003", pick: 1 }, T0);    // B, MID
    await rejects(draft.makePick(db, B, { leagueId, playerId: "2001" }, T0), "permission-denied");
    await rejects(draft.makePick(db, A, { leagueId, playerId: "1003" }, T0), "already-exists");
    await draft.makePick(db, A, { leagueId, playerId: "2001", pick: null }, T0); // A
    await draft.makePick(db, A, { leagueId, playerId: "2002" }, T0);             // A again (snake)
    await rejects(draft.makePick(db, B, { leagueId, playerId: "1003" }, T0), "already-exists");
    expect((await leagueDoc(leagueId)).rosterLimit).toBe(0);
    const res = await draft.makePick(db, A, { leagueId, playerId: "1001", pick: 4 }, T0); // A picks for B
    expect(res).toEqual({ pick: 4, done: true });

    const m = await members(leagueId);
    expect(m.u1.roster).toEqual(["2001", "2002"]);
    expect(m.u2.roster).toEqual(["1003", "1001"]);
    expect((await db.doc(`leagues/${leagueId}/draft/state`).get()).data()).toMatchObject({ status: "done", startedAtGw: 0 });
    expect((await leagueDoc(leagueId)).rosterLimit).toBe(2);     // squads stay the size they were drafted at
    const log = (await db.collection(`leagues/${leagueId}/txns`).get()).docs.map(d => d.get("text"));
    expect(log).toContain("Draft pick 1: B United took Saka");
  });

  it("refuses a pick sent for a turn that has already gone", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await draft.setupDraft(db, A, { leagueId, order: [a, b], rounds: 2, quotas: { GK: 0, DEF: 0, MID: 0, FWD: 0 } });
    await draft.startDraft(db, A, { leagueId }, T0);
    await draft.makePick(db, A, { leagueId, playerId: "2001", pick: 1 }, T0);
    // A double tap: the commissioner's second request would otherwise spend B's pick.
    await rejects(draft.makePick(db, A, { leagueId, playerId: "2002", pick: 1 }, T0), "aborted");
    await rejects(draft.makePick(db, B, { leagueId, playerId: "1003", pick: 3 }, T0), "aborted");
    await rejects(draft.makePick(db, B, { leagueId, playerId: "1003", pick: 1.5 }, T0), "invalid-argument");
    await rejects(draft.makePick(db, B, { leagueId, playerId: "1003", pick: "2" }, T0), "invalid-argument");
    expect(await draft.makePick(db, B, { leagueId, playerId: "1003", pick: 2 }, T0)).toEqual({ pick: 2, done: false });
    expect((await db.doc(`leagues/${leagueId}/draft/state`).get()).get("picks")).toHaveLength(2);
  });

  it("fails cleanly when the team on the clock no longer exists", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await draft.setupDraft(db, A, { leagueId, order: [a, b], rounds: 1 });
    await draft.startDraft(db, A, { leagueId }, T0);
    await db.doc(`leagues/${leagueId}/draft/state`).update({ order: ["gone", b] });
    await rejects(draft.makePick(db, A, { leagueId, playerId: "2001" }, T0), "failed-precondition");
    await db.doc(`leagues/${leagueId}/draft/state`).update({ order: [] });
    await rejects(draft.makePick(db, A, { leagueId, playerId: "2001" }, T0), "failed-precondition");
  });

  it("enforces quotas on the team on the clock", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await draft.setupDraft(db, A, { leagueId, order: [a, b], rounds: 3, quotas: { GK: 0, DEF: 0, MID: 1, FWD: 0 } });
    await draft.startDraft(db, A, { leagueId }, T0);
    await draft.makePick(db, A, { leagueId, playerId: "1003" }, T0);
    await draft.makePick(db, B, { leagueId, playerId: "1002" }, T0);
    await draft.makePick(db, B, { leagueId, playerId: "2003" }, T0);
    await rejects(draft.makePick(db, A, { leagueId, playerId: "2001" }, T0), "failed-precondition"); // 2nd MID
  });

  it("keeps rosters closed to members until the draft is done, and starts from empty squads", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await rejects(roster.addDrop(db, B, { leagueId, add: "1003" }, T0), "failed-precondition");
    await rejects(trades.proposeTrade(db, A, { leagueId, to: b, give: [], get: [] }), "failed-precondition");
    await manage.updateLeague(db, A, { leagueId, waivers: true });
    await rejects(roster.submitClaim(db, B, { leagueId, playerId: "1003" }), "failed-precondition");
    await manage.updateLeague(db, A, { leagueId, waivers: false });

    // The commissioner can still build squads by hand, their own and other people's.
    await roster.addDrop(db, A, { leagueId, add: "2001" }, T0);
    await roster.addDrop(db, A, { leagueId, memberId: b, add: "1003" }, T0);
    await roster.addDrop(db, B, { leagueId, drop: "1003" }, T0);                     // dropping is always allowed
    expect((await members(leagueId)).u2.roster).toEqual([]);

    await draft.setupDraft(db, A, { leagueId, order: [a, b], rounds: 1 });
    await rejects(roster.addDrop(db, B, { leagueId, add: "1003" }, T0), "failed-precondition");   // set up isn't done
    await rejects(draft.startDraft(db, A, { leagueId }, T0), "failed-precondition");              // A still holds Salah
    await draft.resetDraft(db, A, { leagueId }, T0);                                              // clears the squads
    expect((await members(leagueId)).u1.roster).toEqual([]);
    await draft.startDraft(db, A, { leagueId }, T0);
    await draft.makePick(db, A, { leagueId, playerId: "2001" }, T0);
    await draft.makePick(db, B, { leagueId, playerId: "1003" }, T0);
    await roster.addDrop(db, B, { leagueId, add: "1002", drop: "1003" }, T0);                     // open now
  });

  it("can be reset until a gameweek has been banked with the drafted squads", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await draft.setupDraft(db, A, { leagueId, order: [a, b], rounds: 2, quotas: { GK: 0, DEF: 0, MID: 0, FWD: 0 } });
    await draft.startDraft(db, A, { leagueId }, T0);
    await draft.makePick(db, A, { leagueId, playerId: "2001" }, T0);
    await rejects(draft.resetDraft(db, B, { leagueId }, T0), "permission-denied");
    await draft.resetDraft(db, A, { leagueId }, T0);
    const state = (await db.doc(`leagues/${leagueId}/draft/state`).get()).data()!;
    expect(state).toMatchObject({ status: "setup", picks: [] });
    expect(state).not.toHaveProperty("startedAtGw");
    expect((await members(leagueId)).u1.roster).toEqual([]);

    await draft.startDraft(db, A, { leagueId }, T0);
    for (const [who, pid] of [[A, "2001"], [B, "1003"], [B, "1002"], [A, "2002"]] as const)
      await draft.makePick(db, who, { leagueId, playerId: pid }, T0);
    // The deadline has passed but the sync hasn't run: the squads count as scored all the same,
    // and the refused reset leaves no half-applied banking behind.
    await rejects(draft.resetDraft(db, A, { leagueId }, AFTER_GW1), "failed-precondition");
    expect((await leagueDoc(leagueId)).bankedGw).toBe(0);
    await tick(db, fakeFpl({}), AFTER_GW1);
    expect((await leagueDoc(leagueId)).bankedGw).toBe(1);
    await rejects(draft.resetDraft(db, A, { leagueId }, AFTER_GW1), "failed-precondition");
    expect((await members(leagueId)).u1.roster).toEqual(["2001", "2002"]);
  });
});

describe("trades and waivers", () => {
  it("accepts a trade and voids one whose players moved", async () => {
    const { leagueId, b } = await drafted();
    await rejects(trades.proposeTrade(db, A, { leagueId, to: b, give: ["1003"], get: [] }), "failed-precondition");
    await rejects(trades.proposeTrade(db, A, { leagueId, to: b, give: ["2002", "x"], get: [] }), "invalid-argument");
    await rejects(trades.proposeTrade(db, A, { leagueId, to: "a/b", give: ["2002"], get: [] }), "invalid-argument");
    const { tradeId } = await trades.proposeTrade(db, A, { leagueId, to: b, give: ["2002"], get: ["1003"], note: null });
    const { tradeId: stale } = await trades.proposeTrade(db, A, { leagueId, to: b, give: ["2002"], get: ["1002"] });
    await rejects(trades.respondTrade(db, A, { leagueId, tradeId, action: "accept" }, T0), "permission-denied");
    expect(await trades.respondTrade(db, B, { leagueId, tradeId, action: "accept" }, T0)).toEqual({ status: "accepted" });
    const m = await members(leagueId);
    expect(m.u1.roster.sort()).toEqual(["1003", "2001"]);
    expect(m.u2.roster.sort()).toEqual(["1002", "2002"]);
    expect(await trades.respondTrade(db, B, { leagueId, tradeId: stale, action: "accept" }, T0)).toEqual({ status: "void" });
  });

  it("holds squads to the roster limit in free agency, trades and waivers", async () => {
    const { leagueId, a, b } = await drafted();                 // the two-round draft set the limit to 2
    expect((await leagueDoc(leagueId)).rosterLimit).toBe(2);
    await rejects(roster.addDrop(db, A, { leagueId, add: "1001" }, T0), "failed-precondition");
    await rejects(roster.addDrop(db, A, { leagueId, memberId: b, add: "1001" }, T0), "failed-precondition");   // commissioner too
    await roster.addDrop(db, A, { leagueId, add: "1001", drop: "2002" }, T0);                                   // one in, one out
    await roster.addDrop(db, A, { leagueId, add: "2002", drop: "1001" }, T0);

    // Two-for-one: B would end up with three. The accept is refused, and the offer stays open.
    const { tradeId } = await trades.proposeTrade(db, A, { leagueId, to: b, give: ["2001", "2002"], get: ["1003"] });
    await rejects(trades.respondTrade(db, B, { leagueId, tradeId, action: "accept" }, T0), "failed-precondition");
    expect((await db.doc(`leagues/${leagueId}/trades/${tradeId}`).get()).get("status")).toBe("open");
    expect((await members(leagueId)).u2.roster).toEqual(["1003", "1002"]);

    // Waivers: a claim that would overfill the squad fails unless it names a drop.
    await manage.updateLeague(db, A, { leagueId, waivers: true });
    await db.doc(`leagues/${leagueId}/meta/standings`).set({ totals: { [a]: 5, [b]: 50 } });
    await roster.submitClaim(db, A, { leagueId, playerId: "1001" });
    await roster.submitClaim(db, B, { leagueId, playerId: "2003", drop: "1002" });
    expect(await waivers.processWaivers(db, A, { leagueId }, T0)).toEqual({ granted: 1, failed: 1 });
    let m = await members(leagueId);
    expect(m.u1.roster).toEqual(["2001", "2002"]);
    expect(m.u2.roster).toEqual(["1003", "2003"]);

    // Raising the limit lets the same trade through; a lowered limit never blocks a plain drop.
    await manage.updateLeague(db, A, { leagueId, rosterLimit: 3 });
    expect(await trades.respondTrade(db, B, { leagueId, tradeId, action: "accept" }, T0)).toEqual({ status: "accepted" });
    m = await members(leagueId);
    expect(m.u1.roster).toEqual(["1003"]);
    expect(m.u2.roster.sort()).toEqual(["2001", "2002", "2003"]);
    await manage.updateLeague(db, A, { leagueId, rosterLimit: 1 });
    await roster.addDrop(db, B, { leagueId, drop: "2003" }, T0);
    await manage.updateLeague(db, A, { leagueId, rosterLimit: 0, waivers: false });
    await roster.addDrop(db, B, { leagueId, add: "1001" }, T0);
    await roster.addDrop(db, B, { leagueId, add: "1002" }, T0);                 // 0 means no limit
    expect((await members(leagueId)).u2.roster).toHaveLength(4);
  });

  it("free agency, then waivers by fewest points", async () => {
    const { leagueId, a, b } = await drafted();
    await roster.addDrop(db, A, { leagueId, add: "1001", drop: "2002" }, T0);
    await rejects(roster.addDrop(db, B, { leagueId, add: "1001", drop: "1002" }, T0), "already-exists");
    await rejects(roster.addDrop(db, B, { leagueId, memberId: a, drop: "2001" }, T0), "permission-denied");

    await manage.updateLeague(db, A, { leagueId, waivers: true });
    await rejects(roster.addDrop(db, B, { leagueId, add: "2002", drop: "1002" }, T0), "failed-precondition");
    await db.doc(`leagues/${leagueId}/meta/standings`).set({ totals: { [a]: 5, [b]: 50 } });
    await roster.submitClaim(db, B, { leagueId, playerId: "2002", drop: "1002" });
    await rejects(roster.submitClaim(db, B, { leagueId, playerId: "2002" }), "already-exists");
    await roster.submitClaim(db, A, { leagueId, playerId: "2002", drop: "1001" });
    await rejects(waivers.processWaivers(db, B, { leagueId }, T0), "permission-denied");
    expect(await waivers.processWaivers(db, A, { leagueId }, T0)).toEqual({ granted: 1, failed: 1 });
    const m = await members(leagueId);
    expect(m.u1.roster).toContain("2002");          // A has fewer points, so A wins it
    expect(m.u2.roster).toContain("1002");          // B's drop didn't happen
    expect((await db.collection(`leagues/${leagueId}/waivers`).get()).empty).toBe(true);
  });

  it("makes the commissioner use waivers for their own team, but not when managing someone else's", async () => {
    const { leagueId, b } = await drafted();
    await manage.updateLeague(db, A, { leagueId, waivers: true });
    await rejects(roster.addDrop(db, A, { leagueId, add: "1001", drop: "2002" }, T0), "failed-precondition");
    expect((await members(leagueId)).u1.roster).toEqual(["2001", "2002"]);
    await roster.addDrop(db, A, { leagueId, memberId: b, add: "1001", drop: "1002" }, T0);
    expect((await members(leagueId)).u2.roster).toEqual(["1003", "1001"]);
    await roster.addDrop(db, A, { leagueId, drop: "2002" }, T0);        // drops never needed a claim
  });
});

describe("FPL sync and scoring", () => {
  it("banks ownership at each deadline and scores from synced stats", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await roster.addDrop(db, A, { leagueId, add: "2002" }, T0);                 // Isak (FWD) to A before GW1
    await roster.addDrop(db, A, { leagueId, memberId: b, add: "1003" }, T0);    // Saka (MID) to B

    const gw1 = live([{ id: 21, min: 90, g: 2 }, { id: 12, min: 90, a: 1, cs: 1 }, { id: 20, min: 90, g: 3 }]);
    await tick(db, fakeFpl({ 1: gw1 }), new Date("2026-08-15T12:00:00Z"));
    let s = await standings(leagueId);
    expect(s.totals).toEqual({ [a]: 9, [b]: 5 });               // 1+2*4, 1+3+1
    expect(s.awards[1].top).toMatchObject({ playerId: "2001", pts: 16, owner: null });
    expect(s.liveGw).toEqual([1]);

    // A drops Isak after the GW1 deadline: GW1 points stay with A
    const later = new Date("2026-08-20T12:00:00Z");
    await roster.addDrop(db, A, { leagueId, drop: "2002" }, later);
    await roster.addDrop(db, A, { leagueId, memberId: b, add: "2002" }, later);
    await tick(db, fakeFpl({ 1: gw1 }, [1]), later);
    s = await standings(leagueId);
    expect(s.totals).toEqual({ [a]: 9, [b]: 5 });
    expect(s.liveGw).toEqual([]);
    const catalog = (await db.doc("fpl/catalog").get()).data()!;
    expect(catalog.players).toHaveLength(6);
    expect(catalog.players).toContainEqual({ c: "1003", n: "Saka", f: "Bukayo Saka", p: "MID", t: "ARS", s: "d" });
    const cur = (await db.doc("fpl/current").get()).data()!;
    expect(cur.finalized).toEqual([1]);

    const gw2 = live([{ id: 21, min: 90, g: 1 }]);
    await tick(db, fakeFpl({ 1: gw1, 2: gw2 }, [1]), new Date("2026-08-22T15:00:00Z"));
    s = await standings(leagueId);
    expect(s.gwPoints[2]).toEqual({ [a]: 0, [b]: 5 });
    expect(s.liveGw).toEqual([2]);
    expect((await leagueDoc(leagueId)).bankedGw).toBe(2);

    // A scoring change rescores the season (the trigger does this in production)
    await manage.updateLeague(db, A, { leagueId, scoring: { goal_fwd: 10 } });
    await recomputeStandings(db, leagueId);
    s = await standings(leagueId);
    expect(s.totals[a]).toBe(21);
  });

  it("a league created mid-season starts scoring from the next deadline", async () => {
    await tick(db, fakeFpl({}), new Date("2026-08-23T00:00:00Z"));
    const { leagueId } = await manage.createLeague(db, A, { name: "Late", teamName: "A" }, new Date("2026-08-23T00:00:00Z"));
    expect((await leagueDoc(leagueId)).bankedGw).toBe(2);
  });

  it("banks the deadline even when FPL is down", async () => {
    const { leagueId, a, b } = await drafted();
    await tick(db, fplDown, AFTER_GW1);                         // must not throw
    expect((await leagueDoc(leagueId)).bankedGw).toBe(1);
    expect((await db.doc(`leagues/${leagueId}/gameweeks/1`).get()).get("owners"))
      .toEqual({ "2001": a, "2002": a, "1003": b, "1002": b });
    expect(await standings(leagueId)).toMatchObject({ totals: { [a]: 0, [b]: 0 }, liveGw: [1] });
    expect((await db.doc("seasons/2026-27/gameweeks/1").get()).exists).toBe(false);

    // Bootstrap up but the live endpoint still "updating": the calendar refreshes, stats wait.
    const half = async (path: string) => path === "/bootstrap-static/" ? bootstrap({ deadlines: DEADLINES }) : fplDown(path);
    await tick(db, half, AFTER_GW1);
    expect((await db.doc("seasons/2026-27/gameweeks/1").get()).exists).toBe(false);
    await tick(db, fakeFpl({ 1: live([{ id: 21, min: 90, g: 1 }]) }), AFTER_GW1);
    expect((await standings(leagueId)).totals).toEqual({ [a]: 5, [b]: 0 });
  });

  it("a roster move after the deadline but before the next sync banks the squads as they were", async () => {
    const { leagueId, a, b } = await drafted();
    await roster.addDrop(db, A, { leagueId, drop: "2002" }, AFTER_GW1);       // Isak dropped minutes after the deadline
    expect((await leagueDoc(leagueId)).bankedGw).toBe(1);
    expect((await db.doc(`leagues/${leagueId}/gameweeks/1`).get()).get("owners"))
      .toEqual({ "2001": a, "2002": a, "1003": b, "1002": b });
    expect((await members(leagueId)).u1.roster).toEqual(["2001"]);
    await roster.addDrop(db, B, { leagueId, add: "2002", drop: "1002" }, AFTER_GW1);

    await tick(db, fakeFpl({ 1: live([{ id: 21, min: 90, g: 2 }]) }), new Date("2026-08-14T18:05:00Z"));
    expect((await standings(leagueId)).totals).toEqual({ [a]: 9, [b]: 0 });   // Isak's goals stay with A
    expect((await db.doc(`leagues/${leagueId}/gameweeks/1`).get()).get("owners")["2002"]).toBe(a);

    // The other roster-changing calls bank first too. Two missed deadlines both get a snapshot.
    const { tradeId } = await trades.proposeTrade(db, A, { leagueId, to: b, give: ["2001"], get: ["1003"] });
    await trades.respondTrade(db, B, { leagueId, tradeId, action: "accept" }, AFTER_GW2);
    expect((await leagueDoc(leagueId)).bankedGw).toBe(2);
    expect((await db.doc(`leagues/${leagueId}/gameweeks/2`).get()).get("owners"))
      .toEqual({ "2001": a, "1003": b, "2002": b });
    await manage.updateLeague(db, A, { leagueId, waivers: true });
    await roster.submitClaim(db, A, { leagueId, playerId: "1001" });
    await waivers.processWaivers(db, A, { leagueId }, new Date("2026-08-29T11:00:00Z"));
    expect((await db.doc(`leagues/${leagueId}/gameweeks/3`).get()).get("owners"))
      .toEqual({ "1003": a, "2001": b, "2002": b });
    expect((await members(leagueId)).u1.roster).toEqual(["1003", "1001"]);
  });

  it("banks before a draft pick or a removal when the deadline falls mid-draft", async () => {
    const { leagueId, inviteCode, a, b } = await twoTeamLeague();
    await manage.joinLeague(db, C, { code: inviteCode, teamName: "C" });
    const c = (await members(leagueId)).u3.id;
    await roster.addDrop(db, A, { leagueId, memberId: c, add: "2003" }, T0);
    await manage.removeMember(db, A, { leagueId, memberId: c }, AFTER_GW1);
    expect((await db.doc(`leagues/${leagueId}/gameweeks/1`).get()).get("owners")).toEqual({ "2003": c });

    await draft.setupDraft(db, A, { leagueId, order: [a, b], rounds: 1 });
    await draft.startDraft(db, A, { leagueId }, AFTER_GW1);
    await draft.makePick(db, A, { leagueId, playerId: "2001" }, AFTER_GW1);
    await draft.makePick(db, B, { leagueId, playerId: "1003" }, AFTER_GW2);
    expect((await db.doc(`leagues/${leagueId}/gameweeks/2`).get()).get("owners")).toEqual({ "2001": a });
    expect((await leagueDoc(leagueId)).bankedGw).toBe(2);
  });

  it("counts only final gameweeks in the head-to-head table", async () => {
    const { leagueId, a, b } = await drafted();
    await manage.generateSchedule(db, A, { leagueId });
    const gw1 = live([{ id: 21, min: 90, g: 2 }]);              // Isak: A leads 9-0
    await tick(db, fakeFpl({ 1: gw1 }), AFTER_GW1);
    let s = await standings(leagueId);
    expect(s.totals).toEqual({ [a]: 9, [b]: 0 });
    expect(s.liveGw).toEqual([1]);
    expect(s.h2h.map((r: any) => [r.p, r.pts])).toEqual([[0, 0], [0, 0]]);

    await tick(db, fakeFpl({ 1: gw1 }, [1]), new Date("2026-08-18T00:00:00Z"));
    s = await standings(leagueId);
    expect(s.liveGw).toEqual([]);
    expect(s.h2h[0]).toMatchObject({ memberId: a, p: 1, w: 1, pts: 3, total: 9 });
    expect(s.h2h[1]).toMatchObject({ memberId: b, p: 1, l: 1, pts: 0 });
  });

  it("doesn't rewrite stats or standings that haven't changed", async () => {
    const { leagueId } = await drafted();
    const gw1 = live([{ id: 21, min: 90, g: 2 }]);
    await tick(db, fakeFpl({ 1: gw1 }), AFTER_GW1);
    const stats = db.doc("seasons/2026-27/gameweeks/1"), table = db.doc(`leagues/${leagueId}/meta/standings`);
    const [statsAt, tableAt] = [(await stats.get()).get("updatedAt"), (await table.get()).get("updatedAt")];
    expect((await stats.get()).get("hash")).toMatch(/^[0-9a-f]{40}$/);

    await tick(db, fakeFpl({ 1: gw1 }), new Date("2026-08-14T18:10:00Z"));
    await recomputeStandings(db, leagueId);
    expect((await stats.get()).get("updatedAt").isEqual(statsAt)).toBe(true);
    expect((await table.get()).get("updatedAt").isEqual(tableAt)).toBe(true);

    // A changed stat is written and rescored; so is the same stat becoming final.
    await tick(db, fakeFpl({ 1: live([{ id: 21, min: 90, g: 3 }]) }), new Date("2026-08-14T18:20:00Z"));
    const [statsAt2, tableAt2] = [(await stats.get()).get("updatedAt"), (await table.get()).get("updatedAt")];
    expect(statsAt2.isEqual(statsAt)).toBe(false);
    expect(tableAt2.isEqual(tableAt)).toBe(false);
    await tick(db, fakeFpl({ 1: live([{ id: 21, min: 90, g: 3 }]) }, [1]), new Date("2026-08-14T18:30:00Z"));
    expect((await stats.get()).get("final")).toBe(true);
    expect((await table.get()).get("updatedAt").isEqual(tableAt2)).toBe(false);
    expect((await table.get()).get("liveGw")).toEqual([]);
  });

  it("one broken league doesn't stop the others, and the gameweek isn't finalised until it is fixed", async () => {
    const good = await drafted();
    const bad = await manage.createLeague(db, B, { name: "Broken", teamName: "B" }, T0);
    const badMember = (await db.collection(`leagues/${bad.leagueId}/members`).get()).docs[0].ref;
    await badMember.update({ roster: 42 });                      // banking this league throws
    const half = await manage.createLeague(db, C, { name: "Half-migrated", teamName: "C" }, T0);
    await db.doc(`leagues/${half.leagueId}`).update({ migrating: true });

    const gw1 = live([{ id: 21, min: 90, g: 2 }]);
    await tick(db, fakeFpl({ 1: gw1 }, [1]), AFTER_GW1);          // must not throw
    expect((await standings(good.leagueId)).totals).toEqual({ [good.a]: 9, [good.b]: 0 });
    expect((await leagueDoc(bad.leagueId)).bankedGw).toBe(0);
    let cur = (await db.doc("fpl/current").get()).data()!;
    expect(cur.finalized).toEqual([]);
    expect(cur.retryRescore).toBe(true);
    // A league still being migrated is left alone entirely.
    expect((await leagueDoc(half.leagueId)).bankedGw).toBe(0);
    expect((await db.doc(`leagues/${half.leagueId}/meta/standings`).get()).exists).toBe(false);

    await badMember.update({ roster: ["1001"] });
    await tick(db, fakeFpl({ 1: gw1 }, [1]), new Date("2026-08-14T18:10:00Z"));
    cur = (await db.doc("fpl/current").get()).data()!;
    expect(cur.finalized).toEqual([1]);
    expect(cur.retryRescore).toBe(false);
    expect((await leagueDoc(bad.leagueId)).bankedGw).toBe(1);
    expect((await db.doc(`leagues/${bad.leagueId}/gameweeks/1`).get()).get("owners")).toEqual({ "1001": badMember.id });
    expect((await standings(bad.leagueId)).liveGw).toEqual([]);
  });

  it("ignores a malformed schedule doc instead of failing the league", async () => {
    const { leagueId, a, b } = await drafted();
    await manage.updateLeague(db, A, { leagueId, h2h: true });
    await db.doc(`leagues/${leagueId}/meta/schedule`).set({ 1: "a|b", 2: [7, `${a}|${b}|x`, `${a}|${b}`], junk: { x: 1 } });
    await tick(db, fakeFpl({ 1: live([{ id: 21, min: 90, g: 2 }]), 2: live([{ id: 12, min: 90 }]) }, [1, 2]), AFTER_GW2);
    const s = await standings(leagueId);
    expect(s.h2h[0]).toMatchObject({ memberId: b, p: 1, w: 1 });         // only GW2's one valid pair counts
    expect(s.h2h[1]).toMatchObject({ memberId: a, p: 1, d: 0, l: 1 });
  });
});
