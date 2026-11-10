import { HttpsError } from "firebase-functions/v2/https";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { DraftState, POSITIONS, Position } from "../core/types";
import { draftTotalPicks, quotaBlocked, snakePick } from "../core/league-logic";
import { Caller, given, idList, int, loadLeague, memberRef, ownerOf, playerId } from "./access";
import { logTxn } from "./manage";
import { playerNames, positionsOf } from "./players";
import { bankIfDue } from "./standings";

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
    if (given(data.order)) {
      const o = idList(data.order, "order", 20);
      if (o.length !== ids.length || o.some(id => !ctx.members.has(id)))
        throw new HttpsError("invalid-argument", "Draft order must list every team once.");
      order = o;
    }
    let rounds = prev?.rounds ?? 15;
    if (given(data.rounds)) rounds = int(data.rounds, "Rounds", 1, 30);
    const quotas = { ...(prev?.quotas ?? DEFAULT_QUOTAS) };
    if (given(data.quotas)) {
      const q = data.quotas as Record<string, unknown>;
      if (typeof q !== "object" || Array.isArray(q)) throw new HttpsError("invalid-argument", "Bad position limits.");
      for (const p of POSITIONS) if (given(q[p])) quotas[p] = int(q[p], `Limit for ${p}`, 0, 30);
    }
    if (POSITIONS.every(p => quotas[p] > 0) && POSITIONS.reduce((t, p) => t + quotas[p], 0) < rounds)
      throw new HttpsError("invalid-argument", "Position limits add up to fewer players than there are rounds.");
    const next: DraftState = { status: "setup", order, rounds, quotas, picks: [] };
    tx.set(ref, next);
  });
  return { ok: true };
}

/**
 * Squads must be empty so every team starts level and nobody already holds a
 * player the draft would hand out again. `startedAtGw` remembers where scoring
 * stood, so a reset can tell whether these squads have earned points yet.
 */
export async function startDraft(db: Firestore, caller: Caller, data: { leagueId?: unknown }, now = new Date()) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const ref = draftRef(db, ctx.ref.id);
    const cur = await tx.get(ref);
    if (!cur.exists || cur.get("status") !== "setup") throw new HttpsError("failed-precondition", "Set up the draft first.");
    const d = cur.data() as DraftState;
    if (d.order.length < 2 || d.order.some(id => !ctx.members.has(id)) || d.order.length !== ctx.members.size)
      throw new HttpsError("failed-precondition", "The draft order is out of date; save it again.");
    if ([...ctx.members.values()].some(m => m.roster.length))
      throw new HttpsError("failed-precondition", "Every squad must be empty before the draft starts. Reset the draft to clear them.");
    await bankIfDue(tx, db, ctx, now);
    tx.update(ref, { status: "live", startedAtGw: ctx.league.bankedGw || 0 });
    logTxn(tx, ctx.ref, "The draft has started");
  });
  return { ok: true };
}

/**
 * Commissioner wipes the draft, and every roster with it, back to setup. Not
 * once a deadline has been banked with the drafted squads: wiping them then
 * would leave the season's points pointing at teams that no longer exist.
 */
export async function resetDraft(db: Firestore, caller: Caller, data: { leagueId?: unknown }, now = new Date()) {
  await db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    const ref = draftRef(db, ctx.ref.id);
    const cur = await tx.get(ref);
    if (!cur.exists) return;
    const startedAtGw = cur.get("startedAtGw");
    await bankIfDue(tx, db, ctx, now);   // a deadline that has just passed counts, even if the sync hasn't run
    if (typeof startedAtGw === "number" && (ctx.league.bankedGw || 0) > startedAtGw)
      throw new HttpsError("failed-precondition", "Points have already been scored with these squads.");
    for (const id of ctx.members.keys()) tx.update(memberRef(db, ctx.ref.id, id), { roster: [] });
    tx.update(ref, { status: "setup", picks: [], startedAtGw: FieldValue.delete() });
    logTxn(tx, ctx.ref, "The draft was reset");
  });
  return { ok: true };
}

/**
 * Make the current pick. The team on the clock picks; the commissioner can pick
 * for anyone. Clients send `pick`, the number they believe is on the clock, so
 * a double tap or a stale screen can't spend the next pick by accident.
 */
export async function makePick(db: Firestore, caller: Caller,
                               data: { leagueId?: unknown; playerId?: unknown; pick?: unknown }, now = new Date()) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const ref = draftRef(db, ctx.ref.id);
    const cur = await tx.get(ref);
    if (!cur.exists || cur.get("status") !== "live") throw new HttpsError("failed-precondition", "The draft isn't live.");
    const d = cur.data() as DraftState;
    const n = d.picks.length;
    const pid = playerId(data.playerId, "playerId");
    if (given(data.pick) && int(data.pick, "pick", 1, 1000) !== n + 1)
      throw new HttpsError("aborted", "That pick has already been made.");
    const { memberId } = snakePick(d.order, n);
    const picker = memberId ? ctx.members.get(memberId) : undefined;
    if (!picker) throw new HttpsError("failed-precondition", "The team on the clock is no longer in the league. Reset the draft.");
    if (memberId !== ctx.memberId && !ctx.isAdmin) throw new HttpsError("permission-denied", "It's not your pick.");
    if (ownerOf(ctx.members, pid)) throw new HttpsError("already-exists", "That player has been taken.");
    const positions = await positionsOf(tx, db, [...picker.roster, pid]);
    if (quotaBlocked(d.quotas, picker.roster, positions, positions[pid]))
      throw new HttpsError("failed-precondition", `${picker.teamName} is full at ${positions[pid]}.`);
    const names = await playerNames(tx, db, [pid]);

    const picks = [...d.picks, { memberId, playerId: pid }];
    const done = picks.length >= draftTotalPicks(d);
    await bankIfDue(tx, db, ctx, now);
    tx.update(memberRef(db, ctx.ref.id, memberId), { roster: [...picker.roster, pid] });
    tx.update(ref, { picks, ...(done ? { status: "done" } : {}) });
    // Squads stay the size they were drafted at unless the commissioner changes it.
    if (done) tx.update(ctx.ref, { rosterLimit: d.rounds });
    logTxn(tx, ctx.ref, `Draft pick ${n + 1}: ${picker.teamName} took ${names[pid]}`);
    if (done) logTxn(tx, ctx.ref, "The draft is complete");
    return { pick: n + 1, done };
  });
}
