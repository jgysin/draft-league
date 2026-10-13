import { HttpsError } from "firebase-functions/v2/https";
import type { Firestore } from "firebase-admin/firestore";
import { resolveWaivers } from "../core/league-logic";
import { WaiverClaim } from "../core/types";
import { Caller, loadLeague, memberRef } from "./access";
import { logTxn } from "./manage";
import { assertRostersOpen } from "./roster";
import { playerNames } from "./players";

/** Commissioner runs all pending claims: fewest points picks first. */
export async function processWaivers(db: Firestore, caller: Caller, data: { leagueId?: unknown }) {
  return db.runTransaction(async tx => {
    const ctx = await loadLeague(tx, db, data.leagueId, caller, { admin: true });
    await assertRostersOpen(tx, ctx);
    const [claimsSnap, standings] = await Promise.all([
      tx.get(ctx.ref.collection("waivers")), tx.get(ctx.ref.collection("meta").doc("standings"))]);
    if (claimsSnap.empty) throw new HttpsError("failed-precondition", "No pending claims.");
    const claims = claimsSnap.docs.map(d => {
      const c = d.data() as WaiverClaim;
      return { id: d.id, memberId: c.memberId, playerId: c.playerId, drop: c.drop, tsMs: c.ts?.toMillis() ?? 0 };
    }).filter(c => ctx.members.has(c.memberId));
    const rosters = Object.fromEntries([...ctx.members].map(([id, m]) => [id, m.roster]));
    const totals = (standings.exists ? standings.get("totals") : {}) as Record<string, number>;
    const { rosters: next, granted } = resolveWaivers({ claims, rosters, totals });
    const names = await playerNames(tx, db, granted.flatMap(g => [g.playerId, ...(g.drop ? [g.drop] : [])]));

    for (const id of new Set(granted.map(g => g.memberId)))
      tx.update(memberRef(db, ctx.ref.id, id), { roster: next[id] });
    for (const d of claimsSnap.docs) tx.delete(d.ref);
    for (const g of granted) {
      const team = ctx.members.get(g.memberId)!.teamName;
      logTxn(tx, ctx.ref, `${team} won a waiver claim for ${names[g.playerId]}` + (g.drop ? `, dropped ${names[g.drop]}` : ""));
    }
    return { granted: granted.length, failed: claimsSnap.size - granted.length };
  });
}
