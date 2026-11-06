import test from 'node:test';
import assert from 'node:assert/strict';
import { currentCashPolicy, interimCashEnabled } from '../src/cash-policy.ts';

test('Interim cash policy is explicit, strict by default, and rejects invalid configuration', () => {
  const previous = process.env.KALASH_CASH_POLICY;
  try {
    delete process.env.KALASH_CASH_POLICY;
    assert.equal(currentCashPolicy(), 'strict');
    assert.equal(interimCashEnabled(), false);
    process.env.KALASH_CASH_POLICY = 'strict';
    assert.equal(interimCashEnabled(), false);
    process.env.KALASH_CASH_POLICY = 'interim-ledger';
    assert.equal(currentCashPolicy(), 'interim-ledger');
    assert.equal(interimCashEnabled(), true);
    process.env.KALASH_CASH_POLICY = 'true';
    assert.throws(currentCashPolicy, /KALASH_CASH_POLICY/);
  } finally {
    if (previous === undefined) delete process.env.KALASH_CASH_POLICY;
    else process.env.KALASH_CASH_POLICY = previous;
  }
});
