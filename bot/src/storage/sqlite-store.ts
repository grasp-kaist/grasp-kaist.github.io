import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite';

export type BindingStatus = 'provisioning' | 'active' | 'revoked';

export type ProfileBinding = {
  guildId: string;
  discordUserId: string;
  profileSlug: string;
  status: BindingStatus;
  provisioningOperationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type InteractionStatus = 'processing' | 'completed' | 'failed';

export type InteractionReceipt = {
  interactionId: string;
  operationId: string;
  kind: string;
  status: InteractionStatus;
  responseJson?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProfileState = {
  guildId: string;
  profileSlug: string;
  profileJson: string;
  profileBlobSha: string;
  photoBlobSha?: string;
  lastCommitSha?: string;
  lastDeploymentStatus: string;
  updatedAt: string;
};

export type ProfileStateInput = {
  guildId: string;
  profileSlug: string;
  profileJson: string;
  profileBlobSha: string;
  photoBlobSha?: string;
  lastCommitSha?: string;
  lastDeploymentStatus: string;
};

export type StagedPhoto = {
  id: string;
  guildId: string;
  discordUserId: string;
  profileSlug: string;
  bytes: Buffer;
  width: number;
  height: number;
  status: 'prepared' | 'publishing';
  createdAt: string;
  expiresAt: string;
};

export type AuditEventInput = {
  interactionId: string;
  guildId: string;
  discordUserId: string;
  profileSlug?: string;
  action: string;
  commitSha?: string;
  deploymentStatus?: string;
  detail?: unknown;
};

export class BindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingConflictError';
  }
}

export class SqliteStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, options: { now?: () => Date } = {}) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.#database = new DatabaseSync(path);
    this.#now = options.now ?? (() => new Date());
    this.#migrate();
  }

  close() {
    this.#database.close();
  }

  getBinding(guildId: string, discordUserId: string) {
    const row = this.#database
      .prepare(
        `SELECT guild_id, discord_user_id, profile_slug, status,
                provisioning_operation_id, created_at, updated_at
         FROM profile_bindings
         WHERE guild_id = ? AND discord_user_id = ?`,
      )
      .get(guildId, discordUserId) as BindingRow | undefined;

    return row ? mapBinding(row) : undefined;
  }

  getBindingBySlug(guildId: string, profileSlug: string) {
    const row = this.#database
      .prepare(
        `SELECT guild_id, discord_user_id, profile_slug, status,
                provisioning_operation_id, created_at, updated_at
         FROM profile_bindings
         WHERE guild_id = ? AND profile_slug = ?`,
      )
      .get(guildId, profileSlug) as BindingRow | undefined;

    return row ? mapBinding(row) : undefined;
  }

  getProfileState(guildId: string, profileSlug: string) {
    const row = this.#database
      .prepare(
        `SELECT guild_id, profile_slug, profile_json, profile_blob_sha, photo_blob_sha,
                last_commit_sha, last_deployment_status, updated_at
         FROM profile_states
         WHERE guild_id = ? AND profile_slug = ?`,
      )
      .get(guildId, profileSlug) as ProfileStateRow | undefined;

    return row ? mapProfileState(row) : undefined;
  }

  saveProfileState(input: ProfileStateInput) {
    this.#upsertProfileState(input);

    return this.getProfileState(input.guildId, input.profileSlug)!;
  }

  activateBindingWithProfileState(
    guildId: string,
    discordUserId: string,
    provisioningOperationId: string,
    state: Omit<ProfileStateInput, 'guildId'>,
  ) {
    this.#transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET status = 'active', provisioning_operation_id = NULL, updated_at = ?
           WHERE guild_id = ? AND discord_user_id = ? AND profile_slug = ?
             AND status = 'provisioning' AND provisioning_operation_id = ?`,
        )
        .run(
          this.#timestamp(),
          guildId,
          discordUserId,
          state.profileSlug,
          provisioningOperationId,
        );

      assertChanged(result, 'Provisioning binding was not found.');
      this.#upsertProfileState({ guildId, ...state });
    });

    return {
      binding: this.getBinding(guildId, discordUserId)!,
      state: this.getProfileState(guildId, state.profileSlug)!,
    };
  }

  listBindings(guildId: string) {
    const rows = this.#database
      .prepare(
        `SELECT guild_id, discord_user_id, profile_slug, status,
                provisioning_operation_id, created_at, updated_at
         FROM profile_bindings
         WHERE guild_id = ?
         ORDER BY created_at, discord_user_id`,
      )
      .all(guildId) as unknown as BindingRow[];

    return rows.map(mapBinding);
  }

  listGuildIds() {
    const rows = this.#database
      .prepare(
        `SELECT DISTINCT guild_id
         FROM profile_bindings
         ORDER BY guild_id`,
      )
      .all() as unknown as Array<{ guild_id: string }>;

    return rows.map((row) => row.guild_id);
  }

  reserveBinding(
    guildId: string,
    discordUserId: string,
    profileSlug: string,
    provisioningOperationId?: string,
  ) {
    const timestamp = this.#timestamp();

    try {
      this.#database
        .prepare(
          `INSERT INTO profile_bindings (
             guild_id, discord_user_id, profile_slug, status,
             provisioning_operation_id, created_at, updated_at
           ) VALUES (?, ?, ?, 'provisioning', ?, ?, ?)`,
        )
        .run(
          guildId,
          discordUserId,
          profileSlug,
          provisioningOperationId ?? null,
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new BindingConflictError('The Discord account or profile slug is already registered.');
      }

      throw error;
    }

    return this.getBinding(guildId, discordUserId)!;
  }

  activateBinding(guildId: string, discordUserId: string) {
    const result = this.#database
      .prepare(
        `UPDATE profile_bindings
         SET status = 'active', provisioning_operation_id = NULL, updated_at = ?
         WHERE guild_id = ? AND discord_user_id = ? AND status = 'provisioning'`,
      )
      .run(this.#timestamp(), guildId, discordUserId);

    assertChanged(result, 'Provisioning binding was not found.');
    return this.getBinding(guildId, discordUserId)!;
  }

  removeProvisioningBinding(guildId: string, discordUserId: string) {
    this.#database
      .prepare(
        `DELETE FROM profile_bindings
         WHERE guild_id = ? AND discord_user_id = ? AND status = 'provisioning'`,
      )
      .run(guildId, discordUserId);
  }

  setBindingStatus(guildId: string, discordUserId: string, status: 'active' | 'revoked') {
    const result = this.#database
      .prepare(
        `UPDATE profile_bindings
         SET status = ?, provisioning_operation_id = NULL, updated_at = ?
         WHERE guild_id = ? AND discord_user_id = ?`,
      )
      .run(status, this.#timestamp(), guildId, discordUserId);

    assertChanged(result, 'Binding was not found.');
    return this.getBinding(guildId, discordUserId)!;
  }

  transferBinding(guildId: string, profileSlug: string, newDiscordUserId: string) {
    this.#transaction(() => {
      const existingTarget = this.getBinding(guildId, newDiscordUserId);

      if (existingTarget) {
        throw new BindingConflictError('The destination Discord account is already registered.');
      }

      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET discord_user_id = ?, status = 'active', provisioning_operation_id = NULL,
               updated_at = ?
           WHERE guild_id = ? AND profile_slug = ?`,
        )
        .run(newDiscordUserId, this.#timestamp(), guildId, profileSlug);

      assertChanged(result, 'Profile binding was not found.');
    });

    return this.getBindingBySlug(guildId, profileSlug)!;
  }

  beginInteraction(interactionId: string, operationId: string, kind: string) {
    const timestamp = this.#timestamp();
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO interaction_receipts (
           interaction_id, operation_id, kind, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'processing', ?, ?)`,
      )
      .run(interactionId, operationId, kind, timestamp, timestamp);

    return Number(result.changes) === 1;
  }

  finishInteraction(
    interactionId: string,
    status: 'completed' | 'failed',
    response: unknown,
  ) {
    const result = this.#database
      .prepare(
        `UPDATE interaction_receipts
         SET status = ?, response_json = ?, updated_at = ?
         WHERE interaction_id = ?`,
      )
      .run(status, JSON.stringify(response), this.#timestamp(), interactionId);

    assertChanged(result, 'Interaction receipt was not found.');
  }

  getInteractionReceipt(interactionId: string) {
    const row = this.#database
      .prepare(
        `SELECT interaction_id, operation_id, kind, status, response_json, created_at, updated_at
         FROM interaction_receipts
         WHERE interaction_id = ?`,
      )
      .get(interactionId) as InteractionRow | undefined;

    if (!row) {
      return undefined;
    }

    const receipt: InteractionReceipt = {
      interactionId: row.interaction_id,
      operationId: row.operation_id,
      kind: row.kind,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    if (row.response_json !== null) {
      receipt.responseJson = row.response_json;
    }

    return receipt;
  }

  stagePhoto(input: {
    id: string;
    guildId: string;
    discordUserId: string;
    profileSlug: string;
    bytes: Uint8Array;
    width: number;
    height: number;
    expiresAt: Date;
  }) {
    const timestamp = this.#timestamp();

    this.#transaction(() => {
      this.#database
        .prepare(
          `DELETE FROM staged_photos
           WHERE guild_id = ? AND discord_user_id = ? AND status = 'prepared'`,
        )
        .run(input.guildId, input.discordUserId);

      this.#database
        .prepare(
          `INSERT INTO staged_photos (
             id, guild_id, discord_user_id, profile_slug, photo_bytes,
             width, height, status, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        )
        .run(
          input.id,
          input.guildId,
          input.discordUserId,
          input.profileSlug,
          Buffer.from(input.bytes),
          input.width,
          input.height,
          timestamp,
          input.expiresAt.toISOString(),
        );
    });

    return this.getStagedPhoto(input.guildId, input.discordUserId, input.id)!;
  }

  getStagedPhoto(guildId: string, discordUserId: string, id: string) {
    const row = this.#database
      .prepare(
        `SELECT id, guild_id, discord_user_id, profile_slug, photo_bytes,
                width, height, status, created_at, expires_at
         FROM staged_photos
         WHERE id = ? AND guild_id = ? AND discord_user_id = ?`,
      )
      .get(id, guildId, discordUserId) as StagedPhotoRow | undefined;

    if (!row) {
      return undefined;
    }

    if (Date.parse(row.expires_at) <= this.#now().getTime()) {
      this.deleteStagedPhoto(guildId, discordUserId, id);
      return undefined;
    }

    return mapStagedPhoto(row);
  }

  claimStagedPhoto(guildId: string, discordUserId: string, id: string) {
    const staged = this.getStagedPhoto(guildId, discordUserId, id);

    if (!staged || staged.status !== 'prepared') {
      throw new Error('The staged photo is missing, expired, or already being published.');
    }

    const result = this.#database
      .prepare(
        `UPDATE staged_photos
         SET status = 'publishing'
         WHERE id = ? AND guild_id = ? AND discord_user_id = ? AND status = 'prepared'`,
      )
      .run(id, guildId, discordUserId);

    assertChanged(result, 'The staged photo is already being published.');
    return { ...staged, status: 'publishing' as const };
  }

  releaseStagedPhoto(guildId: string, discordUserId: string, id: string) {
    this.#database
      .prepare(
        `UPDATE staged_photos
         SET status = 'prepared'
         WHERE id = ? AND guild_id = ? AND discord_user_id = ? AND status = 'publishing'`,
      )
      .run(id, guildId, discordUserId);
  }

  deleteStagedPhoto(guildId: string, discordUserId: string, id: string) {
    this.#database
      .prepare(
        `DELETE FROM staged_photos
         WHERE id = ? AND guild_id = ? AND discord_user_id = ?`,
      )
      .run(id, guildId, discordUserId);
  }

  deleteExpiredStagedPhotos() {
    const result = this.#database
      .prepare('DELETE FROM staged_photos WHERE expires_at <= ?')
      .run(this.#timestamp());

    return Number(result.changes);
  }

  recoverInterruptedStagedPhotos() {
    const timestamp = this.#timestamp();

    return this.#transaction(() => {
      const recovered = this.#database
        .prepare(
          `UPDATE staged_photos
           SET status = 'prepared'
           WHERE status = 'publishing' AND expires_at > ?`,
        )
        .run(timestamp);
      const expired = this.#database
        .prepare('DELETE FROM staged_photos WHERE expires_at <= ?')
        .run(timestamp);

      return {
        recovered: Number(recovered.changes),
        expired: Number(expired.changes),
      };
    });
  }

  recordAuditEvent(input: AuditEventInput) {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
           interaction_id, guild_id, discord_user_id, profile_slug, action,
           commit_sha, deployment_status, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.interactionId,
        input.guildId,
        input.discordUserId,
        input.profileSlug ?? null,
        input.action,
        input.commitSha ?? null,
        input.deploymentStatus ?? null,
        input.detail === undefined ? null : JSON.stringify(input.detail),
        this.#timestamp(),
      );
  }

  #timestamp() {
    return this.#now().toISOString();
  }

  #transaction<T>(operation: () => T) {
    this.#database.exec('BEGIN IMMEDIATE');

    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #migrate() {
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS profile_bindings (
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

      CREATE TABLE IF NOT EXISTS interaction_receipts (
        interaction_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profile_states (
        guild_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        profile_blob_sha TEXT NOT NULL,
        photo_blob_sha TEXT,
        last_commit_sha TEXT,
        last_deployment_status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (guild_id, profile_slug),
        FOREIGN KEY (guild_id, profile_slug)
          REFERENCES profile_bindings (guild_id, profile_slug)
          ON UPDATE CASCADE ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS staged_photos (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        profile_slug TEXT NOT NULL,
        photo_bytes BLOB NOT NULL,
        width INTEGER NOT NULL CHECK (width > 0),
        height INTEGER NOT NULL CHECK (height > 0),
        status TEXT NOT NULL CHECK (status IN ('prepared', 'publishing')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        interaction_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        profile_slug TEXT,
        action TEXT NOT NULL,
        commit_sha TEXT,
        deployment_status TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_profile_created
        ON audit_events (profile_slug, created_at);
    `);

    const bindingColumns = this.#database
      .prepare('PRAGMA table_info(profile_bindings)')
      .all() as unknown as Array<{ name: string }>;

    if (!bindingColumns.some((column) => column.name === 'provisioning_operation_id')) {
      this.#database.exec(
        'ALTER TABLE profile_bindings ADD COLUMN provisioning_operation_id TEXT',
      );
    }
  }

  #upsertProfileState(input: ProfileStateInput) {
    this.#database
      .prepare(
        `INSERT INTO profile_states (
           guild_id, profile_slug, profile_json, profile_blob_sha, photo_blob_sha,
           last_commit_sha, last_deployment_status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, profile_slug) DO UPDATE SET
           profile_json = excluded.profile_json,
           profile_blob_sha = excluded.profile_blob_sha,
           photo_blob_sha = excluded.photo_blob_sha,
           last_commit_sha = excluded.last_commit_sha,
           last_deployment_status = excluded.last_deployment_status,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.guildId,
        input.profileSlug,
        input.profileJson,
        input.profileBlobSha,
        input.photoBlobSha ?? null,
        input.lastCommitSha ?? null,
        input.lastDeploymentStatus,
        this.#timestamp(),
      );
  }
}

type BindingRow = {
  guild_id: string;
  discord_user_id: string;
  profile_slug: string;
  status: BindingStatus;
  provisioning_operation_id: string | null;
  created_at: string;
  updated_at: string;
};

type InteractionRow = {
  interaction_id: string;
  operation_id: string;
  kind: string;
  status: InteractionStatus;
  response_json: string | null;
  created_at: string;
  updated_at: string;
};

type ProfileStateRow = {
  guild_id: string;
  profile_slug: string;
  profile_json: string;
  profile_blob_sha: string;
  photo_blob_sha: string | null;
  last_commit_sha: string | null;
  last_deployment_status: string;
  updated_at: string;
};

type StagedPhotoRow = {
  id: string;
  guild_id: string;
  discord_user_id: string;
  profile_slug: string;
  photo_bytes: Buffer;
  width: number;
  height: number;
  status: 'prepared' | 'publishing';
  created_at: string;
  expires_at: string;
};

function mapBinding(row: BindingRow): ProfileBinding {
  const binding: ProfileBinding = {
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    profileSlug: row.profile_slug,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.provisioning_operation_id !== null) {
    binding.provisioningOperationId = row.provisioning_operation_id;
  }

  return binding;
}

function mapProfileState(row: ProfileStateRow): ProfileState {
  const state: ProfileState = {
    guildId: row.guild_id,
    profileSlug: row.profile_slug,
    profileJson: row.profile_json,
    profileBlobSha: row.profile_blob_sha,
    lastDeploymentStatus: row.last_deployment_status,
    updatedAt: row.updated_at,
  };

  if (row.photo_blob_sha !== null) {
    state.photoBlobSha = row.photo_blob_sha;
  }

  if (row.last_commit_sha !== null) {
    state.lastCommitSha = row.last_commit_sha;
  }

  return state;
}

function mapStagedPhoto(row: StagedPhotoRow): StagedPhoto {
  return {
    id: row.id,
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    profileSlug: row.profile_slug,
    bytes: Buffer.from(row.photo_bytes),
    width: row.width,
    height: row.height,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function assertChanged(result: StatementResultingChanges, message: string) {
  if (Number(result.changes) !== 1) {
    throw new Error(message);
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}
