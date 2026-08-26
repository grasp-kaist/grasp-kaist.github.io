import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { SqliteBackupScheduler } from '../src/storage/sqlite-backup.js';

test('creates a verified atomic backup and prunes only managed old backups', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-backups-'));
  let sequence = 0;
  const source = {
    backupTo: async (path: string) => writeFileSync(path, `backup-${sequence}`, 'utf8'),
    verifyBackup: (path: string) => assert.match(readFileSync(path, 'utf8'), /^backup-/),
  };
  const scheduler = new SqliteBackupScheduler({
    source,
    directory,
    intervalMs: 60_000,
    retentionCount: 2,
    now: () => new Date(`2026-08-2${6 + sequence}T00:00:00.000Z`),
    newId: () => `${sequence}`.padStart(8, 'a'),
  });

  try {
    const first = await scheduler.backupNow();
    sequence += 1;
    const second = await scheduler.backupNow();
    sequence += 1;
    const third = await scheduler.backupNow();
    writeFileSync(join(directory, 'keep-me.txt'), 'unmanaged', 'utf8');

    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), true);
    assert.equal(existsSync(third), true);
    assert.equal(existsSync(join(directory, 'keep-me.txt')), true);
    assert.match(basename(third), /^grasp-profile-bot-/);
  } finally {
    await scheduler.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('does not publish an unverified backup file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-backups-'));
  const scheduler = new SqliteBackupScheduler({
    source: {
      backupTo: async (path) => writeFileSync(path, 'broken', 'utf8'),
      verifyBackup: () => {
        throw new Error('integrity check failed');
      },
    },
    directory,
    intervalMs: 60_000,
    retentionCount: 2,
  });

  try {
    await assert.rejects(scheduler.backupNow(), /integrity check failed/);
    assert.deepEqual(
      (await import('node:fs')).readdirSync(directory),
      [],
    );
  } finally {
    await scheduler.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
