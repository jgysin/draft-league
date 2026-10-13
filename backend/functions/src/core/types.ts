/**
 * Shared shapes for the Firestore data model. See backend/README.md for the
 * full layout. Player ids everywhere are FPL `code`s as strings: unlike FPL
 * element ids they stay the same from season to season, and they are what the
 * official headshot URLs use.
 */

export type Position = "GK" | "DEF" | "MID" | "FWD";
export const POSITIONS: Position[] = ["GK", "DEF", "MID", "FWD"];

export type Role = "owner" | "admin" | "member";

export interface Scoring {
  appearance: number;
  goal_gk: number;
  goal_def: number;
  goal_mid: number;
  goal_fwd: number;
  assist: number;
  cs_gk: number;
  cs_def: number;
  cs_mid: number;
  yellow: number;
  red: number;
  own_goal: number;
}

export const DEFAULT_SCORING: Scoring = {
  appearance: 1, goal_gk: 6, goal_def: 6, goal_mid: 5, goal_fwd: 4,
  assist: 3, cs_gk: 4, cs_def: 4, cs_mid: 1, yellow: -1, red: -3, own_goal: -2,
};

/** One player's real-world output in one gameweek (summed over double gameweeks). */
export interface PlayerGwStats {
  apps: number;     // fixtures with minutes > 0
  minutes: number;
  goals: number;
  assists: number;
  cs: number;       // clean sheets as FPL awards them (60+ minutes)
  yc: number;
  rc: number;
  og: number;
}

/** players/{code} */
export interface Player {
  code: string;
  fplId: number;    // this season's element id
  name: string;     // web_name
  fullName: string;
  position: Position;
  club: string;     // short name, e.g. "ARS"
  status: string;   // FPL availability flag: a, d, i, s, u, n
  news: string;
}

/** leagues/{leagueId} */
export interface League {
  name: string;
  season: string;               // e.g. "2026-27"
  inviteCode: string;
  memberUids: string[];         // signed-in members, used by security rules
  scoring: Scoring;
  h2h: boolean;
  waivers: boolean;
  /** Highest gameweek whose deadline ownership has been banked. */
  bankedGw: number;
  createdAt: FirebaseFirestore.Timestamp;
}

/**
 * leagues/{leagueId}/members/{memberId}
 * A member is a team in the league. `uid` is null for a slot the commissioner
 * created (or migrated) that nobody has claimed yet; it is claimed by the
 * first signed-in user whose email matches `email`.
 */
export interface Member {
  teamName: string;
  uid: string | null;
  email: string | null;
  role: Role;
  roster: string[];
  joinedAt: FirebaseFirestore.Timestamp | null;
}

export type DraftStatus = "setup" | "live" | "done";

/** leagues/{leagueId}/draft/state */
export interface DraftState {
  status: DraftStatus;
  order: string[];                          // memberIds, round 1 order
  rounds: number;
  quotas: Record<Position, number>;         // max per position, 0 = unlimited
  picks: { memberId: string; playerId: string }[];
}

export type TradeStatus = "open" | "accepted" | "rejected" | "cancelled" | "vetoed" | "void";

/** leagues/{leagueId}/trades/{tradeId} */
export interface Trade {
  from: string;     // memberId
  to: string;
  give: string[];   // playerIds `from` sends
  get: string[];    // playerIds `from` receives
  note: string;
  status: TradeStatus;
  ts: FirebaseFirestore.Timestamp;
}

/** leagues/{leagueId}/waivers/{claimId} */
export interface WaiverClaim {
  memberId: string;
  playerId: string;
  drop: string | null;
  ts: FirebaseFirestore.Timestamp;
}

/**
 * leagues/{leagueId}/gameweeks/{gw}
 * `owners` is the roster snapshot taken at the gameweek deadline: a manager
 * only scores for players they owned at the deadline, so later moves never
 * shift points that were already earned.
 */
export interface LeagueGameweek {
  owners: Record<string, string>;   // playerId -> memberId
  bankedAt: FirebaseFirestore.Timestamp;
}

/** fpl/current */
export interface FplEvent {
  id: number;
  deadline: string;     // ISO
  finished: boolean;
  dataChecked: boolean;
  isCurrent: boolean;
}
export interface FplCurrent {
  season: string;
  events: FplEvent[];
  elementToCode: Record<string, string>;
  updatedAt: FirebaseFirestore.Timestamp;
}
