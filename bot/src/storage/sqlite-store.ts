import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { backup, DatabaseSync, type StatementResultingChanges } from 'node:sqlite';

export type BindingStatus = 'provisioning' | 'active' | 'revoked';
export type ListingPolicy = 'user_controlled' | 'force_hidden';
export type PendingAdminAction = 'hide' | 'revoke';
export type PublicationJobAction =
  | 'PROFILE_CREATE'
  | 'PROFILE_UPDATE'
  | 'PROFILE_REPLACE_PHOTO'
  | 'PROFILE_REMOVE_PHOTO'
  | 'PROFILE_SET_LISTED';
export type PublicationJobStatus = 'queued' | 'leased' | 'completed' | 'failed';

export type PublicationJobContext = {
  guildId: string;
  actorUserId: string;
  targetUserId: string;
  interactionId: string;
  receiptKind: string;
  stagedPhotoId?: string;
  adminAction?: PendingAdminAction;
};

export type PublicationJobPhoto =
  | { kind: 'upsert'; bytes: Buffer; expectedSha: string | null }
  | { kind: 'delete'; expectedSha: string };

export type EnqueuePublicationJobInput = {
  operationId: string;
  context: PublicationJobContext;
  profileSlug: string;
  action: PublicationJobAction;
  profileJson: string;
  profileExpectedSha: string | null;
  photo?: PublicationJobPhoto;
};

export type ProfilePublicationJob = EnqueuePublicationJobInput & {
  status: PublicationJobStatus;
  attempts: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseGeneration: number;
  leaseExpiresAt?: string;
  errorJson?: string;
  resultJson?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  appliedAt?: string;
};

export type PublicationJobOutcome = Pick<
  ProfilePublicationJob,
  'status' | 'appliedAt' | 'resultJson' | 'errorJson'
>;

export type PublicationRecoveryCandidate = Pick<
  ProfilePublicationJob,
  'status' | 'leaseExpiresAt'
>;

export type ProfileBinding = {
  guildId: string;
  discordUserId: string;
  profileSlug: string;
  status: BindingStatus;
  listingPolicy: ListingPolicy;
  pendingAdminAction?: PendingAdminAction;
  pendingAdminOperationId?: string;
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

export class PublicationJobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicationJobConflictError';
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

  async backupTo(path: string) {
    if (!path.trim() || path === ':memory:') {
      throw new Error('A filesystem path is required for a SQLite backup.');
    }
    mkdirSync(dirname(path), { recursive: true });
    await backup(this.#database, path);
    this.verifyBackup(path);
  }

  assertHealthy() {
    assertDatabaseHealthy(this.#database, 'primary database');
  }

  verifyBackup(path: string) {
    if (!path.trim() || path === ':memory:') {
      throw new Error('A filesystem path is required to verify a SQLite backup.');
    }
    const copy = new DatabaseSync(path, { readOnly: true });

    try {
      assertDatabaseHealthy(copy, 'backup database');
    } finally {
      copy.close();
    }
  }

  getBinding(guildId: string, discordUserId: string) {
    const row = this.#database
      .prepare(
        `SELECT guild_id, discord_user_id, profile_slug, status, listing_policy,
                pending_admin_action, pending_admin_operation_id,
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
        `SELECT guild_id, discord_user_id, profile_slug, status, listing_policy,
                pending_admin_action, pending_admin_operation_id,
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
        `SELECT guild_id, discord_user_id, profile_slug, status, listing_policy,
                pending_admin_action, pending_admin_operation_id,
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
    this.#transaction(() => {
      const binding = this.getBinding(guildId, discordUserId);
      if (binding) {
        this.#assertNoPendingPublication(guildId, binding.profileSlug);
      }
      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET status = ?, provisioning_operation_id = NULL, updated_at = ?
           WHERE guild_id = ? AND discord_user_id = ? AND pending_admin_action IS NULL`,
        )
        .run(status, this.#timestamp(), guildId, discordUserId);

      assertChanged(result, 'Binding was not found.');
    });
    return this.getBinding(guildId, discordUserId)!;
  }

  beginAdminAction(
    guildId: string,
    discordUserId: string,
    action: PendingAdminAction,
    operationId: string,
  ) {
    this.#transaction(() => {
      const binding = this.getBinding(guildId, discordUserId);
      if (binding) {
        this.#assertNoPendingPublication(guildId, binding.profileSlug);
      }
      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET pending_admin_action = ?, pending_admin_operation_id = ?, updated_at = ?
           WHERE guild_id = ? AND discord_user_id = ?
             AND status = 'active' AND pending_admin_action IS NULL`,
        )
        .run(action, operationId, this.#timestamp(), guildId, discordUserId);

      assertChanged(result, 'Active binding is missing or already has a pending admin action.');
    });
    return this.getBinding(guildId, discordUserId)!;
  }

  clearPendingAdminAction(guildId: string, discordUserId: string, operationId: string) {
    const result = this.#database
      .prepare(
        `UPDATE profile_bindings
         SET pending_admin_action = NULL, pending_admin_operation_id = NULL, updated_at = ?
         WHERE guild_id = ? AND discord_user_id = ? AND pending_admin_operation_id = ?`,
      )
      .run(this.#timestamp(), guildId, discordUserId, operationId);

    assertChanged(result, 'Pending admin action was not found.');
    return this.getBinding(guildId, discordUserId)!;
  }

  completeAdminActionWithProfileState(input: {
    guildId: string;
    discordUserId: string;
    operationId: string;
    action: PendingAdminAction;
    state: Omit<ProfileStateInput, 'guildId'>;
  }) {
    this.#transaction(() => {
      this.#upsertProfileState({ guildId: input.guildId, ...input.state });
      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET status = ?, listing_policy = 'force_hidden',
               pending_admin_action = NULL, pending_admin_operation_id = NULL, updated_at = ?
           WHERE guild_id = ? AND discord_user_id = ?
             AND pending_admin_action = ? AND pending_admin_operation_id = ?`,
        )
        .run(
          input.action === 'revoke' ? 'revoked' : 'active',
          this.#timestamp(),
          input.guildId,
          input.discordUserId,
          input.action,
          input.operationId,
        );

      assertChanged(result, 'Pending admin action changed before it could be completed.');
    });

    return {
      binding: this.getBinding(input.guildId, input.discordUserId)!,
      state: this.getProfileState(input.guildId, input.state.profileSlug)!,
    };
  }

  clearForceHidden(guildId: string, discordUserId: string) {
    this.#transaction(() => {
      const binding = this.getBinding(guildId, discordUserId);
      if (binding) {
        this.#assertNoPendingPublication(guildId, binding.profileSlug);
      }
      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET listing_policy = 'user_controlled', updated_at = ?
           WHERE guild_id = ? AND discord_user_id = ?
             AND pending_admin_action IS NULL`,
        )
        .run(this.#timestamp(), guildId, discordUserId);

      assertChanged(result, 'Binding is missing or still has a pending admin action.');
    });
    return this.getBinding(guildId, discordUserId)!;
  }

  transferBinding(guildId: string, profileSlug: string, newDiscordUserId: string) {
    this.#transaction(() => {
      this.#assertNoPendingPublication(guildId, profileSlug);
      const existingTarget = this.getBinding(guildId, newDiscordUserId);

      if (existingTarget) {
        throw new BindingConflictError('The destination Discord account is already registered.');
      }

      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET discord_user_id = ?, status = 'active', provisioning_operation_id = NULL,
               updated_at = ?
           WHERE guild_id = ? AND profile_slug = ? AND pending_admin_action IS NULL`,
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

  completeProcessingInteractionByOperation(
    operationId: string,
    kind: string,
    response: unknown,
  ) {
    const row = this.#database
      .prepare(
        `SELECT interaction_id, operation_id, kind, status, response_json, created_at, updated_at
         FROM interaction_receipts
         WHERE operation_id = ? AND kind = ? AND status = 'processing'
         ORDER BY created_at, interaction_id
         LIMIT 1`,
      )
      .get(operationId, kind) as InteractionRow | undefined;

    if (!row) {
      return undefined;
    }

    const responseJson = JSON.stringify(response);
    const updatedAt = this.#timestamp();
    const result = this.#database
      .prepare(
        `UPDATE interaction_receipts
         SET status = 'completed', response_json = ?, updated_at = ?
         WHERE interaction_id = ? AND operation_id = ? AND kind = ? AND status = 'processing'`,
      )
      .run(responseJson, updatedAt, row.interaction_id, operationId, kind);

    if (Number(result.changes) !== 1) {
      return undefined;
    }

    return mapInteractionReceipt({
      ...row,
      status: 'completed',
      response_json: responseJson,
      updated_at: updatedAt,
    });
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

    return mapInteractionReceipt(row);
  }

  getProcessingInteractionReceiptByOperation(operationId: string, kind: string) {
    const row = this.#database
      .prepare(
        `SELECT interaction_id, operation_id, kind, status, response_json, created_at, updated_at
         FROM interaction_receipts
         WHERE operation_id = ? AND kind = ? AND status = 'processing'
         ORDER BY created_at, interaction_id
         LIMIT 1`,
      )
      .get(operationId, kind) as InteractionRow | undefined;

    return row ? mapInteractionReceipt(row) : undefined;
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
      const binding = this.getBinding(input.guildId, input.discordUserId);
      if (
        !binding
        || binding.profileSlug !== input.profileSlug
        || binding.status !== 'active'
        || binding.pendingAdminAction
      ) {
        throw new BindingConflictError('The staged photo does not match the current profile binding.');
      }
      this.#assertNoPendingPublication(input.guildId, input.profileSlug);
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
      this.#database
        .prepare(
          `DELETE FROM staged_photos
           WHERE id = ? AND guild_id = ? AND discord_user_id = ?
             AND NOT EXISTS (
               SELECT 1
               FROM profile_publish_jobs AS job
               WHERE job.guild_id = staged_photos.guild_id
                 AND job.staged_photo_id = staged_photos.id
                 AND (job.status IN ('queued', 'leased')
                   OR (job.status = 'completed' AND job.applied_at IS NULL))
             )`,
        )
        .run(id, guildId, discordUserId);
      return undefined;
    }

    return mapStagedPhoto(row);
  }

  claimStagedPhoto(guildId: string, discordUserId: string, id: string) {
    return this.#transaction(() => {
      const staged = this.getStagedPhoto(guildId, discordUserId, id);

      if (!staged || staged.status !== 'prepared') {
        throw new Error('The staged photo is missing, expired, or already being published.');
      }
      const binding = this.getBinding(guildId, discordUserId);
      if (
        !binding
        || binding.profileSlug !== staged.profileSlug
        || binding.status !== 'active'
        || binding.pendingAdminAction
      ) {
        throw new BindingConflictError('The staged photo does not match an active profile binding.');
      }
      this.#assertNoPendingPublication(guildId, staged.profileSlug);

      const result = this.#database
        .prepare(
          `UPDATE staged_photos
           SET status = 'publishing'
           WHERE id = ? AND guild_id = ? AND discord_user_id = ? AND status = 'prepared'`,
        )
        .run(id, guildId, discordUserId);

      assertChanged(result, 'The staged photo is already being published.');
      return { ...staged, status: 'publishing' as const };
    });
  }

  releaseStagedPhoto(guildId: string, discordUserId: string, id: string) {
    this.#database
      .prepare(
        `UPDATE staged_photos
         SET status = 'prepared'
         WHERE id = ? AND guild_id = ? AND discord_user_id = ? AND status = 'publishing'
           AND NOT EXISTS (
             SELECT 1
             FROM profile_publish_jobs AS job
             WHERE job.guild_id = staged_photos.guild_id
               AND job.staged_photo_id = staged_photos.id
               AND (job.status IN ('queued', 'leased')
                 OR (job.status = 'completed' AND job.applied_at IS NULL))
           )`,
      )
      .run(id, guildId, discordUserId);
  }

  deleteStagedPhoto(guildId: string, discordUserId: string, id: string) {
    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT profile_slug
           FROM staged_photos
           WHERE id = ? AND guild_id = ? AND discord_user_id = ?`,
        )
        .get(id, guildId, discordUserId) as { profile_slug: string } | undefined;
      if (!row) {
        return false;
      }
      this.#assertNoPendingPublication(guildId, row.profile_slug);
      const result = this.#database
        .prepare(
          `DELETE FROM staged_photos
           WHERE id = ? AND guild_id = ? AND discord_user_id = ?`,
        )
        .run(id, guildId, discordUserId);
      assertChanged(result, 'The staged photo changed before it could be deleted.');
      return true;
    });
  }

  deleteExpiredStagedPhotos() {
    const result = this.#database
      .prepare(
        `DELETE FROM staged_photos
         WHERE expires_at <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM profile_publish_jobs AS job
             WHERE job.guild_id = staged_photos.guild_id
               AND job.staged_photo_id = staged_photos.id
               AND (job.status IN ('queued', 'leased')
                 OR (job.status = 'completed' AND job.applied_at IS NULL))
           )`,
      )
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
           WHERE status = 'publishing' AND expires_at > ?
             AND NOT EXISTS (
               SELECT 1
               FROM profile_publish_jobs AS job
               WHERE job.guild_id = staged_photos.guild_id
                 AND job.staged_photo_id = staged_photos.id
                 AND (job.status IN ('queued', 'leased')
                   OR (job.status = 'completed' AND job.applied_at IS NULL))
             )`,
        )
        .run(timestamp);
      const expired = this.#database
        .prepare(
          `DELETE FROM staged_photos
           WHERE expires_at <= ?
             AND NOT EXISTS (
               SELECT 1
               FROM profile_publish_jobs AS job
               WHERE job.guild_id = staged_photos.guild_id
                 AND job.staged_photo_id = staged_photos.id
                 AND (job.status IN ('queued', 'leased')
                   OR (job.status = 'completed' AND job.applied_at IS NULL))
             )`,
        )
        .run(timestamp);

      return {
        recovered: Number(recovered.changes),
        expired: Number(expired.changes),
      };
    });
  }

  enqueuePublicationJob(input: EnqueuePublicationJobInput) {
    validatePublicationJobInput(input);
    return this.#transaction(() => {
      const existing = this.getPublicationJob(input.operationId);
      if (existing) {
        assertSamePublicationRequest(existing, input);
        return existing;
      }

      const binding = this.#assertPublicationBindingCanEnqueue(input);
      this.#assertNoPendingPublication(input.context.guildId, input.profileSlug);
      const timestamp = this.#timestamp();

      if (input.context.adminAction && !binding.pendingAdminAction) {
        const pending = this.#database
          .prepare(
            `UPDATE profile_bindings
             SET pending_admin_action = ?, pending_admin_operation_id = ?, updated_at = ?
             WHERE guild_id = ? AND discord_user_id = ? AND profile_slug = ?
               AND status = 'active' AND pending_admin_action IS NULL`,
          )
          .run(
            input.context.adminAction,
            input.operationId,
            timestamp,
            input.context.guildId,
            input.context.targetUserId,
            input.profileSlug,
          );
        assertChanged(pending, 'Active binding changed before owner moderation could be queued.');
      }

      const photoKind = input.photo?.kind ?? null;
      const photoBytes = input.photo?.kind === 'upsert' ? Buffer.from(input.photo.bytes) : null;
      const photoExpectedSha = input.photo?.expectedSha ?? null;

      try {
        this.#database
          .prepare(
            `INSERT INTO profile_publish_jobs (
               operation_id, guild_id, actor_user_id, target_user_id,
               interaction_id, receipt_kind, staged_photo_id, admin_action,
               profile_slug, action,
               profile_json, profile_expected_sha,
               photo_kind, photo_bytes, photo_expected_sha,
               status, attempts, lease_generation, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?)`,
          )
          .run(
            input.operationId,
            input.context.guildId,
            input.context.actorUserId,
            input.context.targetUserId,
            input.context.interactionId,
            input.context.receiptKind,
            input.context.stagedPhotoId ?? null,
            input.context.adminAction ?? null,
            input.profileSlug,
            input.action,
            input.profileJson,
            input.profileExpectedSha,
            photoKind,
            photoBytes,
            photoExpectedSha,
            timestamp,
            timestamp,
          );
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
        throw new PublicationJobConflictError(
          'This profile already has a queued or publishing website update.',
        );
      }

      return this.getPublicationJob(input.operationId)!;
    });
  }

  getPublicationJob(operationId: string) {
    const row = this.#database
      .prepare(`${PUBLICATION_JOB_SELECT} WHERE operation_id = ?`)
      .get(operationId) as PublicationJobRow | undefined;

    return row ? mapPublicationJob(row) : undefined;
  }

  getPublicationJobOutcome(operationId: string): PublicationJobOutcome | undefined {
    const row = this.#database
      .prepare(
        `SELECT status, applied_at, result_json, error_json
         FROM profile_publish_jobs
         WHERE operation_id = ?`,
      )
      .get(operationId) as {
        status: PublicationJobStatus;
        applied_at: string | null;
        result_json: string | null;
        error_json: string | null;
      } | undefined;

    if (!row) return undefined;
    return {
      status: row.status,
      ...(row.applied_at !== null ? { appliedAt: row.applied_at } : {}),
      ...(row.result_json !== null ? { resultJson: row.result_json } : {}),
      ...(row.error_json !== null ? { errorJson: row.error_json } : {}),
    };
  }

  listPublicationJobs(guildId: string) {
    const rows = this.#database
      .prepare(`${PUBLICATION_JOB_SELECT} WHERE guild_id = ? ORDER BY created_at, operation_id`)
      .all(guildId) as unknown as PublicationJobRow[];

    return rows.map(mapPublicationJob);
  }

  listPublicationRecoveryCandidates(guildId: string): PublicationRecoveryCandidate[] {
    const rows = this.#database
      .prepare(
        `SELECT status, lease_expires_at
         FROM profile_publish_jobs
         WHERE guild_id = ?
           AND (status IN ('queued', 'leased') OR (status = 'completed' AND applied_at IS NULL))`,
      )
      .all(guildId) as unknown as Array<{
        status: PublicationJobStatus;
        lease_expires_at: string | null;
      }>;

    return rows.map((row) => ({
      status: row.status,
      ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    }));
  }

  getOldestQueuedPublicationCreatedAt(guildId: string) {
    const row = this.#database
      .prepare(
        `SELECT created_at
         FROM profile_publish_jobs
         WHERE guild_id = ? AND status = 'queued'
         ORDER BY created_at, operation_id
         LIMIT 1`,
      )
      .get(guildId) as { created_at: string } | undefined;

    return row?.created_at;
  }

  listUnappliedPublicationJobs(guildId: string, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('Unapplied publication limit must be between 1 and 20.');
    }
    const rows = this.#database
      .prepare(
        `${PUBLICATION_JOB_SELECT}
         WHERE guild_id = ? AND status = 'completed' AND applied_at IS NULL
         ORDER BY completed_at, operation_id
         LIMIT ?`,
      )
      .all(guildId, limit) as unknown as PublicationJobRow[];

    return rows.map(mapPublicationJob);
  }

  hasNonterminalPublicationJob(guildId: string, profileSlug: string) {
    const row = this.#database
      .prepare(
        `SELECT 1 AS present
         FROM profile_publish_jobs
         WHERE guild_id = ? AND profile_slug = ?
           AND (status IN ('queued', 'leased') OR (status = 'completed' AND applied_at IS NULL))
         LIMIT 1`,
      )
      .get(guildId, profileSlug) as { present: number } | undefined;

    return row?.present === 1;
  }

  countNonterminalPublicationJobs(guildId: string) {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM profile_publish_jobs
         WHERE guild_id = ?
           AND (status IN ('queued', 'leased') OR (status = 'completed' AND applied_at IS NULL))`,
      )
      .get(guildId) as { count: number };

    return row.count;
  }

  claimPublicationJobs(input: {
    guildId: string;
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: Date;
    limit?: number;
  }) {
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error('Publication claim limit must be between 1 and 20.');
    }
    requireNonEmpty(input.workerId, 'workerId');
    requireNonEmpty(input.leaseToken, 'leaseToken');
    if (!Number.isFinite(input.leaseExpiresAt.getTime())) {
      throw new Error('Publication lease expiry must be a valid date.');
    }

    return this.#transaction(() => {
      const timestamp = this.#timestamp();
      this.#database
        .prepare(
          `UPDATE profile_publish_jobs
           SET status = 'queued', lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE guild_id = ? AND status = 'leased'
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .run(timestamp, input.guildId, timestamp);

      const rows = this.#database
        .prepare(
          `SELECT operation_id
           FROM profile_publish_jobs
           WHERE guild_id = ? AND status = 'queued'
           ORDER BY created_at, operation_id
           LIMIT ?`,
        )
        .all(input.guildId, limit) as unknown as Array<{ operation_id: string }>;

      if (rows.length === 0) {
        return [];
      }

      const operationIds = rows.map((row) => row.operation_id);
      const placeholders = operationIds.map(() => '?').join(', ');
      const claimed = this.#database
        .prepare(
          `UPDATE profile_publish_jobs
           SET status = 'leased', attempts = attempts + 1,
               lease_generation = lease_generation + 1,
               lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE status = 'queued' AND operation_id IN (${placeholders})`,
        )
        .run(
          input.workerId,
          input.leaseToken,
          input.leaseExpiresAt.toISOString(),
          timestamp,
          ...operationIds,
        );

      if (Number(claimed.changes) !== operationIds.length) {
        throw new Error('Publication jobs changed while the batch lease was being claimed.');
      }

      return operationIds.map((operationId) => this.getPublicationJob(operationId)!);
    });
  }

  renewPublicationLease(input: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: Date;
  }) {
    const result = this.#database
      .prepare(
        `UPDATE profile_publish_jobs
         SET lease_expires_at = ?, updated_at = ?
         WHERE status = 'leased' AND lease_owner = ? AND lease_token = ?`,
      )
      .run(
        input.leaseExpiresAt.toISOString(),
        this.#timestamp(),
        input.workerId,
        input.leaseToken,
      );

    return Number(result.changes);
  }

  recordPublicationBatchSuccess(input: {
    workerId: string;
    leaseToken: string;
    results: Array<{
      operationId: string;
      leaseGeneration: number;
      resultJson: string;
    }>;
  }) {
    return this.#transaction(() => {
      const timestamp = this.#timestamp();

      for (const item of input.results) {
        parseJsonRecord(item.resultJson, 'publication result');
        const job = this.getPublicationJob(item.operationId);
        assertPublicationLease(job, input.workerId, input.leaseToken, item.leaseGeneration);

        const result = this.#database
          .prepare(
            `UPDATE profile_publish_jobs
             SET status = 'completed', result_json = ?, error_json = NULL,
                 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                 completed_at = ?, applied_at = NULL, updated_at = ?
             WHERE operation_id = ? AND status = 'leased'
               AND lease_owner = ? AND lease_token = ? AND lease_generation = ?`,
          )
          .run(
            item.resultJson,
            timestamp,
            timestamp,
            item.operationId,
            input.workerId,
            input.leaseToken,
            item.leaseGeneration,
          );
        assertChanged(result, 'The publication job lease was lost before completion.');
      }

      return input.results.map((item) => this.getPublicationJob(item.operationId)!);
    });
  }

  applyRecordedPublicationBatchSuccess(input: {
    results: Array<{
      operationId: string;
      resultJson: string;
      state: Omit<ProfileStateInput, 'guildId'>;
    }>;
  }) {
    return this.#transaction(() => {
      const timestamp = this.#timestamp();

      for (const item of input.results) {
        const published = parseJsonRecord(item.resultJson, 'publication result');
        const job = this.getPublicationJob(item.operationId);
        if (!job || job.status !== 'completed' || job.resultJson !== item.resultJson) {
          throw new Error('The recorded publication result no longer matches the job.');
        }
        if (job.appliedAt) {
          continue;
        }
        if (item.state.profileSlug !== job.profileSlug) {
          throw new Error('Publication state slug does not match the recorded job.');
        }

        this.#applySuccessfulPublicationBinding(job, timestamp);
        this.#upsertProfileState({ guildId: job.context.guildId, ...item.state });
        this.#finishQueuedInteraction(
          job,
          'completed',
          JSON.stringify({
            ...(typeof published.commitSha === 'string' ? { commitSha: published.commitSha } : {}),
            deploymentStatus: published.status,
          }),
          timestamp,
        );
        this.#finishQueuedPhoto(job, true);
        this.#recordQueuedPublicationAudit(job, published, timestamp);

        const result = this.#database
          .prepare(
            `UPDATE profile_publish_jobs
             SET applied_at = ?, updated_at = ?
             WHERE operation_id = ? AND status = 'completed'
               AND result_json = ? AND applied_at IS NULL`,
          )
          .run(timestamp, timestamp, item.operationId, item.resultJson);
        assertChanged(result, 'The recorded publication result was already applied elsewhere.');
      }

      return input.results.map((item) => this.getPublicationJob(item.operationId)!);
    });
  }

  applyPublicationBatchFailure(input: {
    workerId: string;
    leaseToken: string;
    jobs: Array<{ operationId: string; leaseGeneration: number }>;
    errorJson: string;
  }) {
    const storedError = parseJsonRecord(input.errorJson, 'publication error');
    return this.#transaction(() => {
      const timestamp = this.#timestamp();

      for (const item of input.jobs) {
        const job = this.getPublicationJob(item.operationId);
        assertPublicationLease(job, input.workerId, input.leaseToken, item.leaseGeneration);
        this.#cleanupFailedPublicationBinding(job, timestamp);
        this.#finishQueuedInteraction(job, 'failed', input.errorJson, timestamp);
        this.#finishQueuedPhoto(job, false);
        this.#recordQueuedPublicationAudit(job, storedError, timestamp, 'failed');

        const result = this.#database
          .prepare(
            `UPDATE profile_publish_jobs
             SET status = 'failed', error_json = ?, result_json = NULL,
                 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                 completed_at = ?, applied_at = ?, updated_at = ?
             WHERE operation_id = ? AND status = 'leased'
               AND lease_owner = ? AND lease_token = ? AND lease_generation = ?`,
          )
          .run(
            input.errorJson,
            timestamp,
            timestamp,
            timestamp,
            item.operationId,
            input.workerId,
            input.leaseToken,
            item.leaseGeneration,
          );
        assertChanged(result, 'The publication job lease was lost before failure was recorded.');
      }

      return input.jobs.map((item) => this.getPublicationJob(item.operationId)!);
    });
  }

  releasePublicationBatchForRetry(input: {
    workerId: string;
    leaseToken: string;
    jobs: Array<{ operationId: string; leaseGeneration: number }>;
    errorJson: string;
  }) {
    parseJsonRecord(input.errorJson, 'publication retry error');
    return this.#transaction(() => {
      const timestamp = this.#timestamp();

      for (const item of input.jobs) {
        const job = this.getPublicationJob(item.operationId);
        assertPublicationLease(job, input.workerId, input.leaseToken, item.leaseGeneration);
        const result = this.#database
          .prepare(
            `UPDATE profile_publish_jobs
             SET status = 'queued', error_json = ?, result_json = NULL,
                 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                 completed_at = NULL, applied_at = NULL, updated_at = ?
             WHERE operation_id = ? AND status = 'leased'
               AND lease_owner = ? AND lease_token = ? AND lease_generation = ?`,
          )
          .run(
            input.errorJson,
            timestamp,
            item.operationId,
            input.workerId,
            input.leaseToken,
            item.leaseGeneration,
          );
        assertChanged(result, 'The publication job lease was lost before retry was recorded.');
      }

      return input.jobs.map((item) => this.getPublicationJob(item.operationId)!);
    });
  }

  recoverPublicationLeases(guildId: string) {
    const timestamp = this.#timestamp();
    const result = this.#database
      .prepare(
        `UPDATE profile_publish_jobs
         SET status = 'queued', lease_owner = NULL, lease_token = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE guild_id = ? AND status = 'leased'
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(timestamp, guildId, timestamp);

    return Number(result.changes);
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

  #assertPublicationBindingCanEnqueue(input: EnqueuePublicationJobInput) {
    const binding = this.getBinding(input.context.guildId, input.context.targetUserId);
    if (!binding || binding.profileSlug !== input.profileSlug) {
      throw new PublicationJobConflictError(
        'The profile binding changed before the website update could be queued.',
      );
    }

    const receipt = this.getInteractionReceipt(input.context.interactionId);
    if (
      !receipt
      || receipt.operationId !== input.operationId
      || receipt.kind !== input.context.receiptKind
      || receipt.status !== 'processing'
    ) {
      throw new PublicationJobConflictError(
        'The Discord operation receipt changed before the website update could be queued.',
      );
    }

    if (input.action === 'PROFILE_CREATE') {
      if (
        binding.status !== 'provisioning'
        || binding.provisioningOperationId !== input.operationId
        || binding.pendingAdminAction
      ) {
        throw new PublicationJobConflictError(
          'The profile registration changed before it could be queued.',
        );
      }
    } else if (binding.status !== 'active' && binding.status !== 'revoked') {
      throw new PublicationJobConflictError(
        'The profile binding is not available for another website update.',
      );
    }

    if (
      input.action !== 'PROFILE_CREATE'
      && !input.context.adminAction
      && input.context.actorUserId === input.context.targetUserId
      && binding.status !== 'active'
    ) {
      throw new PublicationJobConflictError(
        'A revoked profile cannot queue a member-initiated website update.',
      );
    }

    if (input.context.adminAction) {
      if (input.action !== 'PROFILE_SET_LISTED') {
        throw new PublicationJobConflictError(
          'Owner moderation can only queue a profile listing change.',
        );
      }
      if (
        binding.status !== 'active'
        || (
          binding.pendingAdminAction !== undefined
          && (
            binding.pendingAdminAction !== input.context.adminAction
            || binding.pendingAdminOperationId !== input.operationId
          )
        )
      ) {
        throw new PublicationJobConflictError(
          'Only an available active profile can begin owner moderation.',
        );
      }
    } else if (binding.pendingAdminAction) {
      throw new PublicationJobConflictError(
        'An owner moderation action is already pending for this profile.',
      );
    }

    if (input.context.stagedPhotoId) {
      const staged = this.#database
        .prepare(
          `SELECT 1 AS present
           FROM staged_photos
           WHERE id = ? AND guild_id = ? AND discord_user_id = ?
             AND profile_slug = ? AND status = 'publishing'`,
        )
        .get(
          input.context.stagedPhotoId,
          input.context.guildId,
          input.context.targetUserId,
          input.profileSlug,
        ) as { present: number } | undefined;
      if (staged?.present !== 1) {
        throw new PublicationJobConflictError(
          'The staged photo claim changed before its website update could be queued.',
        );
      }
    }

    return binding;
  }

  #assertNoPendingPublication(guildId: string, profileSlug: string) {
    if (this.hasNonterminalPublicationJob(guildId, profileSlug)) {
      throw new PublicationJobConflictError(
        'This profile already has a queued or publishing website update.',
      );
    }
  }

  #applySuccessfulPublicationBinding(job: ProfilePublicationJob, timestamp: string) {
    if (job.context.adminAction) {
      if (job.action !== 'PROFILE_SET_LISTED') {
        throw new Error('Owner moderation jobs may only publish listing changes.');
      }
      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET status = ?, listing_policy = 'force_hidden',
               pending_admin_action = NULL, pending_admin_operation_id = NULL,
               updated_at = ?
           WHERE guild_id = ? AND discord_user_id = ? AND profile_slug = ?
             AND pending_admin_action = ? AND pending_admin_operation_id = ?`,
        )
        .run(
          job.context.adminAction === 'revoke' ? 'revoked' : 'active',
          timestamp,
          job.context.guildId,
          job.context.targetUserId,
          job.profileSlug,
          job.context.adminAction,
          job.operationId,
        );
      assertChanged(result, 'The pending owner moderation state no longer matches the publication job.');
      return;
    }

    if (job.action === 'PROFILE_CREATE') {
      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET status = 'active', provisioning_operation_id = NULL, updated_at = ?
           WHERE guild_id = ? AND discord_user_id = ? AND profile_slug = ?
             AND status = 'provisioning' AND provisioning_operation_id = ?`,
        )
        .run(
          timestamp,
          job.context.guildId,
          job.context.targetUserId,
          job.profileSlug,
          job.operationId,
        );
      assertChanged(result, 'The provisioning binding no longer matches the publication job.');
      return;
    }

    const binding = this.getBinding(job.context.guildId, job.context.targetUserId);
    if (
      !binding
      || binding.profileSlug !== job.profileSlug
      || (binding.status !== 'active' && binding.status !== 'revoked')
      || binding.pendingAdminAction !== undefined
    ) {
      throw new Error('The profile binding no longer matches the publication job.');
    }
  }

  #cleanupFailedPublicationBinding(job: ProfilePublicationJob, timestamp: string) {
    if (job.context.adminAction) {
      const result = this.#database
        .prepare(
          `UPDATE profile_bindings
           SET pending_admin_action = NULL, pending_admin_operation_id = NULL, updated_at = ?
           WHERE guild_id = ? AND discord_user_id = ? AND profile_slug = ?
             AND pending_admin_action = ? AND pending_admin_operation_id = ?`,
        )
        .run(
          timestamp,
          job.context.guildId,
          job.context.targetUserId,
          job.profileSlug,
          job.context.adminAction,
          job.operationId,
        );
      assertChanged(result, 'The failed owner moderation state no longer matches the publication job.');
      return;
    }

    if (job.action === 'PROFILE_CREATE') {
      const result = this.#database
        .prepare(
          `DELETE FROM profile_bindings
           WHERE guild_id = ? AND discord_user_id = ? AND profile_slug = ?
             AND status = 'provisioning' AND provisioning_operation_id = ?`,
        )
        .run(
          job.context.guildId,
          job.context.targetUserId,
          job.profileSlug,
          job.operationId,
        );
      assertChanged(result, 'The failed provisioning binding no longer matches the publication job.');
    }
  }

  #finishQueuedInteraction(
    job: ProfilePublicationJob,
    status: 'completed' | 'failed',
    responseJson: string,
    timestamp: string,
  ) {
    const result = this.#database
      .prepare(
        `UPDATE interaction_receipts
         SET status = ?, response_json = ?, updated_at = ?
         WHERE interaction_id = ? AND operation_id = ? AND kind = ? AND status = 'processing'`,
      )
      .run(
        status,
        responseJson,
        timestamp,
        job.context.interactionId,
        job.operationId,
        job.context.receiptKind,
      );
    assertChanged(result, 'The interaction receipt no longer matches the publication job.');
  }

  #finishQueuedPhoto(job: ProfilePublicationJob, succeeded: boolean) {
    if (!job.context.stagedPhotoId) {
      return;
    }

    const result = succeeded
      ? this.#database
          .prepare(
            `DELETE FROM staged_photos
             WHERE id = ? AND guild_id = ? AND discord_user_id = ?
               AND profile_slug = ? AND status = 'publishing'`,
          )
          .run(
            job.context.stagedPhotoId,
            job.context.guildId,
            job.context.targetUserId,
            job.profileSlug,
          )
      : this.#database
          .prepare(
            `UPDATE staged_photos
             SET status = 'prepared'
             WHERE id = ? AND guild_id = ? AND discord_user_id = ?
               AND profile_slug = ? AND status = 'publishing'`,
          )
          .run(
            job.context.stagedPhotoId,
            job.context.guildId,
            job.context.targetUserId,
            job.profileSlug,
          );
    assertChanged(result, 'The staged photo claim no longer matches the publication job.');
  }

  #recordQueuedPublicationAudit(
    job: ProfilePublicationJob,
    value: Record<string, unknown>,
    timestamp: string,
    deploymentStatus?: string,
  ) {
    this.#database
      .prepare(
        `INSERT INTO audit_events (
           interaction_id, guild_id, discord_user_id, profile_slug, action,
           commit_sha, deployment_status, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.context.interactionId,
        job.context.guildId,
        job.context.actorUserId,
        job.profileSlug,
        job.action,
        typeof value.commitSha === 'string' ? value.commitSha : null,
        deploymentStatus ?? (typeof value.status === 'string' ? value.status : null),
        JSON.stringify({
          operationId: job.operationId,
          targetUserId: job.context.targetUserId,
          queueAttempts: job.attempts,
          ...(job.context.adminAction ? { adminAction: job.context.adminAction } : {}),
          ...(deploymentStatus === 'failed' ? { error: value } : {}),
        }),
        timestamp,
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
        listing_policy TEXT NOT NULL DEFAULT 'user_controlled'
          CHECK (listing_policy IN ('user_controlled', 'force_hidden')),
        pending_admin_action TEXT
          CHECK (pending_admin_action IS NULL OR pending_admin_action IN ('hide', 'revoke')),
        pending_admin_operation_id TEXT,
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

      CREATE TABLE IF NOT EXISTS profile_publish_jobs (
        operation_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        receipt_kind TEXT NOT NULL,
        staged_photo_id TEXT,
        admin_action TEXT
          CHECK (admin_action IS NULL OR admin_action IN ('hide', 'revoke')),
        profile_slug TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN (
          'PROFILE_CREATE', 'PROFILE_UPDATE', 'PROFILE_REPLACE_PHOTO',
          'PROFILE_REMOVE_PHOTO', 'PROFILE_SET_LISTED'
        )),
        profile_json TEXT NOT NULL,
        profile_expected_sha TEXT,
        photo_kind TEXT CHECK (photo_kind IS NULL OR photo_kind IN ('upsert', 'delete')),
        photo_bytes BLOB,
        photo_expected_sha TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_token TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
        lease_expires_at TEXT,
        error_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        applied_at TEXT,
        CHECK (
          (photo_kind IS NULL AND photo_bytes IS NULL AND photo_expected_sha IS NULL)
          OR (photo_kind = 'upsert' AND photo_bytes IS NOT NULL)
          OR (photo_kind = 'delete' AND photo_bytes IS NULL AND photo_expected_sha IS NOT NULL)
        )
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

      CREATE INDEX IF NOT EXISTS idx_interaction_operation
        ON interaction_receipts (operation_id, kind, status);

      CREATE INDEX IF NOT EXISTS idx_publish_jobs_claim
        ON profile_publish_jobs (guild_id, status, created_at, operation_id);
    `);

    this.#database.exec(`
      DROP INDEX IF EXISTS idx_publish_jobs_nonterminal_profile;
      CREATE UNIQUE INDEX idx_publish_jobs_nonterminal_profile
        ON profile_publish_jobs (guild_id, profile_slug)
        WHERE status IN ('queued', 'leased') OR (status = 'completed' AND applied_at IS NULL);
    `);

    const bindingColumns = this.#database
      .prepare('PRAGMA table_info(profile_bindings)')
      .all() as unknown as Array<{ name: string }>;

    if (!bindingColumns.some((column) => column.name === 'provisioning_operation_id')) {
      this.#database.exec(
        'ALTER TABLE profile_bindings ADD COLUMN provisioning_operation_id TEXT',
      );
    }

    if (!bindingColumns.some((column) => column.name === 'listing_policy')) {
      this.#database.exec(
        "ALTER TABLE profile_bindings ADD COLUMN listing_policy TEXT NOT NULL DEFAULT 'user_controlled'",
      );
    }

    if (!bindingColumns.some((column) => column.name === 'pending_admin_action')) {
      this.#database.exec(
        'ALTER TABLE profile_bindings ADD COLUMN pending_admin_action TEXT',
      );
    }

    if (!bindingColumns.some((column) => column.name === 'pending_admin_operation_id')) {
      this.#database.exec(
        'ALTER TABLE profile_bindings ADD COLUMN pending_admin_operation_id TEXT',
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
  listing_policy: ListingPolicy;
  pending_admin_action: PendingAdminAction | null;
  pending_admin_operation_id: string | null;
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

type PublicationJobRow = {
  operation_id: string;
  guild_id: string;
  actor_user_id: string;
  target_user_id: string;
  interaction_id: string;
  receipt_kind: string;
  staged_photo_id: string | null;
  admin_action: PendingAdminAction | null;
  profile_slug: string;
  action: PublicationJobAction;
  profile_json: string;
  profile_expected_sha: string | null;
  photo_kind: 'upsert' | 'delete' | null;
  photo_bytes: Buffer | null;
  photo_expected_sha: string | null;
  status: PublicationJobStatus;
  attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_generation: number;
  lease_expires_at: string | null;
  error_json: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  applied_at: string | null;
};

const PUBLICATION_JOB_SELECT = `SELECT
  operation_id, guild_id, actor_user_id, target_user_id, interaction_id, receipt_kind,
  staged_photo_id, admin_action, profile_slug, action, profile_json, profile_expected_sha,
  photo_kind, photo_bytes, photo_expected_sha, status, attempts,
  lease_owner, lease_token, lease_generation, lease_expires_at,
  error_json, result_json, created_at, updated_at, completed_at, applied_at
FROM profile_publish_jobs`;

function mapBinding(row: BindingRow): ProfileBinding {
  const binding: ProfileBinding = {
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    profileSlug: row.profile_slug,
    status: row.status,
    listingPolicy: row.listing_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.provisioning_operation_id !== null) {
    binding.provisioningOperationId = row.provisioning_operation_id;
  }

  if (row.pending_admin_action !== null) {
    binding.pendingAdminAction = row.pending_admin_action;
  }

  if (row.pending_admin_operation_id !== null) {
    binding.pendingAdminOperationId = row.pending_admin_operation_id;
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

function mapInteractionReceipt(row: InteractionRow): InteractionReceipt {
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

function mapPublicationJob(row: PublicationJobRow): ProfilePublicationJob {
  const context: PublicationJobContext = {
    guildId: row.guild_id,
    actorUserId: row.actor_user_id,
    targetUserId: row.target_user_id,
    interactionId: row.interaction_id,
    receiptKind: row.receipt_kind,
  };

  if (row.staged_photo_id !== null) {
    context.stagedPhotoId = row.staged_photo_id;
  }
  if (row.admin_action !== null) {
    context.adminAction = row.admin_action;
  }

  const job: ProfilePublicationJob = {
    operationId: row.operation_id,
    context,
    profileSlug: row.profile_slug,
    action: row.action,
    profileJson: row.profile_json,
    profileExpectedSha: row.profile_expected_sha,
    status: row.status,
    attempts: row.attempts,
    leaseGeneration: row.lease_generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.photo_kind === 'upsert') {
    if (row.photo_bytes === null) {
      throw new Error('Queued photo upsert is missing its bytes.');
    }
    job.photo = {
      kind: 'upsert',
      bytes: Buffer.from(row.photo_bytes),
      expectedSha: row.photo_expected_sha,
    };
  } else if (row.photo_kind === 'delete') {
    if (row.photo_expected_sha === null) {
      throw new Error('Queued photo deletion is missing its expected revision.');
    }
    job.photo = { kind: 'delete', expectedSha: row.photo_expected_sha };
  }

  if (row.lease_owner !== null) job.leaseOwner = row.lease_owner;
  if (row.lease_token !== null) job.leaseToken = row.lease_token;
  if (row.lease_expires_at !== null) job.leaseExpiresAt = row.lease_expires_at;
  if (row.error_json !== null) job.errorJson = row.error_json;
  if (row.result_json !== null) job.resultJson = row.result_json;
  if (row.completed_at !== null) job.completedAt = row.completed_at;
  if (row.applied_at !== null) job.appliedAt = row.applied_at;
  return job;
}

function validatePublicationJobInput(input: EnqueuePublicationJobInput) {
  requireNonEmpty(input.operationId, 'operationId');
  requireNonEmpty(input.context.guildId, 'guildId');
  requireNonEmpty(input.context.actorUserId, 'actorUserId');
  requireNonEmpty(input.context.targetUserId, 'targetUserId');
  requireNonEmpty(input.context.interactionId, 'interactionId');
  requireNonEmpty(input.context.receiptKind, 'receiptKind');
  requireNonEmpty(input.profileSlug, 'profileSlug');
  requireNonEmpty(input.profileJson, 'profileJson');

  if (input.photo?.kind === 'upsert' && input.photo.bytes.byteLength === 0) {
    throw new Error('Queued profile photo bytes must not be empty.');
  }
}

function requireNonEmpty(value: string, name: string) {
  if (!value.trim()) {
    throw new Error(`Publication job ${name} must not be empty.`);
  }
}

function assertSamePublicationRequest(
  existing: ProfilePublicationJob,
  input: EnqueuePublicationJobInput,
) {
  const samePhoto = existing.photo?.kind === input.photo?.kind
    && (existing.photo?.expectedSha ?? null) === (input.photo?.expectedSha ?? null)
    && (
      existing.photo?.kind !== 'upsert'
      || (input.photo?.kind === 'upsert' && existing.photo.bytes.equals(input.photo.bytes))
    );
  const same = existing.context.guildId === input.context.guildId
    && existing.context.actorUserId === input.context.actorUserId
    && existing.context.targetUserId === input.context.targetUserId
    && existing.context.interactionId === input.context.interactionId
    && existing.context.receiptKind === input.context.receiptKind
    && existing.context.stagedPhotoId === input.context.stagedPhotoId
    && existing.context.adminAction === input.context.adminAction
    && existing.profileSlug === input.profileSlug
    && existing.action === input.action
    && existing.profileJson === input.profileJson
    && existing.profileExpectedSha === input.profileExpectedSha
    && samePhoto;

  if (!same) {
    throw new PublicationJobConflictError(
      'The publication operation ID was already used for different profile content.',
    );
  }
}

function assertPublicationLease(
  job: ProfilePublicationJob | undefined,
  workerId: string,
  leaseToken: string,
  leaseGeneration: number,
): asserts job is ProfilePublicationJob {
  if (
    !job
    || job.status !== 'leased'
    || job.leaseOwner !== workerId
    || job.leaseToken !== leaseToken
    || job.leaseGeneration !== leaseGeneration
  ) {
    throw new Error('The publication job lease is missing or stale.');
  }
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Stored ${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function assertChanged(result: StatementResultingChanges, message: string) {
  if (Number(result.changes) !== 1) {
    throw new Error(message);
  }
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

function assertDatabaseHealthy(database: DatabaseSync, label: string) {
  const quickCheck = database.prepare('PRAGMA quick_check').all() as unknown as Array<{
    quick_check: string;
  }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new Error(`SQLite ${label} failed quick_check.`);
  }

  const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) {
    throw new Error(`SQLite ${label} failed foreign_key_check.`);
  }
}
