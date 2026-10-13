import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

/** Typed wrappers for the callables in backend/functions/src/index.ts. */
function call<In, Out = { ok: true }>(name: string) {
  const fn = httpsCallable<In, Out>(functions, name);
  return async (data: In) => (await fn(data)).data;
}

type L = { leagueId: string };

export const api = {
  createLeague: call<{ name: string; teamName: string }, { leagueId: string; inviteCode: string }>('createLeague'),
  joinLeague: call<{ code: string; teamName?: string }, { leagueId: string; memberId: string }>('joinLeague'),
  claimSlots: call<Record<string, never>, { claimed: string[] }>('claimSlots'),
  rotateInvite: call<L, { inviteCode: string }>('rotateInvite'),
  updateMember: call<L & { memberId: string; teamName?: string }>('updateMember'),
  addDrop: call<L & { memberId?: string; add?: string; drop?: string }>('addDrop'),
  submitClaim: call<L & { playerId: string; drop?: string | null }, { claimId: string }>('submitClaim'),
};

/** The message a callable error carries, for showing to the user. */
export function errorMessage(e: unknown): string {
  const msg = (e as { message?: string })?.message;
  return msg && !msg.startsWith('internal') ? msg : 'Something went wrong. Try again.';
}
