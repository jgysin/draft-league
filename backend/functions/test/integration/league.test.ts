import { beforeEach, describe, expect, it } from "vitest";
import { clearDb, db, rejects, user } from "./setup";
import { bootstrap, live } from "../fixtures/fpl";
import * as manage from "../../src/league/manage";
import * as draft from "../../src/league/draft";
import * as roster from "../../src/league/roster";
import * as trades from "../../src/league/trades";
import * as waivers from "../../src/league/waivers";
import { tick } from "../../src/fpl/sync";

const DEADLINES = ["2026-08-14T17:30:00Z", "2026-08-22T10:00:00Z", "2026-08-29T10:00:00Z"];
const fakeFpl = (liveByGw: Record<number, ReturnType<typeof live>>, checked: number[] = []) =>
  async (path: string) => {
    if (path === "/bootstrap-static/") return bootstrap({ deadlines: DEADLINES, checked });
    const gw = Number(path.match(/event\/(\d+)/)?.[1]);
    return liveByGw[gw] ?? live([]);
  };

const [A, B, C] = [user(1), user(2), user(3)];
const members = async (leagueId: string) =>
  Object.fromEntries((await db.collection(`leagues/${leagueId}/members`).get()).docs.map(d => [d.get("uid") ?? d.id, { id: d.id, ...d.data() }])) as Record<string, any>;

/** League with A (owner) and B joined, players synced, before GW1's deadline. */
async function twoTeamLeague() {
  await tick(db, fakeFpl({}), new Date("2026-08-01T00:00:00Z"));
  const { leagueId, inviteCode } = await manage.createLeague(db, A, { name: "Lads", teamName: "A FC" }, new Date("2026-08-01T00:00:00Z"));
  await manage.joinLeague(db, B, { code: inviteCode.toLowerCase(), teamName: "B United" });
  const m = await members(leagueId);
  return { leagueId, inviteCode, a: m.u1.id as string, b: m.u2.id as string };
}

beforeEach(clearDb);

describe("joining", () => {
  it("creates a league, joins by code and claims a reserved slot by email", async () => {
    const { leagueId, inviteCode } = await twoTeamLeague();
    await manage.addSlot(db, A, { leagueId, teamName: "C City", email: "Friend3@Example.com" });
    await rejects(manage.addSlot(db, B, { leagueId, teamName: "nope" }), "permission-denied");

    expect(await manage.claimSlots(db, C)).toEqual({ claimed: [leagueId] });
    const league = (await db.doc(`leagues/${leagueId}`).get()).data()!;
    expect(league.memberUids.sort()).toEqual(["u1", "u2", "u3"]);
    expect(league.season).toBe("2026-27");
    expect((await members(leagueId)).u3.teamName).toBe("C City");

    // joining again is a no-op; a bad code is a clean error
    await manage.joinLeague(db, B, { code: inviteCode });
    expect(Object.keys(await members(leagueId))).toHaveLength(3);
    await rejects(manage.joinLeague(db, C, { code: "ZZZZZZ" }), "not-found");
  });

  it("retires the old code when the invite rotates", async () => {
    const { leagueId, inviteCode } = await twoTeamLeague();
    const { inviteCode: next } = await manage.rotateInvite(db, A, { leagueId });
    await rejects(manage.joinLeague(db, C, { code: inviteCode, teamName: "C" }), "not-found");
    await manage.joinLeague(db, C, { code: next, teamName: "C" });
  });
});

describe("draft", () => {
  it("runs a snake draft with turn order and position limits", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await draft.setupDraft(db, A, { leagueId, order: [b, a], rounds: 2, quotas: { GK: 1, DEF: 1, MID: 1, FWD: 1 } });
    await rejects(draft.makePick(db, B, { leagueId, playerId: "1003" }), "failed-precondition"); // not live
    await draft.startDraft(db, A, { leagueId });
    await rejects(roster.addDrop(db, A, { leagueId, add: "1001" }), "failed-precondition");      // locked

    await rejects(draft.makePick(db, B, { leagueId, playerId: "424242" }), "not-found");
    await draft.makePick(db, B, { leagueId, playerId: "1003" });             // B, MID
    await rejects(draft.makePick(db, B, { leagueId, playerId: "2001" }), "permission-denied");
    await rejects(draft.makePick(db, A, { leagueId, playerId: "1003" }), "already-exists");
    await draft.makePick(db, A, { leagueId, playerId: "2001" });             // A
    await draft.makePick(db, A, { leagueId, playerId: "2002" });             // A again (snake)
    await rejects(draft.makePick(db, B, { leagueId, playerId: "1003" }), "already-exists");
    const res = await draft.makePick(db, A, { leagueId, playerId: "1001" }); // A picks for B
    expect(res).toEqual({ pick: 4, done: true });

    const m = await members(leagueId);
    expect(m.u1.roster).toEqual(["2001", "2002"]);
    expect(m.u2.roster).toEqual(["1003", "1001"]);
    expect((await db.doc(`leagues/${leagueId}/draft/state`).get()).get("status")).toBe("done");
    const log = (await db.collection(`leagues/${leagueId}/txns`).get()).docs.map(d => d.get("text"));
    expect(log).toContain("Draft pick 1: B United took Saka");
  });

  it("enforces quotas on the team on the clock", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await draft.setupDraft(db, A, { leagueId, order: [a, b], rounds: 3, quotas: { GK: 0, DEF: 0, MID: 1, FWD: 0 } });
    await draft.startDraft(db, A, { leagueId });
    await draft.makePick(db, A, { leagueId, playerId: "1003" });
    await draft.makePick(db, B, { leagueId, playerId: "1002" });
    await draft.makePick(db, B, { leagueId, playerId: "2003" });
    await rejects(draft.makePick(db, A, { leagueId, playerId: "2001" }), "failed-precondition"); // 2nd MID
  });
});

describe("trades and waivers", () => {
  async function drafted() {
    const ctx = await twoTeamLeague();
    await draft.setupDraft(db, A, { leagueId: ctx.leagueId, order: [ctx.a, ctx.b], rounds: 2, quotas: { GK: 0, DEF: 0, MID: 0, FWD: 0 } });
    await draft.startDraft(db, A, { leagueId: ctx.leagueId });
    for (const [who, pid] of [[A, "2001"], [B, "1003"], [B, "1002"], [A, "2002"]] as const)
      await draft.makePick(db, who, { leagueId: ctx.leagueId, playerId: pid });
    return ctx;
  }

  it("accepts a trade and voids one whose players moved", async () => {
    const { leagueId, b } = await drafted();
    await rejects(trades.proposeTrade(db, A, { leagueId, to: b, give: ["1003"], get: [] }), "failed-precondition");
    const { tradeId } = await trades.proposeTrade(db, A, { leagueId, to: b, give: ["2002"], get: ["1003"] });
    const { tradeId: stale } = await trades.proposeTrade(db, A, { leagueId, to: b, give: ["2002"], get: ["1002"] });
    await rejects(trades.respondTrade(db, A, { leagueId, tradeId, action: "accept" }), "permission-denied");
    expect(await trades.respondTrade(db, B, { leagueId, tradeId, action: "accept" })).toEqual({ status: "accepted" });
    const m = await members(leagueId);
    expect(m.u1.roster.sort()).toEqual(["1003", "2001"]);
    expect(m.u2.roster.sort()).toEqual(["1002", "2002"]);
    expect(await trades.respondTrade(db, B, { leagueId, tradeId: stale, action: "accept" })).toEqual({ status: "void" });
  });

  it("free agency, then waivers by fewest points", async () => {
    const { leagueId, a, b } = await drafted();
    await roster.addDrop(db, A, { leagueId, add: "1001", drop: "2002" });
    await rejects(roster.addDrop(db, B, { leagueId, add: "1001" }), "already-exists");
    await rejects(roster.addDrop(db, B, { leagueId, memberId: a, drop: "2001" }), "permission-denied");

    await manage.updateLeague(db, A, { leagueId, waivers: true });
    await rejects(roster.addDrop(db, B, { leagueId, add: "2002" }), "failed-precondition");
    await db.doc(`leagues/${leagueId}/meta/standings`).set({ totals: { [a]: 5, [b]: 50 } });
    await roster.submitClaim(db, B, { leagueId, playerId: "2002", drop: "1002" });
    await rejects(roster.submitClaim(db, B, { leagueId, playerId: "2002" }), "already-exists");
    await roster.submitClaim(db, A, { leagueId, playerId: "2002" });
    await rejects(waivers.processWaivers(db, B, { leagueId }), "permission-denied");
    expect(await waivers.processWaivers(db, A, { leagueId })).toEqual({ granted: 1, failed: 1 });
    const m = await members(leagueId);
    expect(m.u1.roster).toContain("2002");          // A has fewer points, so A wins it
    expect(m.u2.roster).toContain("1002");          // B's drop didn't happen
    expect((await db.collection(`leagues/${leagueId}/waivers`).get()).empty).toBe(true);
  });
});

describe("FPL sync and scoring", () => {
  it("banks ownership at each deadline and scores from synced stats", async () => {
    const { leagueId, a, b } = await twoTeamLeague();
    await manage.updateLeague(db, A, { leagueId, waivers: false });
    await roster.addDrop(db, A, { leagueId, add: "2002" });   // Isak (FWD) to A before GW1
    await roster.addDrop(db, B, { leagueId, add: "1003" });   // Saka (MID) to B

    const gw1 = live([{ id: 21, min: 90, g: 2 }, { id: 12, min: 90, a: 1, cs: 1 }, { id: 20, min: 90, g: 3 }]);
    await tick(db, fakeFpl({ 1: gw1 }), new Date("2026-08-15T12:00:00Z"));
    let s = (await db.doc(`leagues/${leagueId}/meta/standings`).get()).data()!;
    expect(s.totals).toEqual({ [a]: 9, [b]: 5 });               // 1+2*4, 1+3+1
    expect(s.awards[1].top).toMatchObject({ playerId: "2001", pts: 16, owner: null });

    // A drops Isak after the GW1 deadline: GW1 points stay with A
    await roster.addDrop(db, A, { leagueId, drop: "2002" });
    await roster.addDrop(db, B, { leagueId, add: "2002" });
    await tick(db, fakeFpl({ 1: gw1 }, [1]), new Date("2026-08-20T12:00:00Z"));
    s = (await db.doc(`leagues/${leagueId}/meta/standings`).get()).data()!;
    expect(s.totals).toEqual({ [a]: 9, [b]: 5 });
    const cur = (await db.doc("fpl/current").get()).data()!;
    expect(cur.finalized).toEqual([1]);

    const gw2 = live([{ id: 21, min: 90, g: 1 }]);
    await tick(db, fakeFpl({ 1: gw1, 2: gw2 }, [1]), new Date("2026-08-22T15:00:00Z"));
    s = (await db.doc(`leagues/${leagueId}/meta/standings`).get()).data()!;
    expect(s.gwPoints[2]).toEqual({ [a]: 0, [b]: 5 });
    expect((await db.doc(`leagues/${leagueId}`).get()).get("bankedGw")).toBe(2);

    // A scoring change rescores the season (the trigger does this in production)
    await manage.updateLeague(db, A, { leagueId, scoring: { goal_fwd: 10 } });
    const { recomputeStandings } = await import("../../src/league/standings");
    await recomputeStandings(db, leagueId);
    s = (await db.doc(`leagues/${leagueId}/meta/standings`).get()).data()!;
    expect(s.totals[a]).toBe(21);
  });

  it("a league created mid-season starts scoring from the next deadline", async () => {
    await tick(db, fakeFpl({}), new Date("2026-08-23T00:00:00Z"));
    const { leagueId } = await manage.createLeague(db, A, { name: "Late", teamName: "A" }, new Date("2026-08-23T00:00:00Z"));
    expect((await db.doc(`leagues/${leagueId}`).get()).get("bankedGw")).toBe(2);
  });
});
