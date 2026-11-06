import { erc20Abi, getAddress, parseEventLogs, type Log } from 'viem';
import { cashFeeAbi, type CashFeeInvoice } from '../payout.ts';
import { USDC } from '../shared.ts';
import { requireValue } from './errors.ts';

export function validateCashFeeReceipt(logs: readonly Log[], invoice: CashFeeInvoice, timestamp: bigint) {
  const fees = parseEventLogs({ abi: cashFeeAbi, eventName: 'FeePaid', strict: true,
    logs: logs.filter((log) => getAddress(log.address) === getAddress(invoice.vault)) });
  const fee = fees[0];
  requireValue(fees.length === 1 && fee && fee.args.invoiceId === invoice.invoiceId
    && getAddress(fee.args.payer) === getAddress(invoice.payer) && fee.args.templeId === invoice.templeKey
    && fee.args.amount === BigInt(invoice.amount) && getAddress(fee.args.recipient) === getAddress(invoice.recipient)
    && timestamp <= BigInt(invoice.deadline), 400, 'FEE_EVENT_MISMATCH', 'FeePaid must match the exact registered invoice.');
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', strict: true,
    logs: logs.filter((log) => getAddress(log.address) === USDC) })
    .filter((log) => getAddress(log.args.from) === getAddress(invoice.payer));
  requireValue(transfers.length === 1 && transfers[0] && getAddress(transfers[0].args.to) === getAddress(invoice.recipient)
    && transfers[0].args.value === BigInt(invoice.amount), 400, 'FEE_TRANSFER_MISMATCH', 'Exact fee transfer is required.');
  return fee.logIndex;
}
