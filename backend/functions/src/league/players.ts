import { HttpsError } from "firebase-functions/v2/https";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import { Player, Position } from "../core/types";

export const playerRef = (db: Firestore, code: string) => db.collection("players").doc(code);

/** Positions for a set of player codes, read inside the transaction. Unknown ids throw. */
export async function positionsOf(tx: Transaction, db: Firestore, ids: string[]): Promise<Record<string, Position>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return {};
  const snaps = await tx.getAll(...unique.map(id => playerRef(db, id)));
  const out: Record<string, Position> = {};
  for (const s of snaps) {
    if (!s.exists) throw new HttpsError("not-found", `Unknown player ${s.id}.`);
    out[s.id] = (s.data() as Player).position;
  }
  return out;
}

export async function playerNames(tx: Transaction, db: Firestore, ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return {};
  const snaps = await tx.getAll(...unique.map(id => playerRef(db, id)));
  return Object.fromEntries(snaps.map(s => [s.id, s.exists ? (s.data() as Player).name : s.id]));
}
