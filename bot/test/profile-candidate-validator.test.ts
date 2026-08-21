import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { validateProfileCandidate } from '../scripts/validate-profile-candidate.mjs';

const SLUG = 'example-member';

test('accepts a canonical slug photo with exact bounded 4:5 WebP output', async (t) => {
  const rootDirectory = await makeCandidateRoot(t);
  await writeProfile(rootDirectory, `${SLUG}.webp`);
  await writeImage(rootDirectory, sharp({
    create: {
      width: 400,
      height: 500,
      channels: 3,
      background: '#123456',
    },
  }).webp());

  const result = await validateProfileCandidate({ slug: SLUG, rootDirectory });

  assert.deepEqual(result, { slug: SLUG, hasPhoto: true, width: 400, height: 500 });
});

test('rejects a deleted profile JSON and an orphan slug photo', async (t) => {
  const deletedRoot = await makeCandidateRoot(t);
  await assert.rejects(
    () => validateProfileCandidate({ slug: SLUG, rootDirectory: deletedRoot }),
    /profile JSON must exist as a regular file/,
  );

  const orphanRoot = await makeCandidateRoot(t);
  await writeProfile(orphanRoot, '');
  await writeImage(orphanRoot, sharp({
    create: {
      width: 400,
      height: 500,
      channels: 3,
      background: '#123456',
    },
  }).webp());
  await assert.rejects(
    () => validateProfileCandidate({ slug: SLUG, rootDirectory: orphanRoot }),
    /Orphan bot-managed photo/,
  );
});

test('rejects mismatched references and invalid WebP output properties', async (t) => {
  const mismatchRoot = await makeCandidateRoot(t);
  await writeProfile(mismatchRoot, 'someone-else.webp');
  await assert.rejects(
    () => validateProfileCandidate({ slug: SLUG, rootDirectory: mismatchRoot }),
    /must be empty or exactly example-member\.webp/,
  );

  const squareRoot = await makeCandidateRoot(t);
  await writeProfile(squareRoot, `${SLUG}.webp`);
  await writeImage(squareRoot, sharp({
    create: {
      width: 400,
      height: 400,
      channels: 3,
      background: '#123456',
    },
  }).webp());
  await assert.rejects(
    () => validateProfileCandidate({ slug: SLUG, rootDirectory: squareRoot }),
    /exact 4:5 aspect ratio/,
  );

  const pngRoot = await makeCandidateRoot(t);
  await writeProfile(pngRoot, `${SLUG}.webp`);
  await writeImage(pngRoot, sharp({
    create: {
      width: 400,
      height: 500,
      channels: 3,
      background: '#123456',
    },
  }).png());
  await assert.rejects(
    () => validateProfileCandidate({ slug: SLUG, rootDirectory: pngRoot }),
    /encoded as WebP/,
  );
});

test('rejects oversized and metadata-bearing exact 4:5 WebP photos', async (t) => {
  const oversizedRoot = await makeCandidateRoot(t);
  await writeProfile(oversizedRoot, `${SLUG}.webp`);
  await writeImage(oversizedRoot, sharp({
    create: {
      width: 804,
      height: 1005,
      channels: 3,
      background: '#123456',
    },
  }).webp());
  await assert.rejects(
    () => validateProfileCandidate({ slug: SLUG, rootDirectory: oversizedRoot }),
    /must not exceed 800x1000 pixels/,
  );

  const metadataRoot = await makeCandidateRoot(t);
  await writeProfile(metadataRoot, `${SLUG}.webp`);
  await writeImage(metadataRoot, sharp({
    create: {
      width: 400,
      height: 500,
      channels: 3,
      background: '#123456',
    },
  }).webp().withMetadata({ orientation: 1 }));
  await assert.rejects(
    () => validateProfileCandidate({ slug: SLUG, rootDirectory: metadataRoot }),
    /must not contain embedded metadata/,
  );
});

async function makeCandidateRoot(t: test.TestContext) {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'grasp-profile-candidate-'));
  await fs.mkdir(path.join(rootDirectory, 'src', 'data', 'members'), { recursive: true });
  t.after(() => fs.rm(rootDirectory, { recursive: true, force: true }));
  return rootDirectory;
}

async function writeProfile(rootDirectory: string, photo: string) {
  const profile = {
    listed: false,
    order: 4,
    name: 'Example Member',
    position: 'Undergraduate Student',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo,
  };
  await fs.writeFile(
    path.join(rootDirectory, 'src', 'data', 'members', `${SLUG}.json`),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
}

async function writeImage(rootDirectory: string, image: sharp.Sharp) {
  await image.toFile(path.join(rootDirectory, 'src', 'data', 'members', `${SLUG}.webp`));
}
