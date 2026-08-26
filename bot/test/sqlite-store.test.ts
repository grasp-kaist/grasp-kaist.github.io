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

test('new bindings start user-controlled with no pending moderation action', () => {
  const store = new SqliteStore(':memory:');

  try {
    const binding = store.reserveBinding('guild', 'user-1', 'member-a');
    assert.equal(binding.listingPolicy, 'user_controlled');
    assert.equal(binding.pendingAdminAction, undefined);
    assert.equal(binding.pendingAdminOperationId, undefined);
  } finally {
    store.close();
  }
});

test('legacy bindings migrate to user-controlled moderation fields without data loss', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-profile-store-migration-'));
  const databasePath = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(databasePath);

  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE profile_bindings (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'revoked')),
        provisioning_operation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, discord_user_id),
        UNIQUE (guild_id, profile_slug)
      );
      INSERT INTO profile_bindings (
        guild_id, discord_user_id, profile_slug, status,
        provisioning_operation_id, created_at, updated_at
      ) VALUES (
        'legacy-guild', 'legacy-user', 'legacy-member', 'active',
        NULL, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
      );
    `);
  } finally {
    legacy.close();
  }

  const migrated = new SqliteStore(databasePath);
  try {
    const binding = migrated.getBinding('legacy-guild', 'legacy-user');
    assert.equal(binding?.profileSlug, 'legacy-member');
    assert.equal(binding?.status, 'active');
    assert.equal(binding?.createdAt, '2026-08-20T00:00:00.000Z');
    assert.equal(binding?.listingPolicy, 'user_controlled');
    assert.equal(binding?.pendingAdminAction, undefined);

    const pending = migrated.beginAdminAction(
      'legacy-guild',
      'legacy-user',
      'hide',
      'legacy-hide-operation',
    );
    assert.equal(pending.pendingAdminAction, 'hide');
    assert.equal(pending.pendingAdminOperationId, 'legacy-hide-operation');
    migrated.clearPendingAdminAction('legacy-guild', 'legacy-user', 'legacy-hide-operation');
    migrated.beginInteraction(
      'legacy-interaction',
      'legacy-publish-operation',
      'PROFILE_UPDATE',
    );

    const migratedJob = migrated.enqueuePublicationJob({
      operationId: 'legacy-publish-operation',
      context: {
        guildId: 'legacy-guild',
        actorUserId: 'legacy-user',
        targetUserId: 'legacy-user',
        interactionId: 'legacy-interaction',
        receiptKind: 'PROFILE_UPDATE',
      },
      profileSlug: 'legacy-member',
      action: 'PROFILE_UPDATE',
      profileJson: '{"name":"Legacy Member"}',
      profileExpectedSha: 'legacy-profile-sha',
    });
    assert.equal(migratedJob.status, 'queued');
  } finally {
    migrated.close();
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

test('admin moderation completion atomically updates profile state and binding policy', () => {
  const store = new SqliteStore(':memory:', { now: () => fixedDate });

  try {
    store.reserveBinding('guild', 'user-1', 'member-a');
    store.activateBinding('guild', 'user-1');
    store.saveProfileState({
      guildId: 'guild',
      profileSlug: 'member-a',
      profileJson: '{"listed":true}',
      profileBlobSha: 'profile-before',
      lastCommitSha: 'commit-before',
      lastDeploymentStatus: 'deployed',
    });
    const pending = store.beginAdminAction(
      'guild',
      'user-1',
      'revoke',
      'revoke-operation',
    );
    assert.equal(pending.status, 'active');
    assert.equal(pending.listingPolicy, 'user_controlled');
    assert.equal(pending.pendingAdminAction, 'revoke');

    assert.throws(() => store.completeAdminActionWithProfileState({
      guildId: 'guild',
      discordUserId: 'user-1',
      operationId: 'wrong-operation',
      action: 'revoke',
      state: {
        profileSlug: 'member-a',
        profileJson: '{"listed":false}',
        profileBlobSha: 'profile-should-roll-back',
        lastCommitSha: 'commit-should-roll-back',
        lastDeploymentStatus: 'deployed',
      },
    }));

    assert.equal(store.getProfileState('guild', 'member-a')?.profileBlobSha, 'profile-before');
    assert.equal(store.getBinding('guild', 'user-1')?.pendingAdminAction, 'revoke');

    const completed = store.completeAdminActionWithProfileState({
      guildId: 'guild',
      discordUserId: 'user-1',
      operationId: 'revoke-operation',
      action: 'revoke',
      state: {
        profileSlug: 'member-a',
        profileJson: '{"listed":false}',
        profileBlobSha: 'profile-after',
        lastCommitSha: 'commit-after',
        lastDeploymentStatus: 'deployed',
      },
    });

    assert.equal(completed.binding.status, 'revoked');
    assert.equal(completed.binding.listingPolicy, 'force_hidden');
    assert.equal(completed.binding.pendingAdminAction, undefined);
    assert.equal(completed.binding.pendingAdminOperationId, undefined);
    assert.equal(completed.state.profileBlobSha, 'profile-after');
    assert.equal(completed.state.profileJson, '{"listed":false}');
  } finally {
    store.close();
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

test('owner recovery can revoke and transfer a binding', () => {
  const store = new SqliteStore(':memory:');

  try {
    store.reserveBinding('guild', 'old-user', 'member-a');
    store.activateBinding('guild', 'old-user');
    store.setBindingStatus('guild', 'old-user', 'revoked');

    const transferred = store.transferBinding('guild', 'member-a', 'new-user');
    assert.equal(transferred.discordUserId, 'new-user');
    assert.equal(transferred.status, 'active');
    assert.equal(store.getBinding('guild', 'old-user'), undefined);
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
    assert.deepEqual(store.listPublicationRecoveryCandidates('guild'), [{ status: 'queued' }]);
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
      guildId: 'guild',
      workerId: 'worker-a',
      leaseToken: 'lease-a',
      leaseExpiresAt: new Date('2026-08-21T00:05:00.000Z'),
    });
    assert.equal(claimed?.status, 'leased');
    assert.equal(claimed?.attempts, 1);
    assert.equal(claimed?.leaseGeneration, 1);
    assert.deepEqual(claimed?.photo?.kind === 'upsert' ? claimed.photo.bytes : null, input.photo.bytes);
    assert.deepEqual(store.listPublicationRecoveryCandidates('guild'), [{
      status: 'leased',
      leaseExpiresAt: '2026-08-21T00:05:00.000Z',
    }]);

    assert.equal(store.recoverPublicationLeases('guild'), 0);
    const active = store.getPublicationJob(input.operationId);
    assert.equal(active?.status, 'leased');
    assert.equal(active?.leaseOwner, 'worker-a');

    now = new Date('2026-08-21T00:05:00.000Z');
    assert.equal(store.recoverPublicationLeases('guild'), 1);
    const recovered = store.getPublicationJob(input.operationId);
    assert.equal(recovered?.status, 'queued');
    assert.equal(recovered?.leaseOwner, undefined);
    assert.deepEqual(recovered?.photo?.kind === 'upsert' ? recovered.photo.bytes : null, input.photo.bytes);
  } finally {
    store.close();
  }
});

test('two stores atomically queue owner moderation with its pending binding state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-admin-enqueue-race-'));
  const databasePath = join(directory, 'shared.sqlite');
  const first = new SqliteStore(databasePath, { now: () => fixedDate });
  const second = new SqliteStore(databasePath, { now: () => fixedDate });

  try {
    first.reserveBinding('guild', 'user-1', 'member-a');
    first.activateBinding('guild', 'user-1');
    first.saveProfileState({
      guildId: 'guild',
      profileSlug: 'member-a',
      profileJson: '{"name":"Member A","listed":true}',
      profileBlobSha: 'profile-before',
      lastDeploymentStatus: 'deployed',
    });
    first.beginInteraction('hide-interaction', 'hide-operation', 'PROFILE_OWNER_HIDE');

    assert.equal(second.hasNonterminalPublicationJob('guild', 'member-a'), false);
    assert.equal(second.getBinding('guild', 'user-1')?.pendingAdminAction, undefined);

    first.enqueuePublicationJob({
      operationId: 'hide-operation',
      context: {
        guildId: 'guild',
        actorUserId: 'owner',
        targetUserId: 'user-1',
        interactionId: 'hide-interaction',
        receiptKind: 'PROFILE_OWNER_HIDE',
        adminAction: 'hide',
      },
      profileSlug: 'member-a',
      action: 'PROFILE_SET_LISTED',
      profileJson: '{"name":"Member A","listed":false}',
      profileExpectedSha: 'profile-before',
    });

    assert.equal(second.hasNonterminalPublicationJob('guild', 'member-a'), true);
    assert.equal(second.getBinding('guild', 'user-1')?.pendingAdminAction, 'hide');
    assert.equal(
      second.getBinding('guild', 'user-1')?.pendingAdminOperationId,
      'hide-operation',
    );
    assert.throws(
      () => second.transferBinding('guild', 'member-a', 'user-2'),
      PublicationJobConflictError,
    );
    assert.equal(second.getBinding('guild', 'user-1')?.profileSlug, 'member-a');
    assert.equal(second.getBinding('guild', 'user-2'), undefined);
  } finally {
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('atomic enqueue rejects a member write after the binding becomes revoked', () => {
  const store = new SqliteStore(':memory:', { now: () => fixedDate });

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
    store.setBindingStatus('guild', 'user-1', 'revoked');
    store.beginInteraction('late-edit', 'late-operation', 'PROFILE_UPDATE');

    assert.throws(
      () => store.enqueuePublicationJob({
        operationId: 'late-operation',
        context: {
          guildId: 'guild',
          actorUserId: 'user-1',
          targetUserId: 'user-1',
          interactionId: 'late-edit',
          receiptKind: 'PROFILE_UPDATE',
        },
        profileSlug: 'member-a',
        action: 'PROFILE_UPDATE',
        profileJson: '{"name":"Too Late"}',
        profileExpectedSha: 'profile-before',
      }),
      PublicationJobConflictError,
    );
    assert.equal(store.listPublicationJobs('guild').length, 0);
  } finally {
    store.close();
  }
});

test('a second store cannot mutate binding or staged-photo state after a stale queue check', () => {
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
      () => second.setBindingStatus('guild', 'user-1', 'revoked'),
      () => second.clearForceHidden('guild', 'user-1'),
      () => second.beginAdminAction('guild', 'user-1', 'hide', 'late-hide'),
      () => second.transferBinding('guild', 'member-a', 'user-2'),
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
    assert.equal(second.getBinding('guild', 'user-1')?.pendingAdminAction, undefined);
    assert.equal(second.getBinding('guild', 'user-2'), undefined);
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
      guildId: 'guild',
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
