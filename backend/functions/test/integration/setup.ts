import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import type { Caller } from "../../src/league/access";

export const PROJECT = "demo-draft-league";
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Run integration tests with `npm run test:emulator`.");
if (!getApps().length) initializeApp({ projectId: PROJECT });
export const db = getFirestore();

export async function clearDb() {
  const res = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" });
  if (!res.ok) throw new Error(`clear failed: ${res.status}`);
}

export const user = (n: number): Caller => ({ uid: `u${n}`, email: `friend${n}@example.com` });

/** Expect a callable to fail with a given HttpsError code. */
export async function rejects(p: Promise<unknown>, code: string) {
  try { await p; } catch (e: any) {
    if (e?.code !== code) throw new Error(`expected ${code}, got ${e?.code}: ${e?.message}`);
    return;
  }
  throw new Error(`expected ${code}, but it succeeded`);
}
