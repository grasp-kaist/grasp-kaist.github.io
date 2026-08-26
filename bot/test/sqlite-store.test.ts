import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { BindingConflictError, SqliteStore } from '../src/storage/sqlite-store.js';

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
  } finally {
    migrated.close();
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
