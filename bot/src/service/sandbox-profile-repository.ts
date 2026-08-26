import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { assertMemberProfile, type MemberProfile } from '../domain/member-profile.js';
import type {
  ProfilePublisher,
  ProfilePublishInput,
  ProfilePublishResult,
  ProfileRepositoryReader,
  RepositoryProfileSnapshot,
} from './profile-service.js';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const GENERATION_PATTERN = /^\d{16}$/;
const MAX_PROFILE_JSON_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_PROFILE_PHOTO_BYTES = 20 * 1024 * 1024;
const DISCORD_GUILD_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const PHOTO_BLOB_NAME_PATTERN = /^([0-9a-f]{40})\.webp$/;
const TEMPORARY_ENTRY_PATTERN = /^\.tmp-[A-Za-z0-9_-]+$/;

export const SANDBOX_RETAINED_REVISIONS = 8;
export const SANDBOX_STALE_TEMP_AGE_MS = 60 * 60 * 1000;

const profileActions = new Set<ProfilePublishInput['action']>([
  'PROFILE_CREATE',
  'PROFILE_UPDATE',
  'PROFILE_REPLACE_PHOTO',
  'PROFILE_REMOVE_PHOTO',
  'PROFILE_SET_LISTED',
]);

const publicationTails = new Map<string, Promise<void>>();

type SandboxMetadata = {
  version: 1;
  generation: number;
  slug: string;
  action: ProfilePublishInput['action'];
  operationId: string;
  profileBlobSha: string;
  photoBlobSha: string | null;
  commitSha: string;
  createdAt: string;
};

type LoadedRevision = {
  generation: number;
  profile: MemberProfile;
  profileBytes: Buffer;
  profileBlobSha: string;
  commitSha: string;
  operationId: string;
  photoPath?: string;
  photoBlobSha?: string;
};

type SandboxProfileDirectories = {
  revisionsDirectory: string;
  blobsDirectory: string;
};

type PreparedPublication = {
  operationId: string;
  slug: string;
  action: ProfilePublishInput['action'];
  profile: MemberProfile;
  profileBytes: Buffer;
  profileExpectedSha: string | null;
  photo?:
    | {
        kind: 'upsert';
        bytes: Buffer;
        expectedSha: string | null;
      }
    | {
        kind: 'delete';
        expectedSha: string;
      };
};

export type SandboxProfileRepositoryErrorCode =
  | 'invalid_input'
  | 'content_conflict'
  | 'storage_corrupt'
  | 'storage_error';

export class SandboxProfileRepositoryError extends Error {
  readonly code: SandboxProfileRepositoryErrorCode;

  constructor(
    code: SandboxProfileRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SandboxProfileRepositoryError';
    this.code = code;
  }
}

/**
 * A volume-backed profile repository for testing the bot without touching GitHub.
 *
 * Each guild is isolated below a validated snowflake path. Publications are
 * written to a private temporary directory and exposed by one same-filesystem
 * directory rename. Readers only consider numbered revision directories, so an
 * interrupted write cannot expose a partial profile/meta set. Photos are stored
 * once by content hash and hard-linked into revisions, while both revision and
 * photo history are retained within a fixed local bound.
 */
export class SandboxProfileRepository implements ProfilePublisher, ProfileRepositoryReader {
  readonly #baseRootDirectory: string;
  readonly #guildId: string;
  readonly #rootDirectory: string;
  readonly #now: () => Date;

  constructor(options: { rootDirectory: string; guildId: string; now?: () => Date }) {
    if (!options || typeof options.rootDirectory !== 'string' || !options.rootDirectory.trim()) {
      throw new SandboxProfileRepositoryError(
        'invalid_input',
        'Sandbox root directory is required.',
      );
    }

    if (
      typeof options.guildId !== 'string'
      || !DISCORD_GUILD_ID_PATTERN.test(options.guildId)
    ) {
      throw new SandboxProfileRepositoryError(
        'invalid_input',
        'Sandbox Discord guild ID must be a positive decimal snowflake.',
      );
    }

    this.#baseRootDirectory = resolve(options.rootDirectory);
    this.#guildId = options.guildId;
    this.#rootDirectory = join(this.#baseRootDirectory, 'guilds', this.#guildId);
    this.#now = options.now ?? (() => new Date());
  }

  async publish(input: ProfilePublishInput): Promise<ProfilePublishResult> {
    const prepared = prepareInput(input);
    const normalizedRoot = process.platform === 'win32'
      ? this.#rootDirectory.toLowerCase()
      : this.#rootDirectory;
    const lockKey = `${normalizedRoot}\0${prepared.slug}`;

    return withPublicationLock(lockKey, () => this.#publishLocked(prepared));
  }

  async readProfile(slug: string): Promise<RepositoryProfileSnapshot | null> {
    assertValidSlug(slug);
    const revision = await this.#readLatestRevision(slug);

    if (!revision) {
      return null;
    }

    return {
      profile: revision.profile,
      profileBlobSha: revision.profileBlobSha,
      commitSha: revision.commitSha,
      operationId: revision.operationId,
      ...(revision.photoBlobSha ? { photoBlobSha: revision.photoBlobSha } : {}),
    };
  }

  async #publishLocked(prepared: PreparedPublication): Promise<ProfilePublishResult> {
    const current = await this.#readLatestRevision(prepared.slug);
    assertExpectedSha(
      'profile JSON',
      prepared.profileExpectedSha,
      current?.profileBlobSha ?? null,
    );

    if (prepared.photo) {
      assertExpectedSha('profile photo', prepared.photo.expectedSha, current?.photoBlobSha ?? null);
    }

    let photoBytes: Buffer | undefined;
    let photoBlobSha: string | undefined;

    if (prepared.photo?.kind === 'upsert') {
      photoBytes = prepared.photo.bytes;
      photoBlobSha = gitBlobSha(photoBytes);
    } else if (!prepared.photo) {
      photoBlobSha = current?.photoBlobSha;
    }

    const expectedPhotoName = `${prepared.slug}.webp`;

    if (prepared.profile.photo === expectedPhotoName && !photoBlobSha) {
      throw new SandboxProfileRepositoryError(
        'invalid_input',
        'The profile references a photo, but no photo would be stored.',
      );
    }

    if (prepared.profile.photo === '' && photoBlobSha) {
      throw new SandboxProfileRepositoryError(
        'invalid_input',
        'Removing the profile photo requires an explicit photo deletion.',
      );
    }

    const profileBlobSha = gitBlobSha(prepared.profileBytes);

    if (
      current
      && current.profileBlobSha === profileBlobSha
      && current.photoBlobSha === photoBlobSha
    ) {
      const directories = await this.#findProfileDirectories(prepared.slug);

      if (!directories) {
        throw corruptRevision('The current sandbox profile storage disappeared during publication.');
      }

      await this.#maintainProfileStorage(
        prepared.slug,
        directories,
        SANDBOX_RETAINED_REVISIONS,
      );

      return {
        status: 'no_change',
        attempts: 1,
        profileBlobSha,
        commitSha: current.commitSha,
        ...(photoBlobSha ? { photoBlobSha } : {}),
      };
    }

    const generation = (current?.generation ?? 0) + 1;
    const publicationTime = this.#now();

    if (!(publicationTime instanceof Date) || !Number.isFinite(publicationTime.getTime())) {
      throw new SandboxProfileRepositoryError(
        'storage_error',
        'The sandbox clock returned an invalid publication time.',
      );
    }

    const createdAt = publicationTime.toISOString();
    const commitSha = sandboxCommitSha({
      generation,
      slug: prepared.slug,
      action: prepared.action,
      operationId: prepared.operationId,
      profileBlobSha,
      createdAt,
      ...(photoBlobSha ? { photoBlobSha } : {}),
    });
    const metadata: SandboxMetadata = {
      version: 1,
      generation,
      slug: prepared.slug,
      action: prepared.action,
      operationId: prepared.operationId,
      profileBlobSha,
      photoBlobSha: photoBlobSha ?? null,
      commitSha,
      createdAt,
    };

    await this.#commitRevision(
      prepared.slug,
      generation,
      prepared.profileBytes,
      photoBytes,
      current?.photoPath,
      photoBlobSha,
      metadata,
    );

    return {
      status: 'sandbox',
      attempts: 1,
      profileBlobSha,
      commitSha,
      ...(photoBlobSha ? { photoBlobSha } : {}),
    };
  }

  async #commitRevision(
    slug: string,
    generation: number,
    profileBytes: Buffer,
    photoBytes: Buffer | undefined,
    currentPhotoPath: string | undefined,
    photoBlobSha: string | undefined,
    metadata: SandboxMetadata,
  ) {
    let finalDirectory: string | undefined;
    let temporaryDirectory: string | undefined;

    try {
      const { revisionsDirectory, blobsDirectory } = await this.#ensureProfileDirectories(slug);
      await this.#maintainProfileStorage(
        slug,
        { revisionsDirectory, blobsDirectory },
        SANDBOX_RETAINED_REVISIONS - 1,
      );

      let photoSourcePath = currentPhotoPath;

      if (photoBytes && photoBlobSha) {
        await this.#storePhotoBlob(blobsDirectory, photoBlobSha, photoBytes);
        photoSourcePath = join(blobsDirectory, `${photoBlobSha}.webp`);
      }

      finalDirectory = join(revisionsDirectory, formatGeneration(generation));
      temporaryDirectory = await mkdtemp(join(revisionsDirectory, '.tmp-'));
      await writeFile(
        join(temporaryDirectory, 'profile.json'),
        profileBytes,
        { flag: 'wx', flush: true },
      );

      if (photoBlobSha) {
        if (!photoSourcePath) {
          throw corruptRevision('The current profile photo source is unavailable.');
        }

        await link(photoSourcePath, join(temporaryDirectory, 'photo.webp'));
      }

      await writeFile(
        join(temporaryDirectory, 'meta.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', flush: true },
      );

      await rename(temporaryDirectory, finalDirectory);
      temporaryDirectory = undefined;
    } catch (error) {
      const collided = !(error instanceof SandboxProfileRepositoryError)
        && (
          isAlreadyExistsError(error)
          || (finalDirectory !== undefined
            && await pathExists(finalDirectory).catch(() => false))
        );

      if (collided) {
        throw new SandboxProfileRepositoryError(
          'content_conflict',
          'The sandbox profile changed during publication. Reopen the profile editor.',
          { cause: error },
        );
      }

      if (error instanceof SandboxProfileRepositoryError) {
        throw error;
      }

      throw new SandboxProfileRepositoryError(
        'storage_error',
        'The sandbox profile revision could not be stored.',
        { cause: error },
      );
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #readLatestRevision(slug: string): Promise<LoadedRevision | null> {
    const directories = await this.#findProfileDirectories(slug);

    if (!directories) {
      return null;
    }

    const { revisionsDirectory } = directories;

    let entries;

    try {
      entries = await readdir(revisionsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }

      throw new SandboxProfileRepositoryError(
        'storage_error',
        'The sandbox profile directory could not be read.',
        { cause: error },
      );
    }

    const generations = entries
      .filter((entry) => entry.isDirectory() && GENERATION_PATTERN.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((generation) => Number.isSafeInteger(generation) && generation > 0)
      .sort((left, right) => right - left);
    const generation = generations[0];

    if (generation === undefined) {
      return null;
    }

    return this.#readRevision(directories, slug, generation);
  }

  async #readRevision(
    directories: SandboxProfileDirectories,
    slug: string,
    generation: number,
  ): Promise<LoadedRevision> {
    const { revisionsDirectory } = directories;
    const revisionDirectory = join(revisionsDirectory, formatGeneration(generation));

    try {
      const revisionStatus = await lstat(revisionDirectory);

      if (!revisionStatus.isDirectory() || revisionStatus.isSymbolicLink()) {
        throw corruptRevision('The stored profile revision is not a regular directory.');
      }

      await assertContainedPath(await realpath(revisionsDirectory), revisionDirectory);

      const [profileBytes, metadataBytes] = await Promise.all([
        readRegularFile(
          join(revisionDirectory, 'profile.json'),
          'profile JSON',
          MAX_PROFILE_JSON_BYTES,
        ),
        readRegularFile(
          join(revisionDirectory, 'meta.json'),
          'profile metadata',
          MAX_METADATA_BYTES,
        ),
      ]);

      const metadata = parseMetadata(metadataBytes, slug, generation);
      const profile = parseStoredProfile(profileBytes, slug);
      const profileBlobSha = gitBlobSha(profileBytes);
      const storedPhotoBlobSha = metadata.photoBlobSha;

      const expectedCommitSha = sandboxCommitSha({
        generation,
        slug,
        action: metadata.action,
        operationId: metadata.operationId,
        profileBlobSha: metadata.profileBlobSha,
        createdAt: metadata.createdAt,
        ...(storedPhotoBlobSha ? { photoBlobSha: storedPhotoBlobSha } : {}),
      });

      if (metadata.commitSha !== expectedCommitSha) {
        throw corruptRevision('The stored revision identifier does not match its metadata.');
      }

      if (metadata.profileBlobSha !== profileBlobSha) {
        throw corruptRevision('The stored profile JSON hash does not match its metadata.');
      }

      if (storedPhotoBlobSha) {
        const photoPath = join(revisionDirectory, 'photo.webp');
        const photoBytes = await readRegularFile(
          photoPath,
          'profile photo',
          MAX_PROFILE_PHOTO_BYTES,
        );

        if (gitBlobSha(photoBytes) !== storedPhotoBlobSha) {
          throw corruptRevision('The stored profile photo hash does not match its metadata.');
        }
      } else if (await pathExists(join(revisionDirectory, 'photo.webp'))) {
        throw corruptRevision('The stored revision contains an unexpected inline profile photo.');
      }

      const expectedPhotoName = `${slug}.webp`;

      if (profile.photo === expectedPhotoName && !storedPhotoBlobSha) {
        throw corruptRevision('The stored profile references a missing photo.');
      }

      if (profile.photo === '' && storedPhotoBlobSha) {
        throw corruptRevision('The stored profile has a photo that its JSON does not reference.');
      }

      return {
        generation,
        profile,
        profileBytes,
        profileBlobSha,
        commitSha: metadata.commitSha,
        operationId: metadata.operationId,
        ...(storedPhotoBlobSha
          ? {
              photoPath: join(revisionDirectory, 'photo.webp'),
              photoBlobSha: storedPhotoBlobSha,
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof SandboxProfileRepositoryError) {
        throw error;
      }

      throw corruptRevision('The latest sandbox profile revision is incomplete or unreadable.', error);
    }
  }

  async #findProfileDirectories(slug: string): Promise<SandboxProfileDirectories | null> {
    try {
      const rootStatus = await lstatOrNull(this.#baseRootDirectory);

      if (!rootStatus) {
        return null;
      }

      const canonicalRoot = await canonicalRootDirectory(this.#baseRootDirectory);
      let current = this.#baseRootDirectory;

      for (const segment of ['guilds', this.#guildId, 'profiles', slug]) {
        current = join(current, segment);
        const status = await lstatOrNull(current);

        if (!status) {
          return null;
        }

        if (!status.isDirectory() || status.isSymbolicLink()) {
          throw corruptRevision('The sandbox storage layout contains an unsafe managed path.');
        }
      }

      await assertContainedPath(canonicalRoot, current);
      const revisionsDirectory = join(current, 'revisions');
      const blobsDirectory = join(current, 'blobs');

      for (const directory of [revisionsDirectory, blobsDirectory]) {
        const status = await lstatOrNull(directory);

        if (!status || !status.isDirectory() || status.isSymbolicLink()) {
          throw corruptRevision('The sandbox profile storage is incomplete or unsafe.');
        }

        await assertContainedPath(canonicalRoot, directory);
      }

      return { revisionsDirectory, blobsDirectory };
    } catch (error) {
      if (error instanceof SandboxProfileRepositoryError) {
        throw error;
      }

      throw new SandboxProfileRepositoryError(
        'storage_error',
        'The sandbox profile directory could not be inspected safely.',
        { cause: error },
      );
    }
  }

  async #ensureProfileDirectories(slug: string): Promise<SandboxProfileDirectories> {
    try {
      await mkdir(this.#baseRootDirectory, { recursive: true });
      const canonicalRoot = await canonicalRootDirectory(this.#baseRootDirectory);
      let current = this.#baseRootDirectory;

      for (const segment of ['guilds', this.#guildId, 'profiles', slug]) {
        current = join(current, segment);

        try {
          await mkdir(current);
        } catch (error) {
          if (!isAlreadyExistsError(error)) {
            throw error;
          }
        }

        const status = await lstat(current);

        if (!status.isDirectory() || status.isSymbolicLink()) {
          throw corruptRevision('The sandbox storage layout contains an unsafe managed path.');
        }

        await assertContainedPath(canonicalRoot, current);
      }

      const revisionsDirectory = join(current, 'revisions');
      const blobsDirectory = join(current, 'blobs');

      for (const directory of [revisionsDirectory, blobsDirectory]) {
        try {
          await mkdir(directory);
        } catch (error) {
          if (!isAlreadyExistsError(error)) {
            throw error;
          }
        }

        const status = await lstat(directory);

        if (!status.isDirectory() || status.isSymbolicLink()) {
          throw corruptRevision('The sandbox storage layout contains an unsafe managed path.');
        }

        await assertContainedPath(canonicalRoot, directory);
      }

      return { revisionsDirectory, blobsDirectory };
    } catch (error) {
      if (error instanceof SandboxProfileRepositoryError) {
        throw error;
      }

      throw new SandboxProfileRepositoryError(
        'storage_error',
        'The sandbox profile directory could not be created safely.',
        { cause: error },
      );
    }
  }

  async #storePhotoBlob(blobsDirectory: string, photoBlobSha: string, bytes: Buffer) {
    const finalPath = join(blobsDirectory, `${photoBlobSha}.webp`);
    const existing = await lstatOrNull(finalPath);

    if (existing) {
      const stored = await readRegularFile(finalPath, 'profile photo', MAX_PROFILE_PHOTO_BYTES);

      if (gitBlobSha(stored) !== photoBlobSha || !stored.equals(bytes)) {
        throw corruptRevision('The stored profile photo blob does not match its name.');
      }

      return;
    }

    let temporaryDirectory: string | undefined;

    try {
      temporaryDirectory = await mkdtemp(join(blobsDirectory, '.tmp-'));
      const temporaryPath = join(temporaryDirectory, 'photo.webp');
      await writeFile(temporaryPath, bytes, { flag: 'wx', flush: true });

      try {
        await link(temporaryPath, finalPath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }

        const stored = await readRegularFile(finalPath, 'profile photo', MAX_PROFILE_PHOTO_BYTES);

        if (gitBlobSha(stored) !== photoBlobSha || !stored.equals(bytes)) {
          throw corruptRevision('A conflicting profile photo blob already exists.');
        }
      }
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async #maintainProfileStorage(
    slug: string,
    directories: SandboxProfileDirectories,
    retainedBeforeCommit: number,
  ) {
    try {
      await this.#maintainProfileStorageUnchecked(
        slug,
        directories,
        retainedBeforeCommit,
      );
    } catch (error) {
      if (error instanceof SandboxProfileRepositoryError) {
        throw error;
      }

      throw new SandboxProfileRepositoryError(
        'storage_error',
        'The sandbox profile history could not be cleaned safely.',
        { cause: error },
      );
    }
  }

  async #maintainProfileStorageUnchecked(
    slug: string,
    directories: SandboxProfileDirectories,
    retainedBeforeCommit: number,
  ) {
    const { revisionsDirectory, blobsDirectory } = directories;
    const revisionEntries = await readdir(revisionsDirectory, { withFileTypes: true });
    const generations = revisionEntries
      .filter((entry) => entry.isDirectory() && GENERATION_PATTERN.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((generation) => Number.isSafeInteger(generation) && generation > 0)
      .sort((left, right) => right - left);
    const retained = generations.slice(0, retainedBeforeCommit);
    const pruned = generations.slice(retainedBeforeCommit);
    const referencedPhotoBlobs = new Set<string>();
    const invalidHistoricalGenerations: number[] = [];

    for (const generation of retained) {
      try {
        const metadataBytes = await readRegularFile(
          join(revisionsDirectory, formatGeneration(generation), 'meta.json'),
          'profile metadata',
          MAX_METADATA_BYTES,
        );
        const metadata = parseMetadata(metadataBytes, slug, generation);

        if (metadata.photoBlobSha) {
          referencedPhotoBlobs.add(metadata.photoBlobSha);
        }
      } catch (error) {
        if (generation === generations[0]) {
          throw error;
        }

        invalidHistoricalGenerations.push(generation);
      }
    }

    for (const generation of [...pruned, ...invalidHistoricalGenerations]) {
      await removeManagedDirectory(
        revisionsDirectory,
        formatGeneration(generation),
        'sandbox profile revision',
      );
    }

    const blobEntries = await readdir(blobsDirectory, { withFileTypes: true });

    for (const entry of blobEntries) {
      const match = PHOTO_BLOB_NAME_PATTERN.exec(entry.name);

      if (match && !referencedPhotoBlobs.has(match[1]!)) {
        await removeManagedFile(blobsDirectory, entry.name, 'sandbox profile photo blob');
      }
    }

    const nowMs = Date.now();
    await Promise.all([
      removeStaleTemporaryDirectories(revisionsDirectory, nowMs),
      removeStaleTemporaryDirectories(blobsDirectory, nowMs),
    ]);
  }
}

function prepareInput(input: ProfilePublishInput): PreparedPublication {
  if (!input || typeof input !== 'object') {
    throw new SandboxProfileRepositoryError('invalid_input', 'Profile publication is invalid.');
  }

  assertValidSlug(input.slug);

  if (typeof input.operationId !== 'string' || !OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new SandboxProfileRepositoryError('invalid_input', 'Operation ID is invalid.');
  }

  if (typeof input.action !== 'string' || !profileActions.has(input.action)) {
    throw new SandboxProfileRepositoryError('invalid_input', 'Profile action is invalid.');
  }

  const runtimeProfile = input.profile as unknown;

  if (
    !isRecord(runtimeProfile)
    || typeof runtimeProfile.json !== 'string'
    || !('expectedSha' in runtimeProfile)
  ) {
    throw new SandboxProfileRepositoryError('invalid_input', 'Profile publication is invalid.');
  }

  const runtimePhoto = input.photo as unknown;

  if (
    runtimePhoto !== undefined
    && (
      !isRecord(runtimePhoto)
      || (runtimePhoto.kind !== 'upsert' && runtimePhoto.kind !== 'delete')
      || !('expectedSha' in runtimePhoto)
    )
  ) {
    throw new SandboxProfileRepositoryError('invalid_input', 'Photo publication is invalid.');
  }

  assertExpectedShaSyntax(input.profile.expectedSha, 'profile expected SHA');

  if (input.photo) {
    assertExpectedShaSyntax(input.photo.expectedSha, 'photo expected SHA');
  }

  if (
    input.photo?.kind === 'upsert'
    && (
      !(input.photo.bytes instanceof Uint8Array)
      || input.photo.bytes.byteLength === 0
      || input.photo.bytes.byteLength > MAX_PROFILE_PHOTO_BYTES
    )
  ) {
    throw new SandboxProfileRepositoryError(
      'invalid_input',
      'Photo bytes must be a non-empty Uint8Array no larger than 20 MiB.',
    );
  }

  const profileBytes = Buffer.from(input.profile.json, 'utf8');

  if (profileBytes.byteLength > MAX_PROFILE_JSON_BYTES) {
    throw new SandboxProfileRepositoryError(
      'invalid_input',
      'Profile JSON exceeds the size limit.',
    );
  }

  let profile: unknown;

  try {
    profile = JSON.parse(input.profile.json);
    assertMemberProfile(profile);
  } catch (error) {
    throw new SandboxProfileRepositoryError(
      'invalid_input',
      'Profile JSON does not match the member schema.',
      { cause: error },
    );
  }

  const expectedPhotoName = `${input.slug}.webp`;

  if (profile.photo !== '' && profile.photo !== expectedPhotoName) {
    throw new SandboxProfileRepositoryError(
      'invalid_input',
      `Bot-managed profiles may only reference ${expectedPhotoName}.`,
    );
  }

  if (input.photo?.kind === 'upsert' && profile.photo !== expectedPhotoName) {
    throw new SandboxProfileRepositoryError(
      'invalid_input',
      'Photo upsert requires the profile photo field.',
    );
  }

  if (input.photo?.kind === 'delete' && profile.photo !== '') {
    throw new SandboxProfileRepositoryError(
      'invalid_input',
      'Photo deletion requires an empty profile photo field.',
    );
  }

  const prepared: PreparedPublication = {
    operationId: input.operationId,
    slug: input.slug,
    action: input.action,
    profile,
    profileBytes,
    profileExpectedSha: input.profile.expectedSha,
  };

  if (input.photo?.kind === 'upsert') {
    prepared.photo = {
      kind: 'upsert',
      bytes: Buffer.from(input.photo.bytes),
      expectedSha: input.photo.expectedSha,
    };
  } else if (input.photo?.kind === 'delete') {
    prepared.photo = {
      kind: 'delete',
      expectedSha: input.photo.expectedSha,
    };
  }

  return prepared;
}

function parseStoredProfile(bytes: Buffer, slug: string) {
  let profile: unknown;

  try {
    profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertMemberProfile(profile);
  } catch (error) {
    throw corruptRevision('The stored profile JSON is not a canonical member profile.', error);
  }

  if (profile.photo !== '' && profile.photo !== `${slug}.webp`) {
    throw corruptRevision('The stored profile references a photo outside its sandbox revision.');
  }

  return profile;
}

function parseMetadata(bytes: Buffer, slug: string, generation: number): SandboxMetadata {
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw corruptRevision('The stored profile metadata is not valid JSON.', error);
  }

  if (!isRecord(value)) {
    throw corruptRevision('The stored profile metadata is invalid.');
  }

  const photoBlobSha = value.photoBlobSha;

  if (
    value.version !== 1
    || value.generation !== generation
    || value.slug !== slug
    || typeof value.action !== 'string'
    || !profileActions.has(value.action as ProfilePublishInput['action'])
    || typeof value.operationId !== 'string'
    || !OPERATION_ID_PATTERN.test(value.operationId)
    || typeof value.profileBlobSha !== 'string'
    || !SHA_PATTERN.test(value.profileBlobSha)
    || (photoBlobSha !== null && (typeof photoBlobSha !== 'string' || !SHA_PATTERN.test(photoBlobSha)))
    || typeof value.commitSha !== 'string'
    || !SHA_PATTERN.test(value.commitSha)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw corruptRevision('The stored profile metadata is invalid.');
  }

  return {
    version: 1,
    generation,
    slug,
    action: value.action as ProfilePublishInput['action'],
    operationId: value.operationId,
    profileBlobSha: value.profileBlobSha,
    photoBlobSha,
    commitSha: value.commitSha,
    createdAt: value.createdAt,
  };
}

function assertValidSlug(slug: string) {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug) || slug.length > 64) {
    throw new SandboxProfileRepositoryError('invalid_input', 'Profile slug is invalid.');
  }
}

function assertExpectedShaSyntax(value: unknown, label: string) {
  if (value !== null && (typeof value !== 'string' || !SHA_PATTERN.test(value))) {
    throw new SandboxProfileRepositoryError('invalid_input', `${label} must be a full Git SHA.`);
  }
}

function assertExpectedSha(label: string, expected: string | null, actual: string | null) {
  if (expected !== actual) {
    throw new SandboxProfileRepositoryError(
      'content_conflict',
      `The ${label} changed since the profile editor was opened.`,
    );
  }
}

function gitBlobSha(bytes: Uint8Array) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function sandboxCommitSha(input: {
  generation: number;
  slug: string;
  action: ProfilePublishInput['action'];
  operationId: string;
  profileBlobSha: string;
  photoBlobSha?: string;
  createdAt: string;
}) {
  return createHash('sha1')
    .update('sandbox-profile-revision\0')
    .update(JSON.stringify(input))
    .digest('hex');
}

function formatGeneration(generation: number) {
  if (!Number.isSafeInteger(generation) || generation <= 0 || generation > 9_999_999_999_999_999) {
    throw new SandboxProfileRepositoryError(
      'storage_error',
      'The sandbox profile revision counter is exhausted.',
    );
  }

  return generation.toString().padStart(16, '0');
}

async function withPublicationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = publicationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(() => current);
  publicationTails.set(key, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();

    if (publicationTails.get(key) === tail) {
      publicationTails.delete(key);
    }
  }
}

async function readRegularFile(path: string, label: string, maxBytes: number) {
  const status = await lstat(path);

  if (!status.isFile() || status.isSymbolicLink()) {
    throw corruptRevision(`The stored ${label} is not a regular file.`);
  }

  if (status.size > maxBytes) {
    throw corruptRevision(`The stored ${label} exceeds its size limit.`);
  }

  const bytes = await readFile(path);

  if (bytes.byteLength > maxBytes) {
    throw corruptRevision(`The stored ${label} exceeds its size limit.`);
  }

  return bytes;
}

async function removeManagedDirectory(parent: string, name: string, label: string) {
  const path = join(parent, name);
  const status = await lstat(path);

  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw corruptRevision(`The ${label} selected for cleanup is not a regular directory.`);
  }

  await assertContainedPath(await realpath(parent), path);
  await rm(path, { recursive: true, force: false });
}

async function removeManagedFile(parent: string, name: string, label: string) {
  const path = join(parent, name);
  const status = await lstat(path);

  if (!status.isFile() || status.isSymbolicLink()) {
    throw corruptRevision(`The ${label} selected for cleanup is not a regular file.`);
  }

  await assertContainedPath(await realpath(parent), path);
  await rm(path, { force: false });
}

async function removeStaleTemporaryDirectories(parent: string, nowMs: number) {
  const entries = await readdir(parent, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !TEMPORARY_ENTRY_PATTERN.test(entry.name)) {
      continue;
    }

    const path = join(parent, entry.name);
    const status = await lstat(path);

    if (
      !status.isDirectory()
      || status.isSymbolicLink()
      || nowMs - status.mtimeMs < SANDBOX_STALE_TEMP_AGE_MS
    ) {
      continue;
    }

    await assertContainedPath(await realpath(parent), path);
    await rm(path, { recursive: true, force: false });
  }
}

async function canonicalRootDirectory(rootDirectory: string) {
  const canonicalRoot = await realpath(rootDirectory);
  const status = await lstat(canonicalRoot);

  if (!status.isDirectory()) {
    throw corruptRevision('The sandbox root is not a directory.');
  }

  return canonicalRoot;
}

async function assertContainedPath(canonicalRoot: string, path: string) {
  const canonicalPath = await realpath(path);
  const relativePath = relative(canonicalRoot, canonicalPath);

  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw corruptRevision('A managed sandbox path escapes the configured root directory.');
  }
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function corruptRevision(message: string, cause?: unknown) {
  return new SandboxProfileRepositoryError(
    'storage_corrupt',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isNotFoundError(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown) {
  return isRecord(error) && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
