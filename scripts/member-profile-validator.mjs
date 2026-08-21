import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const DEFAULT_SCHEMA_PATH = new URL('../schemas/member-profile.schema.json', import.meta.url);
const DEFAULT_MEMBERS_DIRECTORY = new URL('../src/data/members/', import.meta.url);
const ALLOWED_PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * @typedef {{ file: string, message: string }} ValidationIssue
 */

/**
 * Validate all member JSON files and their referenced photos.
 *
 * @param {{ membersDirectory?: URL | string, schemaPath?: URL | string }} [options]
 * @returns {Promise<{ profileCount: number, issues: ValidationIssue[] }>}
 */
export async function validateMemberProfiles(options = {}) {
  const membersDirectory = options.membersDirectory ?? DEFAULT_MEMBERS_DIRECTORY;
  const schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const directoryEntries = await fs.readdir(membersDirectory, { withFileTypes: true });
  const profileFiles = directoryEntries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
    .sort((a, b) => a.name.localeCompare(b.name));
  /** @type {ValidationIssue[]} */
  const issues = [];

  for (const entry of profileFiles) {
    const profilePath = resolveChildPath(membersDirectory, entry.name);
    let profile;

    try {
      profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
    } catch (error) {
      issues.push({
        file: entry.name,
        message: `cannot parse JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (!validate(profile)) {
      for (const error of validate.errors ?? []) {
        const location = error.instancePath || '/';
        issues.push({
          file: entry.name,
          message: `${location} ${error.message ?? 'is invalid'}`,
        });
      }
      continue;
    }

    if (profile.photo) {
      const extension = path.extname(profile.photo).toLowerCase();

      if (!ALLOWED_PHOTO_EXTENSIONS.has(extension)) {
        issues.push({
          file: entry.name,
          message: `/photo uses unsupported extension "${extension}"`,
        });
        continue;
      }

      const photoPath = resolveChildPath(membersDirectory, profile.photo);

      try {
        const photoStat = await fs.stat(photoPath);

        if (!photoStat.isFile()) {
          issues.push({
            file: entry.name,
            message: `/photo does not reference a file: "${profile.photo}"`,
          });
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          issues.push({
            file: entry.name,
            message: `/photo file is missing: "${profile.photo}"`,
          });
        } else {
          throw error;
        }
      }
    }
  }

  return { profileCount: profileFiles.length, issues };
}

function resolveChildPath(directory, childName) {
  if (directory instanceof URL) {
    return new URL(encodeURIComponent(childName), directory);
  }

  return path.join(directory, childName);
}
