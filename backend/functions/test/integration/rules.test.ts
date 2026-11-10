import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from "@firebase/rules-unit-testing";
import {
  addDoc, collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp,
  updateDoc, where,
} from "firebase/firestore";
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
    await setDoc(doc(fs, "leagues/L/members/ma"), { uid: "alice", teamName: "A", role: "owner", roster: [] });
    await setDoc(doc(fs, "leagues/L/members/mb"), { uid: "bob", teamName: "B", role: "member", roster: [] });
    await setDoc(doc(fs, "leagues/L/members/mc"), { uid: null, teamName: "C", role: "member", roster: [] });
    await setDoc(doc(fs, "leagues/L/slots/mc"), { email: "carol@example.com", autoClaim: true });
    await setDoc(doc(fs, "leagues/L/meta/standings"), { totals: {} });
    await setDoc(doc(fs, "leagues/L/draft/state"), { status: "setup" });
    await setDoc(doc(fs, "leagues/L/gameweeks/1"), { owners: {} });
    await setDoc(doc(fs, "leagues/L/trades/t1"), { status: "pending" });
    await setDoc(doc(fs, "leagues/L/waivers/w1"), { status: "pending" });
    await setDoc(doc(fs, "leagues/L/txns/x1"), { text: "signed" });
    await setDoc(doc(fs, "leagues/L/chat/c1"), { uid: "bob", memberId: "mb", text: "first", ts: Timestamp.now() });
    await setDoc(doc(fs, "leagues/M"), { name: "Moving", memberUids: ["alice"], season: "2026-27", migrating: true });
    await setDoc(doc(fs, "leagues/M/members/ma"), { uid: "alice", teamName: "A", role: "owner", roster: [] });
    await setDoc(doc(fs, "players/1003"), { name: "Saka" });
    await setDoc(doc(fs, "fpl/current"), { season: "2026-27" });
    await setDoc(doc(fs, "seasons/2026-27/gameweeks/1"), { stats: {}, final: false });
    await setDoc(doc(fs, "inviteCodes/ABC234"), { leagueId: "L" });
    await setDoc(doc(fs, "managers/x"), { name: "old", email: "", roster: [] });
    await setDoc(doc(fs, "managers/x/sub/y"), { secret: true });
    await setDoc(doc(fs, "chat/old"), { name: "old", text: "hello", ts: Timestamp.now() });
  });
});

const as = (uid: string | null) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
/** A Google sign-in as the website sees it: an email that Google has verified. */
const asVerified = (uid: string) =>
  env.authenticatedContext(uid, { email: "a@example.com", email_verified: true }).firestore();
const asUnverified = (uid: string) =>
  env.authenticatedContext(uid, { email: "a@example.com", email_verified: false }).firestore();

const msg = (over: Record<string, unknown> = {}) =>
  ({ uid: "alice", memberId: "ma", text: "hi", ts: serverTimestamp(), ...over });

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

  it("signed-out visitors read nothing of a league", async () => {
    await assertFails(getDoc(doc(as(null), "leagues/L")));
    await assertFails(getDoc(doc(as(null), "leagues/L/members/ma")));
    await assertFails(getDocs(collection(as(null), "leagues/L/chat")));
    await assertFails(getDocs(collection(as(null), "leagues")));
  });

  it("you can only list leagues by your own uid", async () => {
    await assertFails(getDocs(query(collection(as("eve"), "leagues"), where("memberUids", "array-contains", "alice"))));
    await assertFails(getDocs(query(collection(as("bob"), "leagues"), where("memberUids", "array-contains", "alice"))));
    await assertSucceeds(getDocs(query(collection(as("bob"), "leagues"), where("memberUids", "array-contains", "bob"))));
  });

  it("members read every listed subcollection", async () => {
    const fs = as("bob");
    for (const path of ["members/ma", "draft/state", "gameweeks/1", "meta/standings", "trades/t1", "waivers/w1", "txns/x1"])
      await assertSucceeds(getDoc(doc(fs, `leagues/L/${path}`)));
    await assertSucceeds(getDocs(collection(fs, "leagues/L/members")));
  });

  it("slots (reserved emails) are private to the functions", async () => {
    for (const uid of ["alice", "bob", "eve", null]) {
      await assertFails(getDoc(doc(as(uid), "leagues/L/slots/mc")));
      await assertFails(getDocs(collection(as(uid), "leagues/L/slots")));
    }
    await assertFails(setDoc(doc(as("alice"), "leagues/L/slots/mc"), { email: "alice@example.com", autoClaim: true }));
    await assertFails(deleteDoc(doc(as("alice"), "leagues/L/slots/mc")));
    await assertFails(getDocs(collectionGroup(as("alice"), "slots")));
  });

  it("a subcollection nobody listed stays private", async () => {
    await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), "leagues/L/secrets/s"), { v: 1 }));
    await assertFails(getDoc(doc(as("alice"), "leagues/L/secrets/s")));
  });

  it("collection group queries are closed to clients", async () => {
    await assertFails(getDocs(collectionGroup(as("alice"), "members")));
    await assertFails(getDocs(collectionGroup(as("alice"), "chat")));
    await assertFails(getDocs(query(collectionGroup(as("alice"), "members"), where("uid", "==", "alice"))));
  });

  it("a member removed from memberUids loses read and post", async () => {
    await assertSucceeds(getDoc(doc(as("alice"), "leagues/L")));
    await env.withSecurityRulesDisabled(async ctx => {
      await updateDoc(doc(ctx.firestore(), "leagues/L"), { memberUids: ["bob"] });
    });
    const fs = as("alice");
    await assertFails(getDoc(doc(fs, "leagues/L")));
    await assertFails(getDoc(doc(fs, "leagues/L/members/ma")));
    await assertFails(getDoc(doc(fs, "leagues/L/meta/standings")));
    await assertFails(getDocs(collection(fs, "leagues/L/chat")));
    // Her member doc still names her, but she is no longer in memberUids.
    await assertFails(addDoc(collection(fs, "leagues/L/chat"), msg()));
  });

  it("a league being migrated can't be opened", async () => {
    await assertFails(getDoc(doc(as("alice"), "leagues/M")));
    await assertFails(getDoc(doc(as("eve"), "leagues/M")));
    await assertFails(getDoc(doc(as("alice"), "leagues/M/members/ma")));
    await assertFails(getDocs(collection(as("alice"), "leagues/M/chat")));
    await assertFails(addDoc(collection(as("alice"), "leagues/M/chat"), msg()));
    // The list query the app runs keeps working while a migration is under way.
    await assertSucceeds(getDocs(query(collection(as("alice"), "leagues"), where("memberUids", "array-contains", "alice"))));
    // Normal leagues are unaffected, with or without an explicit false.
    await assertSucceeds(getDoc(doc(as("alice"), "leagues/L")));
    await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), "leagues/M"), { migrating: false }));
    await assertSucceeds(getDoc(doc(as("alice"), "leagues/M")));
    await assertSucceeds(getDoc(doc(as("alice"), "leagues/M/members/ma")));
  });

  it("nobody writes league state directly", async () => {
    await assertFails(updateDoc(doc(as("alice"), "leagues/L/members/ma"), { roster: ["1003"] }));
    await assertFails(updateDoc(doc(as("alice"), "leagues/L"), { memberUids: ["alice", "bob", "eve"] }));
    await assertFails(setDoc(doc(as("alice"), "leagues/L/meta/standings"), { totals: { ma: 999 } }));
    await assertFails(setDoc(doc(as("alice"), "players/1003"), { name: "x" }));
    await assertFails(setDoc(doc(as("alice"), "leagues/New"), { name: "mine", memberUids: ["alice"] }));
    await assertFails(deleteDoc(doc(as("alice"), "leagues/L")));
    await assertFails(setDoc(doc(as("alice"), "inviteCodes/ZZZZ2345"), { leagueId: "L" }));
  });
});

describe("league chat", () => {
  it("post as yourself only", async () => {
    const fs = as("alice");
    await assertSucceeds(addDoc(collection(fs, "leagues/L/chat"), msg()));
    await assertSucceeds(getDocs(collection(as("bob"), "leagues/L/chat")));
    await assertFails(addDoc(collection(fs, "leagues/L/chat"), msg({ memberId: "mb", text: "I'm bob" })));
    await assertFails(addDoc(collection(fs, "leagues/L/chat"), msg({ uid: "bob", memberId: "mb" })));
    await assertFails(addDoc(collection(fs, "leagues/L/chat"), msg({ memberId: "mc" })));        // unclaimed team
    await assertFails(addDoc(collection(fs, "leagues/L/chat"), msg({ memberId: "nobody" })));    // no such team
    await assertFails(addDoc(collection(as("eve"), "leagues/L/chat"), msg({ uid: "eve" })));
    await assertFails(getDocs(collection(as("eve"), "leagues/L/chat")));
  });

  it("messages have the exact shape and a server timestamp", async () => {
    const chat = collection(as("alice"), "leagues/L/chat");
    await assertSucceeds(addDoc(chat, msg({ text: "x".repeat(1000) })));
    await assertFails(addDoc(chat, msg({ text: "x".repeat(1001) })));
    await assertFails(addDoc(chat, msg({ text: "" })));
    await assertFails(addDoc(chat, msg({ text: "   \n\t " })));
    await assertFails(addDoc(chat, msg({ text: 42 })));
    await assertFails(addDoc(chat, msg({ ts: Timestamp.fromMillis(Date.now() - 60_000) })));
    await assertFails(addDoc(chat, msg({ ts: Timestamp.fromMillis(Date.now() + 86_400_000) })));
    await assertFails(addDoc(chat, msg({ pinned: true })));
    await assertFails(addDoc(chat, msg({ memberId: 7 })));
    await assertFails(addDoc(chat, msg({ memberId: ["ma"] })));
    await assertFails(addDoc(chat, { uid: "alice", text: "hi", ts: serverTimestamp() }));
  });

  it("messages can't be edited or deleted", async () => {
    await assertSucceeds(setDoc(doc(as("alice"), "leagues/L/chat/mine"), msg()));
    await assertFails(updateDoc(doc(as("alice"), "leagues/L/chat/mine"), { text: "edited" }));
    await assertFails(deleteDoc(doc(as("alice"), "leagues/L/chat/mine")));
    await assertFails(updateDoc(doc(as("alice"), "leagues/L/chat/c1"), { text: "edited" }));
    await assertFails(deleteDoc(doc(as("bob"), "leagues/L/chat/c1")));
  });
});

describe("shared data", () => {
  it("FPL data needs sign-in", async () => {
    await assertSucceeds(getDoc(doc(as("eve"), "players/1003")));
    await assertSucceeds(getDoc(doc(as("eve"), "fpl/current")));
    await assertSucceeds(getDoc(doc(as("eve"), "seasons/2026-27/gameweeks/1")));
    await assertSucceeds(getDocs(collection(as("eve"), "seasons/2026-27/gameweeks")));
    await assertFails(getDoc(doc(as(null), "players/1003")));
    await assertFails(getDoc(doc(as(null), "fpl/current")));
    await assertFails(getDoc(doc(as(null), "seasons/2026-27/gameweeks/1")));
  });

  it("FPL data is never writable", async () => {
    for (const fs of [as("alice"), asVerified("alice")]) {
      await assertFails(setDoc(doc(fs, "fpl/current"), { season: "x" }));
      await assertFails(setDoc(doc(fs, "fpl/catalog"), { players: [] }));
      await assertFails(updateDoc(doc(fs, "seasons/2026-27/gameweeks/1"), { final: true }));
      await assertFails(setDoc(doc(fs, "seasons/2026-27/gameweeks/2"), { stats: {} }));
      await assertFails(deleteDoc(doc(fs, "players/1003")));
    }
    // The season doc itself matches no rule at all.
    await assertFails(getDoc(doc(as("alice"), "seasons/2026-27")));
  });

  it("unknown root collections are closed", async () => {
    await assertFails(getDoc(doc(asVerified("alice"), "secrets/x")));
    await assertFails(setDoc(doc(asVerified("alice"), "secrets/x"), { v: 1 }));
    await assertFails(getDocs(collection(asVerified("alice"), "inviteCodes")));
  });
});

describe("profiles", () => {
  it("are private and limited to known fields", async () => {
    await assertSucceeds(setDoc(doc(as("alice"), "users/alice"), { displayName: "Al", pushTokens: ["t"] }));
    await assertSucceeds(getDoc(doc(as("alice"), "users/alice")));
    await assertFails(setDoc(doc(as("alice"), "users/alice"), { admin: true }));
    await assertFails(getDoc(doc(as("bob"), "users/alice")));
    await assertFails(getDoc(doc(as(null), "users/alice")));
    await assertFails(getDocs(collection(as("alice"), "users")));
  });

  it("can't be written for someone else", async () => {
    await assertFails(setDoc(doc(as("bob"), "users/alice"), { displayName: "Bob was here" }));
    await assertFails(setDoc(doc(as(null), "users/alice"), { displayName: "anon" }));
    await assertSucceeds(setDoc(doc(as("alice"), "users/alice"), { displayName: "Al" }));
    await assertFails(updateDoc(doc(as("bob"), "users/alice"), { displayName: "Bob was here" }));
    await assertFails(deleteDoc(doc(as("bob"), "users/alice")));
  });

  it("reject bad types and oversized values", async () => {
    const me = doc(as("alice"), "users/alice");
    await assertFails(setDoc(me, { displayName: 42 }));
    await assertFails(setDoc(me, { displayName: "x".repeat(61) }));
    await assertSucceeds(setDoc(me, { displayName: "x".repeat(60) }));
    await assertFails(setDoc(me, { pushTokens: "token" }));
    await assertFails(setDoc(me, { pushTokens: { a: 1 } }));
    await assertFails(setDoc(me, { pushTokens: Array.from({ length: 11 }, (_, i) => `t${i}`) }));
    await assertSucceeds(setDoc(me, { pushTokens: Array.from({ length: 10 }, (_, i) => `t${i}`) }));
    await assertFails(setDoc(me, { updatedAt: Timestamp.fromMillis(1) }));
    await assertFails(setDoc(me, { updatedAt: "yesterday" }));
    await assertSucceeds(setDoc(me, { displayName: "Al", updatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(me, {}));
  });

  it("can be updated and deleted by their owner", async () => {
    const me = doc(as("alice"), "users/alice");
    await assertSucceeds(setDoc(me, { displayName: "Al", updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(me, { displayName: "Alice" }));                    // updatedAt left alone
    await assertSucceeds(updateDoc(me, { pushTokens: ["t"], updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(me, { updatedAt: Timestamp.fromMillis(1) }));
    await assertFails(updateDoc(me, { displayName: 42 }));
    await assertFails(updateDoc(me, { admin: true }));
    await assertSucceeds(deleteDoc(me));
  });
});

describe("legacy website collections", () => {
  const LEGACY = ["meta", "managers", "gameweeks", "chat", "trades", "txns", "waivers"];

  it("anyone can read", async () => {
    for (const c of LEGACY) {
      await assertSucceeds(getDoc(doc(as(null), `${c}/any`)));
      await assertSucceeds(getDocs(collection(as(null), c)));
    }
  });

  it("anonymous visitors can't write", async () => {
    for (const c of LEGACY) {
      await assertFails(setDoc(doc(as(null), `${c}/x`), { text: "hi", name: "anon" }));
      await assertFails(addDoc(collection(as(null), c), { text: "hi", name: "anon" }));
    }
    await assertFails(updateDoc(doc(as(null), "managers/x"), { admin: true }));
    await assertFails(deleteDoc(doc(as(null), "managers/x")));
    await assertFails(deleteDoc(doc(as(null), "chat/old")));
  });

  it("a verified Google sign-in can write, as the website does", async () => {
    const fs = asVerified("alice");
    await assertSucceeds(setDoc(doc(fs, "meta/config"), { leagueName: "Lads", commissionerEmail: "a@example.com" }));
    await assertSucceeds(setDoc(doc(fs, "meta/players"), {}, { merge: true }));
    await assertSucceeds(updateDoc(doc(fs, "managers/x"), { roster: ["p1"] }));
    await assertSucceeds(setDoc(doc(fs, "gameweeks/1"), { stats: { p1: { goals: 1 } } }, { merge: true }));
    await assertSucceeds(addDoc(collection(fs, "chat"), { ts: serverTimestamp(), name: "Al", text: "hi" }));
    await assertSucceeds(addDoc(collection(fs, "txns"), { ts: serverTimestamp(), text: "Al signed Saka" }));
    await assertSucceeds(addDoc(collection(fs, "trades"), { ts: serverTimestamp(), from: "x", to: "y", status: "pending" }));
    await assertSucceeds(addDoc(collection(fs, "waivers"), { ts: serverTimestamp(), mid: "x", pid: "p1", status: "pending" }));
    await assertSucceeds(deleteDoc(doc(fs, "gameweeks/1")));
    await assertSucceeds(deleteDoc(doc(fs, "managers/x")));
  });

  it("an unverified or email-less sign-in can't write", async () => {
    for (const fs of [asUnverified("mallory"), as("mallory")]) {
      await assertFails(setDoc(doc(fs, "meta/config"), { commissionerEmail: "mallory@example.com" }));
      await assertFails(updateDoc(doc(fs, "managers/x"), { admin: true }));
      await assertFails(addDoc(collection(fs, "chat"), { ts: serverTimestamp(), name: "M", text: "hi" }));
      await assertFails(deleteDoc(doc(fs, "managers/x")));
    }
  });

  it("chat and txns text is capped", async () => {
    const fs = asVerified("alice");
    for (const c of ["chat", "txns"]) {
      await assertSucceeds(addDoc(collection(fs, c), { ts: serverTimestamp(), name: "Al", text: "x".repeat(2000) }));
      await assertFails(addDoc(collection(fs, c), { ts: serverTimestamp(), name: "Al", text: "x".repeat(2001) }));
      await assertFails(addDoc(collection(fs, c), { ts: serverTimestamp(), name: "Al", text: 42 }));
      await assertFails(addDoc(collection(fs, c), { ts: serverTimestamp(), name: "Al" }));
    }
  });

  it("doesn't extend to subcollections", async () => {
    await assertFails(getDoc(doc(as(null), "managers/x/sub/y")));
    await assertFails(getDoc(doc(asVerified("alice"), "managers/x/sub/y")));
    await assertFails(setDoc(doc(asVerified("alice"), "managers/x/sub/z"), { v: 1 }));
    await assertFails(setDoc(doc(asVerified("alice"), "meta/config/history/1"), { v: 1 }));
  });
});
