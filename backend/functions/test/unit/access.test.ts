import { describe, expect, it } from "vitest";
import { bool, email, given, id, idList, int, playerId, playerIdList, requireAuth } from "../../src/league/access";

const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.code; } return "ok"; };

describe("requireAuth", () => {
  it("only trusts an email the provider has verified", () => {
    expect(requireAuth({ uid: "u", token: { email: "Me@Example.com", email_verified: true } })).toEqual({ uid: "u", email: "me@example.com" });
    expect(requireAuth({ uid: "u", token: { email: "me@example.com", email_verified: false } }).email).toBeNull();
    expect(requireAuth({ uid: "u", token: { email: "me@example.com" } }).email).toBeNull();
    expect(requireAuth({ uid: "u", token: {} }).email).toBeNull();
    expect(code(() => requireAuth(undefined))).toBe("unauthenticated");
  });
});

describe("argument validation", () => {
  it("accepts only safe document ids", () => {
    expect(id("aB3_-x", "leagueId")).toBe("aB3_-x");
    for (const bad of ["", "a/b", "..", "__name__.x", "a b", "x".repeat(65), 5, null, undefined, {}])
      expect(code(() => id(bad, "leagueId"))).toBe("invalid-argument");
    expect(idList(["a", "b", "a"], "order")).toEqual(["a", "b"]);
    expect(code(() => idList(["a", "b/c"], "order"))).toBe("invalid-argument");
    expect(code(() => idList("a", "order"))).toBe("invalid-argument");
  });

  it("accepts only numeric player codes", () => {
    expect(playerId("223094", "playerId")).toBe("223094");
    for (const bad of ["", "12a", "1.5", "-1", " 12", "12345678901", 12, null, undefined])
      expect(code(() => playerId(bad, "playerId"))).toBe("invalid-argument");
    expect(playerIdList(["1", "2", "1"], "give")).toEqual(["1", "2"]);
    expect(code(() => playerIdList(["1", "x"], "give"))).toBe("invalid-argument");
    expect(code(() => playerIdList(Array(31).fill("1"), "give"))).toBe("invalid-argument");
  });

  it("treats null like a missing argument and insists on real booleans and integers", () => {
    expect([given(undefined), given(null), given(false), given(0), given("")]).toEqual([false, false, true, true, true]);
    expect(bool(false, "h2h")).toBe(false);
    for (const bad of ["true", 1, 0, null, undefined]) expect(code(() => bool(bad, "h2h"))).toBe("invalid-argument");
    expect(int(40, "n", 0, 40)).toBe(40);
    for (const bad of [41, -1, 1.5, "3", NaN, null]) expect(code(() => int(bad, "n", 0, 40))).toBe("invalid-argument");
  });

  it("lower-cases emails and rejects things that aren't one", () => {
    expect(email(" Friend@Example.com ")).toBe("friend@example.com");
    for (const bad of ["friend", "a@b", "a b@c.com", "", 7]) expect(code(() => email(bad))).toBe("invalid-argument");
  });
});
