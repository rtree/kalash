export type CashPolicy = 'strict' | 'interim-ledger';

export function currentCashPolicy(): CashPolicy {
  const configured = process.env.KALASH_CASH_POLICY;
  if (configured === undefined || configured === 'strict') return 'strict';
  if (configured === 'interim-ledger') return configured;
  throw new Error('KALASH_CASH_POLICY must be strict or interim-ledger.');
}

export function interimCashEnabled(): boolean {
  return currentCashPolicy() === 'interim-ledger';
}
