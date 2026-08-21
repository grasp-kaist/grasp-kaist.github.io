#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const PROFILE_DIRECTORY = path.join('src', 'data', 'members');
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function validateProfileCandidate({
  slug,
  rootDirectory = process.cwd(),
}) {
  if (typeof slug !== 'string' || slug.length > 64 || !SLUG_PATTERN.test(slug)) {
    throw new Error('Candidate profile slug is invalid.');
  }

  const membersDirectory = path.resolve(rootDirectory, PROFILE_DIRECTORY);
  const profilePath = path.join(membersDirectory, `${slug}.json`);
  const photoPath = path.join(membersDirectory, `${slug}.webp`);

  await requireRegularFile(profilePath, 'Candidate profile JSON');

  let profile;
  try {
    profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  } catch (error) {
    throw new Error('Candidate profile JSON could not be parsed.', { cause: error });
  }

  if (!isRecord(profile) || typeof profile.photo !== 'string') {
    throw new Error('Candidate profile JSON must contain a string photo field.');
  }

  const expectedPhoto = `${slug}.webp`;
  if (profile.photo !== '' && profile.photo !== expectedPhoto) {
    throw new Error(`Candidate profile photo must be empty or exactly ${expectedPhoto}.`);
  }

  const photoStat = await optionalLstat(photoPath);

  if (profile.photo === '') {
    if (photoStat) {
      throw new Error(`Orphan bot-managed photo exists while ${slug}.json has an empty photo field.`);
    }

    return { slug, hasPhoto: false };
  }

  if (!photoStat?.isFile()) {
    throw new Error('Referenced bot-managed photo must exist as a regular file.');
  }

  let metadata;
  try {
    const photoBytes = await fs.readFile(photoPath);
    metadata = await sharp(photoBytes, { animated: true }).metadata();
  } catch (error) {
    throw new Error('Referenced bot-managed photo is not a readable image.', { cause: error });
  }

  if (metadata.format !== 'webp') {
    throw new Error('Bot-managed profile photo must be encoded as WebP.');
  }

  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error('Bot-managed profile photo dimensions are missing.');
  }

  if (metadata.width * 5 !== metadata.height * 4) {
    throw new Error('Bot-managed profile photo must have an exact 4:5 aspect ratio.');
  }

  if (metadata.width > 800 || metadata.height > 1000) {
    throw new Error('Bot-managed profile photo must not exceed 800x1000 pixels.');
  }

  if ((metadata.pages ?? 1) !== 1) {
    throw new Error('Bot-managed profile photo must contain exactly one image frame.');
  }

  const embeddedMetadata = ['exif', 'icc', 'iptc', 'xmp']
    .filter((field) => metadata[field] !== undefined);
  if (embeddedMetadata.length > 0) {
    throw new Error(
      `Bot-managed profile photo must not contain embedded metadata (${embeddedMetadata.join(', ')}).`,
    );
  }

  return {
    slug,
    hasPhoto: true,
    width: metadata.width,
    height: metadata.height,
  };
}

async function requireRegularFile(filePath, label) {
  const stat = await optionalLstat(filePath);

  if (!stat?.isFile()) {
    throw new Error(`${label} must exist as a regular file.`);
  }
}

async function optionalLstat(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function run() {
  const slug = process.argv[2];

  try {
    const result = await validateProfileCandidate({ slug });
    console.log(
      result.hasPhoto
        ? `Validated ${result.slug}.json and its ${result.width}x${result.height} WebP photo.`
        : `Validated ${result.slug}.json without a profile photo.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await run();
}
