import { normaliseSearch } from '../search';

describe('normaliseSearch', () => {
  it('lower-cases and trims', () => {
    expect(normaliseSearch('  SAKA ')).toBe('saka');
  });

  it('strips accents', () => {
    expect(normaliseSearch('Guéhi')).toBe('guehi');
    expect(normaliseSearch('Gyökeres')).toBe('gyokeres');
    expect(normaliseSearch('Šeško')).toBe('sesko');
    expect(normaliseSearch('João Félix')).toBe('joao felix');
  });

  it('folds letters that have no decomposition', () => {
    expect(normaliseSearch('Ødegaard')).toBe('odegaard');
    expect(normaliseSearch('Højlund')).toBe('hojlund');
    expect(normaliseSearch('Næstved')).toBe('naestved');
    expect(normaliseSearch('Groß')).toBe('gross');
    expect(normaliseSearch('Łukasz')).toBe('lukasz');
    expect(normaliseSearch('Guðmundsson')).toBe('gudmundsson');
  });

  it('lets an unaccented query find an accented name', () => {
    expect(normaliseSearch('Martin Ødegaard')).toContain(normaliseSearch('odeg'));
  });
});
