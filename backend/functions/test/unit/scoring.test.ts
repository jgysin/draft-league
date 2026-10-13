import { describe, expect, it } from "vitest";
import { computeStandings, statPoints } from "../../src/core/scoring";
import { DEFAULT_SCORING } from "../../src/core/types";

describe("statPoints", () => {
  it("matches the website's default scoring", () => {
    // MID: appearance 1 + goal 5 + assist 3 + cs 1 + yellow -1
    expect(statPoints("MID", { apps: 1, goals: 1, assists: 1, cs: 1, yc: 1 })).toBe(9);
    // FWD gets nothing for a clean sheet
    expect(statPoints("FWD", { apps: 1, cs: 1 })).toBe(1);
    expect(statPoints("GK", undefined)).toBe(0);
  });

  it("counts double gameweeks per fixture", () => {
    expect(statPoints("DEF", { apps: 2, cs: 2 })).toBe(2 + 8);
  });

  it("uses league overrides on top of the defaults", () => {
    expect(statPoints("FWD", { apps: 1, goals: 2 }, { goal_fwd: 10 })).toBe(21);
    expect(statPoints("FWD", { og: 1 }, { ...DEFAULT_SCORING, own_goal: -5 })).toBe(-5);
  });
});

describe("computeStandings", () => {
  const positions = { p1: "FWD", p2: "MID", p3: "DEF" } as const;
  const gameweeks = [
    { gw: 1, owners: { p1: "a", p2: "b" }, stats: { p1: { apps: 1, goals: 1 }, p2: { apps: 1 }, p3: { apps: 1, goals: 3 } } },
    // p1 moved to b before gw 2's deadline: gw 1 points stay with a
    { gw: 2, owners: { p1: "b", p2: "b" }, stats: { p1: { apps: 1 } } },
  ];

  it("credits points to whoever owned the player at the deadline", () => {
    const s = computeStandings({ memberIds: ["a", "b"], positions, scoring: DEFAULT_SCORING, gameweeks });
    expect(s.gwPoints[1]).toEqual({ a: 5, b: 1 });
    expect(s.gwPoints[2]).toEqual({ a: 0, b: 1 });
    expect(s.totals).toEqual({ a: 5, b: 2 });
    expect(s.awards[1].top).toEqual({ playerId: "p3", pts: 19, owner: null });
    expect(s.awards[1].best.memberId).toBe("a");
    expect(s.h2h).toBeNull();
  });

  it("builds the head-to-head table with total points as tiebreak", () => {
    const s = computeStandings({ memberIds: ["a", "b"], positions, scoring: DEFAULT_SCORING, gameweeks,
      schedule: { 1: [["a", "b"]], 2: [["a", "b"]] } });
    expect(s.h2h![0]).toMatchObject({ memberId: "a", w: 1, l: 1, pts: 3, total: 5 });
    expect(s.h2h![1]).toMatchObject({ memberId: "b", w: 1, l: 1, pts: 3, total: 2 });
  });
});
