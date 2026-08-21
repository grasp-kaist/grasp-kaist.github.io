import sharp from 'sharp';

export const PROFILE_PHOTO_MAX_BYTES = 20 * 1024 * 1024;
export const PROFILE_PHOTO_MAX_PIXELS = 40_000_000;
export const PROFILE_PHOTO_MAX_WIDTH = 800;
export const PROFILE_PHOTO_MAX_HEIGHT = 1000;

const supportedFormats = new Set(['jpeg', 'png', 'webp']);
let photoProcessorTail = Promise.resolve();

export type ProcessedProfilePhoto = {
  data: Buffer;
  width: number;
  height: number;
  size: number;
  format: 'webp';
};

export class ProfilePhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfilePhotoError';
  }
}

export async function processProfilePhoto(input: Buffer): Promise<ProcessedProfilePhoto> {
  if (input.byteLength === 0) {
    throw new ProfilePhotoError('The uploaded photo is empty.');
  }

  if (input.byteLength > PROFILE_PHOTO_MAX_BYTES) {
    throw new ProfilePhotoError('The uploaded photo is larger than 20 MiB.');
  }

  return withPhotoProcessorSlot(async () => {
    try {
      const source = sharp(input, {
        animated: false,
        failOn: 'warning',
        limitInputPixels: PROFILE_PHOTO_MAX_PIXELS,
      });
      const metadata = await source.metadata();

      if (!metadata.format || !supportedFormats.has(metadata.format)) {
        throw new ProfilePhotoError('Only JPEG, PNG, and WebP photos are supported.');
      }

      if ((metadata.pages ?? 1) > 1) {
        throw new ProfilePhotoError('Animated photos are not supported.');
      }

      const oriented = await source.rotate().toBuffer({ resolveWithObject: true });
      const { width, height } = oriented.info;

      if (!width || !height) {
        throw new ProfilePhotoError('The uploaded photo has invalid dimensions.');
      }

      const crop = getCenteredFourByFiveCrop(width, height);
      const output = await sharp(oriented.data, {
        failOn: 'warning',
        limitInputPixels: PROFILE_PHOTO_MAX_PIXELS,
      })
        .extract(crop)
        .resize({
          width: PROFILE_PHOTO_MAX_WIDTH,
          height: PROFILE_PHOTO_MAX_HEIGHT,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 82, effort: 4 })
        .toBuffer({ resolveWithObject: true });

      return {
        data: output.data,
        width: output.info.width,
        height: output.info.height,
        size: output.data.byteLength,
        format: 'webp' as const,
      };
    } catch (error) {
      if (error instanceof ProfilePhotoError) {
        throw error;
      }

      throw new ProfilePhotoError(
        `The uploaded file could not be decoded as an image: ${toErrorMessage(error)}`,
      );
    }
  });
}

export function getCenteredFourByFiveCrop(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ProfilePhotoError('Photo dimensions must be positive integers.');
  }

  const scale = Math.floor(Math.min(width / 4, height / 5));

  if (scale < 1) {
    throw new ProfilePhotoError('Photo dimensions are too small for a 4:5 crop.');
  }

  const cropWidth = scale * 4;
  const cropHeight = scale * 5;

  return {
    left: Math.floor((width - cropWidth) / 2),
    top: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

async function withPhotoProcessorSlot<T>(operation: () => Promise<T>) {
  const previous = photoProcessorTail;
  let release!: () => void;
  photoProcessorTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'unknown image error';
}
