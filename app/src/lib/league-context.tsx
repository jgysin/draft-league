import { createContext, useContext } from 'react';
import type { CatalogPlayer, League, Member } from './types';

export interface LeagueCtx {
  league: League;
  members: Member[];
  me: Member | null;
  catalog: Map<string, CatalogPlayer> | null;
  nicknames: Record<string, string>;
  memberName: (id: string | null | undefined) => string;
  playerName: (code: string) => string;
}

export const LeagueContext = createContext<LeagueCtx | null>(null);

export function useLeagueCtx(): LeagueCtx {
  const ctx = useContext(LeagueContext);
  if (!ctx) throw new Error('useLeagueCtx outside a league');
  return ctx;
}

export const headshotUrl = (code: string) =>
  `https://resources.premierleague.com/premierleague/photos/players/110x140/p${code}.png`;
