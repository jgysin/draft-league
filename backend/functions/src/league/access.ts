import { HttpsError } from "firebase-functions/v2/https";
import type { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import { League, Member } from "../core/types";

export const leagueRef = (db: Firestore, leagueId: string) => db.collection("leagues").doc(leagueId);
export const memberRef = (db: Firestore, leagueId: string, memberId: string) =>
  leagueRef(db, leagueId).collection("members").doc(memberId);

export interface Caller { uid: string; email: string | null }

/** An email only identifies someone once the provider has verified it; anything else could claim a friend's team. */
export function requireAuth(auth: { uid: string; token: { email?: string; email_verified?: boolean } } | undefined): Caller {
  if (!auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const email = auth.token.email && auth.token.email_verified === true ? auth.token.email.toLowerCase() : null;
  return { uid: auth.uid, email };
}

/** Optional argument: Swift encodes nil as null, so null means "not sent" just like undefined. */
export const given = (v: unknown): boolean => v !== undefined && v !== null;

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpsError("invalid-argument", `${field} is required.`);
  if (v.length > max) throw new HttpsError("invalid-argument", `${field} is too long.`);
  return v.trim();
}

/** A Firestore document id we generated (or a legacy manager id); keeps "/", "." and "__x__" out of paths. */
export function id(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v))
    throw new HttpsError("invalid-argument", `${field} is not a valid id.`);
  return v;
}

/** An FPL player code. */
export function playerId(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d{1,10}$/.test(v))
    throw new HttpsError("invalid-argument", `${field} is not a valid player.`);
  return v;
}

function list(v: unknown, field: string, max: number, each: (x: unknown, field: string) => string): string[] {
  if (!Array.isArray(v) || v.length > max) throw new HttpsError("invalid-argument", `${field} must be a list of ids.`);
  return [...new Set(v.map(x => each(x, field)))];
}
export const idList = (v: unknown, field: string, max = 30) => list(v, field, max, id);
export const playerIdList = (v: unknown, field: string, max = 30) => list(v, field, max, playerId);

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new HttpsError("invalid-argument", `${field} must be true or false.`);
  return v;
}

export function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new HttpsError("invalid-argument", `${field} must be a whole number from ${min} to ${max}.`);
  return v;
}

export function email(v: unknown, field = "Email"): string {
  const e = str(v, field, 200).toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpsError("invalid-argument", `${field} doesn't look like an email address.`);
  return e;
}
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LeagueCtx {
  ref: DocumentReference;
  league: League;
  memberId: string;
  member: Member;
  isAdmin: boolean;
  members: Map<string, Member>;
}

/**
 * Load a league and all its members inside a transaction, and check that the
 * caller is a member (and an admin when `admin` is set). Leagues are small, so
 * reading every member keeps roster checks simple and consistent.
 */
export async function loadLeague(tx: Transaction, db: Firestore, leagueId: unknown, caller: Caller,
                                 opts: { admin?: boolean } = {}): Promise<LeagueCtx> {
  const ref = leagueRef(db, id(leagueId, "leagueId"));
  const [snap, membersSnap] = await Promise.all([tx.get(ref), tx.get(ref.collection("members"))]);
  if (!snap.exists || snap.get("migrating")) throw new HttpsError("not-found", "League not found.");
  const members = new Map(membersSnap.docs.map(d => [d.id, d.data() as Member]));
  const mine = [...members].find(([, m]) => m.uid === caller.uid);
  if (!mine) throw new HttpsError("permission-denied", "You're not in this league.");
  const [memberId, member] = mine;
  const isAdmin = member.role === "owner" || member.role === "admin";
  if (opts.admin && !isAdmin) throw new HttpsError("permission-denied", "Only the commissioner can do that.");
  return { ref, league: snap.data() as League, memberId, member, isAdmin, members };
}

export function ownerOf(members: Map<string, Member>, playerId: string): string | null {
  for (const [id, m] of members) if (m.roster.includes(playerId)) return id;
  return null;
}
