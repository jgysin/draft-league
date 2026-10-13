import { HttpsError } from "firebase-functions/v2/https";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { Caller, LeagueCtx, loadLeague, memberRef, ownerOf, str } from "./access";
import { logTxn } from "./manage";
import { playerNames, positionsOf } from "./players";

/** Rosters can't change while the draft is running. */
export async function assertRostersOpen(tx: Transaction, ctx: LeagueCtx) {
  const d = await tx.get(ctx.ref.collection("draft").doc("state"));
  if (d.exists && d.get("status") === "live") throw new HttpsError("failed-precondition", "Rosters are locked during the draft.");
}

function targetMember(ctx: LeagueCtx, memberId: unknown): string {
  const id = memberId === undefined ? ctx.memberId : str(memberId, "memberId", 64);
  if (!ctx.members.has(id)) throw new HttpsError("not-found", "No such team.");
  if (id !== ctx.memberId && !ctx.isAdmin) throw new HttpsError("permission-denied", "That's not your team.");
  return id;
}

/**
 * Add a free agent and/or drop a player in one move. In waiver leagues adds go
 * through `submitClaim` instead, except when the commissioner makes them.
 */
export async function addDrop(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; memberId?: unknown; add?: unknown; drop?: unknown;
}) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const mid = targetMember(ctx, data.memberId);
    await assertRostersOpen(tx, ctx);
    const add = data.add ? str(data.add, "add", 20) : null;
    const drop = data.drop ? str(data.drop, "drop", 20) : null;
    if (!add && !drop) throw new HttpsError("invalid-argument", "Nothing to do.");
    const m = ctx.members.get(mid)!;
    if (add) {
      if (ctx.league.waivers && !ctx.isAdmin)
        throw new HttpsError("failed-precondition", "This league uses waivers. Put in a claim instead.");
      if (ownerOf(ctx.members, add)) throw new HttpsError("already-exists", "That player is already on a team.");
      await positionsOf(tx, db, [add]);   // validates the player exists
    }
    if (drop && !m.roster.includes(drop)) throw new HttpsError("failed-precondition", "That player isn't on your team.");
    const names = await playerNames(tx, db, [add, drop].filter(Boolean) as string[]);
    const roster = [...m.roster.filter(p => p !== drop), ...(add ? [add] : [])];
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
    await assertRostersOpen(tx, ctx);
    if (!ctx.league.waivers) throw new HttpsError("failed-precondition", "This league doesn't use waivers.");
    const pid = str(data.playerId, "playerId", 20);
    const drop = data.drop ? str(data.drop, "drop", 20) : null;
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
    const ref = ctx.ref.collection("waivers").doc(str(data.claimId, "claimId", 64));
    const c = await tx.get(ref);
    if (!c.exists) return;
    if (c.get("memberId") !== ctx.memberId && !ctx.isAdmin) throw new HttpsError("permission-denied", "That's not your claim.");
    tx.delete(ref);
  });
  return { ok: true };
}
