/** Letters that Unicode decomposition (NFD) leaves alone but people type without. */
const FOLD: Record<string, string> = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', đ: 'd', ð: 'd', þ: 'th', ł: 'l', ı: 'i' };

/** Lower-cased and stripped of diacritics, so "odegaard" finds "Ødegaard" and "guehi" finds "Guéhi". */
export function normaliseSearch(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[øæœßđðþłı]/g, ch => FOLD[ch]).trim();
}
