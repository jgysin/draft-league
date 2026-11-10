import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The app calls backend functions by name, which nothing else checks. This reads
 * both sides as text so a renamed or removed callable fails here, not on a phone.
 */
const read = (...path: string[]) => readFileSync(join(__dirname, ...path), 'utf8');

describe('callable contract', () => {
  const used = [...read('..', 'api.ts').matchAll(/\bcall<.*>\('(\w+)'\)/g)].map(m => m[1]);
  const backend = read('..', '..', '..', '..', 'backend', 'functions', 'src', 'index.ts');
  const exported = new Set([...backend.matchAll(/^export const (\w+) = callable\(/gm)].map(m => m[1]));

  it('finds the callables on both sides', () => {
    expect(used.length).toBeGreaterThanOrEqual(7);
    expect(exported.size).toBeGreaterThan(0);
  });

  it.each(used)('%s is exported by backend/functions/src/index.ts', name => {
    expect(exported.has(name)).toBe(true);
  });
});
