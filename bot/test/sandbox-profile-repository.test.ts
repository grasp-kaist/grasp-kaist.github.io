import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  SANDBOX_RETAINED_REVISIONS,
  SANDBOX_STALE_TEMP_AGE_MS,
  SandboxProfileRepository,
  SandboxProfileRepositoryError,
} from '../src/service/sandbox-profile-repository.js';
import {
  ProfileService,
  type ProfilePublishInput,
} from '../src/service/profile-service.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const SLUG = 'sandbox-member';
const GUILD_ID = '111111111111111111';
const OTHER_GUILD_ID = '222222222222222222';

function createRepository(rootDirectory: string, guildId = GUILD_ID) {
  return new SandboxProfileRepository({ rootDirectory, guildId });
}

function profileStorageRoot(rootDirectory: string, guildId = GUILD_ID) {
  return join(rootDirectory, 'guilds', guildId, 'profiles', SLUG);
}

function profileJson(input: { name?: string; photo?: string } = {}) {
  return `${JSON.stringify({
    listed: false,
    order: 4,
    name: input.name ?? 'Sandbox Member',
    position: 'Undergraduate Student',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo: input.photo ?? '',
  }, null, 2)}\n`;
}

function publishInput(overrides: Partial<ProfilePublishInput> = {}): ProfilePublishInput {
  return {
    operationId: 'sandbox-operation-1',
    slug: SLUG,
    action: 'PROFILE_CREATE',
    profile: {
      json: profileJson(),
      expectedSha: null,
    },
    ...overrides,
  };
}

async function createRoot(t: TestContext) {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'grasp-profile-sandbox-'));
  t.after(async () => rm(rootDirectory, { recursive: true, force: true }));
  return rootDirectory;
}

test('atomically creates, updates, removes a photo, and reads every state after restart', async (t) => {
  const rootDirectory = await createRoot(t);
  const photo = Buffer.from('processed-webp-photo');
  let repository = createRepository(rootDirectory);

  assert.equal(await repository.readProfile(SLUG), null);

  const created = await repository.publish(publishInput({
    profile: {
      json: profileJson({ photo: `${SLUG}.webp` }),
      expectedSha: null,
    },
    photo: { kind: 'upsert', bytes: photo, expectedSha: null },
  }));

  assert.equal(created.status, 'sandbox');
  assert.match(created.profileBlobSha, /^[0-9a-f]{40}$/);
  assert.match(created.photoBlobSha ?? '', /^[0-9a-f]{40}$/);
  assert.match(created.commitSha ?? '', /^[0-9a-f]{40}$/);

  repository = createRepository(rootDirectory);
  const afterCreate = await repository.readProfile(SLUG);
  assert.equal(afterCreate?.profile.name, 'Sandbox Member');
  assert.equal(afterCreate?.profile.photo, `${SLUG}.webp`);
  assert.equal(afterCreate?.profileBlobSha, created.profileBlobSha);
  assert.equal(afterCreate?.photoBlobSha, created.photoBlobSha);
  assert.equal(afterCreate?.operationId, 'sandbox-operation-1');

  const updated = await repository.publish(publishInput({
    operationId: 'sandbox-operation-2',
    action: 'PROFILE_UPDATE',
    profile: {
      json: profileJson({ name: 'Updated Member', photo: `${SLUG}.webp` }),
      expectedSha: created.profileBlobSha,
    },
  }));

  assert.equal(updated.status, 'sandbox');
  assert.notEqual(updated.profileBlobSha, created.profileBlobSha);
  assert.equal(updated.photoBlobSha, created.photoBlobSha);

  repository = createRepository(rootDirectory);
  const afterUpdate = await repository.readProfile(SLUG);
  assert.equal(afterUpdate?.profile.name, 'Updated Member');
  assert.equal(afterUpdate?.photoBlobSha, created.photoBlobSha);
  const revisionsDirectory = join(profileStorageRoot(rootDirectory), 'revisions');
  assert.equal(
    (await stat(join(revisionsDirectory, '0000000000000001', 'photo.webp'))).ino,
    (await stat(join(revisionsDirectory, '0000000000000002', 'photo.webp'))).ino,
  );

  const removed = await repository.publish(publishInput({
    operationId: 'sandbox-operation-3',
    action: 'PROFILE_REMOVE_PHOTO',
    profile: {
      json: profileJson({ name: 'Updated Member' }),
      expectedSha: updated.profileBlobSha,
    },
    photo: {
      kind: 'delete',
      expectedSha: updated.photoBlobSha ?? '',
    },
  }));

  assert.equal(removed.status, 'sandbox');
  assert.equal(removed.photoBlobSha, undefined);

  repository = createRepository(rootDirectory);
  const afterDelete = await repository.readProfile(SLUG);
  assert.equal(afterDelete?.profile.photo, '');
  assert.equal(afterDelete?.photoBlobSha, undefined);
  assert.equal(afterDelete?.operationId, 'sandbox-operation-3');

  const revisions = (await readdir(revisionsDirectory)).filter((name) => /^\d{16}$/.test(name));
  assert.deepEqual(revisions.sort(), [
    '0000000000000001',
    '0000000000000002',
    '0000000000000003',
  ]);

  const finalRevision = join(revisionsDirectory, '0000000000000003');
  assert.equal(JSON.parse(await readFile(join(finalRevision, 'meta.json'), 'utf8')).generation, 3);
  await assert.rejects(() => readFile(join(finalRevision, 'photo.webp')), { code: 'ENOENT' });
  assert.deepEqual(
    await readFile(
      join(profileStorageRoot(rootDirectory), 'blobs', `${created.photoBlobSha}.webp`),
    ),
    photo,
  );
});

test('rejects stale profile and photo expected SHAs without exposing a new revision', async (t) => {
  const rootDirectory = await createRoot(t);
  const repository = createRepository(rootDirectory);
  const created = await repository.publish(publishInput({
    profile: {
      json: profileJson({ photo: `${SLUG}.webp` }),
      expectedSha: null,
    },
    photo: {
      kind: 'upsert',
      bytes: Buffer.from('photo-one'),
      expectedSha: null,
    },
  }));

  await assert.rejects(
    () => repository.publish(publishInput({
      operationId: 'stale-profile-operation',
      action: 'PROFILE_UPDATE',
      profile: {
        json: profileJson({ name: 'Must Not Publish', photo: `${SLUG}.webp` }),
        expectedSha: 'f'.repeat(40),
      },
    })),
    (error: unknown) => error instanceof SandboxProfileRepositoryError
      && error.code === 'content_conflict',
  );

  await assert.rejects(
    () => repository.publish(publishInput({
      operationId: 'stale-photo-operation',
      action: 'PROFILE_REMOVE_PHOTO',
      profile: {
        json: profileJson(),
        expectedSha: created.profileBlobSha,
      },
      photo: { kind: 'delete', expectedSha: 'e'.repeat(40) },
    })),
    (error: unknown) => error instanceof SandboxProfileRepositoryError
      && error.code === 'content_conflict',
  );

  const snapshot = await repository.readProfile(SLUG);
  assert.equal(snapshot?.profile.name, 'Sandbox Member');
  assert.equal(snapshot?.profile.photo, `${SLUG}.webp`);

  const revisions = await readdir(join(profileStorageRoot(rootDirectory), 'revisions'));
  assert.deepEqual(revisions.filter((name) => /^\d{16}$/.test(name)), ['0000000000000001']);
});

test('ignores an interrupted temporary revision and avoids a revision for no-change writes', async (t) => {
  const rootDirectory = await createRoot(t);
  let repository = createRepository(rootDirectory);
  const json = profileJson();
  const created = await repository.publish(publishInput({ profile: { json, expectedSha: null } }));
  const revisionsDirectory = join(profileStorageRoot(rootDirectory), 'revisions');
  const interruptedDirectory = join(revisionsDirectory, '.tmp-interrupted');
  await mkdir(interruptedDirectory);
  const staleTime = new Date(Date.now() - SANDBOX_STALE_TEMP_AGE_MS - 60_000);
  await utimes(interruptedDirectory, staleTime, staleTime);
  await readFile(join(revisionsDirectory, '0000000000000001', 'profile.json'));

  repository = createRepository(rootDirectory);
  const recovered = await repository.readProfile(SLUG);
  assert.equal(recovered?.profileBlobSha, created.profileBlobSha);

  const unchanged = await repository.publish(publishInput({
    operationId: 'sandbox-operation-no-change',
    action: 'PROFILE_UPDATE',
    profile: { json, expectedSha: created.profileBlobSha },
  }));

  assert.equal(unchanged.status, 'no_change');
  assert.equal(unchanged.commitSha, created.commitSha);
  const revisions = await readdir(revisionsDirectory);
  assert.deepEqual(revisions.filter((name) => /^\d{16}$/.test(name)), ['0000000000000001']);
  assert.ok(!revisions.includes('.tmp-interrupted'));
});

test('serializes concurrent creators and exposes exactly one complete revision', async (t) => {
  const rootDirectory = await createRoot(t);
  const firstRepository = createRepository(rootDirectory);
  const secondRepository = createRepository(rootDirectory);
  const publications = await Promise.allSettled([
    firstRepository.publish(publishInput({
      operationId: 'concurrent-operation-1',
      profile: { json: profileJson({ name: 'Concurrent One' }), expectedSha: null },
    })),
    secondRepository.publish(publishInput({
      operationId: 'concurrent-operation-2',
      profile: { json: profileJson({ name: 'Concurrent Two' }), expectedSha: null },
    })),
  ]);
  const fulfilled = publications.filter((result) => result.status === 'fulfilled');
  const rejected = publications.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0]?.value.status, 'sandbox');
  assert.ok(rejected[0]?.reason instanceof SandboxProfileRepositoryError);
  assert.equal(rejected[0]?.reason.code, 'content_conflict');

  const revisionsDirectory = join(profileStorageRoot(rootDirectory), 'revisions');
  const entries = await readdir(revisionsDirectory);
  assert.deepEqual(entries, ['0000000000000001']);

  const recovered = await createRepository(rootDirectory).readProfile(SLUG);
  assert.ok(
    recovered?.profile.name === 'Concurrent One'
    || recovered?.profile.name === 'Concurrent Two',
  );
});

test('isolates identical profile slugs by a traversal-safe Discord guild namespace', async (t) => {
  const rootDirectory = await createRoot(t);
  const firstRepository = createRepository(rootDirectory, GUILD_ID);
  const secondRepository = createRepository(rootDirectory, OTHER_GUILD_ID);

  const first = await firstRepository.publish(publishInput({
    operationId: 'first-guild-operation',
    profile: { json: profileJson({ name: 'First Guild' }), expectedSha: null },
  }));
  const second = await secondRepository.publish(publishInput({
    operationId: 'second-guild-operation',
    profile: { json: profileJson({ name: 'Second Guild' }), expectedSha: null },
  }));

  assert.equal(first.status, 'sandbox');
  assert.equal(second.status, 'sandbox');
  assert.equal((await firstRepository.readProfile(SLUG))?.profile.name, 'First Guild');
  assert.equal((await secondRepository.readProfile(SLUG))?.profile.name, 'Second Guild');
  assert.deepEqual((await readdir(join(rootDirectory, 'guilds'))).sort(), [
    GUILD_ID,
    OTHER_GUILD_ID,
  ].sort());

  assert.throws(
    () => new SandboxProfileRepository({ rootDirectory, guildId: '../escaped' }),
    (error: unknown) => error instanceof SandboxProfileRepositoryError
      && error.code === 'invalid_input',
  );
});

test('deduplicates photo blobs and bounds retained revisions and photo history', async (t) => {
  const rootDirectory = await createRoot(t);
  const repository = createRepository(rootDirectory);
  let latest = await repository.publish(publishInput({
    profile: {
      json: profileJson({ photo: `${SLUG}.webp` }),
      expectedSha: null,
    },
    photo: {
      kind: 'upsert',
      bytes: Buffer.from('initial-photo'),
      expectedSha: null,
    },
  }));

  for (let index = 1; index <= 3; index += 1) {
    latest = await repository.publish(publishInput({
      operationId: `profile-only-update-${index}`,
      action: 'PROFILE_UPDATE',
      profile: {
        json: profileJson({ name: `Profile Update ${index}`, photo: `${SLUG}.webp` }),
        expectedSha: latest.profileBlobSha,
      },
    }));
  }

  const storageRoot = profileStorageRoot(rootDirectory);
  let blobNames = (await readdir(join(storageRoot, 'blobs')))
    .filter((name) => /^[0-9a-f]{40}\.webp$/.test(name));
  assert.equal(blobNames.length, 1);

  for (let index = 1; index <= SANDBOX_RETAINED_REVISIONS + 3; index += 1) {
    latest = await repository.publish(publishInput({
      operationId: `photo-replacement-${index}`,
      action: 'PROFILE_REPLACE_PHOTO',
      profile: {
        json: profileJson({ name: `Photo Replacement ${index}`, photo: `${SLUG}.webp` }),
        expectedSha: latest.profileBlobSha,
      },
      photo: {
        kind: 'upsert',
        bytes: Buffer.from(`replacement-photo-${index}`),
        expectedSha: latest.photoBlobSha ?? null,
      },
    }));
  }

  const revisionNames = (await readdir(join(storageRoot, 'revisions')))
    .filter((name) => /^\d{16}$/.test(name));
  blobNames = (await readdir(join(storageRoot, 'blobs')))
    .filter((name) => /^[0-9a-f]{40}\.webp$/.test(name));
  assert.equal(revisionNames.length, SANDBOX_RETAINED_REVISIONS);
  assert.ok(blobNames.length <= SANDBOX_RETAINED_REVISIONS);

  for (const revisionName of revisionNames) {
    assert.ok(
      (await readFile(join(storageRoot, 'revisions', revisionName, 'photo.webp'))).byteLength > 0,
    );
  }

  const recovered = await createRepository(rootDirectory).readProfile(SLUG);
  assert.equal(recovered?.profile.name, `Photo Replacement ${SANDBOX_RETAINED_REVISIONS + 3}`);
  assert.equal(recovered?.photoBlobSha, latest.photoBlobSha);
});

test('removes only stale managed temporary directories before a new revision', async (t) => {
  const rootDirectory = await createRoot(t);
  const repository = createRepository(rootDirectory);
  const created = await repository.publish(publishInput());
  const storageRoot = profileStorageRoot(rootDirectory);
  const revisionsDirectory = join(storageRoot, 'revisions');
  const blobsDirectory = join(storageRoot, 'blobs');
  const oldRevisionTemp = join(revisionsDirectory, '.tmp-old-revision');
  const oldBlobTemp = join(blobsDirectory, '.tmp-old-blob');
  const recentRevisionTemp = join(revisionsDirectory, '.tmp-recent-revision');
  const recentBlobTemp = join(blobsDirectory, '.tmp-recent-blob');
  await Promise.all([
    mkdir(oldRevisionTemp),
    mkdir(oldBlobTemp),
    mkdir(recentRevisionTemp),
    mkdir(recentBlobTemp),
  ]);
  const staleTime = new Date(Date.now() - SANDBOX_STALE_TEMP_AGE_MS - 60_000);
  await Promise.all([
    utimes(oldRevisionTemp, staleTime, staleTime),
    utimes(oldBlobTemp, staleTime, staleTime),
  ]);

  await repository.publish(publishInput({
    operationId: 'cleanup-trigger',
    action: 'PROFILE_UPDATE',
    profile: {
      json: profileJson({ name: 'Cleanup Trigger' }),
      expectedSha: created.profileBlobSha,
    },
  }));

  const revisionEntries = await readdir(revisionsDirectory);
  const blobEntries = await readdir(blobsDirectory);
  assert.ok(!revisionEntries.includes('.tmp-old-revision'));
  assert.ok(!blobEntries.includes('.tmp-old-blob'));
  assert.ok(revisionEntries.includes('.tmp-recent-revision'));
  assert.ok(blobEntries.includes('.tmp-recent-blob'));
});

test('rejects traversal-shaped slugs and malformed photo mutations before writing', async (t) => {
  const rootDirectory = await createRoot(t);
  const repository = createRepository(rootDirectory);

  await assert.rejects(
    () => repository.readProfile('../escaped'),
    (error: unknown) => error instanceof SandboxProfileRepositoryError
      && error.code === 'invalid_input',
  );

  await assert.rejects(
    () => repository.publish(publishInput({ slug: '../escaped' })),
    (error: unknown) => error instanceof SandboxProfileRepositoryError
      && error.code === 'invalid_input',
  );

  const malformedMutation = {
    ...publishInput(),
    photo: { kind: 'truncate', expectedSha: null },
  } as unknown as ProfilePublishInput;
  await assert.rejects(
    () => repository.publish(malformedMutation),
    (error: unknown) => error instanceof SandboxProfileRepositoryError
      && error.code === 'invalid_input',
  );

  assert.deepEqual(await readdir(rootDirectory), []);
});

test('snapshots a mutable request before the asynchronous publication boundary', async (t) => {
  const rootDirectory = await createRoot(t);
  const repository = createRepository(rootDirectory);
  const input = publishInput();
  const publication = repository.publish(input);

  input.slug = '../mutated-after-validation';
  input.operationId = 'mutated-operation';
  input.profile.json = profileJson({ name: 'Mutated After Validation' });
  input.profile.expectedSha = 'f'.repeat(40);

  const result = await publication;
  const stored = await repository.readProfile(SLUG);

  assert.equal(result.status, 'sandbox');
  assert.equal(stored?.profile.name, 'Sandbox Member');
  assert.equal(stored?.operationId, 'sandbox-operation-1');
  assert.deepEqual(await readdir(rootDirectory), ['guilds']);
});

test('refuses a managed-directory symlink before it can write outside the sandbox root', async (t) => {
  const rootDirectory = await createRoot(t);
  const outsideDirectory = await createRoot(t);
  const guildRoot = join(rootDirectory, 'guilds', GUILD_ID);
  await mkdir(guildRoot, { recursive: true });

  try {
    await symlink(
      outsideDirectory,
      join(guildRoot, 'profiles'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      t.skip('The host does not permit creating a directory symlink for this test.');
      return;
    }

    throw error;
  }

  const repository = createRepository(rootDirectory);
  await assert.rejects(
    () => repository.publish(publishInput()),
    (error: unknown) => error instanceof SandboxProfileRepositoryError
      && error.code === 'storage_corrupt',
  );
  assert.deepEqual(await readdir(outsideDirectory), []);
});

test('supports provisioning recovery from metadata after the process restarts', async (t) => {
  const rootDirectory = await createRoot(t);
  const operationId = 'registration-operation';
  const guildId = GUILD_ID;
  const userId = 'sandbox-user';
  const store = new SqliteStore(':memory:', {
    now: () => new Date('2026-08-26T00:00:00.000Z'),
  });
  t.after(() => store.close());
  store.reserveBinding(guildId, userId, SLUG, operationId);

  const publisher = createRepository(rootDirectory);
  const published = await publisher.publish(publishInput({
    operationId,
    profile: { json: profileJson({ name: 'Recovered Sandbox Member' }), expectedSha: null },
  }));
  const restartedRepository = createRepository(rootDirectory);
  const service = new ProfileService({
    store,
    publisher: restartedRepository,
    repositoryReader: restartedRepository,
    guildId,
    ownerUserId: 'sandbox-owner',
    now: () => new Date('2026-08-26T00:01:00.000Z'),
  });

  const summary = await service.reconcileKnownProfiles();
  const local = service.getOwnProfileLocal(guildId, userId);

  assert.equal(summary.reconciled, 1);
  assert.deepEqual(summary.issues, []);
  assert.equal(store.getBinding(guildId, userId)?.status, 'active');
  assert.equal(local.snapshot?.profile.name, 'Recovered Sandbox Member');
  assert.equal(local.snapshot?.lastCommitSha, published.commitSha);
  assert.equal(local.snapshot?.lastDeploymentStatus, 'published_status_unknown');
});
