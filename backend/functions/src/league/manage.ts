import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import type { Firestore, Transaction, DocumentReference } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { DEFAULT_SCORING, DraftState, League, Role, Scoring, Slot } from "../core/types";
import { INVITE_CODE_RE, newInviteCode, roundRobin } from "../core/league-logic";
import { passedDeadlines } from "../fpl/parse";
import { bool, Caller, email as emailArg, given, id, int, leagueRef, LeagueCtx, loadLeague, memberRef, playerId, str } from "./access";
import { positionsOf } from "./players";
import { applyBank, currentRef, dueGameweeks } from "./standings";

export const MAX_MEMBERS = 20;
export const MAX_LEAGUES_PER_USER = 10;

export function logTxn(tx: Transaction, league: DocumentReference, text: string) {
  tx.create(league.collection("txns").doc(), { ts: FieldValue.serverTimestamp(), text });
}

export const slotRef = (league: DocumentReference, memberId: string) => league.collection("slots").doc(memberId);
const draftRef = (league: DocumentReference) => league.collection("draft").doc("state");

/** Reads until it finds a free code, then writes it: call it after the transaction's other reads. */
export async function reserveInviteCode(tx: Transaction, db: Firestore, leagueId: string): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = newInviteCode();
    const ref = db.collection("inviteCodes").doc(code);
    if (!(await tx.get(ref)).exists) { tx.create(ref, { leagueId }); return code; }
  }
  throw new HttpsError("resource-exhausted", "Couldn't allocate an invite code, try again.");
}

/** Swap the league's invite code for a fresh one, so the old one stops working. */
async function rotateCode(tx: Transaction, db: Firestore, ctx: LeagueCtx): Promise<string> {
  const code = await reserveInviteCode(tx, db, ctx.ref.id);
  tx.delete(db.collection("inviteCodes").doc(ctx.league.inviteCode));
  tx.update(ctx.ref, { inviteCode: code });
  return code;
}

/**
 * The season and the starting gameweek both come from fpl/current, read in the
 * transaction, so a league can never be created against a season the sync
 * doesn't know or miss a deadline that passes while it is being created. A
 * league created mid-season starts scoring from the next deadline.
 */
export async function createLeague(db: Firestore, caller: Caller, data: { name?: unknown; teamName?: unknown },
                                   now = new Date()) {
  const name = str(data.name, "League name", 60);
  const teamName = str(data.teamName, "Team name", 40);
  const ref = db.collection("leagues").doc();
  const inviteCode = await db.runTransaction(async tx => {
    const [cur, mine] = await Promise.all([tx.get(currentRef(db)),
      tx.get(db.collection("leagues").where("memberUids", "array-contains", caller.uid).count())]);
    if (!cur.exists || typeof cur.get("season") !== "string")
      throw new HttpsError("unavailable", "Player data is still loading. Try again in a few minutes.");
    if (mine.data().count >= MAX_LEAGUES_PER_USER)
      throw new HttpsError("resource-exhausted", `You can be in at most ${MAX_LEAGUES_PER_USER} leagues.`);
    const passed = passedDeadlines(cur.get("events"), now);
    const code = await reserveInviteCode(tx, db, ref.id);
    const league: Omit<League, "createdAt"> & { createdAt: FieldValue } = {
      name, season: cur.get("season"), inviteCode: code,
      memberUids: [caller.uid], scoring: DEFAULT_SCORING, h2h: false, waivers: false,
      bankedGw: passed.length ? passed[passed.length - 1] : 0, rosterLimit: 0,
      createdAt: FieldValue.serverTimestamp(),
    };
    tx.create(ref, league);
    tx.create(ref.collection("members").doc(), {
      teamName, uid: caller.uid, role: "owner", roster: [], joinedAt: FieldValue.serverTimestamp(),
    });
    return code;
  });
  return { leagueId: ref.id, inviteCode };
}

/**
 * Join with an invite code. In order: a team reserved for the caller's verified
 * email is claimed; else, if `memberId` names an unclaimed team that isn't
 * reserved for anyone, that one is claimed (teams the commissioner set up for
 * people to pick, and the way in for emails that can't match, such as Apple's
 * private relay); else a new team is created from `teamName`.
 */
export async function joinLeague(db: Firestore, caller: Caller,
                                 data: { code?: unknown; teamName?: unknown; memberId?: unknown }) {
  const code = str(data.code, "Invite code", 40).toUpperCase();
  const wanted = given(data.memberId) ? id(data.memberId, "memberId") : null;
  const noLeague = () => new HttpsError("not-found", "That invite code doesn't match a league.");
  if (!INVITE_CODE_RE.test(code)) throw noLeague();
  const invite = await db.collection("inviteCodes").doc(code).get();
  if (!invite.exists) throw noLeague();
  const leagueId = invite.get("leagueId") as string;
  const ref = leagueRef(db, leagueId);
  return db.runTransaction(async tx => {
    const [league, members, draft, slots] = await Promise.all([
      tx.get(ref), tx.get(ref.collection("members")), tx.get(draftRef(ref)), tx.get(ref.collection("slots"))]);
    if (!league.exists || league.get("migrating") || league.get("inviteCode") !== code)
      throw new HttpsError("not-found", "That invite code has expired.");
    const existing = members.docs.find(d => d.get("uid") === caller.uid);
    if (existing) return { leagueId, memberId: existing.id };
    const reserved = new Map(slots.docs.map(d => [d.id, (d.data() as Slot).email]));
    let slot = caller.email ? members.docs.find(d => !d.get("uid") && reserved.get(d.id) === caller.email) : undefined;
    if (!slot && wanted) {
      slot = members.docs.find(d => d.id === wanted);
      if (!slot) throw new HttpsError("not-found", "No such team.");
      if (slot.get("uid")) throw new HttpsError("already-exists", "Someone has already taken that team.");
      if (reserved.has(wanted)) throw new HttpsError("permission-denied", "That team is reserved for someone else.");
    }
    let memberId: string;
    if (slot) {
      tx.update(slot.ref, { uid: caller.uid, joinedAt: FieldValue.serverTimestamp() });
      tx.delete(slotRef(ref, slot.id));
      memberId = slot.id;
    } else {
      if (draft.exists && draft.get("status") === "live")
        throw new HttpsError("failed-precondition", "The draft is in progress. Join once it's finished.");
      if (members.size >= MAX_MEMBERS) throw new HttpsError("resource-exhausted", "This league is full.");
      const teamName = str(data.teamName, "Team name", 40);
      const mref = ref.collection("members").doc();
      tx.create(mref, { teamName, uid: caller.uid, role: "member", roster: [], joinedAt: FieldValue.serverTimestamp() });
      memberId = mref.id;
      logTxn(tx, ref, `${teamName} joined the league`);
    }
    tx.update(ref, { memberUids: FieldValue.arrayUnion(caller.uid) });
    return { leagueId, memberId };
  });
}

/**
 * Called on every sign-in: claim the teams a migrated league reserved for the
 * caller's verified email (`autoClaim` slots). Slots a commissioner reserved by
 * hand are not claimed here; otherwise anyone could pull a stranger into their
 * league just by typing their email. Those are claimed when the person joins
 * with the invite code.
 */
export async function claimSlots(db: Firestore, caller: Caller) {
  const claimed: string[] = [];
  if (!caller.email) return { claimed };
  const slots = await db.collectionGroup("slots")
    .where("email", "==", caller.email).where("autoClaim", "==", true).get();
  for (const slot of slots.docs) {
    const league = slot.ref.parent.parent;
    if (!league || league.parent.id !== "leagues") continue;
    try {
      const member = league.collection("members").doc(slot.id);
      const ok = await db.runTransaction(async tx => {
        const [l, m, s, mine] = await Promise.all([tx.get(league), tx.get(member), tx.get(slot.ref),
          tx.get(league.collection("members").where("uid", "==", caller.uid))]);
        if (!l.exists || l.get("migrating") || !m.exists || m.get("uid") || !mine.empty) return false;
        if (s.get("email") !== caller.email || s.get("autoClaim") !== true) return false;
        tx.update(member, { uid: caller.uid, joinedAt: FieldValue.serverTimestamp() });
        tx.update(league, { memberUids: FieldValue.arrayUnion(caller.uid) });
        tx.delete(slot.ref);
        return true;
      });
      if (ok) claimed.push(league.id);
    } catch (e) {
      logger.warn(`claimSlots: skipped ${slot.ref.path}`, e);
    }
  }
  return { claimed };
}

const SCORING_KEYS = Object.keys(DEFAULT_SCORING) as (keyof Scoring)[];

export async function updateLeague(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; name?: unknown; scoring?: unknown; h2h?: unknown; waivers?: unknown; rosterLimit?: unknown;
}) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const patch: Record<string, unknown> = {};
    if (given(data.name)) patch.name = str(data.name, "League name", 60);
    if (given(data.h2h)) patch.h2h = bool(data.h2h, "h2h");
    if (given(data.waivers)) patch.waivers = bool(data.waivers, "waivers");
    if (given(data.rosterLimit)) patch.rosterLimit = int(data.rosterLimit, "Squad size", 0, 40);
    if (given(data.scoring)) {
      const s = data.scoring as Record<string, unknown>;
      if (typeof s !== "object" || Array.isArray(s)) throw new HttpsError("invalid-argument", "Bad scoring.");
      const next = { ...ctx.league.scoring };
      for (const k of SCORING_KEYS) if (given(s[k])) {
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

async function draftStatus(tx: Transaction, ctx: LeagueCtx): Promise<DraftState | null> {
  const d = await tx.get(draftRef(ctx.ref));
  return d.exists ? d.data() as DraftState : null;
}

/** Commissioner creates an empty team slot, optionally reserved for an email. */
export async function addSlot(db: Firestore, caller: Caller, data: { leagueId?: unknown; teamName?: unknown; email?: unknown }) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    if ((await draftStatus(tx, ctx))?.status === "live")
      throw new HttpsError("failed-precondition", "Teams can't be added during the draft.");
    if (ctx.members.size >= MAX_MEMBERS) throw new HttpsError("resource-exhausted", "This league is full.");
    const teamName = str(data.teamName, "Team name", 40);
    const email = given(data.email) && data.email !== "" ? emailArg(data.email) : null;
    const ref = ctx.ref.collection("members").doc();
    tx.create(ref, { teamName, uid: null, role: "member", roster: [], joinedAt: null });
    if (email) tx.create(slotRef(ctx.ref, ref.id), { email, autoClaim: false } satisfies Slot);
    return { memberId: ref.id };
  });
}

/** `email: ""` clears a reservation; null or a missing field leaves it alone. */
export async function updateMember(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; memberId?: unknown; teamName?: unknown; email?: unknown; role?: unknown;
}) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const targetId = id(data.memberId, "memberId");
    const target = ctx.members.get(targetId);
    if (!target) throw new HttpsError("not-found", "No such team.");
    const self = targetId === ctx.memberId;
    if (!self && !ctx.isAdmin) throw new HttpsError("permission-denied", "Only the commissioner can edit other teams.");
    const patch: Record<string, unknown> = {};
    if (given(data.teamName)) patch.teamName = str(data.teamName, "Team name", 40);
    if (given(data.email)) {
      if (!ctx.isAdmin) throw new HttpsError("permission-denied", "Only the commissioner can assign emails.");
      if (target.uid) throw new HttpsError("failed-precondition", "That team is already claimed.");
      if (data.email === "") tx.delete(slotRef(ctx.ref, targetId));
      else tx.set(slotRef(ctx.ref, targetId), { email: emailArg(data.email), autoClaim: false } satisfies Slot);
    }
    if (given(data.role)) {
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

/**
 * Removing a team also retires the invite code, so the person can't simply
 * walk back in with it. Not allowed mid-draft: the pick order depends on it.
 */
export async function removeMember(db: Firestore, caller: Caller, data: { leagueId?: unknown; memberId?: unknown },
                                   now = new Date()) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const targetId = id(data.memberId, "memberId");
    const target = ctx.members.get(targetId);
    if (!target) throw new HttpsError("not-found", "No such team.");
    if (target.role === "owner") throw new HttpsError("failed-precondition", "The owner can't be removed.");
    const draft = await draftStatus(tx, ctx);
    if (draft?.status === "live") throw new HttpsError("failed-precondition", "Teams can't be removed during the draft.");
    // If a deadline has just passed, the departing squad still scores for that gameweek.
    const due = await dueGameweeks(tx, db, ctx, now);
    const inviteCode = await rotateCode(tx, db, ctx);
    applyBank(tx, ctx, due);
    tx.delete(memberRef(db, ctx.ref.id, targetId));
    tx.delete(slotRef(ctx.ref, targetId));
    if (draft?.status === "setup" && Array.isArray(draft.order) && draft.order.includes(targetId))
      tx.update(draftRef(ctx.ref), { order: draft.order.filter(m => m !== targetId) });
    if (target.uid) tx.update(ctx.ref, { memberUids: FieldValue.arrayRemove(target.uid) });
    logTxn(tx, ctx.ref, `${target.teamName} was removed from the league`);
    return { ok: true, inviteCode };
  });
}

export async function rotateInvite(db: Firestore, caller: Caller, data: { leagueId?: unknown }) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    return { inviteCode: await rotateCode(tx, db, ctx) };
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

/** A missing, null or empty nickname clears it. */
export async function setNickname(db: Firestore, caller: Caller, data: { leagueId?: unknown; playerId?: unknown; nickname?: unknown }) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const pid = playerId(data.playerId, "playerId");
    if (given(data.nickname) && typeof data.nickname !== "string")
      throw new HttpsError("invalid-argument", "Nickname must be text.");
    const nick = typeof data.nickname === "string" ? data.nickname.trim().slice(0, 40) : "";
    await positionsOf(tx, db, [pid]);   // only real players get nicknames, so the doc can't be stuffed
    tx.set(ctx.ref.collection("meta").doc("nicknames"),
           { [pid]: nick || FieldValue.delete() }, { merge: true });
  });
  return { ok: true };
}
