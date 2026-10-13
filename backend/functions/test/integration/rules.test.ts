import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { PROJECT } from "./setup";

let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { host, port: Number(port), rules: readFileSync(resolve(__dirname, "../../../firestore.rules"), "utf8") },
  });
});
afterAll(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const fs = ctx.firestore();
    await setDoc(doc(fs, "leagues/L"), { name: "Lads", memberUids: ["alice", "bob"], season: "2026-27" });
    await setDoc(doc(fs, "leagues/L/members/ma"), { uid: "alice", teamName: "A", roster: [] });
    await setDoc(doc(fs, "leagues/L/members/mb"), { uid: "bob", teamName: "B", roster: [] });
    await setDoc(doc(fs, "leagues/L/meta/standings"), { totals: {} });
    await setDoc(doc(fs, "players/1003"), { name: "Saka" });
    await setDoc(doc(fs, "inviteCodes/ABC234"), { leagueId: "L" });
  });
});

const as = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

describe("league access", () => {
  it("members read their league; others can't", async () => {
    await assertSucceeds(getDoc(doc(as("alice"), "leagues/L")));
    await assertSucceeds(getDoc(doc(as("alice"), "leagues/L/meta/standings")));
    await assertSucceeds(getDocs(query(collection(as("alice"), "leagues"), where("memberUids", "array-contains", "alice"))));
    await assertFails(getDoc(doc(as("eve"), "leagues/L")));
    await assertFails(getDoc(doc(as("eve"), "leagues/L/members/ma")));
    await assertFails(getDocs(collection(as("eve"), "leagues")));
    await assertFails(getDoc(doc(as("alice"), "inviteCodes/ABC234")));
  });

  it("nobody writes league state directly", async () => {
    await assertFails(updateDoc(doc(as("alice"), "leagues/L/members/ma"), { roster: ["1003"] }));
    await assertFails(updateDoc(doc(as("alice"), "leagues/L"), { memberUids: ["alice", "bob", "eve"] }));
    await assertFails(setDoc(doc(as("alice"), "leagues/L/meta/standings"), { totals: { ma: 999 } }));
    await assertFails(setDoc(doc(as("alice"), "players/1003"), { name: "x" }));
  });

  it("chat: post as yourself only", async () => {
    const fs = as("alice");
    await assertSucceeds(addDoc(collection(fs, "leagues/L/chat"), { uid: "alice", memberId: "ma", text: "hi", ts: serverTimestamp() }));
    await assertSucceeds(getDocs(collection(as("bob"), "leagues/L/chat")));
    await assertFails(addDoc(collection(fs, "leagues/L/chat"), { uid: "alice", memberId: "mb", text: "I'm bob", ts: serverTimestamp() }));
    await assertFails(addDoc(collection(fs, "leagues/L/chat"), { uid: "bob", memberId: "mb", text: "hi", ts: serverTimestamp() }));
    await assertFails(addDoc(collection(fs, "leagues/L/chat"), { uid: "alice", memberId: "ma", text: "", ts: serverTimestamp() }));
    await assertFails(addDoc(collection(as("eve"), "leagues/L/chat"), { uid: "eve", memberId: "ma", text: "hi", ts: serverTimestamp() }));
    await assertFails(getDocs(collection(as("eve"), "leagues/L/chat")));
  });

  it("shared FPL data needs sign-in", async () => {
    await assertSucceeds(getDoc(doc(as("eve"), "players/1003")));
    await assertFails(getDoc(doc(as(null), "players/1003")));
  });

  it("profiles are private and limited to known fields", async () => {
    await assertSucceeds(setDoc(doc(as("alice"), "users/alice"), { displayName: "Al", pushTokens: ["t"] }));
    await assertFails(setDoc(doc(as("alice"), "users/alice"), { admin: true }));
    await assertFails(getDoc(doc(as("bob"), "users/alice")));
  });

  it("legacy website collections stay open until cutover", async () => {
    await assertSucceeds(setDoc(doc(as(null), "managers/x"), { name: "old" }));
    await assertSucceeds(getDoc(doc(as(null), "meta/config")));
  });
});
