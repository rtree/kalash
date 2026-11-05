import { temples } from '../src/server/catalog.ts';
import { db } from '../src/server/config.ts';

await db.runTransaction(async (tx) => {
  const snapshots = await Promise.all(temples.map((temple) => tx.get(db.collection('temples').doc(temple.id))));
  for (let index = 0; index < temples.length; index++) {
    const temple = temples[index]!;
    const current = snapshots[index]!;
    if (current.exists) {
      if (current.get('recipient') !== temple.recipient) throw new Error(`Recipient mismatch ${temple.id}; bootstrap will not overwrite`);
    } else {
      tx.create(current.ref, { ...temple, demo: true });
    }
  }
});
console.log(`Registered ${temples.length} demo temples without changing existing wallets or history.`);
await db.terminate();
