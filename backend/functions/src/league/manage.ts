import { HttpsError } from "firebase-functions/v2/https";
import type { Firestore, Transaction, DocumentReference } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { DEFAULT_SCORING, League, Role, Scoring } from "../core/types";
import { newInviteCode, roundRobin, seasonFor } from "../core/league-logic";
import { passedDeadlines } from "../fpl/parse";
import { Caller, leagueRef, loadLeague, memberRef, str } from "./access";

export const MAX_MEMBERS = 20;

export function logTxn(tx: Transaction, league: DocumentReference, text: string) {
  tx.create(league.collection("txns").doc(), { ts: FieldValue.serverTimestamp(), text });
}

async function reserveInviteCode(tx: Transaction, db: Firestore, leagueId: string): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = newInviteCode();
    const ref = db.collection("inviteCodes").doc(code);
    if (!(await tx.get(ref)).exists) { tx.create(ref, { leagueId }); return code; }
  }
  throw new HttpsError("resource-exhausted", "Couldn't allocate an invite code, try again.");
}

/** The gameweek a new league starts scoring from: the next deadline still to come. */
async function currentBankedGw(db: Firestore, now: Date): Promise<number> {
  const cur = await db.collection("fpl").doc("current").get();
  const events = cur.exists ? cur.get("events") || [] : [];
  const passed = passedDeadlines(events, now);
  return passed.length ? passed[passed.length - 1] : 0;
}

export async function createLeague(db: Firestore, caller: Caller, data: { name?: unknown; teamName?: unknown },
                                   now = new Date()) {
  const name = str(data.name, "League name", 60);
  const teamName = str(data.teamName, "Team name", 40);
  const ref = db.collection("leagues").doc();
  const bankedGw = await currentBankedGw(db, now);
  const inviteCode = await db.runTransaction(async tx => {
    const code = await reserveInviteCode(tx, db, ref.id);
    const league: Omit<League, "createdAt"> & { createdAt: FieldValue } = {
      name, season: seasonFor(now), inviteCode: code,
      memberUids: [caller.uid], scoring: DEFAULT_SCORING, h2h: false, waivers: false,
      bankedGw, createdAt: FieldValue.serverTimestamp(),
    };
    tx.create(ref, league);
    tx.create(ref.collection("members").doc(), {
      teamName, uid: caller.uid, email: caller.email, role: "owner", roster: [],
      joinedAt: FieldValue.serverTimestamp(),
    });
    return code;
  });
  return { leagueId: ref.id, inviteCode };
}

export async function joinLeague(db: Firestore, caller: Caller, data: { code?: unknown; teamName?: unknown }) {
  const code = str(data.code, "Invite code", 12).toUpperCase();
  const invite = await db.collection("inviteCodes").doc(code).get();
  if (!invite.exists) throw new HttpsError("not-found", "That invite code doesn't match a league.");
  const leagueId = invite.get("leagueId") as string;
  const ref = leagueRef(db, leagueId);
  return db.runTransaction(async tx => {
    const [league, members, draft] = await Promise.all([
      tx.get(ref), tx.get(ref.collection("members")), tx.get(ref.collection("draft").doc("state"))]);
    if (!league.exists || league.get("inviteCode") !== code)
      throw new HttpsError("not-found", "That invite code has expired.");
    const existing = members.docs.find(d => d.get("uid") === caller.uid);
    if (existing) return { leagueId, memberId: existing.id };
    const slot = caller.email && members.docs.find(d => !d.get("uid") && d.get("email") === caller.email);
    let memberId: string;
    if (slot) {
      tx.update(slot.ref, { uid: caller.uid, joinedAt: FieldValue.serverTimestamp() });
      memberId = slot.id;
    } else {
      if (draft.exists && draft.get("status") === "live")
        throw new HttpsError("failed-precondition", "The draft is in progress. Join once it's finished.");
      if (members.size >= MAX_MEMBERS) throw new HttpsError("resource-exhausted", "This league is full.");
      const teamName = str(data.teamName, "Team name", 40);
      const mref = ref.collection("members").doc();
      tx.create(mref, { teamName, uid: caller.uid, email: caller.email, role: "member", roster: [],
                        joinedAt: FieldValue.serverTimestamp() });
      memberId = mref.id;
      logTxn(tx, ref, `${teamName} joined the league`);
    }
    tx.update(ref, { memberUids: FieldValue.arrayUnion(caller.uid) });
    return { leagueId, memberId };
  });
}

/**
 * Claim every unclaimed team slot whose email matches the caller's verified
 * email. This is how friends land in a migrated league just by signing in.
 */
export async function claimSlots(db: Firestore, caller: Caller) {
  if (!caller.email) return { claimed: [] as string[] };
  const slots = await db.collectionGroup("members")
    .where("email", "==", caller.email).where("uid", "==", null).get();
  const claimed: string[] = [];
  for (const slot of slots.docs) {
    const league = slot.ref.parent.parent!;
    const ok = await db.runTransaction(async tx => {
      const [fresh, others] = await Promise.all([
        tx.get(slot.ref), tx.get(league.collection("members").where("uid", "==", caller.uid))]);
      if (!fresh.exists || fresh.get("uid") || !others.empty) return false;
      tx.update(slot.ref, { uid: caller.uid, joinedAt: FieldValue.serverTimestamp() });
      tx.update(league, { memberUids: FieldValue.arrayUnion(caller.uid) });
      return true;
    });
    if (ok) claimed.push(league.id);
  }
  return { claimed };
}

const SCORING_KEYS = Object.keys(DEFAULT_SCORING) as (keyof Scoring)[];

export async function updateLeague(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; name?: unknown; scoring?: unknown; h2h?: unknown; waivers?: unknown;
}) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = str(data.name, "League name", 60);
    if (data.h2h !== undefined) patch.h2h = !!data.h2h;
    if (data.waivers !== undefined) patch.waivers = !!data.waivers;
    if (data.scoring !== undefined) {
      const s = data.scoring as Record<string, unknown>;
      if (!s || typeof s !== "object") throw new HttpsError("invalid-argument", "Bad scoring.");
      const next = { ...ctx.league.scoring };
      for (const k of SCORING_KEYS) if (k in s) {
        const v = Number(s[k]);
        if (!Number.isFinite(v) || Math.abs(v) > 50) throw new HttpsError("invalid-argument", `Bad value for ${k}.`);
        next[k] = v;
      }
      patch.scoring = next;
    }
    if (Object.keys(patch).length) tx.update(ctx.ref, patch);
  });
  return { ok: true };
}

/** Commissioner creates an empty team slot, optionally reserved for an email. */
export async function addSlot(db: Firestore, caller: Caller, data: { leagueId?: unknown; teamName?: unknown; email?: unknown }) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    if (ctx.members.size >= MAX_MEMBERS) throw new HttpsError("resource-exhausted", "This league is full.");
    const teamName = str(data.teamName, "Team name", 40);
    const email = data.email ? str(data.email, "Email", 200).toLowerCase() : null;
    const ref = ctx.ref.collection("members").doc();
    tx.create(ref, { teamName, uid: null, email, role: "member", roster: [], joinedAt: null });
    return { memberId: ref.id };
  });
}

export async function updateMember(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; memberId?: unknown; teamName?: unknown; email?: unknown; role?: unknown;
}) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const targetId = str(data.memberId, "memberId", 64);
    const target = ctx.members.get(targetId);
    if (!target) throw new HttpsError("not-found", "No such team.");
    const self = targetId === ctx.memberId;
    if (!self && !ctx.isAdmin) throw new HttpsError("permission-denied", "Only the commissioner can edit other teams.");
    const patch: Record<string, unknown> = {};
    if (data.teamName !== undefined) patch.teamName = str(data.teamName, "Team name", 40);
    if (data.email !== undefined) {
      if (!ctx.isAdmin) throw new HttpsError("permission-denied", "Only the commissioner can assign emails.");
      if (target.uid) throw new HttpsError("failed-precondition", "That team is already claimed.");
      patch.email = data.email ? str(data.email, "Email", 200).toLowerCase() : null;
    }
    if (data.role !== undefined) {
      const role = data.role as Role;
      if (!ctx.isAdmin || role === "owner" || !["admin", "member"].includes(role))
        throw new HttpsError("permission-denied", "Can't set that role.");
      if (target.role === "owner") throw new HttpsError("failed-precondition", "The owner's role can't change.");
      patch.role = role;
    }
    if (Object.keys(patch).length) tx.update(memberRef(db, ctx.ref.id, targetId), patch);
  });
  return { ok: true };
}

export async function removeMember(db: Firestore, caller: Caller, data: { leagueId?: unknown; memberId?: unknown }) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const targetId = str(data.memberId, "memberId", 64);
    const target = ctx.members.get(targetId);
    if (!target) throw new HttpsError("not-found", "No such team.");
    if (target.role === "owner") throw new HttpsError("failed-precondition", "The owner can't be removed.");
    tx.delete(memberRef(db, ctx.ref.id, targetId));
    if (target.uid) tx.update(ctx.ref, { memberUids: FieldValue.arrayRemove(target.uid) });
    logTxn(tx, ctx.ref, `${target.teamName} was removed from the league`);
  });
  return { ok: true };
}

export async function rotateInvite(db: Firestore, caller: Caller, data: { leagueId?: unknown }) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const code = await reserveInviteCode(tx, db, ctx.ref.id);
    tx.delete(db.collection("inviteCodes").doc(ctx.league.inviteCode));
    tx.update(ctx.ref, { inviteCode: code });
    return { inviteCode: code };
  });
}

export async function generateSchedule(db: Firestore, caller: Caller, data: { leagueId?: unknown }) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    if (ctx.members.size < 2) throw new HttpsError("failed-precondition", "Need at least 2 teams.");
    const sched = roundRobin([...ctx.members.keys()]);
    // Firestore can't store nested arrays, so pairs are stored as "a|b" strings.
    const stored = Object.fromEntries(Object.entries(sched).map(([gw, ps]) => [gw, ps.map(p => p.join("|"))]));
    tx.set(ctx.ref.collection("meta").doc("schedule"), stored);
    tx.update(ctx.ref, { h2h: true });
  });
  return { ok: true };
}

export async function setNickname(db: Firestore, caller: Caller, data: { leagueId?: unknown; playerId?: unknown; nickname?: unknown }) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const pid = str(data.playerId, "playerId", 20);
    const nick = typeof data.nickname === "string" ? data.nickname.trim().slice(0, 40) : "";
    tx.set(ctx.ref.collection("meta").doc("nicknames"),
           { [pid]: nick || FieldValue.delete() }, { merge: true });
  });
  return { ok: true };
}
