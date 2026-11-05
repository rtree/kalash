import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { photoSizeTier } from '../src/shared.ts';
import { processPhotoImage, MAX_PHOTO_INPUT_BYTES } from '../src/server/photo-image.ts';

test('photo size tiers use verified integer point-unit thresholds', () => {
  assert.equal(photoSizeTier('0'), null);
  assert.equal(photoSizeTier('1'), 1);
  assert.equal(photoSizeTier('4999999'), 1);
  assert.equal(photoSizeTier('5000000'), 2);
  assert.equal(photoSizeTier('19999999'), 2);
  assert.equal(photoSizeTier('20000000'), 3);
  assert.equal(photoSizeTier('49999999'), 3);
  assert.equal(photoSizeTier('50000000'), 4);
});

test('JPEG, PNG and WebP are decoded and re-encoded as bounded metadata-free JPEG', async () => {
  for (const [contentType, format] of [
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ] as const) {
    const source = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#aabbcc' },
    }).toFormat(format).withMetadata({ orientation: 6 }).toBuffer();
    const output = await processPhotoImage(source, contentType);
    const metadata = await sharp(output.data).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.width, 20);
    assert.equal(metadata.height, 40);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.icc, undefined);
    assert.ok(output.data.length <= 3 * 1024 * 1024);
  }
});

test('photo upload rejects spoofed formats, malformed bytes and oversized input', async () => {
  await assert.rejects(processPhotoImage(Buffer.from('not an image'), 'image/jpeg'), /readable image/);
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#123456' },
  }).png().toBuffer();
  await assert.rejects(processPhotoImage(png, 'image/jpeg'), /format, dimensions or animation/);
  await assert.rejects(processPhotoImage(png, 'image/gif'), /JPEG, PNG or WebP/);
  await assert.rejects(
    processPhotoImage(Buffer.alloc(MAX_PHOTO_INPUT_BYTES + 1), 'image/jpeg'),
    /no larger than 5 MB/,
  );
});
