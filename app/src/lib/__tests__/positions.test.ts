import { sortByPosition } from '../positions';
import type { CatalogPlayer, Position } from '../types';

const player = (c: string, n: string, p: Position): [string, CatalogPlayer] => [c, { c, n, f: n, p, t: 'ARS', s: 'a' }];
const catalog = new Map([
  player('1', 'Saka', 'MID'), player('2', 'Raya', 'GK'), player('3', 'Haaland', 'FWD'),
  player('4', 'Saliba', 'DEF'), player('5', 'Gabriel', 'DEF'), player('6', 'Rice', 'MID'),
]);

describe('sortByPosition', () => {
  it('orders GK, DEF, MID, FWD, then by name', () => {
    expect(sortByPosition(['1', '2', '3', '4', '5', '6'], catalog)).toEqual(['2', '5', '4', '6', '1', '3']);
  });

  it('files players missing from the catalog with the midfielders, by code', () => {
    expect(sortByPosition(['3', '99', '2'], catalog)).toEqual(['2', '99', '3']);
  });

  it('copes with no catalog and does not mutate its input', () => {
    const codes = ['b', 'a'];
    expect(sortByPosition(codes, null)).toEqual(['a', 'b']);
    expect(codes).toEqual(['b', 'a']);
  });
});
