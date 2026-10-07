#!/bin/bash
# Creates the one-bug repo the film runs against. usage: make_repo.sh <dir>
set -e
rm -rf "$1"; mkdir -p "$1/test"; cd "$1"; git init -q
cat > price.js <<'X'
/**
 * Apply a percentage discount to a price.
 * @param {number} price  price in dollars
 * @param {number} pct    discount in percent (0-100; values above 100 mean free)
 * @returns {number} the discounted price, rounded to cents (half up), never below 0
 */
export function applyDiscount(price, pct) {
  return price - pct;
}
X
cat > test/price.test.js <<'X'
import { test } from 'node:test';
import assert from 'node:assert';
import { applyDiscount } from '../price.js';
test('20% off 50', () => assert.strictEqual(applyDiscount(50, 20), 40));
X
echo '{"type":"module","scripts":{"test":"node --test"}}' > package.json
git add -A
# A unique root commit per repo: opencode keys its project on the root commit.
git -c user.name=demo -c user.email=demo@example.com commit -qm "init $(basename "$1")"
