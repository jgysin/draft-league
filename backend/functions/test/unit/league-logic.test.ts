import { describe, expect, it } from "vitest";
import { INVITE_CODE_RE, newInviteCode, quotaBlocked, resolveWaivers, roundRobin, seasonFor, snakePick } from "../../src/core/league-logic";

describe("snakePick", () => {
  it("reverses every other round", () => {
    const order = ["a", "b", "c"];
    expect([0, 1, 2, 3, 4, 5, 6].map(n => snakePick(order, n).memberId)).toEqual(["a", "b", "c", "c", "b", "a", "a"]);
    expect(snakePick(order, 4).round).toBe(1);
  });
});

describe("quotaBlocked", () => {
  it("blocks at the cap and treats 0 as unlimited", () => {
    const q = { GK: 1, DEF: 0, MID: 2, FWD: 2 };
    const pos = { g1: "GK", d1: "DEF", d2: "DEF" } as const;
    expect(quotaBlocked(q, ["g1"], pos, "GK")).toBe(true);
    expect(quotaBlocked(q, ["d1", "d2"], pos, "DEF")).toBe(false);
    expect(quotaBlocked(q, ["g1"], pos, "MID")).toBe(false);
  });
});

describe("roundRobin", () => {
  it("pairs everyone once per round and everyone meets everyone", () => {
    const s = roundRobin(["a", "b", "c", "d"]);
    expect(Object.keys(s)).toHaveLength(38);
    for (const pairs of Object.values(s)) expect(new Set(pairs.flat()).size).toBe(4);
    const met = new Set(Object.values(s).slice(0, 3).flat().map(p => [...p].sort().join()));
    expect(met.size).toBe(6);
  });
  it("gives a bye with an odd number of teams", () => {
    const s = roundRobin(["a", "b", "c"]);
    for (const pairs of Object.values(s)) expect(pairs).toHaveLength(1);
  });
});

describe("resolveWaivers", () => {
  it("gives contested players to the team with fewer points", () => {
    const r = resolveWaivers({
      claims: [
        { id: "1", memberId: "rich", playerId: "x", drop: null, tsMs: 1 },
        { id: "2", memberId: "poor", playerId: "x", drop: "p1", tsMs: 2 },
        { id: "3", memberId: "rich", playerId: "y", drop: "p2", tsMs: 3 },
      ],
      rosters: { rich: ["p2"], poor: ["p1"] },
      totals: { rich: 50, poor: 10 },
    });
    expect(r.granted.map(g => g.id)).toEqual(["2", "3"]);
    expect(r.rosters).toEqual({ rich: ["y"], poor: ["x"] });
  });
  it("skips a claim whose drop player is already gone", () => {
    const r = resolveWaivers({
      claims: [
        { id: "1", memberId: "a", playerId: "x", drop: "p1", tsMs: 1 },
        { id: "2", memberId: "a", playerId: "y", drop: "p1", tsMs: 2 },
      ],
      rosters: { a: ["p1"] }, totals: {},
    });
    expect(r.granted.map(g => g.id)).toEqual(["1"]);
  });

  it("fails a claim with no drop when the roster is at the limit", () => {
    const r = resolveWaivers({
      claims: [
        { id: "1", memberId: "a", playerId: "x", drop: null, tsMs: 1 },
        { id: "2", memberId: "a", playerId: "y", drop: "p1", tsMs: 2 },
        { id: "3", memberId: "b", playerId: "x", drop: null, tsMs: 3 },
      ],
      rosters: { a: ["p1", "p2"], b: ["p3"] }, totals: {}, rosterLimit: 2,
    });
    expect(r.granted.map(g => g.id)).toEqual(["2", "3"]);
    expect(r.rosters).toEqual({ a: ["p2", "y"], b: ["p3", "x"] });
  });
});

it("invite codes are 8 characters and avoid lookalikes", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const code = newInviteCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(code).toMatch(INVITE_CODE_RE);
    seen.add(code);
  }
  expect(seen.size).toBe(200);
  expect("ABC234").toMatch(INVITE_CODE_RE);          // codes issued before the change still parse
  expect("abc234").not.toMatch(INVITE_CODE_RE);
  expect("ABC23").not.toMatch(INVITE_CODE_RE);
  expect("ABC/234").not.toMatch(INVITE_CODE_RE);
});

it("an empty draft order puts nobody on the clock", () => {
  expect(snakePick([], 0).memberId).toBeUndefined();
});

it("seasons roll over in July", () => {
  expect(seasonFor(new Date("2026-08-15"))).toBe("2026-27");
  expect(seasonFor(new Date("2027-03-01"))).toBe("2026-27");
  expect(seasonFor(new Date("2099-07-01"))).toBe("2099-00");
});
