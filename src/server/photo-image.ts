import sharp from 'sharp';
import { HttpError, requireValue } from './errors.ts';

export const MAX_PHOTO_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_PHOTO_OUTPUT_BYTES = 3 * 1024 * 1024;
const MAX_PHOTO_PIXELS = 20_000_000;
const INPUT_FORMATS = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export async function processPhotoImage(input: Buffer, contentType: unknown) {
  requireValue(typeof contentType === 'string'
    && Object.hasOwn(INPUT_FORMATS, contentType),
  415, 'PHOTO_FORMAT', 'Choose a JPEG, PNG or WebP image.');
  requireValue(input.length > 0 && input.length <= MAX_PHOTO_INPUT_BYTES,
    413, 'PHOTO_SIZE', 'Image must be no larger than 5 MB.');

  let pipeline: sharp.Sharp;
  let metadata: sharp.Metadata;
  try {
    pipeline = sharp(input, { failOn: 'warning', limitInputPixels: MAX_PHOTO_PIXELS });
    metadata = await pipeline.metadata();
  } catch {
    throw new HttpError(400, 'PHOTO_INVALID', 'The selected file is not a readable image.');
  }
  requireValue(metadata.format === INPUT_FORMATS[contentType as keyof typeof INPUT_FORMATS]
    && metadata.width && metadata.height && metadata.width * metadata.height <= MAX_PHOTO_PIXELS
    && (metadata.pages ?? 1) === 1,
  400, 'PHOTO_INVALID', 'Image format, dimensions or animation are not supported.');

  let result: { data: Buffer; info: sharp.OutputInfo };
  try {
    result = await pipeline.rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(400, 'PHOTO_INVALID', 'The selected file could not be safely re-encoded.');
  }
  requireValue(result.data.length <= MAX_PHOTO_OUTPUT_BYTES,
    413, 'PHOTO_SIZE', 'The optimized image is still too large to publish.');
  return result;
}
