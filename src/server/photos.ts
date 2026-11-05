import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { HttpError, requireValue } from './errors.ts';
import { db, publicConfig } from './config.ts';
import { ownedDonation } from './donations.ts';
import { temples } from './catalog.ts';
import {
  PHOTO_CONSENT_VERSION, photoSizeTier, type PhotoDto,
} from '../shared.ts';
import { processPhotoImage } from './photo-image.ts';

type PhotoStatus = 'published' | 'replaced' | 'withdrawn' | 'expired';
interface PhotoRecord {
  id: string;
  ownerWallet: string;
  templeId: string;
  donationId: string;
  objectName: string;
  displayName: string | null;
  sizeTier: 1 | 2 | 3 | 4;
  pointsAtPublish: string;
  status: PhotoStatus;
  createdAt: string;
  expiresAt: string;
  consentVersion: string;
  consentedAt: string;
  storageDeletePending: boolean;
}

const bucketName = process.env.PHOTO_BUCKET ?? publicConfig.firebase.storageBucket;
const bucket = getStorage().bucket(bucketName);
const photoCollection = db.collection('photos');
const slotCollection = db.collection('photoSlots');
const expiryCollection = db.collection('photoExpiryJobs');
const cleanupCollection = db.collection('photoCleanupJobs');
const slotId = (owner: string, templeId: string) => `${owner.toLowerCase()}_${templeId}`;
const publicUrl = (templeId: string, id: string) =>
  `/api/board/${encodeURIComponent(templeId)}/photos/${encodeURIComponent(id)}`;

function publicPhoto(photo: PhotoRecord): PhotoDto {
  return {
    id: photo.id,
    templeId: photo.templeId,
    displayName: photo.displayName,
    sizeTier: photo.sizeTier,
    imageUrl: publicUrl(photo.templeId, photo.id),
    createdAt: photo.createdAt,
    expiresAt: photo.expiresAt,
  };
}

function cleanDisplayName(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  requireValue(typeof input === 'string', 400, 'INVALID_DISPLAY_NAME', 'Display name must be text.');
  const name = input.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  requireValue(Array.from(name).length <= 32, 400, 'INVALID_DISPLAY_NAME', 'Display name must be 32 characters or fewer.');
  return name || null;
}

function decodeImage(input: unknown): Buffer {
  requireValue(typeof input === 'string' && input.length > 0 && input.length <= 7_000_000
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input),
  400, 'PHOTO_INVALID', 'Image upload data is invalid.');
  const bytes = Buffer.from(input, 'base64');
  requireValue(bytes.toString('base64') === input, 400, 'PHOTO_INVALID', 'Image upload data is invalid.');
  return bytes;
}

async function photoEligibility(donationId: unknown, owner: string) {
  const donation = await ownedDonation(donationId, owner as `0x${string}`);
  requireValue(donation.status === 'confirmed', 409, 'DONATION_UNCONFIRMED', 'A confirmed donation is required before sharing a photo.');
  const total = (await db.collection('walletTempleTotals')
    .doc(`${owner.toLowerCase()}_${donation.templeId}`).get()).get('points');
  const points = String(total ?? '0');
  const sizeTier = photoSizeTier(points);
  requireValue(sizeTier !== null, 403, 'PHOTO_NOT_ELIGIBLE', 'A verified donation is required before publishing a photo.');
  return { donation, points, sizeTier };
}

async function deleteRetiredObject(photo: PhotoRecord): Promise<boolean> {
  try {
    await bucket.file(photo.objectName).delete({ ignoreNotFound: true });
    await Promise.all([
      photoCollection.doc(photo.id).update({ storageDeletePending: false }),
      cleanupCollection.doc(photo.id).delete(),
    ]);
    return false;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'photo_object_cleanup_failed', photoId: photo.id,
      error: error instanceof Error ? error.name : 'UnknownError',
    }));
    await cleanupCollection.doc(photo.id).set({
      photoId: photo.id, objectName: photo.objectName, createdAt: new Date().toISOString(),
    });
    return true;
  }
}

export async function getPhotoEligibility(donationId: unknown, owner: string) {
  const { donation, points, sizeTier } = await photoEligibility(donationId, owner);
  return { templeId: donation.templeId, points, sizeTier };
}

export async function uploadPhoto(owner: string, body: Record<string, unknown>) {
  requireValue(body.consent === true && body.consentVersion === PHOTO_CONSENT_VERSION,
    400, 'PHOTO_CONSENT_REQUIRED', 'Explicit photo-board consent is required before upload.');
  requireValue(Object.keys(body).every((key) => [
    'donationId', 'imageBase64', 'contentType', 'displayName', 'consent', 'consentVersion',
  ].includes(key)), 400, 'UNKNOWN_FIELD', 'Photo upload contains an unsupported field.');
  const { donation, points, sizeTier } = await photoEligibility(body.donationId, owner);
  const image = await processPhotoImage(decodeImage(body.imageBase64), body.contentType);
  const id = randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const displayName = cleanDisplayName(body.displayName);
  const objectName = `photos/${id}.jpg`;
  const record: PhotoRecord = {
    id, ownerWallet: owner.toLowerCase(), templeId: donation.templeId,
    donationId: donation.id, objectName, displayName, sizeTier,
    pointsAtPublish: points, status: 'published', createdAt, expiresAt,
    consentVersion: PHOTO_CONSENT_VERSION, consentedAt: createdAt,
    storageDeletePending: false,
  };
  await bucket.file(objectName).save(image.data, {
    resumable: false,
    validation: 'crc32c',
    metadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' },
  });

  const photoRef = photoCollection.doc(id);
  const slotRef = slotCollection.doc(slotId(owner, donation.templeId));
  let retired: PhotoRecord | undefined;
  try {
    await db.runTransaction(async (transaction) => {
      retired = undefined;
      const slot = await transaction.get(slotRef);
      const previousId = slot.get('photoId') as string | undefined;
      const previousRef = previousId ? photoCollection.doc(previousId) : undefined;
      const previous = previousRef ? await transaction.get(previousRef) : undefined;
      if (previous?.exists && previousRef) {
        retired = previous.data() as PhotoRecord;
        transaction.update(previousRef, { status: 'replaced', storageDeletePending: true });
        transaction.delete(expiryCollection.doc(previousId!));
        transaction.set(cleanupCollection.doc(previousId!), {
          photoId: previousId, objectName: retired.objectName, createdAt,
        });
      }
      transaction.create(photoRef, record);
      transaction.set(slotRef, { ownerWallet: owner.toLowerCase(), templeId: donation.templeId, photoId: id });
      transaction.create(expiryCollection.doc(id), { photoId: id, expiresAt });
    });
  } catch (error) {
    try {
      await bucket.file(objectName).delete({ ignoreNotFound: true });
    } catch (cleanupError) {
      console.error(JSON.stringify({
        event: 'photo_orphan_cleanup_failed', photoId: id,
        error: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
      }));
      await cleanupCollection.doc(id).set({ photoId: id, objectName, createdAt });
    }
    throw error;
  }
  const cleanupPending = retired ? await deleteRetiredObject(retired) : false;
  return { photo: publicPhoto(record), cleanupPending };
}

export async function listOwnedPhotos(owner: string): Promise<PhotoDto[]> {
  const now = new Date().toISOString();
  const result = await photoCollection.where('ownerWallet', '==', owner.toLowerCase()).limit(100).get();
  return result.docs.map((doc) => doc.data() as PhotoRecord)
    .filter((photo) => photo.status === 'published' && photo.expiresAt > now)
    .map(publicPhoto);
}

export async function listBoardPhotos(templeId: string): Promise<PhotoDto[]> {
  requireValue(temples.some((temple) => temple.id === templeId), 404, 'UNKNOWN_TEMPLE', 'Unknown temple.');
  const now = new Date().toISOString();
  const result = await photoCollection.where('templeId', '==', templeId).limit(100).get();
  return result.docs.map((doc) => doc.data() as PhotoRecord)
    .filter((photo) => photo.status === 'published' && photo.expiresAt > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicPhoto);
}

export async function getBoardPhoto(templeId: string, id: string) {
  requireValue(temples.some((temple) => temple.id === templeId), 404, 'UNKNOWN_TEMPLE', 'Unknown temple.');
  requireValue(/^[0-9a-f-]{36}$/i.test(id), 404, 'PHOTO_NOT_FOUND', 'Photo is not available.');
  const snapshot = await photoCollection.doc(id).get();
  const photo = snapshot.data() as PhotoRecord | undefined;
  const now = new Date().toISOString();
  if (!photo || photo.templeId !== templeId || photo.status !== 'published' || photo.expiresAt <= now) {
    throw new HttpError(404, 'PHOTO_NOT_FOUND', 'Photo is not available.');
  }
  const slot = await slotCollection.doc(slotId(photo.ownerWallet, templeId)).get();
  if (slot.get('photoId') !== id) throw new HttpError(404, 'PHOTO_NOT_FOUND', 'Photo is not available.');
  const [data] = await bucket.file(photo.objectName).download();
  return { data, photo: publicPhoto(photo) };
}

export async function withdrawPhoto(owner: string, id: string) {
  requireValue(/^[0-9a-f-]{36}$/i.test(id), 404, 'PHOTO_NOT_FOUND', 'Photo is not available.');
  const photoRef = photoCollection.doc(id);
  const initial = await photoRef.get();
  const photo = initial.data() as PhotoRecord | undefined;
  requireValue(photo && photo.ownerWallet === owner.toLowerCase(), 404, 'PHOTO_NOT_FOUND', 'Photo is not available.');
  const slotRef = slotCollection.doc(slotId(owner, photo.templeId));
  await db.runTransaction(async (transaction) => {
    const [current, slot] = await Promise.all([transaction.get(photoRef), transaction.get(slotRef)]);
    const latest = current.data() as PhotoRecord | undefined;
    if (!latest || latest.ownerWallet !== owner.toLowerCase()) {
      throw new HttpError(404, 'PHOTO_NOT_FOUND', 'Photo is not available.');
    }
    if (latest.status === 'published') {
      transaction.update(photoRef, { status: 'withdrawn', storageDeletePending: true });
      transaction.delete(expiryCollection.doc(id));
      transaction.set(cleanupCollection.doc(id), {
        photoId: id, objectName: latest.objectName, createdAt: new Date().toISOString(),
      });
    }
    if (slot.get('photoId') === id) transaction.delete(slotRef);
  });
  const cleanupPending = await deleteRetiredObject(photo);
  return { withdrawn: true, cleanupPending };
}

export async function cleanupPhotoLifecycle() {
  const now = new Date().toISOString();
  const expiries = await expiryCollection.where('expiresAt', '<=', now).limit(100).get();
  for (const job of expiries.docs) {
    const photoRef = photoCollection.doc(job.id);
    const snapshot = await photoRef.get();
    const photo = snapshot.data() as PhotoRecord | undefined;
    if (!photo) {
      await job.ref.delete();
      continue;
    }
    const slotRef = slotCollection.doc(slotId(photo.ownerWallet, photo.templeId));
    await db.runTransaction(async (transaction) => {
      const [current, slot, expiry] = await Promise.all([
        transaction.get(photoRef), transaction.get(slotRef), transaction.get(job.ref),
      ]);
      const latest = current.data() as PhotoRecord | undefined;
      if (latest?.status === 'published' && latest.expiresAt <= now && expiry.exists) {
        transaction.update(photoRef, { status: 'expired', storageDeletePending: true });
        transaction.set(cleanupCollection.doc(photo.id), {
          photoId: photo.id, objectName: latest.objectName, createdAt: now,
        });
        if (slot.get('photoId') === photo.id) transaction.delete(slotRef);
      }
      if (expiry.exists) transaction.delete(job.ref);
    });
  }
  const pending = await cleanupCollection.limit(100).get();
  for (const job of pending.docs) {
    const photo = (await photoCollection.doc(job.id).get()).data() as PhotoRecord | undefined;
    if (!photo) {
      try {
        await bucket.file(job.get('objectName') as string).delete({ ignoreNotFound: true });
        await job.ref.delete();
      } catch (error) {
        console.error(JSON.stringify({
          event: 'photo_orphan_cleanup_failed', photoId: job.id,
          error: error instanceof Error ? error.name : 'UnknownError',
        }));
      }
      continue;
    }
    await deleteRetiredObject(photo);
  }
}
