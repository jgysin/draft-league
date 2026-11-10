import { describe, expect, it } from "vitest";
import { parseBootstrap, parseLive, passedDeadlines } from "../../src/fpl/parse";
import { bootstrap, live } from "../fixtures/fpl";

const boot = bootstrap({ deadlines: ["2026-08-14T17:30:00Z", "2026-08-22T10:00:00Z", "2026-08-29T10:00:00Z"], checked: [1] });

describe("parseBootstrap", () => {
  const p = parseBootstrap(boot);
  it("keys players by code and skips managers", () => {
    expect(p.players).toHaveLength(6);
    expect(p.players.find(x => x.code === "1003")).toMatchObject({ name: "Saka", position: "MID", club: "ARS", status: "d", fplId: 12 });
    expect(p.elementToCode["21"]).toBe("2002");
    expect(p.elementToCode["99"]).toBeUndefined();
  });
  it("lists passed deadlines and shrugs off a malformed events list", () => {
    const now = new Date("2026-08-23T12:00:00Z");
    expect(passedDeadlines(p.events, now)).toEqual([1, 2]);
    expect(passedDeadlines([...p.events].reverse(), now)).toEqual([1, 2]);
    expect(passedDeadlines(undefined, now)).toEqual([]);
    expect(passedDeadlines("nope", now)).toEqual([]);
    expect(passedDeadlines([null, { id: "x", deadline: "2020-01-01" }, { id: 3 }, { id: 4, deadline: "junk" }], now)).toEqual([]);
  });
});

describe("parseLive", () => {
  const { elementToCode } = parseBootstrap(boot);
  it("maps stats to codes and drops players who didn't play", () => {
    const s = parseLive(live([
      { id: 12, min: 90, g: 1, a: 1, cs: 1 },
      { id: 21, min: 0 },
      { id: 22, min: 180, cs: 2, fixtures: 2 },
    ]), elementToCode);
    expect(s["1003"]).toEqual({ apps: 1, minutes: 90, goals: 1, assists: 1, cs: 1, yc: 0, rc: 0, og: 0 });
    expect(s["2002"]).toBeUndefined();
    expect(s["2003"].apps).toBe(2);
  });
  it("keeps an unused sub who was booked or sent off", () => {
    const data = live([{ id: 21, min: 0, yc: 1 }, { id: 22, min: 0 }, { id: 12, min: 0 }, { id: 10, min: 0 }]);
    data.elements[2].stats.red_cards = 1;
    data.elements[3].stats.own_goals = 1;
    const s = parseLive(data, elementToCode);
    expect(s["2002"]).toEqual({ apps: 0, minutes: 0, goals: 0, assists: 0, cs: 0, yc: 1, rc: 0, og: 0 });
    expect(s["2003"]).toBeUndefined();
    expect(s["1003"]).toMatchObject({ apps: 0, rc: 1 });
    expect(s["1001"]).toMatchObject({ apps: 0, og: 1 });
  });
});
