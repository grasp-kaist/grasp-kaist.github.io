import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  backupStorageBeforeMigration,
  finalizeRuntimeStorage,
  prepareRuntimeStorage,
  type RuntimeStorageConfig,
} from '../src/storage/runtime-storage.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const storageId = '8e99c82b-441b-4ce0-a763-cfe01340f39b';

test('requires an explicit one-time initialization and then pins the volume identity', () => {
  const volume = mkdtempSync(join(tmpdir(), 'grasp-volume-'));
  const config = volumeConfig(volume, { initializeStorage: true });

  try {
    const preparation = prepareRuntimeStorage(
      config,
      () => new Date('2026-08-26T00:00:00.000Z'),
    );
    assert.equal(preparation?.initializationPending, true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(volume, '.grasp-profile-bot-volume.json'), 'utf8')),
      {
        version: 1,
        id: storageId,
        createdAt: '2026-08-26T00:00:00.000Z',
      },
    );

    assert.throws(
      () => prepareRuntimeStorage({ ...config, initializeStorage: false }),
      /initialization is incomplete/i,
    );

    createManagedDatabase(config.databasePath);
    createManagedBackup(config);
    finalizeRuntimeStorage(
      config,
      preparation,
      () => new Date('2026-08-26T00:01:00.000Z'),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(volume, '.grasp-profile-bot-storage-ready.json'), 'utf8')),
      {
        version: 1,
        id: storageId,
        readyAt: '2026-08-26T00:01:00.000Z',
        layout: {
          database: 'profiles.sqlite',
          sandbox: 'sandbox',
          backups: 'backups',
        },
      },
    );
    assert.throws(
      () => prepareRuntimeStorage(config),
      /initialization flags must be removed/i,
    );

    const ready = prepareRuntimeStorage({
      ...config,
      initializeStorage: false,
    });
    assert.deepEqual(ready, {
      initializationPending: false,
      identity: {
        id: storageId,
        createdAt: '2026-08-26T00:00:00.000Z',
      },
    });
    assert.throws(
      () => prepareRuntimeStorage({
        ...config,
        initializeStorage: false,
        databasePath: join(volume, 'other.sqlite'),
      }),
      /readiness marker does not match/i,
    );
    assert.throws(
      () => prepareRuntimeStorage({
        ...config,
        initializeStorage: false,
        expectedStorageId: 'dc5d895e-8587-4b4d-a6c9-20a480ce4d56',
      }),
      /does not match PROFILE_STORAGE_ID/i,
    );
  } finally {
    rmSync(volume, { recursive: true, force: true });
  }
});

test('fails closed for a missing marker, missing volume, and corrupt marker', () => {
  const unused = join(tmpdir(), 'unused-grasp-volume');
  assert.throws(
    () => prepareRuntimeStorage({
      persistentRequired: true,
      initializeStorage: false,
      adoptExistingStorage: false,
      databasePath: join(unused, 'profiles.sqlite'),
      sandboxDirectory: join(unused, 'sandbox'),
      backupDirectory: join(unused, 'backups'),
    }),
    /no volume mount/i,
  );

  const volume = mkdtempSync(join(tmpdir(), 'grasp-volume-'));
  try {
    assert.throws(
      () => prepareRuntimeStorage(volumeConfig(volume)),
      /no profile storage marker/i,
    );

    writeFileSync(join(volume, '.grasp-profile-bot-volume.json'), '{broken', 'utf8');
    assert.throws(
      () => prepareRuntimeStorage(volumeConfig(volume)),
      /unreadable or corrupt/i,
    );
  } finally {
    rmSync(volume, { recursive: true, force: true });
  }
});

test('adopts an existing healthy GRASP database only with a pre-migration backup', async () => {
  const volume = mkdtempSync(join(tmpdir(), 'grasp-volume-'));
  const config = volumeConfig(volume, { initializeStorage: true });
  createManagedDatabase(config.databasePath);

  try {
    assert.throws(
      () => prepareRuntimeStorage(config),
      /explicit adoption is required/i,
    );
    assert.equal(existsSync(join(volume, '.grasp-profile-bot-volume.json')), false);

    const preparation = prepareRuntimeStorage({ ...config, adoptExistingStorage: true });
    assert.equal(preparation?.initializationPending, true);
    const preMigrationBackup = await backupStorageBeforeMigration(
      { ...config, adoptExistingStorage: true },
      preparation,
    );
    assert.equal(
      preMigrationBackup,
      join(config.backupDirectory, `grasp-profile-bot-pre-migration-${storageId}.sqlite`),
    );
    assert.equal(existsSync(preMigrationBackup!), true);
    createManagedBackup(config);
    finalizeRuntimeStorage(
      { ...config, adoptExistingStorage: true },
      preparation,
    );
    const ready = prepareRuntimeStorage({
      ...config,
      initializeStorage: false,
      adoptExistingStorage: false,
    });
    assert.equal(ready?.identity.id, storageId);
  } finally {
    rmSync(volume, { recursive: true, force: true });
  }
});

test('does not adopt unrelated or incomplete durable state', () => {
  const volume = mkdtempSync(join(tmpdir(), 'grasp-volume-'));
  const config = volumeConfig(volume, {
    initializeStorage: true,
    adoptExistingStorage: true,
  });
  writeFileSync(config.databasePath, '', 'utf8');

  try {
    assert.throws(
      () => prepareRuntimeStorage(config),
      /cannot be verified safely/i,
    );
    assert.equal(existsSync(join(volume, '.grasp-profile-bot-volume.json')), false);
  } finally {
    rmSync(volume, { recursive: true, force: true });
  }
});

function volumeConfig(
  volumeMountPath: string,
  overrides: Partial<RuntimeStorageConfig> = {},
): RuntimeStorageConfig {
  return {
    persistentRequired: true,
    volumeMountPath,
    expectedStorageId: storageId,
    initializeStorage: false,
    adoptExistingStorage: false,
    databasePath: join(volumeMountPath, 'profiles.sqlite'),
    sandboxDirectory: join(volumeMountPath, 'sandbox'),
    backupDirectory: join(volumeMountPath, 'backups'),
    ...overrides,
  };
}

function createManagedDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const store = new SqliteStore(path);
  store.close();
}

function createManagedBackup(config: RuntimeStorageConfig) {
  mkdirSync(config.backupDirectory, { recursive: true });
  copyFileSync(
    config.databasePath,
    join(config.backupDirectory, 'grasp-profile-bot-20260826T000000.000Z-1234abcd.sqlite'),
  );
}
