import { setGlobalOptions } from "firebase-functions/v2";
import { CallableRequest, HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentDeleted, onDocumentUpdated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { db, REGION } from "./admin";
import { Caller, requireAuth } from "./league/access";
import * as manage from "./league/manage";
import * as draft from "./league/draft";
import * as roster from "./league/roster";
import * as trades from "./league/trades";
import * as waivers from "./league/waivers";
import { recomputeStandings } from "./league/standings";
import { tick } from "./fpl/sync";

setGlobalOptions({ region: REGION, maxInstances: 10 });

type Handler = (database: typeof db, caller: Caller, data: any) => Promise<unknown>;

/** Wrap a handler as a callable: auth check, then turn unexpected errors into a generic message. */
function callable(handler: Handler) {
  return onCall(async (req: CallableRequest) => {
    const caller = requireAuth(req.auth);
    try {
      return await handler(db, caller, req.data ?? {});
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error(e);
      throw new HttpsError("internal", "Something went wrong. Try again.");
    }
  });
}

// League membership and settings
export const createLeague = callable(manage.createLeague);
export const joinLeague = callable(manage.joinLeague);
export const claimSlots = callable(manage.claimSlots);
export const updateLeague = callable(manage.updateLeague);
export const addSlot = callable(manage.addSlot);
export const updateMember = callable(manage.updateMember);
export const removeMember = callable(manage.removeMember);
export const rotateInvite = callable(manage.rotateInvite);
export const generateSchedule = callable(manage.generateSchedule);
export const setNickname = callable(manage.setNickname);

// Draft
export const setupDraft = callable(draft.setupDraft);
export const startDraft = callable(draft.startDraft);
export const resetDraft = callable(draft.resetDraft);
export const makePick = callable(draft.makePick);

// Rosters, trades, waivers
export const addDrop = callable(roster.addDrop);
export const submitClaim = callable(roster.submitClaim);
export const cancelClaim = callable(roster.cancelClaim);
export const processWaivers = callable(waivers.processWaivers);
export const proposeTrade = callable(trades.proposeTrade);
export const respondTrade = callable(trades.respondTrade);

/** Pull FPL data, bank deadlines and rescore leagues. */
export const fplTick = onSchedule({ schedule: "every 10 minutes", timeoutSeconds: 540, memory: "512MiB" },
  async () => { await tick(db); });

/** Scoring and H2H changes rescore the whole season straight away. */
export const onLeagueSettings = onDocumentUpdated("leagues/{leagueId}", async event => {
  const before = event.data?.before.data(), after = event.data?.after.data();
  if (!before || !after) return;
  if (JSON.stringify(before.scoring) !== JSON.stringify(after.scoring) || before.h2h !== after.h2h)
    await recomputeStandings(db, event.params.leagueId);
});
export const onScheduleWritten = onDocumentWritten("leagues/{leagueId}/meta/schedule",
  async event => { await recomputeStandings(db, event.params.leagueId); });
export const onMemberRemoved = onDocumentDeleted("leagues/{leagueId}/members/{memberId}",
  async event => { await recomputeStandings(db, event.params.leagueId); });
