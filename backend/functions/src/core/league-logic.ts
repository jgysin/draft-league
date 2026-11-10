/** Pure league rules shared by the callables and (later) the app. */
import { randomInt } from "node:crypto";
import { DraftState, Position } from "./types";

/** Who is on the clock for pick index `n` (0-based) in a snake draft. */
export function snakePick(order: string[], n: number): { round: number; memberId: string } {
  const size = order.length || 1;   // an empty order yields an undefined memberId, not NaN indexes
  const round = Math.floor(n / size);
  const i = n % size;
  return { round, memberId: round % 2 === 0 ? order[i] : order[size - 1 - i] };
}

export function draftTotalPicks(d: Pick<DraftState, "order" | "rounds">): number {
  return d.order.length * d.rounds;
}

export function quotaBlocked(quotas: Record<Position, number>, roster: string[],
                             positions: Record<string, Position>, pos: Position): boolean {
  const cap = quotas[pos] || 0;
  if (!cap) return false;
  return roster.filter(p => positions[p] === pos).length >= cap;
}

/** Circle-method round robin over 38 gameweeks; odd member counts get a bye (""). */
export function roundRobin(memberIds: string[], gameweeks = 38): Record<string, [string, string][]> {
  const ids = [...memberIds];
  if (ids.length % 2) ids.push("");
  const n = ids.length;
  const out: Record<string, [string, string][]> = {};
  for (let gw = 1; gw <= gameweeks; gw++) {
    const rest = ids.slice(1), k = (gw - 1) % (n - 1);
    const line = [ids[0], ...rest.slice(k), ...rest.slice(0, k)];
    const pairs: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = line[i], b = line[n - 1 - i];
      if (a && b) pairs.push([a, b]);
    }
    out[gw] = pairs;
  }
  return out;
}

/**
 * Resolve pending waiver claims. Priority goes to the member with the fewest
 * points; within one member, claims run oldest first. A claim fails if the
 * player is already taken, its drop player is no longer on the roster, or it
 * has no drop and the roster is already at `rosterLimit` (0 = unlimited).
 */
export function resolveWaivers(opts: {
  claims: { id: string; memberId: string; playerId: string; drop: string | null; tsMs: number }[];
  rosters: Record<string, string[]>;
  totals: Record<string, number>;
  rosterLimit?: number;
}): { rosters: Record<string, string[]>; granted: { id: string; memberId: string; playerId: string; drop: string | null }[] } {
  const rosters = Object.fromEntries(Object.entries(opts.rosters).map(([k, v]) => [k, [...v]]));
  const taken = new Set(Object.values(rosters).flat());
  const order = Object.keys(rosters).sort((a, b) =>
    (opts.totals[a] || 0) - (opts.totals[b] || 0) || a.localeCompare(b));
  const granted: ReturnType<typeof resolveWaivers>["granted"] = [];
  for (const mid of order) {
    const mine = opts.claims.filter(c => c.memberId === mid).sort((a, b) => a.tsMs - b.tsMs);
    for (const c of mine) {
      if (taken.has(c.playerId)) continue;
      if (c.drop && !rosters[mid].includes(c.drop)) continue;
      if (opts.rosterLimit && !c.drop && rosters[mid].length >= opts.rosterLimit) continue;
      if (c.drop) { rosters[mid] = rosters[mid].filter(p => p !== c.drop); taken.delete(c.drop); }
      rosters[mid].push(c.playerId);
      taken.add(c.playerId);
      granted.push({ id: c.id, memberId: mid, playerId: c.playerId, drop: c.drop });
    }
  }
  return { rosters, granted };
}

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I
/** Join codes are the only secret between a stranger and a league, so they come from the CSPRNG. */
export function newInviteCode(length = 8): string {
  let s = "";
  for (let i = 0; i < length; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return s;
}
/** What a typed code must look like (older leagues have 6-character codes). */
export const INVITE_CODE_RE = /^[A-Z2-9]{6,10}$/;

/** FPL season label for a date: seasons roll over on 1 July. Only the sync uses this; leagues copy fpl/current. */
export function seasonFor(d: Date): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
