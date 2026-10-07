import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
const { applyDiscount } = await import(pathToFileURL(process.cwd() + '/price.js').href);
const cases = [[9.99, 33, 6.69], [19.99, 15, 16.99], [10, 150, 0], [100, 0, 100], [50, 20, 40], [5.35, 10, 4.82], [8.29, 50, 4.15]];
for (const [p, d, want] of cases) {
  const got = applyDiscount(p, d);
  assert.strictEqual(got, want, `applyDiscount(${p}, ${d}): expected ${want}, got ${got}`);
}
console.log(`holdout: ${cases.length} cases pass`);
