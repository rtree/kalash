import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { ATM_PHOTO_IDLE_MS, CASH_ACCEPTANCE_MS, CASH_LIMIT_PAISE, VISIT_TTL_MS, cashMachineStatus, metaMaskLink, templeTarget, visitState } from '../src/atm.ts';

const origin = 'https://kalash-central-548318651344.asia-south1.run.app';
const reference = 'a'.repeat(64);
test('ATM deeplink preserves the canonical temple and opaque reference exactly', () => {
  const target = templeTarget(origin, 'temple-01', reference);
  assert.equal(target, `${origin}/temples/temple-01?visit=${reference}`);
  const link = metaMaskLink(target, origin);
  assert.equal(link, `https://link.metamask.io/dapp/${target.slice(8)}`);
  assert.equal(new URL(`https://${link.split('/dapp/')[1]}`).href, target);
  const qr = QRCode.create(link, { errorCorrectionLevel: 'M' });
  assert.ok(qr.modules.size > 0);
  assert.ok(qr.segments.length > 0);
  assert.equal(metaMaskLink(templeTarget(origin, 'temple-10'), origin),
    `https://link.metamask.io/dapp/${origin.slice(8)}/temples/temple-10`);
});
test('ATM links reject arbitrary origins, parameters, credentials and malformed references', () => {
  for (const target of [
    `https://other.invalid/temples/temple-01?visit=${reference}`,
    `${origin}/temples/temple-01?visit=${reference}&kind=1`,
    `${origin}/temples/temple-01?visit=${reference}&visit=${reference}`,
    `${origin}/temples/temple-01?visit=${reference}#cash`,
    `${origin}/temples/temple-01?visit=short`,
    `${origin}/temples/temple-11`,
    `${origin}/temples/temple-01/`,
    `${origin}/api/atm/atm-01`,
    origin.replace('https://', 'https://user:password@') + '/temples/temple-01',
  ]) assert.throws(() => metaMaskLink(target, origin));
  for (const invalidOrigin of ['http://localhost:3000', 'https://localhost', 'https://127.0.0.1', `${origin}/nested`, `${origin}?token=x`]) {
    assert.throws(() => templeTarget(invalidOrigin, 'temple-01'));
  }
});
test('QR expiry never closes a linked reception or implies cash success', () => {
  assert.equal(visitState('awaiting_wallet', 120000, 119999), 'awaiting_wallet');
  assert.equal(visitState('awaiting_wallet', 120000, 120000), 'expired');
  assert.equal(visitState('linked', 120000, 999999), 'linked');
  assert.equal(visitState('donation_pending', 120000, 999999), 'donation_pending');
  assert.equal(visitState('closed', 120000, 0), 'closed');
  assert.equal(cashMachineStatus(null, 120000), 'offline');
  const unplugged = {
    sequence: 1, receivedAt: 100000, usbConnected: false, connectionOpen: false,
    deviceStarted: false, routesVerified: false, pollerOwned: true,
  };
  assert.equal(cashMachineStatus(unplugged, 105000), 'disconnected');
  assert.equal(cashMachineStatus(unplugged, 116000), 'offline');
  assert.equal(cashMachineStatus({ ...unplugged, usbConnected: true, connectionOpen: true, deviceStarted: true, routesVerified: true }, 105000), 'ready');
  assert.equal(VISIT_TTL_MS, 120000);
  assert.equal(CASH_ACCEPTANCE_MS, 120000);
  assert.equal(ATM_PHOTO_IDLE_MS, 30000);
  assert.equal(CASH_LIMIT_PAISE, '40000');
});
