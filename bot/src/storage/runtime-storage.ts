import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const STORAGE_MARKER_NAME = '.grasp-profile-bot-volume.json';
const STORAGE_READY_MARKER_NAME = '.grasp-profile-bot-storage-ready.json';
const STORAGE_MARKER_VERSION = 1;
const MANAGED_BACKUP_PATTERN = /^grasp-profile-bot-\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{8}\.sqlite$/;

export type RuntimeStorageConfig = {
  persistentRequired: boolean;
  volumeMountPath?: string;
  expectedStorageId?: string;
  initializeStorage: boolean;
  adoptExistingStorage: boolean;
  databasePath: string;
  sandboxDirectory: string;
  backupDirectory: string;
};

export type RuntimeStorageIdentity = {
  id: string;
  createdAt: string;
};

export type RuntimeStoragePreparation = {
  identity: RuntimeStorageIdentity;
  initializationPending: boolean;
};

/**
 * Proves that the configured durable volume exists, is writable, and has the
 * exact operator-approved identity before the SQLite file is opened.
 */
export function prepareRuntimeStorage(
  config: RuntimeStorageConfig,
  now: () => Date = () => new Date(),
): RuntimeStoragePreparation | undefined {
  if (!config.volumeMountPath) {
    if (config.persistentRequired) {
      throw new Error('Persistent profile storage is required but no volume mount is configured.');
    }

    mkdirSync(config.backupDirectory, { recursive: true });
    return undefined;
  }

  const volume = statSync(config.volumeMountPath);
  if (!volume.isDirectory()) {
    throw new Error('The configured Railway volume mount is not a directory.');
  }

  proveWritable(config.volumeMountPath);
  const markerPath = join(config.volumeMountPath, STORAGE_MARKER_NAME);
  const expectedStorageId = config.expectedStorageId;
  if (!expectedStorageId) {
    throw new Error('Persistent profile storage requires an expected storage ID.');
  }

  if (existsSync(markerPath)) {
    const identity = readStorageMarker(markerPath);
    if (identity.id !== expectedStorageId) {
      throw new Error('The attached profile storage ID does not match PROFILE_STORAGE_ID.');
    }

    const readyPath = join(config.volumeMountPath, STORAGE_READY_MARKER_NAME);
    if (!existsSync(readyPath)) {
      if (!config.initializeStorage) {
        throw new Error(
          'Profile storage initialization is incomplete. Re-run the controlled initialization.',
        );
      }
      return { identity, initializationPending: true };
    }
    if (config.initializeStorage || config.adoptExistingStorage) {
      throw new Error(
        'Storage initialization flags must be removed after the one-time initialization.',
      );
    }
    readReadyMarker(readyPath, expectedStorageId, config);
    verifyManagedDatabase(config.databasePath);
    mkdirSync(config.backupDirectory, { recursive: true });
    return { identity, initializationPending: false };
  }

  if (!config.initializeStorage) {
    throw new Error(
      'The attached volume has no profile storage marker. Refusing to initialize it implicitly.',
    );
  }

  const existingState = inspectManagedState(config);
  if (existingState.hasState && !config.adoptExistingStorage) {
    throw new Error(
      'Managed profile data already exists. Explicit adoption is required before creating its storage marker.',
    );
  }
  if (!existingState.hasState && config.adoptExistingStorage) {
    throw new Error('Existing storage adoption was requested, but no managed profile data exists.');
  }
  if (config.adoptExistingStorage) {
    verifyManagedDatabase(config.databasePath);
  }

  const created: RuntimeStorageIdentity = {
    id: expectedStorageId,
    createdAt: now().toISOString(),
  };
  writeStorageMarker(markerPath, created);
  return { identity: created, initializationPending: true };
}

export function finalizeRuntimeStorage(
  config: RuntimeStorageConfig,
  preparation: RuntimeStoragePreparation | undefined,
  now: () => Date = () => new Date(),
) {
  if (!config.volumeMountPath || !preparation?.initializationPending) {
    return;
  }

  verifyManagedDatabase(config.databasePath);
  const backups = existsSync(config.backupDirectory)
    ? readdirSync(config.backupDirectory)
      .filter((name) => MANAGED_BACKUP_PATTERN.test(name))
      .sort()
    : [];
  const latestBackup = backups.at(-1);
  if (!latestBackup) {
    throw new Error('Storage initialization requires one verified SQLite backup.');
  }
  verifyManagedDatabase(join(config.backupDirectory, latestBackup));

  const readyPath = join(config.volumeMountPath, STORAGE_READY_MARKER_NAME);
  if (existsSync(readyPath)) {
    readReadyMarker(readyPath, preparation.identity.id, config);
    return;
  }
  writeJsonMarker(readyPath, {
    version: STORAGE_MARKER_VERSION,
    id: preparation.identity.id,
    readyAt: now().toISOString(),
    layout: managedLayout(config),
  });
}

export async function backupStorageBeforeMigration(
  config: RuntimeStorageConfig,
  preparation: RuntimeStoragePreparation | undefined,
) {
  if (
    !config.volumeMountPath
    || !preparation?.initializationPending
    || !existsSync(config.databasePath)
  ) {
    return undefined;
  }

  mkdirSync(config.backupDirectory, { recursive: true });
  const destination = join(
    config.backupDirectory,
    `grasp-profile-bot-pre-migration-${preparation.identity.id}.sqlite`,
  );
  if (existsSync(destination)) {
    verifyManagedDatabase(destination);
    return destination;
  }

  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const source = new DatabaseSync(config.databasePath, { readOnly: true });
  try {
    await backup(source, temporary);
    verifyManagedDatabase(temporary);
    renameSync(temporary, destination);
    return destination;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    source.close();
  }
}

function inspectManagedState(config: RuntimeStorageConfig) {
  const databaseExists = existsSync(config.databasePath);
  const sandboxHasFiles = directoryHasFiles(config.sandboxDirectory);
  const backupHasFiles = directoryHasFiles(config.backupDirectory);

  return {
    hasState: databaseExists || sandboxHasFiles || backupHasFiles,
  };
}

function directoryHasFiles(path: string) {
  if (!existsSync(path)) {
    return false;
  }
  const entry = statSync(path);
  return entry.isDirectory() ? readdirSync(path).length > 0 : true;
}

function verifyManagedDatabase(path: string) {
  if (!existsSync(path)) {
    throw new Error('The approved profile SQLite database is missing.');
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const quickCheck = database.prepare('PRAGMA quick_check').all() as unknown as Array<{
      quick_check: string;
    }>;
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
      throw new Error('The existing profile SQLite database failed quick_check.');
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('The existing profile SQLite database failed foreign_key_check.');
    }
    const tableRows = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all() as unknown as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map((row) => row.name));
    const requiredTables = [
      'profile_bindings',
      'interaction_receipts',
      'profile_states',
      'staged_photos',
      'audit_events',
    ];
    if (!requiredTables.every((name) => tableNames.has(name))) {
      throw new Error('The existing SQLite file is not a GRASP profile database.');
    }
  } catch (error) {
    throw new Error('The profile database cannot be verified safely.', { cause: error });
  } finally {
    database?.close();
  }
}

function writeStorageMarker(path: string, identity: RuntimeStorageIdentity) {
  writeJsonMarker(path, {
    version: STORAGE_MARKER_VERSION,
    ...identity,
  });
}

function writeJsonMarker(path: string, value: Record<string, unknown>) {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function readReadyMarker(
  path: string,
  expectedStorageId: string,
  config: RuntimeStorageConfig,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error('The profile storage readiness marker is unreadable or corrupt.', {
      cause: error,
    });
  }

  if (
    !isRecord(parsed)
    || parsed.version !== STORAGE_MARKER_VERSION
    || parsed.id !== expectedStorageId
    || typeof parsed.readyAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.readyAt))
    || JSON.stringify(parsed.layout) !== JSON.stringify(managedLayout(config))
  ) {
    throw new Error('The profile storage readiness marker does not match this volume.');
  }
}

function managedLayout(config: RuntimeStorageConfig) {
  const volume = config.volumeMountPath!;
  return {
    database: portableRelativePath(volume, config.databasePath),
    sandbox: portableRelativePath(volume, config.sandboxDirectory),
    backups: portableRelativePath(volume, config.backupDirectory),
  };
}

function portableRelativePath(base: string, path: string) {
  return relative(base, path).split(sep).join('/');
}

function proveWritable(directory: string) {
  const probePath = join(directory, `.grasp-write-probe-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(probePath, 'wx', 0o600);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(probePath);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
}

function readStorageMarker(path: string): RuntimeStorageIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error('The profile storage identity marker is unreadable or corrupt.', { cause: error });
  }

  if (
    !isRecord(parsed)
    || parsed.version !== STORAGE_MARKER_VERSION
    || typeof parsed.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(parsed.id)
    || typeof parsed.createdAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.createdAt))
  ) {
    throw new Error('The profile storage identity marker has an unsupported format.');
  }

  return { id: parsed.id, createdAt: parsed.createdAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown) {
  return isRecord(error) && error.code === 'ENOENT';
}
