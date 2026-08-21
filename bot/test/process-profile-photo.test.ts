import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  getCenteredFourByFiveCrop,
  processProfilePhoto,
  ProfilePhotoError,
} from '../src/image/process-profile-photo.js';

test('wide photos use the largest centered 4:5 crop', () => {
  assert.deepEqual(getCenteredFourByFiveCrop(2000, 1000), {
    left: 600,
    top: 0,
    width: 800,
    height: 1000,
  });
});

test('tall photos use the largest centered 4:5 crop', () => {
  assert.deepEqual(getCenteredFourByFiveCrop(800, 2000), {
    left: 0,
    top: 500,
    width: 800,
    height: 1000,
  });
});

test('4:5 photos are not cropped', () => {
  assert.deepEqual(getCenteredFourByFiveCrop(800, 1000), {
    left: 0,
    top: 0,
    width: 800,
    height: 1000,
  });
});

test('odd dimensions still produce an exact centered 4:5 crop', () => {
  const crop = getCenteredFourByFiveCrop(1003, 1001);
  assert.deepEqual(crop, {
    left: 101,
    top: 0,
    width: 800,
    height: 1000,
  });
  assert.equal(crop.width * 5, crop.height * 4);
});

test('large photos become metadata-free 800x1000 WebP images', async () => {
  const input = await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: '#336699',
    },
  })
    .jpeg()
    .withMetadata({ orientation: 1 })
    .toBuffer();

  const output = await processProfilePhoto(input);
  const metadata = await sharp(output.data).metadata();

  assert.equal(output.format, 'webp');
  assert.equal(output.width, 800);
  assert.equal(output.height, 1000);
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
});

test('small 4:5 photos are not enlarged', async () => {
  const input = await sharp({
    create: {
      width: 240,
      height: 300,
      channels: 3,
      background: '#ffffff',
    },
  })
    .png()
    .toBuffer();

  const output = await processProfilePhoto(input);
  assert.equal(output.width, 240);
  assert.equal(output.height, 300);
});

test('EXIF orientation is applied before the centered crop', async () => {
  const input = await sharp({
    create: {
      width: 500,
      height: 400,
      channels: 3,
      background: '#cc8844',
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const output = await processProfilePhoto(input);
  assert.equal(output.width, 400);
  assert.equal(output.height, 500);
});

test('non-image uploads are rejected', async () => {
  await assert.rejects(() => processProfilePhoto(Buffer.from('not an image')), ProfilePhotoError);
});

test('truncated images are consistently wrapped as profile photo errors', async () => {
  const valid = await sharp({
    create: { width: 400, height: 500, channels: 3, background: '#224466' },
  })
    .jpeg()
    .toBuffer();
  const truncated = valid.subarray(0, Math.floor(valid.byteLength / 2));

  await assert.rejects(
    () => processProfilePhoto(truncated),
    (error: unknown) => error instanceof ProfilePhotoError && error.name === 'ProfilePhotoError',
  );
});
