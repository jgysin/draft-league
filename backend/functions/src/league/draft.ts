import { HttpsError } from "firebase-functions/v2/https";
import type { Firestore } from "firebase-admin/firestore";
import { DraftState, POSITIONS, Position } from "../core/types";
import { draftTotalPicks, quotaBlocked, snakePick } from "../core/league-logic";
import { Caller, loadLeague, memberRef, ownerOf, str, strList } from "./access";
import { logTxn } from "./manage";
import { playerNames, positionsOf } from "./players";

const draftRef = (db: Firestore, leagueId: string) =>
  db.collection("leagues").doc(leagueId).collection("draft").doc("state");

const DEFAULT_QUOTAS: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };

export async function setupDraft(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; order?: unknown; rounds?: unknown; quotas?: unknown;
}) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const ref = draftRef(db, ctx.ref.id);
    const cur = await tx.get(ref);
    const prev = cur.exists ? cur.data() as DraftState : null;
    if (prev && prev.status !== "setup") throw new HttpsError("failed-precondition", "The draft has already started.");

    const ids = [...ctx.members.keys()];
    let order = prev?.order.filter(id => ctx.members.has(id)) ?? ids;
    order = [...order, ...ids.filter(id => !order.includes(id))];
    if (data.order !== undefined) {
      const o = strList(data.order, "order", 20);
      if (o.length !== ids.length || o.some(id => !ctx.members.has(id)))
        throw new HttpsError("invalid-argument", "Draft order must list every team once.");
      order = o;
    }
    let rounds = prev?.rounds ?? 15;
    if (data.rounds !== undefined) {
      rounds = Number(data.rounds);
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30) throw new HttpsError("invalid-argument", "Rounds must be 1 to 30.");
    }
    const quotas = { ...(prev?.quotas ?? DEFAULT_QUOTAS) };
    if (data.quotas !== undefined) {
      const q = data.quotas as Record<string, unknown>;
      for (const p of POSITIONS) if (q && p in q) {
        const v = Number(q[p]);
        if (!Number.isInteger(v) || v < 0 || v > 30) throw new HttpsError("invalid-argument", `Bad quota for ${p}.`);
        quotas[p] = v;
      }
    }
    if (POSITIONS.every(p => quotas[p] > 0) && POSITIONS.reduce((t, p) => t + quotas[p], 0) < rounds)
      throw new HttpsError("invalid-argument", "Position limits add up to fewer players than there are rounds.");
    const next: DraftState ={ status: "setup", order, rounds, quotas, picks: [] };
    tx.set(ref, next);
  });
  return { ok: true };
}

export async function startDraft(db: Firestore, caller: Caller, data: { leagueId?: unknown }) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const ref = draftRef(db, ctx.ref.id);
    const cur = await tx.get(ref);
    if (!cur.exists || cur.get("status") !== "setup") throw new HttpsError("failed-precondition", "Set up the draft first.");
    const d = cur.data() as DraftState;
    if (d.order.length < 2 || d.order.some(id => !ctx.members.has(id)) || d.order.length !== ctx.members.size)
      throw new HttpsError("failed-precondition", "The draft order is out of date; save it again.");
    tx.update(ref, { status: "live" });
    logTxn(tx, ctx.ref, "The draft has started");
  });
  return { ok: true };
}

/** Commissioner wipes the draft, and every roster with it, back to setup. */
export async function resetDraft(db: Firestore, caller: Caller, data: { leagueId?: unknown }) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const ref = draftRef(db, ctx.ref.id);
    const cur = await tx.get(ref);
    if (!cur.exists) return;
    for (const id of ctx.members.keys()) tx.update(memberRef(db, ctx.ref.id, id), { roster: [] });
    tx.update(ref, { status: "setup", picks: [] });
    logTxn(tx, ctx.ref, "The draft was reset");
  });
  return { ok: true };
}

/** Make the current pick. The team on the clock picks; the commissioner can pick for anyone. */
export async function makePick(db: Firestore, caller: Caller, data: { leagueId?: unknown; playerId?: unknown }) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const ref = draftRef(db, ctx.ref.id);
    const cur = await tx.get(ref);
    if (!cur.exists || cur.get("status") !== "live") throw new HttpsError("failed-precondition", "The draft isn't live.");
    const d = cur.data() as DraftState;
    const n = d.picks.length;
    const { memberId } = snakePick(d.order, n);
    if (memberId !== ctx.memberId && !ctx.isAdmin) throw new HttpsError("permission-denied", "It's not your pick.");
    const pid = str(data.playerId, "playerId", 20);
    if (ownerOf(ctx.members, pid)) throw new HttpsError("already-exists", "That player has been taken.");
    const picker = ctx.members.get(memberId)!;
    const positions = await positionsOf(tx, db, [...picker.roster, pid]);
    if (quotaBlocked(d.quotas, picker.roster, positions, positions[pid]))
      throw new HttpsError("failed-precondition", `${picker.teamName} is full at ${positions[pid]}.`);
    const names = await playerNames(tx, db, [pid]);

    const picks = [...d.picks, { memberId, playerId: pid }];
    const done = picks.length >= draftTotalPicks(d);
    tx.update(memberRef(db, ctx.ref.id, memberId), { roster: [...picker.roster, pid] });
    tx.update(ref, { picks, ...(done ? { status: "done" } : {}) });
    logTxn(tx, ctx.ref, `Draft pick ${n + 1}: ${picker.teamName} took ${names[pid]}`);
    if (done) logTxn(tx, ctx.ref, "The draft is complete");
    return { pick: n + 1, done };
  });
}
