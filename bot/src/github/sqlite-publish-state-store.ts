import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PublishCheckpoint, PublishResult, PublishStateStore } from './profile-publisher.js';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class PublishCheckpointCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PublishCheckpointCorruptionError';
  }
}

export class SqlitePublishStateStore implements PublishStateStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, options: { now?: () => Date } = {}) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.#database = new DatabaseSync(path);
    this.#now = options.now ?? (() => new Date());
    this.#database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS profile_publish_checkpoints (
        operation_id TEXT PRIMARY KEY,
        checkpoint_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async load(operationId: string): Promise<PublishCheckpoint | null> {
    const row = this.#database
      .prepare(
        `SELECT checkpoint_json
         FROM profile_publish_checkpoints
         WHERE operation_id = ?`,
      )
      .get(operationId) as { checkpoint_json: string } | undefined;

    if (!row) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.checkpoint_json);
    } catch (error) {
      throw new PublishCheckpointCorruptionError(
        `Publish checkpoint ${operationId} is not valid JSON.`,
        { cause: error },
      );
    }

    return parseCheckpoint(parsed, operationId);
  }

  async save(checkpoint: PublishCheckpoint): Promise<void> {
    const validated = parseCheckpoint(checkpoint, checkpoint.operationId);
    this.#database
      .prepare(
        `INSERT INTO profile_publish_checkpoints (operation_id, checkpoint_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET
           checkpoint_json = excluded.checkpoint_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        validated.operationId,
        JSON.stringify(validated),
        this.#now().toISOString(),
      );
  }

  async clear(operationId: string): Promise<void> {
    this.#database
      .prepare('DELETE FROM profile_publish_checkpoints WHERE operation_id = ?')
      .run(operationId);
  }

  close() {
    this.#database.close();
  }
}

function parseCheckpoint(value: unknown, expectedOperationId: string): PublishCheckpoint {
  if (!isRecord(value) || value.version !== 1 || value.operationId !== expectedOperationId) {
    throw corrupted(expectedOperationId, 'identity or version is invalid');
  }

  assertNonEmptyString(value.operationId, expectedOperationId, 'operationId');
  assertPattern(value.fingerprint, FINGERPRINT_PATTERN, expectedOperationId, 'fingerprint');
  assertPattern(value.slug, SLUG_PATTERN, expectedOperationId, 'slug');

  if (value.stage === 'main_updated') {
    assertPattern(value.commitSha, SHA_PATTERN, expectedOperationId, 'commitSha');
    assertPositiveInteger(value.attempts, expectedOperationId, 'attempts');
    assertPattern(value.profileBlobSha, SHA_PATTERN, expectedOperationId, 'profileBlobSha');
    assertOptionalPattern(value.photoBlobSha, SHA_PATTERN, expectedOperationId, 'photoBlobSha');
    return value as PublishCheckpoint;
  }

  if (value.stage === 'completed') {
    assertPublishResult(value.result, expectedOperationId);
    return value as PublishCheckpoint;
  }

  throw corrupted(expectedOperationId, 'stage is invalid');
}

function assertPublishResult(value: unknown, operationId: string): asserts value is PublishResult {
  if (!isRecord(value)) {
    throw corrupted(operationId, 'completed result is missing');
  }

  if (
    value.status !== 'deployed'
    && value.status !== 'no_change'
    && value.status !== 'published_deploy_failed'
  ) {
    throw corrupted(operationId, 'result status is invalid');
  }

  assertPositiveInteger(value.attempts, operationId, 'result.attempts');
  assertPattern(value.profileBlobSha, SHA_PATTERN, operationId, 'result.profileBlobSha');
  assertOptionalPattern(value.photoBlobSha, SHA_PATTERN, operationId, 'result.photoBlobSha');
  assertOptionalPattern(value.commitSha, SHA_PATTERN, operationId, 'result.commitSha');
  assertOptionalString(value.workflowRunUrl, operationId, 'result.workflowRunUrl');
  assertOptionalString(value.pageStatus, operationId, 'result.pageStatus');
  assertOptionalString(value.failure, operationId, 'result.failure');

  if (value.status !== 'no_change' && typeof value.commitSha !== 'string') {
    throw corrupted(operationId, 'published result commitSha is missing');
  }
}

function assertPositiveInteger(value: unknown, operationId: string, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw corrupted(operationId, `${field} is invalid`);
  }
}

function assertPattern(
  value: unknown,
  pattern: RegExp,
  operationId: string,
  field: string,
) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw corrupted(operationId, `${field} is invalid`);
  }
}

function assertOptionalPattern(
  value: unknown,
  pattern: RegExp,
  operationId: string,
  field: string,
) {
  if (value !== undefined) {
    assertPattern(value, pattern, operationId, field);
  }
}

function assertNonEmptyString(value: unknown, operationId: string, field: string) {
  if (typeof value !== 'string' || !value) {
    throw corrupted(operationId, `${field} is invalid`);
  }
}

function assertOptionalString(value: unknown, operationId: string, field: string) {
  if (value !== undefined && (typeof value !== 'string' || !value)) {
    throw corrupted(operationId, `${field} is invalid`);
  }
}

function corrupted(operationId: string, detail: string) {
  return new PublishCheckpointCorruptionError(
    `Publish checkpoint ${operationId} is corrupt: ${detail}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
