import { HttpsError } from "firebase-functions/v2/https";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { Caller, given, id, LeagueCtx, loadLeague, memberRef, ownerOf, playerId } from "./access";
import { logTxn } from "./manage";
import { playerNames, positionsOf } from "./players";
import { bankIfDue } from "./standings";

/**
 * Rosters can't change while the draft is running. With `drafted`, they also
 * can't change before it has finished: until then only the commissioner fills
 * squads, so nobody can grab the best players ahead of the draft.
 */
export async function assertRostersOpen(tx: Transaction, ctx: LeagueCtx, opts: { drafted?: boolean } = {}) {
  const d = await tx.get(ctx.ref.collection("draft").doc("state"));
  const status = d.exists ? d.get("status") : null;
  if (status === "live") throw new HttpsError("failed-precondition", "Rosters are locked during the draft.");
  if (opts.drafted && status !== "done") throw new HttpsError("failed-precondition", "Rosters open once the draft is finished.");
}

/** Throws if `size` players would be more than the league allows (0 = no limit). */
export function assertRosterFits(ctx: LeagueCtx, teamName: string, size: number) {
  const limit = ctx.league.rosterLimit || 0;
  if (limit && size > limit)
    throw new HttpsError("failed-precondition", `${teamName} would have ${size} players; the limit is ${limit}. Drop someone first.`);
}

function targetMember(ctx: LeagueCtx, memberId: unknown): string {
  const mid = given(memberId) ? id(memberId, "memberId") : ctx.memberId;
  if (!ctx.members.has(mid)) throw new HttpsError("not-found", "No such team.");
  if (mid !== ctx.memberId && !ctx.isAdmin) throw new HttpsError("permission-denied", "That's not your team.");
  return mid;
}

/**
 * Add a free agent and/or drop a player in one move. In waiver leagues adds go
 * through `submitClaim` instead, except when the commissioner is managing
 * someone else's team; their own adds wait for waivers like everyone's.
 */
export async function addDrop(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; memberId?: unknown; add?: unknown; drop?: unknown;
}, now = new Date()) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const mid = targetMember(ctx, data.memberId);
    const add = given(data.add) ? playerId(data.add, "add") : null;
    const drop = given(data.drop) ? playerId(data.drop, "drop") : null;
    if (!add && !drop) throw new HttpsError("invalid-argument", "Nothing to do.");
    await assertRostersOpen(tx, ctx, { drafted: !!add && !ctx.isAdmin });
    const m = ctx.members.get(mid)!;
    if (add) {
      if (ctx.league.waivers && !(ctx.isAdmin && mid !== ctx.memberId))
        throw new HttpsError("failed-precondition", "This league uses waivers. Put in a claim instead.");
      if (ownerOf(ctx.members, add)) throw new HttpsError("already-exists", "That player is already on a team.");
      await positionsOf(tx, db, [add]);   // validates the player exists
    }
    if (drop && !m.roster.includes(drop)) throw new HttpsError("failed-precondition", "That player isn't on your team.");
    const roster = [...m.roster.filter(p => p !== drop), ...(add ? [add] : [])];
    if (add) assertRosterFits(ctx, m.teamName, roster.length);   // a plain drop is always allowed
    const names = await playerNames(tx, db, [add, drop].filter(Boolean) as string[]);
    await bankIfDue(tx, db, ctx, now);
    tx.update(memberRef(db, ctx.ref.id, mid), { roster });
    if (add) logTxn(tx, ctx.ref, `${m.teamName} signed ${names[add]}` + (drop ? `, dropped ${names[drop]}` : ""));
    else logTxn(tx, ctx.ref, `${m.teamName} dropped ${names[drop!]}`);
  });
  return { ok: true };
}

export async function submitClaim(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; memberId?: unknown; playerId?: unknown; drop?: unknown;
}) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const mid = targetMember(ctx, data.memberId);
    const pid = playerId(data.playerId, "playerId");
    const drop = given(data.drop) ? playerId(data.drop, "drop") : null;
    await assertRostersOpen(tx, ctx, { drafted: true });
    if (!ctx.league.waivers) throw new HttpsError("failed-precondition", "This league doesn't use waivers.");
    if (ownerOf(ctx.members, pid)) throw new HttpsError("already-exists", "That player is already on a team.");
    if (drop && !ctx.members.get(mid)!.roster.includes(drop))
      throw new HttpsError("failed-precondition", "That player isn't on your team.");
    const dupes = await tx.get(ctx.ref.collection("waivers")
      .where("memberId", "==", mid).where("playerId", "==", pid));
    if (!dupes.empty) throw new HttpsError("already-exists", "You've already claimed that player.");
    await positionsOf(tx, db, [pid]);
    const ref = ctx.ref.collection("waivers").doc();
    tx.create(ref, { memberId: mid, playerId: pid, drop, ts: FieldValue.serverTimestamp() });
    return { claimId: ref.id };
  });
}

export async function cancelClaim(db: Firestore, caller: Caller, data: { leagueId?: unknown; claimId?: unknown }) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const ref = ctx.ref.collection("waivers").doc(id(data.claimId, "claimId"));
    const c = await tx.get(ref);
    if (!c.exists) return;
    if (c.get("memberId") !== ctx.memberId && !ctx.isAdmin) throw new HttpsError("permission-denied", "That's not your claim.");
    tx.delete(ref);
  });
  return { ok: true };
}
