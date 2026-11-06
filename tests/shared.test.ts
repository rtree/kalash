import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseDonationUnits, formatUsdc, formatPaise, donationPointUnits } from '../src/shared.ts';

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

test('Central donation amounts remain base units in wallet calls and displays', () => {
  const amount = parseAmount('0.01').toString();
  assert.equal(parseDonationUnits(amount), 10000n);
  assert.equal(formatUsdc(amount), '0.010000');
  assert.equal(parseDonationUnits('1'), 1n);
  assert.equal(parseDonationUnits('1000000'), 1000000n);
  for (const invalid of ['0', '01', '0.01', '1.000000', '1000001', '-1', '1e4', '', 10000, null]) {
    assert.throws(() => parseDonationUnits(invalid));
  }
});

test('onsite Crypto and remote donations use distinct deterministic point multipliers', () => {
  assert.equal(donationPointUnits('10000', 0), 10000n);
  assert.equal(donationPointUnits('10000', 1), 100000n);
  assert.equal(donationPointUnits('200000', 1), 2000000n);
});

test('cash uses paise for INR display and equivalent units for onsite points, not the Crypto payment cap', () => {
  assert.equal(formatPaise('0'), '0.00');
  assert.equal(formatPaise('1'), '0.01');
  assert.equal(formatPaise('10000'), '100.00');
  assert.equal(formatPaise('40000'), '400.00');
  assert.equal(formatUsdc(40000n * 100n), '4.000000');
  assert.equal(donationPointUnits(40000n * 100n, 1), 40000000n);
  assert.throws(() => parseDonationUnits('4000000'));
});
