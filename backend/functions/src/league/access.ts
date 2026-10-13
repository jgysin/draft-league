import { HttpsError } from "firebase-functions/v2/https";
import type { DocumentReference, Firestore, Transaction } from "firebase-admin/firestore";
import { League, Member } from "../core/types";

export const leagueRef = (db: Firestore, leagueId: string) => db.collection("leagues").doc(leagueId);
export const memberRef = (db: Firestore, leagueId: string, memberId: string) =>
  leagueRef(db, leagueId).collection("members").doc(memberId);

export interface Caller { uid: string; email: string | null }

export function requireAuth(auth: { uid: string; token: { email?: string; email_verified?: boolean } } | undefined): Caller {
  if (!auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const email = auth.token.email && auth.token.email_verified !== false ? auth.token.email.toLowerCase() : null;
  return { uid: auth.uid, email };
}

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpsError("invalid-argument", `${field} is required.`);
  if (v.length > max) throw new HttpsError("invalid-argument", `${field} is too long.`);
  return v.trim();
}

export function strList(v: unknown, field: string, max = 30): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== "string") || v.length > max)
    throw new HttpsError("invalid-argument", `${field} must be a list of ids.`);
  return [...new Set(v as string[])];
}

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
  const id = str(leagueId, "leagueId", 64);
  const ref = leagueRef(db, id);
  const [snap, membersSnap] = await Promise.all([tx.get(ref), tx.get(ref.collection("members"))]);
  if (!snap.exists) throw new HttpsError("not-found", "League not found.");
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
