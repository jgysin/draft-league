/** App-side mirror of backend/functions/src/core/types.ts (Timestamps as the client SDK type). */
import type { Timestamp } from 'firebase/firestore';

export type Position = 'GK' | 'DEF' | 'MID' | 'FWD';
export const POSITIONS: Position[] = ['GK', 'DEF', 'MID', 'FWD'];
export type Role = 'owner' | 'admin' | 'member';

export interface League {
  id: string;
  name: string;
  season: string;
  inviteCode: string;
  memberUids: string[];
  h2h: boolean;
  waivers: boolean;
}

export interface Member {
  id: string;
  teamName: string;
  uid: string | null;
  email: string | null;
  role: Role;
  roster: string[];
}

/** fpl/catalog entry */
export interface CatalogPlayer { c: string; n: string; f: string; p: Position; t: string; s: string }

export interface Standings {
  gwPoints: Record<string, Record<string, number>>;
  totals: Record<string, number>;
  h2h: { memberId: string; p: number; w: number; d: number; l: number; pts: number; total: number }[] | null;
}

export interface ChatMessage { id: string; uid: string | null; memberId: string | null; name?: string; text: string; ts: Timestamp | null }
export interface Txn { id: string; text: string; ts: Timestamp | null }

export const isAdmin = (m?: Member | null) => m?.role === 'owner' || m?.role === 'admin';
