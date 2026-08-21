import assert from 'node:assert/strict';
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
