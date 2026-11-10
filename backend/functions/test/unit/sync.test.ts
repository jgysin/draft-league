import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFpl, statsHash } from "../../src/fpl/sync";
import { parseSchedule } from "../../src/league/standings";

const line = (goals: number) => ({ apps: 1, minutes: 90, goals, assists: 0, cs: 0, yc: 0, rc: 0, og: 0 });

describe("statsHash", () => {
  it("ignores key order and changes with any stat", () => {
    expect(statsHash({ "1": line(1), "2": line(0) })).toBe(statsHash({ "2": line(0), "1": line(1) }));
    expect(statsHash({ "1": line(1), "2": line(0) })).not.toBe(statsHash({ "1": line(1), "2": line(1) }));
    expect(statsHash({ "1": line(1) })).not.toBe(statsHash({ "1": line(1), "2": line(0) }));
    expect(statsHash({ "1": { ...line(0), og: 1 } })).not.toBe(statsHash({ "1": { ...line(0), rc: 1 } }));
  });
});

describe("parseSchedule", () => {
  it("keeps well-formed pairs and ignores everything else", () => {
    expect(parseSchedule({ 1: ["a|b", "c|d"], 2: "a|b", 3: ["a|b|c", "a|", "|b", 7, null, "x|y"], 4: { 0: "a|b" } }))
      .toEqual({ 1: [["a", "b"], ["c", "d"]], 3: [["x", "y"]] });
    expect(parseSchedule(null)).toEqual({});
    expect(parseSchedule("junk")).toEqual({});
  });
});

describe("fetchFpl", () => {
  afterEach(() => vi.unstubAllGlobals());
  const res = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body });

  it("retries a 503 and a network error, with a timeout on every attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(res(200, { events: [] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchFpl("/bootstrap-static/")).toEqual({ events: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up after two retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFpl("/event/1/live/")).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry a 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFpl("/event/99/live/")).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
