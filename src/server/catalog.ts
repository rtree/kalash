import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import type { Temple } from '../shared.ts';

const publicWallets = JSON.parse(readFileSync('config/wallets.public.json', 'utf8')) as {
  wallets: Record<string, string>;
};
const entries = [
  ['Lotus Courtyard', 'A quiet courtyard for a first step on your journey.', 19.0632, 72.8656, 'lotus'],
  ['Golden Banyan', 'Rest beneath an imagined canopy of generous branches.', 19.0675, 72.8625, 'banyan'],
  ['River Bell', 'A gentle bell celebrates the people who make every journey possible.', 19.0612, 72.8598, 'bell'],
  ['Sunrise Mandapa', 'An open pavilion inspired by the first light of morning.', 19.0700, 72.8694, 'sun'],
  ['Jasmine Steps', 'Small acts of kindness blossom along these welcoming steps.', 19.0650, 72.8722, 'jasmine'],
  ['Peacock Garden', 'A garden of colour, community and shared beginnings.', 19.0588, 72.8652, 'peacock'],
  ['Moonstone Shrine', 'A place to pause, reflect and send a little support.', 19.0721, 72.8637, 'moon'],
  ['Marigold Gate', 'An imagined gate welcoming travellers from near and far.', 19.0681, 72.8750, 'marigold'],
  ['Sacred Grove', 'A small grove honouring the everyday work of giving.', 19.0601, 72.8733, 'leaf'],
  ['Harmony Pavilion', 'A meeting place for ten paths and countless generous hearts.', 19.0740, 72.8709, 'harmony'],
] as const;
export const temples: Temple[] = entries.map(([name, description, latitude, longitude, motif], index) => {
  const id = `temple-${String(index + 1).padStart(2, '0')}`;
  const wallet = publicWallets.wallets[id];
  if (!wallet) throw new Error(`Missing registered recipient for ${id}`);
  return { id, name, description, latitude, longitude, motif, recipient: getAddress(wallet), onsite: index === 0 };
});
