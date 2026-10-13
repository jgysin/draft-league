import type { CatalogPlayer, Position } from './types';

const ORDER: Record<Position, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

export function sortByPosition(codes: string[], catalog: Map<string, CatalogPlayer> | null): string[] {
  return [...codes].sort((a, b) => {
    const pa = catalog?.get(a), pb = catalog?.get(b);
    return (ORDER[pa?.p ?? 'MID'] - ORDER[pb?.p ?? 'MID']) || (pa?.n ?? a).localeCompare(pb?.n ?? b);
  });
}
