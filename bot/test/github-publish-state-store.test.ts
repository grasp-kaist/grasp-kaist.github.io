import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  PublishCheckpointCorruptionError,
  SqlitePublishStateStore,
} from '../src/github/sqlite-publish-state-store.js';
import type { PublishCheckpoint } from '../src/github/profile-publisher.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const COMMIT_SHA = 'a'.repeat(40);
const PROFILE_SHA = 'b'.repeat(40);
const PHOTO_SHA = 'c'.repeat(40);
const FINGERPRINT = 'd'.repeat(64);
const FIXED_DATE = new Date('2026-08-21T08:00:00.000Z');

function mainUpdatedCheckpoint(): PublishCheckpoint {
  return {
    version: 1,
    stage: 'main_updated',
    operationId: 'operation-1',
    fingerprint: FINGERPRINT,
    slug: 'example-member',
    commitSha: COMMIT_SHA,
    attempts: 2,
    profileBlobSha: PROFILE_SHA,
    photoBlobSha: PHOTO_SHA,
  };
}

test('SQLite publish checkpoints persist across process-style reopen and can be cleared', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-publish-state-'));
  const databasePath = join(directory, 'bot.sqlite');

  try {
    const first = new SqlitePublishStateStore(databasePath, { now: () => FIXED_DATE });
    await first.save(mainUpdatedCheckpoint());
    first.close();

    const second = new SqlitePublishStateStore(databasePath);
    assert.deepEqual(await second.load('operation-1'), mainUpdatedCheckpoint());

    const completed: PublishCheckpoint = {
      version: 1,
      stage: 'completed',
      operationId: 'operation-1',
      fingerprint: FINGERPRINT,
      slug: 'example-member',
      result: {
        status: 'deployed',
        attempts: 2,
        profileBlobSha: PROFILE_SHA,
        photoBlobSha: PHOTO_SHA,
        commitSha: COMMIT_SHA,
        workflowRunUrl: 'https://github.test/actions/runs/10',
        pageStatus: 'succeed',
      },
    };
    await second.save(completed);
    assert.deepEqual(await second.load('operation-1'), completed);

    await second.clear('operation-1');
    assert.equal(await second.load('operation-1'), null);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('publish checkpoint table coexists with the existing bot store in one WAL database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-publish-shared-'));
  const databasePath = join(directory, 'bot.sqlite');
  const primary = new SqliteStore(databasePath);
  const checkpoints = new SqlitePublishStateStore(databasePath);

  try {
    primary.reserveBinding('guild', 'discord-user', 'example-member');
    await checkpoints.save(mainUpdatedCheckpoint());

    assert.equal(primary.getBinding('guild', 'discord-user')?.profileSlug, 'example-member');
    assert.equal((await checkpoints.load('operation-1'))?.stage, 'main_updated');
  } finally {
    checkpoints.close();
    primary.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('corrupt checkpoint JSON fails closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-publish-corrupt-'));
  const databasePath = join(directory, 'bot.sqlite');

  try {
    const initializer = new SqlitePublishStateStore(databasePath);
    initializer.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare(
      `INSERT INTO profile_publish_checkpoints (operation_id, checkpoint_json, updated_at)
       VALUES (?, ?, ?)`,
    ).run('operation-bad', '{not-json', FIXED_DATE.toISOString());
    raw.close();

    const checkpoints = new SqlitePublishStateStore(databasePath);
    try {
      await assert.rejects(
        checkpoints.load('operation-bad'),
        PublishCheckpointCorruptionError,
      );
    } finally {
      checkpoints.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
