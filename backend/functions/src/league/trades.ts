import { HttpsError } from "firebase-functions/v2/https";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { Trade } from "../core/types";
import { Caller, loadLeague, memberRef, str, strList } from "./access";
import { logTxn } from "./manage";
import { assertRostersOpen } from "./roster";
import { playerNames } from "./players";

export async function proposeTrade(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; to?: unknown; give?: unknown; get?: unknown; note?: unknown;
}) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    await assertRostersOpen(tx, ctx);
    const to = str(data.to, "to", 64);
    const target = ctx.members.get(to);
    if (!target || to === ctx.memberId) throw new HttpsError("invalid-argument", "Pick another team to trade with.");
    const give = strList(data.give ?? [], "give");
    const get = strList(data.get ?? [], "get");
    if (!give.length && !get.length) throw new HttpsError("invalid-argument", "A trade needs at least one player.");
    if (!give.every(p => ctx.member.roster.includes(p))) throw new HttpsError("failed-precondition", "You can only offer your own players.");
    if (!get.every(p => target.roster.includes(p))) throw new HttpsError("failed-precondition", "You can only ask for their players.");
    const note = typeof data.note === "string" ? data.note.trim().slice(0, 280) : "";
    const ref = ctx.ref.collection("trades").doc();
    tx.create(ref, { from: ctx.memberId, to, give, get, note, status: "open", ts: FieldValue.serverTimestamp() });
    return { tradeId: ref.id };
  });
}

type TradeAction = "accept" | "reject" | "cancel" | "veto";

export async function respondTrade(db: Firestore, caller: Caller, data: {
  leagueId?: unknown; tradeId?: unknown; action?: unknown;
}) {
  const action = data.action as TradeAction;
  if (!["accept", "reject", "cancel", "veto"].includes(action)) throw new HttpsError("invalid-argument", "Unknown action.");
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller);
    const ref = ctx.ref.collection("trades").doc(str(data.tradeId, "tradeId", 64));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "No such trade.");
    const t = snap.data() as Trade;
    if (t.status !== "open") throw new HttpsError("failed-precondition", `That trade is already ${t.status}.`);
    const allowed = (action === "accept" || action === "reject") ? ctx.memberId === t.to
      : action === "cancel" ? ctx.memberId === t.from : ctx.isAdmin;
    if (!allowed) throw new HttpsError("permission-denied", "You can't do that to this trade.");

    if (action !== "accept") {
      tx.update(ref, { status: ({ reject: "rejected", cancel: "cancelled", veto: "vetoed" } as const)[action] });
      return { status: action };
    }
    await assertRostersOpen(tx, ctx);
    const from = ctx.members.get(t.from), to = ctx.members.get(t.to);
    const stillValid = from && to && t.give.every(p => from.roster.includes(p)) && t.get.every(p => to.roster.includes(p));
    if (!stillValid) { tx.update(ref, { status: "void" }); return { status: "void" }; }
    const names = await playerNames(tx, db, [...t.give, ...t.get]);
    tx.update(memberRef(db, ctx.ref.id, t.from), { roster: [...from.roster.filter(p => !t.give.includes(p)), ...t.get] });
    tx.update(memberRef(db, ctx.ref.id, t.to), { roster: [...to.roster.filter(p => !t.get.includes(p)), ...t.give] });
    tx.update(ref, { status: "accepted" });
    const list = (ids: string[]) => ids.map(p => names[p]).join(", ") || "nothing";
    logTxn(tx, ctx.ref, `Trade: ${from.teamName} sent ${list(t.give)} to ${to.teamName} for ${list(t.get)}`);
    return { status: "accepted" };
  });
}
