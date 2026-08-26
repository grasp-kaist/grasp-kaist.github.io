import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  BindingConflictError,
  PublicationJobConflictError,
  SqliteStore,
} from '../src/storage/sqlite-store.js';

const fixedDate = new Date('2026-08-21T00:00:00.000Z');

test('binding lifecycle is one Discord account to one profile slug', () => {
  const store = new SqliteStore(':memory:', { now: () => fixedDate });

  try {
    const reserved = store.reserveBinding('guild', 'user-1', 'taein-oh');
    assert.equal(reserved.status, 'provisioning');

    const active = store.activateBinding('guild', 'user-1');
    assert.equal(active.status, 'active');
    assert.equal(active.profileSlug, 'taein-oh');

    assert.throws(
      () => store.reserveBinding('guild', 'user-2', 'taein-oh'),
      BindingConflictError,
    );
    assert.throws(
      () => store.reserveBinding('guild', 'user-1', 'another-profile'),
      BindingConflictError,
    );
  } finally {
    store.close();
  }
});

test('failed provisioning reservations can be released', () => {
  const store = new SqliteStore(':memory:');

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.removeProvisioningBinding('guild', 'user-1');
    assert.equal(store.getBinding('guild', 'user-1'), undefined);
  } finally {
    store.close();
  }
});

test('legacy profile-admin state is retired without leaving a blocked binding or job', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-profile-store-migration-'));
  const databasePath = join(directory, 'legacy.sqlite');
  const seed = new SqliteStore(databasePath, { now: () => fixedDate });

  try {
    seed.reserveBinding('legacy-guild', 'legacy-user', 'legacy-member');
    seed.activateBinding('legacy-guild', 'legacy-user');
    seed.saveProfileState({
      guildId: 'legacy-guild',
      profileSlug: 'legacy-member',
      profileJson: '{"name":"Legacy Member"}',
      profileBlobSha: 'legacy-profile-sha',
      lastDeploymentStatus: 'deployed',
    });
    seed.beginInteraction('legacy-interaction', 'legacy-operation', 'PROFILE_OWNER_HIDE');
    seed.enqueuePublicationJob({
      operationId: 'legacy-operation',
      context: {
        guildId: 'legacy-guild',
        actorUserId: 'legacy-owner',
        targetUserId: 'legacy-user',
        interactionId: 'legacy-interaction',
        receiptKind: 'PROFILE_OWNER_HIDE',
      },
      profileSlug: 'legacy-member',
      action: 'PROFILE_SET_LISTED',
      profileJson: '{"name":"Legacy Member","listed":false}',
      profileExpectedSha: 'legacy-profile-sha',
    });
  } finally {
    seed.close();
  }

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    ALTER TABLE profile_bindings ADD COLUMN listing_policy TEXT NOT NULL DEFAULT 'user_controlled';
    ALTER TABLE profile_bindings ADD COLUMN pending_admin_action TEXT;
    ALTER TABLE profile_bindings ADD COLUMN pending_admin_operation_id TEXT;
    ALTER TABLE profile_publish_jobs ADD COLUMN admin_action TEXT;
    PRAGMA ignore_check_constraints = ON;
    UPDATE profile_bindings
      SET status = 'revoked', listing_policy = 'force_hidden',
          pending_admin_action = 'hide', pending_admin_operation_id = 'legacy-operation';
    UPDATE profile_publish_jobs SET admin_action = 'hide';
    PRAGMA ignore_check_constraints = OFF;
  `);
  legacy.close();

  const migrated = new SqliteStore(databasePath);
  try {
    const binding = migrated.getBinding('legacy-guild', 'legacy-user');
    assert.equal(binding?.profileSlug, 'legacy-member');
    assert.equal(binding?.status, 'active');
    assert.equal(migrated.getPublicationJob('legacy-operation')?.status, 'failed');
    assert.ok(migrated.getPublicationJob('legacy-operation')?.appliedAt);
    assert.equal(migrated.getInteractionReceipt('legacy-interaction')?.status, 'failed');
    assert.match(
      migrated.getInteractionReceipt('legacy-interaction')?.responseJson ?? '',
      /feature_removed/,
    );
  } finally {
    migrated.close();
  }

  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const bindingColumns = inspected.prepare('PRAGMA table_info(profile_bindings)').all() as unknown as Array<{ name: string }>;
    const jobColumns = inspected.prepare('PRAGMA table_info(profile_publish_jobs)').all() as unknown as Array<{ name: string }>;
    assert.equal(bindingColumns.some(({ name }) => name === 'listing_policy'), false);
    assert.equal(bindingColumns.some(({ name }) => name === 'pending_admin_action'), false);
    assert.equal(bindingColumns.some(({ name }) => name === 'pending_admin_operation_id'), false);
    assert.equal(jobColumns.some(({ name }) => name === 'admin_action'), false);
  } finally {
    inspected.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('online SQLite backups are verified read-only and preserve durable queue bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-profile-backup-'));
  const sourcePath = join(directory, 'source.sqlite');
  const backupPath = join(directory, 'nested', 'backup.sqlite');
  const invalidPath = join(directory, 'invalid.sqlite');
  const store = new SqliteStore(sourcePath, { now: () => fixedDate });

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.activateBinding('guild', 'user-1');
    store.saveProfileState({
      guildId: 'guild',
      profileSlug: 'member-a',
      profileJson: '{"name":"Member A"}',
      profileBlobSha: 'profile-before',
      lastDeploymentStatus: 'deployed',
    });
    store.beginInteraction('backup-interaction', 'backup-operation', 'PROFILE_REPLACE_PHOTO');
    store.enqueuePublicationJob({
      operationId: 'backup-operation',
      context: {
        guildId: 'guild',
        actorUserId: 'user-1',
        targetUserId: 'user-1',
        interactionId: 'backup-interaction',
        receiptKind: 'PROFILE_REPLACE_PHOTO',
      },
      profileSlug: 'member-a',
      action: 'PROFILE_REPLACE_PHOTO',
      profileJson: '{"name":"Member A","photo":"member-a.webp"}',
      profileExpectedSha: 'profile-before',
      photo: {
        kind: 'upsert',
        bytes: Buffer.from([1, 2, 3, 255]),
        expectedSha: null,
      },
    });

    store.assertHealthy();
    await store.backupTo(backupPath);
    store.verifyBackup(backupPath);

    const copy = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const row = copy.prepare(
        'SELECT status, photo_bytes FROM profile_publish_jobs WHERE operation_id = ?',
      ).get('backup-operation') as { status: string; photo_bytes: Buffer } | undefined;
      assert.equal(row?.status, 'queued');
      assert.deepEqual(Buffer.from(row?.photo_bytes ?? []), Buffer.from([1, 2, 3, 255]));
    } finally {
      copy.close();
    }

    const invalid = new DatabaseSync(invalidPath);
    try {
      invalid.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent (id)
        );
        INSERT INTO child (id, parent_id) VALUES (1, 999);
      `);
    } finally {
      invalid.close();
    }
    assert.throws(() => store.verifyBackup(invalidPath), /foreign_key_check/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('known guild IDs are distinct and sorted for startup recovery', () => {
  const store = new SqliteStore(':memory:');

  try {
    store.reserveBinding('333333333333333333', 'user-1', 'member-a');
    store.reserveBinding('222222222222222222', 'user-2', 'member-b');
    store.reserveBinding('333333333333333333', 'user-3', 'member-c');

    assert.deepEqual(store.listGuildIds(), [
      '222222222222222222',
      '333333333333333333',
    ]);
  } finally {
    store.close();
  }
});

test('interaction receipts make retries idempotent', () => {
  const store = new SqliteStore(':memory:');

  try {
    assert.equal(store.beginInteraction('interaction-1', 'operation-1', 'PROFILE_CREATE'), true);
    assert.equal(store.beginInteraction('interaction-1', 'operation-2', 'PROFILE_CREATE'), false);

    store.finishInteraction('interaction-1', 'completed', { commitSha: 'abc' });
    const receipt = store.getInteractionReceipt('interaction-1');
    assert.equal(receipt?.status, 'completed');
    assert.equal(receipt?.operationId, 'operation-1');
    assert.equal(receipt?.responseJson, '{"commitSha":"abc"}');
    assert.equal(
      store.getProcessingInteractionReceiptByOperation('operation-1', 'PROFILE_CREATE'),
      undefined,
    );

    assert.equal(store.beginInteraction('interaction-2', 'operation-2', 'PROFILE_UPDATE'), true);
    assert.equal(
      store.getProcessingInteractionReceiptByOperation('operation-2', 'PROFILE_UPDATE')?.interactionId,
      'interaction-2',
    );
  } finally {
    store.close();
  }
});

test('published profile state preserves optimistic-lock revisions', () => {
  const store = new SqliteStore(':memory:', { now: () => fixedDate });

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.activateBinding('guild', 'user-1');
    const state = store.saveProfileState({
      guildId: 'guild',
      profileSlug: 'member-a',
      profileJson: '{"listed":false}',
      profileBlobSha: 'profile-sha',
      photoBlobSha: 'photo-sha',
      lastCommitSha: 'commit-sha',
      lastDeploymentStatus: 'deployed',
    });

    assert.equal(state.profileBlobSha, 'profile-sha');
    assert.equal(state.photoBlobSha, 'photo-sha');
    assert.equal(state.lastCommitSha, 'commit-sha');
    assert.equal(state.updatedAt, fixedDate.toISOString());
  } finally {
    store.close();
  }
});

test('profile drafts persist across reopen with revisions and timestamps intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-profile-draft-'));
  const databasePath = join(directory, 'draft.sqlite');
  let store = new SqliteStore(databasePath, { now: () => fixedDate });

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.activateBinding('guild', 'user-1');
    const saved = store.saveProfileDraft(
      {
        guildId: 'guild',
        discordUserId: 'user-1',
        profileSlug: 'member-a',
        baseStateRevision: '0123456789abcdefabcd',
        draftRevision: 'abcdef0123456789abcd',
        profileJson: '{"name":"Draft Member"}\n',
      },
      null,
    );

    assert.equal(saved.createdAt, fixedDate.toISOString());
    assert.equal(saved.updatedAt, fixedDate.toISOString());
    store.close();

    store = new SqliteStore(databasePath, { now: () => fixedDate });
    assert.deepEqual(store.getProfileDraft('guild', 'user-1'), saved);

    const updated = store.saveProfileDraft(
      {
        guildId: 'guild',
        discordUserId: 'user-1',
        profileSlug: 'member-a',
        baseStateRevision: saved.baseStateRevision,
        draftRevision: '11111111111111111111',
        profileJson: '{"name":"Updated Draft"}\n',
      },
      saved.draftRevision,
    );
    assert.equal(updated.draftRevision, '11111111111111111111');
    assert.equal(updated.profileJson, '{"name":"Updated Draft"}\n');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('photo staging enforces owner, expiry, and one publisher claim', () => {
  let now = new Date('2026-08-21T00:00:00.000Z');
  const store = new SqliteStore(':memory:', { now: () => now });

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.activateBinding('guild', 'user-1');
    store.stagePhoto({
      id: 'stage-a',
      guildId: 'guild',
      discordUserId: 'user-1',
      profileSlug: 'member-a',
      bytes: Buffer.from('webp'),
      width: 400,
      height: 500,
      expiresAt: new Date('2026-08-21T00:15:00.000Z'),
    });

    assert.equal(store.getStagedPhoto('guild', 'other-user', 'stage-a'), undefined);
    assert.equal(store.claimStagedPhoto('guild', 'user-1', 'stage-a').status, 'publishing');
    assert.throws(() => store.claimStagedPhoto('guild', 'user-1', 'stage-a'));

    store.releaseStagedPhoto('guild', 'user-1', 'stage-a');
    assert.equal(store.getStagedPhoto('guild', 'user-1', 'stage-a')?.status, 'prepared');

    now = new Date('2026-08-21T00:16:00.000Z');
    assert.equal(store.getStagedPhoto('guild', 'user-1', 'stage-a'), undefined);
  } finally {
    store.close();
  }
});

test('startup recovery releases interrupted photo publishing leases and purges expired bytes', () => {
  let now = new Date('2026-08-21T00:00:00.000Z');
  const store = new SqliteStore(':memory:', { now: () => now });

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.activateBinding('guild', 'user-1');
    store.stagePhoto({
      id: 'recoverable',
      guildId: 'guild',
      discordUserId: 'user-1',
      profileSlug: 'member-a',
      bytes: Buffer.from('webp'),
      width: 400,
      height: 500,
      expiresAt: new Date('2026-08-21T00:15:00.000Z'),
    });
    store.claimStagedPhoto('guild', 'user-1', 'recoverable');
    assert.deepEqual(store.recoverInterruptedStagedPhotos(), { recovered: 1, expired: 0 });
    assert.equal(store.getStagedPhoto('guild', 'user-1', 'recoverable')?.status, 'prepared');

    now = new Date('2026-08-21T00:16:00.000Z');
    assert.deepEqual(store.recoverInterruptedStagedPhotos(), { recovered: 0, expired: 1 });
  } finally {
    store.close();
  }
});

test('durable publication jobs preserve data and recover only expired leases', () => {
  let now = new Date('2026-08-21T00:00:00.000Z');
  const store = new SqliteStore(':memory:', { now: () => now });
  const input = {
    operationId: 'publish-operation-1',
    context: {
      guildId: 'guild',
      actorUserId: 'user-1',
      targetUserId: 'user-1',
      interactionId: 'interaction-1',
      receiptKind: 'PROFILE_REPLACE_PHOTO',
      stagedPhotoId: 'stage-1',
    },
    profileSlug: 'member-a',
    action: 'PROFILE_REPLACE_PHOTO' as const,
    profileJson: '{"name":"Member A","photo":"member-a.webp"}',
    profileExpectedSha: 'profile-before',
    photo: {
      kind: 'upsert' as const,
      bytes: Buffer.from([0, 1, 2, 255]),
      expectedSha: null,
    },
  };

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.activateBinding('guild', 'user-1');
    store.saveProfileState({
      guildId: 'guild',
      profileSlug: 'member-a',
      profileJson: '{"name":"Member A","photo":""}',
      profileBlobSha: 'profile-before',
      lastDeploymentStatus: 'deployed',
    });
    store.stagePhoto({
      id: 'stage-1',
      guildId: 'guild',
      discordUserId: 'user-1',
      profileSlug: 'member-a',
      bytes: input.photo.bytes,
      width: 400,
      height: 500,
      expiresAt: new Date('2026-08-21T00:10:00.000Z'),
    });
    store.claimStagedPhoto('guild', 'user-1', 'stage-1');
    store.beginInteraction('interaction-1', 'publish-operation-1', 'PROFILE_REPLACE_PHOTO');
    const first = store.enqueuePublicationJob(input);
    const repeated = store.enqueuePublicationJob(input);
    assert.equal(first.status, 'queued');
    assert.equal(repeated.operationId, first.operationId);
    assert.deepEqual(repeated.photo?.kind === 'upsert' ? repeated.photo.bytes : null, input.photo.bytes);
    assert.equal(store.listPublicationJobs('guild').length, 1);
    assert.deepEqual(store.getPublicationJobOutcome(input.operationId), { status: 'queued' });
    assert.deepEqual(store.listPublicationRecoveryCandidates(), [{ status: 'queued' }]);
    assert.equal(store.getPublicationJobOutcome('missing-operation'), undefined);

    assert.throws(
      () => store.enqueuePublicationJob({ ...input, profileJson: '{"different":true}' }),
      PublicationJobConflictError,
    );
    assert.throws(
      () => store.enqueuePublicationJob({
        ...input,
        operationId: 'publish-operation-2',
        context: { ...input.context, interactionId: 'interaction-2' },
      }),
      PublicationJobConflictError,
    );

    const [claimed] = store.claimPublicationJobs({
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: new Date('2026-08-21T00:05:00.000Z'),
    });
    assert.equal(claimed?.status, 'leased');
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.leaseGeneration, 1);
    assert.deepEqual(claimed?.photo?.kind === 'upsert' ? claimed.photo.bytes : null, input.photo.bytes);
    assert.deepEqual(store.listPublicationRecoveryCandidates(), [{
      status: 'leased',
      leaseExpiresAt: '2026-08-21T00:05:00.000Z',
    }]);

    assert.equal(store.recoverPublicationLeases(), 0);
    const active = store.getPublicationJob(input.operationId);
    assert.equal(active?.status, 'leased');
    assert.equal(active?.leaseOwner, 'worker-a');

    now = new Date('2026-08-21T00:05:00.000Z');
    assert.equal(store.recoverPublicationLeases(), 1);
    const recovered = store.getPublicationJob(input.operationId);
    assert.equal(recovered?.status, 'queued');
    assert.equal(recovered?.leaseOwner, undefined);
    assert.deepEqual(recovered?.photo?.kind === 'upsert' ? recovered.photo.bytes : null, input.photo.bytes);
  } finally {
    store.close();
  }
});

test('a second store cannot mutate staged-photo state after a stale queue check', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-profile-mutation-race-'));
  const databasePath = join(directory, 'shared.sqlite');
  const first = new SqliteStore(databasePath, { now: () => fixedDate });
  const second = new SqliteStore(databasePath, { now: () => fixedDate });

  try {
    first.reserveBinding('guild', 'user-1', 'member-a');
    first.activateBinding('guild', 'user-1');
    first.saveProfileState({
      guildId: 'guild',
      profileSlug: 'member-a',
      profileJson: '{"name":"Member A"}',
      profileBlobSha: 'profile-before',
      lastDeploymentStatus: 'deployed',
    });
    first.stagePhoto({
      id: 'prepared-photo',
      guildId: 'guild',
      discordUserId: 'user-1',
      profileSlug: 'member-a',
      bytes: Buffer.from('prepared'),
      width: 400,
      height: 500,
      expiresAt: new Date('2026-08-21T00:15:00.000Z'),
    });
    first.beginInteraction('edit-interaction', 'edit-operation', 'PROFILE_UPDATE');

    assert.equal(second.hasNonterminalPublicationJob('guild', 'member-a'), false);
    first.enqueuePublicationJob({
      operationId: 'edit-operation',
      context: {
        guildId: 'guild',
        actorUserId: 'user-1',
        targetUserId: 'user-1',
        interactionId: 'edit-interaction',
        receiptKind: 'PROFILE_UPDATE',
      },
      profileSlug: 'member-a',
      action: 'PROFILE_UPDATE',
      profileJson: '{"name":"Updated Member A"}',
      profileExpectedSha: 'profile-before',
    });

    const blocked = [
      () => second.stagePhoto({
        id: 'replacement-photo',
        guildId: 'guild',
        discordUserId: 'user-1',
        profileSlug: 'member-a',
        bytes: Buffer.from('replacement'),
        width: 400,
        height: 500,
        expiresAt: new Date('2026-08-21T00:15:00.000Z'),
      }),
      () => second.claimStagedPhoto('guild', 'user-1', 'prepared-photo'),
      () => second.deleteStagedPhoto('guild', 'user-1', 'prepared-photo'),
    ];
    for (const mutate of blocked) {
      assert.throws(mutate, PublicationJobConflictError);
    }

    assert.equal(second.getBinding('guild', 'user-1')?.status, 'active');
    assert.equal(
      second.getStagedPhoto('guild', 'user-1', 'prepared-photo')?.status,
      'prepared',
    );
    assert.equal(
      second.getStagedPhoto('guild', 'user-1', 'replacement-photo'),
      undefined,
    );
  } finally {
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('photo expiry and startup recovery preserve bytes owned by unfinished publication jobs', () => {
  let now = new Date('2026-08-21T00:00:00.000Z');
  const store = new SqliteStore(':memory:', { now: () => now });

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.activateBinding('guild', 'user-1');
    store.saveProfileState({
      guildId: 'guild',
      profileSlug: 'member-a',
      profileJson: '{"name":"Member A","photo":""}',
      profileBlobSha: 'profile-before',
      lastDeploymentStatus: 'deployed',
    });
    store.stagePhoto({
      id: 'stage-owned-by-job',
      guildId: 'guild',
      discordUserId: 'user-1',
      profileSlug: 'member-a',
      bytes: Buffer.from('preserve-me'),
      width: 400,
      height: 500,
      expiresAt: new Date('2026-08-21T00:01:00.000Z'),
    });
    store.claimStagedPhoto('guild', 'user-1', 'stage-owned-by-job');
    store.beginInteraction('interaction-photo', 'operation-photo', 'PROFILE_REPLACE_PHOTO');
    store.enqueuePublicationJob({
      operationId: 'operation-photo',
      context: {
        guildId: 'guild',
        actorUserId: 'user-1',
        targetUserId: 'user-1',
        interactionId: 'interaction-photo',
        receiptKind: 'PROFILE_REPLACE_PHOTO',
        stagedPhotoId: 'stage-owned-by-job',
      },
      profileSlug: 'member-a',
      action: 'PROFILE_REPLACE_PHOTO',
      profileJson: '{"name":"Member A","photo":"member-a.webp"}',
      profileExpectedSha: 'profile-before',
      photo: {
        kind: 'upsert',
        bytes: Buffer.from('preserve-me'),
        expectedSha: null,
      },
    });
    assert.equal(store.hasNonterminalPublicationJob('guild', 'member-a'), true);
    assert.equal(store.hasNonterminalPublicationJob('guild', 'other-member'), false);
    store.releaseStagedPhoto('guild', 'user-1', 'stage-owned-by-job');
    assert.throws(
      () => store.deleteStagedPhoto('guild', 'user-1', 'stage-owned-by-job'),
      PublicationJobConflictError,
    );
    assert.equal(
      store.getStagedPhoto('guild', 'user-1', 'stage-owned-by-job')?.status,
      'publishing',
    );
    const [claimed] = store.claimPublicationJobs({
      workerId: 'worker-photo',
      leaseToken: 'lease-photo',
      leaseExpiresAt: new Date('2026-08-21T00:10:00.000Z'),
    });

    now = new Date('2026-08-21T00:02:00.000Z');
    assert.equal(store.getStagedPhoto('guild', 'user-1', 'stage-owned-by-job'), undefined);
    assert.deepEqual(store.recoverInterruptedStagedPhotos(), { recovered: 0, expired: 0 });
    assert.equal(store.deleteExpiredStagedPhotos(), 0);
    assert.deepEqual(
      store.getPublicationJob('operation-photo')?.photo?.kind === 'upsert'
        ? store.getPublicationJob('operation-photo')?.photo?.bytes
        : undefined,
      Buffer.from('preserve-me'),
    );

    store.applyPublicationBatchFailure({
      workerId: 'worker-photo',
      leaseToken: 'lease-photo',
      jobs: [{
        operationId: 'operation-photo',
        leaseGeneration: claimed!.leaseGeneration,
      }],
      errorJson: '{"error":"invalid input","code":"invalid_input"}',
    });
    assert.equal(store.hasNonterminalPublicationJob('guild', 'member-a'), false);
    assert.equal(store.deleteExpiredStagedPhotos(), 1);
  } finally {
    store.close();
  }
});
