/**
 * One-off copy of the website's single league (root collections meta/,
 * managers/, gameweeks/, chat/, txns/, trades/, waivers/) into the
 * multi-league layout under leagues/{leagueId}. The legacy data is only read,
 * so the website keeps working until everyone has moved over.
 *
 * Anyone can write to the website's collections, so nothing in them is trusted
 * for privileges or shape: the owner is named on the command line, everyone
 * else arrives as a plain member, and every field is validated or dropped.
 *
 * Players are re-keyed from the website's random ids to FPL codes, so the
 * player catalog must be synced first (the fplTick function does this).
 */
import type { DocumentData, DocumentReference, Firestore, WriteBatch } from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { newInviteCode } from "../core/league-logic";
import { DEFAULT_SCORING, DraftStatus, Player, POSITIONS, Role, Scoring, TradeStatus } from "../core/types";
import { EMAIL_RE } from "../league/access";
import { recomputeStandings } from "../league/standings";

export interface MigrateOptions {
  leagueId: string;
  /** Email of the person who becomes the league's owner; must match one legacy manager. */
  ownerEmail: string;
  dryRun?: boolean;
  allowUnmatched?: boolean;
}

export interface MigrateReport {
  leagueId: string;
  inviteCode: string;
  teams: { memberId: string; teamName: string; email: string | null; role: Role; roster: number }[];
  /** Managers the website marked as admin. They arrive as members; the owner can promote them again. */
  legacyAdmins: string[];
  gameweeks: number[];
  unmatched: { legacyId: string; name: string; club: string }[];
  /** Legacy data that failed validation and was left behind, e.g. "gameweek doc 'abc'". */
  skipped: string[];
  counts: Record<string, number>;
}

const MAX_CHAT = 500;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TRADE_STATUSES: TradeStatus[] = ["open", "accepted", "rejected", "cancelled", "vetoed", "void"];

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const text = (v: unknown, max: number): string => typeof v === "string" ? v.slice(0, max) : "";
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const time = (v: unknown): Timestamp => v instanceof Timestamp ? v : Timestamp.now();
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export async function migrateLegacy(db: Firestore, opts: MigrateOptions): Promise<MigrateReport> {
  if (!ID_RE.test(opts.leagueId)) throw new Error("--league-id may only contain letters, digits, - and _.");
  const ownerEmail = String(opts.ownerEmail || "").trim().toLowerCase();
  if (!EMAIL_RE.test(ownerEmail)) throw new Error("--owner-email is required: the email of the manager who will own the league.");
  const target = db.collection("leagues").doc(opts.leagueId);
  const existing = await target.get();
  if (existing.exists && !existing.get("migrating"))
    throw new Error(`leagues/${opts.leagueId} already exists; pick another --league-id`);

  const [config, registry, draft, schedule, managers, gameweeks, chat, txns, trades, waivers, current, catalog] =
    await Promise.all([
      db.doc("meta/config").get(), db.doc("meta/players").get(), db.doc("meta/draft").get(),
      db.doc("meta/schedule").get(), db.collection("managers").get(), db.collection("gameweeks").get(),
      db.collection("chat").orderBy("ts", "desc").limit(MAX_CHAT).get(), db.collection("txns").get(),
      db.collection("trades").get(), db.collection("waivers").get(), db.doc("fpl/current").get(),
      db.collection("players").get(),
    ]);
  if (!config.exists) throw new Error("No legacy league found (meta/config is missing).");
  if (!current.exists || catalog.empty) throw new Error("Sync the FPL player catalog first (run fplTick once).");
  const cfg = config.data()!;
  const skipped: string[] = [];

  // Map legacy player ids to FPL codes: by stored code, else by name + club.
  const byCode = new Map(catalog.docs.map(d => [d.id, d.data() as Player]));
  const byNameClub = new Map<string, string>();
  for (const [code, p] of byCode) {
    byNameClub.set(`${norm(p.name)}|${p.club.toLowerCase()}`, code);
    byNameClub.set(`${norm(p.fullName)}|${p.club.toLowerCase()}`, code);
  }
  const idMap = new Map<string, string>();
  const unmatched: MigrateReport["unmatched"] = [];
  const legacyOf = new Map<string, string[]>();   // code -> legacy ids
  const nicknames: Record<string, string> = {};
  for (const [pid, raw] of Object.entries(registry.data() || {})) {
    const p = record(raw);
    const name = text(p.name, 80), full = text(p.full, 120), club = text(p.club, 10).toLowerCase();
    const stored = typeof p.code === "number" || typeof p.code === "string" ? String(p.code) : "";
    const code = byCode.has(stored) ? stored
      : byNameClub.get(`${norm(name)}|${club}`) ?? (full ? byNameClub.get(`${norm(full)}|${club}`) : undefined);
    if (!code) { unmatched.push({ legacyId: pid, name, club: text(p.club, 10) }); continue; }
    idMap.set(pid, code);
    legacyOf.set(code, [...(legacyOf.get(code) || []), pid]);
    const nick = text(p.nickname, 40).trim();
    if (nick) nicknames[code] = nick;
  }
  // Two website players landing on one FPL player would put him on two teams at once.
  const clashes = [...legacyOf].filter(([, ids]) => ids.length > 1);
  if (clashes.length)
    throw new Error("Several website players match the same FPL player: " +
      clashes.map(([code, ids]) => `${byCode.get(code)!.name} (${code}) ← ${ids.join(", ")}`).join("; ") +
      ". Fix or remove the duplicates on the website and run again.");
  if (unmatched.length && !opts.allowUnmatched && !opts.dryRun)
    throw new Error(`${unmatched.length} players couldn't be matched to FPL: ` +
      unmatched.map(u => `${u.name} (${u.club})`).join(", ") + ". Re-run with --allow-unmatched to drop them.");
  const mapIds = (ids: unknown) => [...new Set(strings(ids).map(id => idMap.get(id)).filter((x): x is string => !!x))];

  // Teams. Legacy admin flags and commissionerEmail are ignored: only --owner-email grants anything.
  const memberDocs = managers.docs.filter(d => ID_RE.test(d.id) || (skipped.push(`manager '${d.id}' (bad id)`), false));
  const memberIds = new Set(memberDocs.map(d => d.id));
  const legacyAdmins: string[] = [];
  const rosters = new Map<string, string[]>();
  const taken = new Map<string, string>();
  const teams: MigrateReport["teams"] = memberDocs.map(d => {
    const m = d.data();
    const teamName = typeof m.name === "string" && m.name.trim() && m.name.trim().length <= 40 ? m.name.trim() : `Team ${d.id}`;
    const email = typeof m.email === "string" && EMAIL_RE.test(m.email.trim().toLowerCase()) ? m.email.trim().toLowerCase() : null;
    if (m.admin) legacyAdmins.push(teamName);
    // A player listed on two website teams stays with the first.
    const roster = mapIds(m.roster).filter(code => !taken.has(code) || (skipped.push(`${teamName}: ${code} is already on another team`), false));
    for (const code of roster) taken.set(code, d.id);
    rosters.set(d.id, roster);
    return { memberId: d.id, teamName, email, role: "member", roster: roster.length };
  });
  const owners = teams.filter(t => t.email === ownerEmail);
  if (owners.length !== 1)
    throw new Error(owners.length ? `${owners.length} website managers use ${ownerEmail}; the owner must be unique.`
      : `No website manager has the email ${ownerEmail}. Managers with an email: ` +
        (teams.filter(t => t.email).map(t => `${t.teamName} <${t.email}>`).join(", ") || "none") + ".");
  owners[0].role = "owner";

  const gwDocs = gameweeks.docs.filter(d => {
    const n = Number(d.id);
    return (/^\d{1,2}$/.test(d.id) && n >= 1 && n <= 38 && String(n) === d.id) || (skipped.push(`gameweek doc '${d.id}'`), false);
  }).sort((a, b) => Number(a.id) - Number(b.id));
  const gwIds = gwDocs.map(d => Number(d.id));

  const inviteCode = newInviteCode();
  const report: MigrateReport = {
    leagueId: opts.leagueId, inviteCode, teams, legacyAdmins, gameweeks: gwIds, unmatched, skipped,
    counts: { chat: chat.size, txns: txns.size, trades: trades.size, waivers: waivers.size },
  };

  // Everything below is computed before any write, so the dry run reports exactly what a real run would skip.
  const sub = (name: string) => target.collection(name);
  const writes: [DocumentReference, DocumentData][] = [];
  for (const t of teams) {
    writes.push([sub("members").doc(t.memberId),
      { teamName: t.teamName, uid: null, role: t.role, roster: rosters.get(t.memberId)!, joinedAt: null }]);
    if (t.email) writes.push([sub("slots").doc(t.memberId), { email: t.email, autoClaim: true }]);
  }
  for (const d of gwDocs) {
    const gwOwners: Record<string, string> = {};
    for (const [pid, mid] of Object.entries(record(d.get("owners")))) {
      const code = idMap.get(pid);
      if (code && typeof mid === "string" && memberIds.has(mid)) gwOwners[code] = mid;
    }
    writes.push([sub("gameweeks").doc(d.id), { owners: gwOwners, bankedAt: FieldValue.serverTimestamp() }]);
  }

  const dr = record(draft.data());
  const anyRoster = [...rosters.values()].some(r => r.length);
  if (draft.exists || anyRoster) {
    // Squads that already exist mean the draft is over, whatever the website's doc says (or if it has none);
    // without a finished draft the app would keep everyone's roster closed.
    const status: DraftStatus = anyRoster && dr.status !== "live" ? "done"
      : (["setup", "live", "done"] as const).find(s => s === dr.status) ?? "setup";
    const order = strings(dr.order).filter(id => memberIds.has(id));
    const rounds = Number.isInteger(dr.rounds) && (dr.rounds as number) >= 1 && (dr.rounds as number) <= 30 ? dr.rounds as number : 15;
    const q = record(dr.quotas);
    const quotas = Object.fromEntries(POSITIONS.map(p =>
      [p, Number.isInteger(q[p]) && (q[p] as number) >= 0 && (q[p] as number) <= 30 ? q[p] as number : 0]));
    const picks = (Array.isArray(dr.picks) ? dr.picks : []).map(record)
      .filter(p => typeof p.mid === "string" && memberIds.has(p.mid) && typeof p.pid === "string" && idMap.has(p.pid))
      .map(p => ({ memberId: p.mid as string, playerId: idMap.get(p.pid as string)! }));
    writes.push([sub("draft").doc("state"), {
      status, order: order.length === memberIds.size ? order : [...memberIds], rounds, quotas, picks,
      // Counted from the season's start, so squads that have already scored can't be wiped by a draft reset.
      ...(status === "setup" ? {} : { startedAtGw: 0 }),
    }]);
  }

  if (schedule.exists) {
    const sched: Record<string, string[]> = {};
    for (const [gw, pairs] of Object.entries(schedule.data()!)) {
      const n = Number(gw);
      if (!Number.isInteger(n) || n < 1 || n > 38 || !Array.isArray(pairs)) { skipped.push(`schedule entry '${gw}'`); continue; }
      const ok = pairs.filter(p => {
        const ids = typeof p === "string" ? p.split("|") : [];
        return ids.length === 2 && ids[0] !== ids[1] && ids.every(id => memberIds.has(id));
      });
      if (ok.length !== pairs.length) skipped.push(`${pairs.length - ok.length} fixture(s) in schedule week ${gw}`);
      sched[String(n)] = ok;
    }
    writes.push([sub("meta").doc("schedule"), sched]);
  }
  if (Object.keys(nicknames).length) writes.push([sub("meta").doc("nicknames"), nicknames]);

  for (const d of chat.docs)
    writes.push([sub("chat").doc(d.id), { uid: null, memberId: null, name: text(d.get("name"), 40), text: text(d.get("text"), 1000), ts: time(d.get("ts")) }]);
  for (const d of txns.docs)
    writes.push([sub("txns").doc(d.id), { ts: time(d.get("ts")), text: text(d.get("text"), 500) }]);
  for (const d of trades.docs) {
    const t = d.data();
    if (typeof t.from !== "string" || typeof t.to !== "string" || !memberIds.has(t.from) || !memberIds.has(t.to)) {
      skipped.push(`trade '${d.id}' (unknown team)`); continue;
    }
    const give = strings(t.give), get = strings(t.get);
    const intact = mapIds(give).length === give.length && mapIds(get).length === get.length;
    const status = TRADE_STATUSES.find(s => s === t.status) ?? "void";
    writes.push([sub("trades").doc(d.id), {
      from: t.from, to: t.to, give: mapIds(give), get: mapIds(get), note: text(t.note, 280),
      status: status === "open" && !intact ? "void" : status, ts: time(t.ts),
    }]);
  }
  for (const d of waivers.docs) {
    const w = d.data();
    if (w.status !== "pending") continue;
    if (typeof w.mid !== "string" || !memberIds.has(w.mid) || typeof w.pid !== "string" || !idMap.has(w.pid)) {
      skipped.push(`waiver claim '${d.id}'`); continue;
    }
    writes.push([sub("waivers").doc(d.id), { memberId: w.mid, playerId: idMap.get(w.pid)!,
      drop: typeof w.drop === "string" ? idMap.get(w.drop) ?? null : null, ts: time(w.ts) }]);
  }
  if (opts.dryRun) return report;

  // A previous run that died part-way left a league marked `migrating`: clear it out and start again.
  if (existing.exists) {
    const old = existing.get("inviteCode");
    await db.recursiveDelete(target);
    if (typeof old === "string" && old) await db.collection("inviteCodes").doc(old).delete();
  }

  // The league doc goes first, flagged `migrating` and with no members, so the sync, the callables and
  // the app all ignore it until every subcollection is in place. Then the flag comes off.
  const cfgScoring = record(cfg.scoring);
  const scoring = { ...DEFAULT_SCORING };
  for (const k of Object.keys(DEFAULT_SCORING) as (keyof Scoring)[]) {
    const v = cfgScoring[k];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 50) scoring[k] = v;
  }
  await target.create({
    name: text(cfg.leagueName, 60).trim() || "Draft League", season: current.get("season"), inviteCode,
    memberUids: [], scoring, h2h: cfg.h2h === true, waivers: cfg.waivers === true,
    bankedGw: gwIds.length ? gwIds[gwIds.length - 1] : 0, rosterLimit: 0,
    createdAt: FieldValue.serverTimestamp(), migratedFrom: "website", migrating: true,
  });
  await db.collection("inviteCodes").doc(inviteCode).create({ leagueId: opts.leagueId });
  for (let i = 0; i < writes.length; i += 400) {
    const batch: WriteBatch = db.batch();
    for (const [ref, data] of writes.slice(i, i + 400)) batch.set(ref, data);
    await batch.commit();
  }
  await target.update({ migrating: FieldValue.delete() });
  await recomputeStandings(db, opts.leagueId);
  return report;
}
