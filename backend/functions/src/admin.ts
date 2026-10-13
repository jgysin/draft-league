import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, Firestore, getFirestore, Timestamp } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();

export const db: Firestore = getFirestore();
export { FieldValue, Timestamp };

/** One region for every function; keep it next to the Firestore database. */
export const REGION = "us-central1";
