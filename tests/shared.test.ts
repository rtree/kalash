import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatUsdc } from '../src/shared.ts';

test('money: default .01 exact fee/net and all cap/precision boundaries', () => {
  const amount = parseAmount('0.01');
  assert.equal(amount, 10000n);
  assert.equal(amount / 10000n, 1n);
  assert.equal(amount - amount / 10000n, 9999n);
  assert.equal(formatUsdc(1n), '0.000001');
  assert.equal(parseAmount('1'), 1000000n);
  assert.equal(parseAmount('0.000001'), 1n);
  for (const invalid of ['0', '1.000001', '0.0000001', '0.0100000', '-1', '1e-2', 'NaN', ' 0.01', '00.01', '', 0.01, null]) {
    assert.throws(() => parseAmount(invalid));
  }
});
