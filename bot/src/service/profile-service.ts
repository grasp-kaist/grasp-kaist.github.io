import { createHash, randomUUID } from 'node:crypto';

import {
  assertMemberProfile,
  createEmptyProfile,
  generateProfileSlug,
  normalizeMemberProfile,
  type MemberOrder,
  type MemberProfile,
} from '../domain/member-profile.js';
import { processProfilePhoto } from '../image/process-profile-photo.js';
import { SqliteStore, type ProfileBinding, type ProfileState } from '../storage/sqlite-store.js';

const STARTUP_RECONCILIATION_CONCURRENCY = 4;

export type DiscordActor = {
  interactionId: string;
  guildId: string;
  userId: string;
};

export type ProfileSnapshot = {
  profileSlug: string;
  profile: MemberProfile;
  bindingStatus: 'provisioning' | 'active' | 'revoked';
  stateRevision: string;
  lastCommitSha?: string;
  lastDeploymentStatus?: string;
  membersPageUrl?: string;
};

export type ProfileOperationResult = {
  snapshot?: ProfileSnapshot;
  commitSha?: string;
  deploymentStatus?: string;
};

export type LocalProfileProbe = {
  hasBinding: boolean;
  snapshot: ProfileSnapshot | null;
};

export type EditableProfilePatch = Partial<
  Pick<
    MemberProfile,
    | 'name'
    | 'position'
    | 'order'
    | 'details'
    | 'researchInterests'
    | 'contact'
    | 'website'
  >
>;

export type ProfilePublishInput = {
  operationId: string;
  slug: string;
  action:
    | 'PROFILE_CREATE'
    | 'PROFILE_UPDATE'
    | 'PROFILE_REPLACE_PHOTO'
    | 'PROFILE_REMOVE_PHOTO'
    | 'PROFILE_SET_LISTED';
  profile: {
    json: string;
    expectedSha: string | null;
  };
  photo?:
    | {
        kind: 'upsert';
        bytes: Uint8Array;
        expectedSha: string | null;
      }
    | {
        kind: 'delete';
        expectedSha: string;
      };
};

export type ProfilePublishResult = {
  status: 'deployed' | 'no_change' | 'published_deploy_failed' | 'sandbox';
  commitSha?: string;
  profileBlobSha: string;
  photoBlobSha?: string | null;
  attempts: number;
  workflowRunUrl?: string;
  pageStatus?: string;
};

export interface ProfilePublisher {
  publish(input: ProfilePublishInput): Promise<ProfilePublishResult>;
}

export type RepositoryProfileSnapshot = {
  profile: MemberProfile;
  profileBlobSha: string;
  photoBlobSha?: string;
  commitSha: string;
  operationId?: string;
};

export interface ProfileRepositoryReader {
  readProfile(slug: string): Promise<RepositoryProfileSnapshot | null>;
}

export interface PublishCheckpointLookup {
  load(operationId: string): Promise<unknown>;
}

export class ProfileServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProfileServiceError';
    this.code = code;
  }
}

export class ProfileService {
  readonly #store: SqliteStore;
  readonly #publisher: ProfilePublisher;
  readonly #repositoryReader: ProfileRepositoryReader | undefined;
  readonly #checkpointLookup: PublishCheckpointLookup | undefined;
  readonly #guildId: string;
  readonly #ownerUserId: string;
  readonly #membersPageUrl: string | undefined;
  readonly #now: () => Date;
  readonly #newOperationId: () => string;
  readonly #newStageId: () => string;
  readonly #reconciliationTasks = new Map<string, Promise<ProfileState | undefined>>();
  readonly #profileOperationTails = new Map<string, Promise<void>>();
  readonly #profilesNeedingReconciliation = new Set<string>();

  constructor(options: {
    store: SqliteStore;
    publisher: ProfilePublisher;
    repositoryReader?: ProfileRepositoryReader;
    checkpointLookup?: PublishCheckpointLookup;
    guildId: string;
    ownerUserId: string;
    membersPageUrl?: string;
    now?: () => Date;
    newOperationId?: () => string;
    newStageId?: () => string;
  }) {
    this.#store = options.store;
    this.#publisher = options.publisher;
    this.#repositoryReader = options.repositoryReader;
    this.#checkpointLookup = options.checkpointLookup;
    this.#guildId = options.guildId;
    this.#ownerUserId = options.ownerUserId;
    this.#membersPageUrl = options.membersPageUrl;
    this.#now = options.now ?? (() => new Date());
    this.#newOperationId = options.newOperationId ?? randomUUID;
    this.#newStageId = options.newStageId ?? randomUUID;
  }

  getOwnProfileLocal(guildId: string, userId: string): LocalProfileProbe {
    this.#assertGuild(guildId);
    const binding = this.#store.getBinding(guildId, userId);

    if (!binding) {
      return { hasBinding: false, snapshot: null };
    }

    const state = this.#store.getProfileState(guildId, binding.profileSlug);
    return {
      hasBinding: true,
      snapshot: state ? this.#snapshot(binding, state) : null,
    };
  }

  async getOwnProfile(guildId: string, userId: string): Promise<ProfileSnapshot | null> {
    this.#assertGuild(guildId);
    const binding = this.#store.getBinding(guildId, userId);

    if (!binding) {
      return null;
    }

    let state = this.#store.getProfileState(guildId, binding.profileSlug);

    if (
      this.#repositoryReader
      && (!state || this.#profilesNeedingReconciliation.has(profileKey(guildId, binding.profileSlug)))
    ) {
      state = await this.#reconcileBinding(binding);
    }

    if (!state) {
      if (binding.status === 'provisioning') {
        return null;
      }

      throw new ProfileServiceError(
        'profile_state_missing',
        'The profile state is unavailable. The bot owner has been notified.',
      );
    }

    const currentBinding = this.#store.getBinding(guildId, userId);

    if (!currentBinding) {
      return null;
    }

    return this.#snapshot(currentBinding, state);
  }

  async reconcileKnownProfiles() {
    const summary = {
      reconciled: 0,
      unchanged: 0,
      released: 0,
      issues: [] as Array<{ profileSlug: string; message: string }>,
    };

    if (!this.#repositoryReader) {
      return summary;
    }

    const pendingBindings = [...this.#store.listBindings(this.#guildId)];
    const workers = Array.from(
      {
        length: Math.min(STARTUP_RECONCILIATION_CONCURRENCY, pendingBindings.length),
      },
      async () => {
        while (pendingBindings.length > 0) {
          const binding = pendingBindings.shift()!;
          try {
            const before = this.#store.getProfileState(binding.guildId, binding.profileSlug);
            const state = await this.#reconcileBinding(binding);

            if (!state) {
              if (!this.#store.getBinding(binding.guildId, binding.discordUserId)) {
                summary.released += 1;
              } else {
                summary.unchanged += 1;
              }
            } else if (
              before?.profileBlobSha === state.profileBlobSha
              && before?.photoBlobSha === state.photoBlobSha
              && binding.status !== 'provisioning'
            ) {
              summary.unchanged += 1;
            } else {
              summary.reconciled += 1;
            }
          } catch (error) {
            summary.issues.push({
              profileSlug: binding.profileSlug,
              message: toErrorMessage(error),
            });
          }
        }
      },
    );
    await Promise.all(workers);

    return summary;
  }

  async register(
    actor: DiscordActor,
    input: { name: string; position: string; order: MemberOrder },
  ): Promise<ProfileOperationResult> {
    return this.#runOperation(actor, 'PROFILE_CREATE', async (operationId) => {
      const existingBinding = this.#store.getBinding(actor.guildId, actor.userId);

      if (existingBinding) {
        throw new ProfileServiceError(
          existingBinding.status === 'provisioning' ? 'registration_recovering' : 'already_registered',
          existingBinding.status === 'provisioning'
            ? 'A previous registration is still being recovered. Try `/profile` again shortly.'
            : 'This Discord account is already registered.',
        );
      }

      const profile = createEmptyProfile(input);
      const takenSlugs = new Set(
        this.#store.listBindings(actor.guildId).map((binding) => binding.profileSlug),
      );
      const slug = generateProfileSlug(profile.name, takenSlugs);
      this.#store.reserveBinding(actor.guildId, actor.userId, slug, operationId);
      let published = false;

      try {
        return await this.#withProfileOperationLock(
          actor.guildId,
          slug,
          'mutation',
          async () => {
            const publishResult = await this.#publisher.publish({
              operationId,
              slug,
              action: 'PROFILE_CREATE',
              profile: { json: serializeProfile(profile), expectedSha: null },
            });
            published = true;
            const publishedState = this.#publishedStateInput(slug, profile, publishResult);
            const { binding, state } = this.#store.activateBindingWithProfileState(
              actor.guildId,
              actor.userId,
              operationId,
              publishedState,
            );
            const result = this.#operationResult(binding, state);
            this.#audit(actor, slug, 'PROFILE_CREATE', result);
            return result;
          },
        );
      } catch (error) {
        if (!published && isDefinitelyUnpublishedRegistrationFailure(error)) {
          this.#store.removeProvisioningBinding(actor.guildId, actor.userId);
        }
        throw error;
      }
    });
  }

  async updateOwnProfile(
    actor: DiscordActor,
    patch: EditableProfilePatch,
    expectedRevision: string,
  ): Promise<ProfileOperationResult> {
    return this.#mutateOwnProfile(
      actor,
      'PROFILE_UPDATE',
      (profile) => ({ ...profile, ...patch }),
      expectedRevision,
    );
  }

  async prepareOwnPhoto(
    actor: DiscordActor,
    input: { bytes: Uint8Array; filename: string; contentType?: string },
  ): Promise<{
    stagedPhotoId: string;
    previewBytes: Uint8Array;
    width: number;
    height: number;
  }> {
    this.#assertActor(actor);
    const existingReceipt = this.#store.getInteractionReceipt(actor.interactionId);

    if (existingReceipt) {
      if (existingReceipt.kind !== 'PROFILE_PREPARE_PHOTO' || existingReceipt.status !== 'completed') {
        throw new ProfileServiceError('duplicate_interaction', 'This photo interaction is already being processed.');
      }

      const cached = parseJson<{ stagedPhotoId: string }>(existingReceipt.responseJson);
      const staged = this.#store.getStagedPhoto(actor.guildId, actor.userId, cached.stagedPhotoId);

      if (!staged) {
        throw new ProfileServiceError('photo_expired', 'The prepared photo has expired. Upload it again.');
      }

      return {
        stagedPhotoId: staged.id,
        previewBytes: staged.bytes,
        width: staged.width,
        height: staged.height,
      };
    }

    const operationId = this.#newOperationId();
    this.#store.beginInteraction(actor.interactionId, operationId, 'PROFILE_PREPARE_PHOTO');

    try {
      const { binding, state } = this.#requireOwnActiveState(actor);
      const processed = await processProfilePhoto(Buffer.from(input.bytes));
      const stagedPhotoId = createStagedPhotoId(this.#newStageId(), profileStateRevision(state));
      const expiresAt = new Date(this.#now().getTime() + 15 * 60 * 1000);
      this.#store.stagePhoto({
        id: stagedPhotoId,
        guildId: actor.guildId,
        discordUserId: actor.userId,
        profileSlug: binding.profileSlug,
        bytes: processed.data,
        width: processed.width,
        height: processed.height,
        expiresAt,
      });
      const receiptResult = { stagedPhotoId, width: processed.width, height: processed.height };
      this.#store.finishInteraction(actor.interactionId, 'completed', receiptResult);
      this.#audit(actor, binding.profileSlug, 'PROFILE_PREPARE_PHOTO', {});
      return {
        stagedPhotoId,
        previewBytes: processed.data,
        width: processed.width,
        height: processed.height,
      };
    } catch (error) {
      this.#store.finishInteraction(actor.interactionId, 'failed', { error: toErrorMessage(error) });
      throw error;
    }
  }

  async confirmOwnPhoto(
    actor: DiscordActor,
    stagedPhotoId: string,
  ): Promise<ProfileOperationResult> {
    return this.#runOperation(actor, 'PROFILE_REPLACE_PHOTO', async (operationId) => {
      const initialBinding = this.#requireBinding(actor.guildId, actor.userId);
      let recoveryBinding = initialBinding;

      try {
        return await this.#withProfileOperationLock(
          actor.guildId,
          initialBinding.profileSlug,
          'mutation',
          async () => {
            const { binding, state, profile } = this.#requireOwnActiveState(actor);
            this.#assertSameProfileBinding(initialBinding, binding);
            recoveryBinding = binding;
            const expectedRevision = stagedPhotoRevision(stagedPhotoId);
            const staged = this.#store.claimStagedPhoto(
              actor.guildId,
              actor.userId,
              stagedPhotoId,
            );

            if (staged.profileSlug !== binding.profileSlug) {
              this.#store.releaseStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);
              throw new ProfileServiceError(
                'photo_owner_mismatch',
                'The prepared photo does not match this profile.',
              );
            }

            if (!expectedRevision || expectedRevision !== profileStateRevision(state)) {
              this.#store.deleteStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);
              throw profileChangedError();
            }

            const nextProfile = normalizeMemberProfile({
              ...profile,
              photo: `${binding.profileSlug}.webp`,
            });

            try {
              const publishResult = await this.#publisher.publish({
                operationId,
                slug: binding.profileSlug,
                action: 'PROFILE_REPLACE_PHOTO',
                profile: { json: serializeProfile(nextProfile), expectedSha: state.profileBlobSha },
                photo: {
                  kind: 'upsert',
                  bytes: staged.bytes,
                  expectedSha: state.photoBlobSha ?? null,
                },
              });
              const nextState = this.#savePublishedState(
                actor.guildId,
                binding.profileSlug,
                nextProfile,
                publishResult,
                'upsert',
                state,
              );
              this.#store.deleteStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);
              const result = this.#operationResult(binding, nextState);
              this.#audit(actor, binding.profileSlug, 'PROFILE_REPLACE_PHOTO', result);
              return result;
            } catch (error) {
              this.#store.releaseStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);
              throw error;
            }
          },
        );
      } catch (error) {
        this.#markReconciliationNeededAfterAmbiguousPublish(error, recoveryBinding);
        if (isContentConflict(error) && this.#repositoryReader) {
          await this.#reconcileBinding(recoveryBinding);
        }

        throw error;
      }
    });
  }

  async discardOwnPhoto(actor: DiscordActor, stagedPhotoId: string): Promise<void> {
    this.#assertActor(actor);
    const staged = this.#store.getStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);

    if (staged?.status === 'publishing') {
      throw new ProfileServiceError('photo_publishing', 'This photo is already being published.');
    }

    this.#store.deleteStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);
    this.#audit(actor, staged?.profileSlug, 'PROFILE_DISCARD_PHOTO', {});
  }

  async removeOwnPhoto(actor: DiscordActor, expectedRevision: string): Promise<ProfileOperationResult> {
    this.#assertActor(actor);
    return this.#runOperation(actor, 'PROFILE_REMOVE_PHOTO', async (operationId) => {
      const initialBinding = this.#requireBinding(actor.guildId, actor.userId);
      let recoveryBinding = initialBinding;

      try {
        return await this.#withProfileOperationLock(
          actor.guildId,
          initialBinding.profileSlug,
          'mutation',
          async () => {
            const { binding, state, profile } = this.#requireOwnActiveState(actor);
            this.#assertSameProfileBinding(initialBinding, binding);
            recoveryBinding = binding;
            this.#assertExpectedRevision(state, expectedRevision);

            if (!state.photoBlobSha && profile.photo === '') {
              const result = this.#operationResult(binding, state);
              this.#audit(actor, binding.profileSlug, 'PROFILE_REMOVE_PHOTO_NOOP', result);
              return result;
            }

            if (!state.photoBlobSha) {
              throw new ProfileServiceError(
                'photo_revision_missing',
                'The current photo revision is missing. An owner must repair the profile state.',
              );
            }

            const nextProfile = normalizeMemberProfile({ ...profile, photo: '' });
            const publishResult = await this.#publisher.publish({
              operationId,
              slug: binding.profileSlug,
              action: 'PROFILE_REMOVE_PHOTO',
              profile: { json: serializeProfile(nextProfile), expectedSha: state.profileBlobSha },
              photo: { kind: 'delete', expectedSha: state.photoBlobSha },
            });
            const nextState = this.#savePublishedState(
              actor.guildId,
              binding.profileSlug,
              nextProfile,
              publishResult,
              'delete',
              state,
            );
            const result = this.#operationResult(binding, nextState);
            this.#audit(actor, binding.profileSlug, 'PROFILE_REMOVE_PHOTO', result);
            return result;
          },
        );
      } catch (error) {
        this.#markReconciliationNeededAfterAmbiguousPublish(error, recoveryBinding);
        if (isContentConflict(error) && this.#repositoryReader) {
          await this.#reconcileBinding(recoveryBinding);
        }

        throw error;
      }
    });
  }

  async setOwnListed(
    actor: DiscordActor,
    listed: boolean,
    expectedRevision: string,
  ): Promise<ProfileOperationResult> {
    return this.#mutateOwnProfile(
      actor,
      'PROFILE_SET_LISTED',
      (profile) => ({
        ...profile,
        listed,
      }),
      expectedRevision,
    );
  }

  async ownerHide(actor: DiscordActor, targetUserId: string): Promise<ProfileOperationResult> {
    this.#assertOwner(actor);
    return this.#mutateTargetProfile(actor, targetUserId, 'PROFILE_SET_LISTED', (profile) => ({
      ...profile,
      listed: false,
    }));
  }

  async ownerRevoke(actor: DiscordActor, targetUserId: string): Promise<ProfileOperationResult> {
    this.#assertOwner(actor);
    return this.#runOperation(actor, 'PROFILE_OWNER_REVOKE', async () => {
      const initialBinding = this.#requireBinding(actor.guildId, targetUserId);
      return this.#withProfileOperationLock(
        actor.guildId,
        initialBinding.profileSlug,
        'mutation',
        async () => {
          const binding = this.#requireBinding(actor.guildId, targetUserId);
          this.#assertSameProfileBinding(initialBinding, binding);
          const state = this.#requireState(actor.guildId, binding.profileSlug);
          const updated = this.#store.setBindingStatus(actor.guildId, targetUserId, 'revoked');
          const result = this.#operationResult(updated, state);
          this.#audit(actor, binding.profileSlug, 'PROFILE_OWNER_REVOKE', result, { targetUserId });
          return result;
        },
      );
    });
  }

  async ownerRestore(actor: DiscordActor, targetUserId: string): Promise<ProfileOperationResult> {
    this.#assertOwner(actor);
    return this.#runOperation(actor, 'PROFILE_OWNER_RESTORE', async () => {
      const initialBinding = this.#requireBinding(actor.guildId, targetUserId);
      return this.#withProfileOperationLock(
        actor.guildId,
        initialBinding.profileSlug,
        'mutation',
        async () => {
          const binding = this.#requireBinding(actor.guildId, targetUserId);
          this.#assertSameProfileBinding(initialBinding, binding);
          const state = this.#requireState(actor.guildId, binding.profileSlug);
          const updated = this.#store.setBindingStatus(actor.guildId, targetUserId, 'active');
          const result = this.#operationResult(updated, state);
          this.#audit(actor, binding.profileSlug, 'PROFILE_OWNER_RESTORE', result, { targetUserId });
          return result;
        },
      );
    });
  }

  async ownerTransfer(
    actor: DiscordActor,
    fromUserId: string,
    toUserId: string,
  ): Promise<ProfileOperationResult> {
    this.#assertOwner(actor);
    return this.#runOperation(actor, 'PROFILE_OWNER_TRANSFER', async () => {
      const initialSource = this.#requireBinding(actor.guildId, fromUserId);
      return this.#withProfileOperationLock(
        actor.guildId,
        initialSource.profileSlug,
        'mutation',
        async () => {
          const source = this.#requireBinding(actor.guildId, fromUserId);
          this.#assertSameProfileBinding(initialSource, source);
          const state = this.#requireState(actor.guildId, source.profileSlug);
          const binding = this.#store.transferBinding(actor.guildId, source.profileSlug, toUserId);
          const result = this.#operationResult(binding, state);
          this.#audit(actor, source.profileSlug, 'PROFILE_OWNER_TRANSFER', result, {
            fromUserId,
            toUserId,
          });
          return result;
        },
      );
    });
  }

  async ownerSetCategory(
    actor: DiscordActor,
    targetUserId: string,
    order: MemberOrder,
  ): Promise<ProfileOperationResult> {
    this.#assertOwner(actor);
    return this.#mutateTargetProfile(actor, targetUserId, 'PROFILE_UPDATE', (profile) => ({
      ...profile,
      order,
    }));
  }

  async #mutateOwnProfile(
    actor: DiscordActor,
    action: ProfilePublishInput['action'],
    mutate: (profile: MemberProfile) => MemberProfile,
    expectedRevision: string,
  ) {
    this.#assertActor(actor);
    return this.#mutateTargetProfile(
      actor,
      actor.userId,
      action,
      mutate,
      undefined,
      true,
      expectedRevision,
    );
  }

  async #mutateTargetProfile(
    actor: DiscordActor,
    targetUserId: string,
    action: ProfilePublishInput['action'],
    mutate: (profile: MemberProfile) => MemberProfile,
    photo?: ProfilePublishInput['photo'],
    requireActive = false,
    expectedRevision?: string,
  ): Promise<ProfileOperationResult> {
    return this.#runOperation(actor, action, async (operationId) => {
      const initialBinding = this.#requireBinding(actor.guildId, targetUserId);
      let recoveryBinding = initialBinding;

      try {
        return await this.#withProfileOperationLock(
          actor.guildId,
          initialBinding.profileSlug,
          'mutation',
          async () => {
            const binding = this.#requireBinding(actor.guildId, targetUserId);
            this.#assertSameProfileBinding(initialBinding, binding);
            recoveryBinding = binding;

            if (requireActive && binding.status !== 'active') {
              throw new ProfileServiceError('profile_revoked', 'This profile is currently revoked.');
            }

            const state = this.#requireState(actor.guildId, binding.profileSlug);
            if (expectedRevision) {
              this.#assertExpectedRevision(state, expectedRevision);
            }
            const profile = parseProfile(state.profileJson);
            const nextProfile = normalizeMemberProfile(mutate(profile));
            const publishResult = await this.#publisher.publish({
              operationId,
              slug: binding.profileSlug,
              action,
              profile: { json: serializeProfile(nextProfile), expectedSha: state.profileBlobSha },
              ...(photo ? { photo } : {}),
            });
            const photoChange = photo?.kind;
            const nextState = this.#savePublishedState(
              actor.guildId,
              binding.profileSlug,
              nextProfile,
              publishResult,
              photoChange,
              state,
            );
            const result = this.#operationResult(binding, nextState);
            this.#audit(actor, binding.profileSlug, action, result, { targetUserId });
            return result;
          },
        );
      } catch (error) {
        this.#markReconciliationNeededAfterAmbiguousPublish(error, recoveryBinding);
        if (isContentConflict(error) && this.#repositoryReader) {
          await this.#reconcileBinding(recoveryBinding);
        }

        throw error;
      }
    });
  }

  #requireOwnActiveState(actor: DiscordActor) {
    this.#assertActor(actor);
    const binding = this.#requireBinding(actor.guildId, actor.userId);

    if (binding.status !== 'active') {
      throw new ProfileServiceError('profile_revoked', 'This profile is currently revoked.');
    }

    const state = this.#requireState(actor.guildId, binding.profileSlug);
    return { binding, state, profile: parseProfile(state.profileJson) };
  }

  async #reconcileBinding(binding: ProfileBinding): Promise<ProfileState | undefined> {
    const key = profileKey(binding.guildId, binding.profileSlug);
    const existingTask = this.#reconciliationTasks.get(key);

    if (existingTask) {
      return existingTask;
    }

    const task = this.#withProfileOperationLock(
      binding.guildId,
      binding.profileSlug,
      'recovery',
      () => {
        const currentBinding = this.#store.getBinding(binding.guildId, binding.discordUserId);

        if (!currentBinding || currentBinding.profileSlug !== binding.profileSlug) {
          return Promise.resolve(undefined);
        }

        return this.#reconcileBindingOnce(currentBinding);
      },
    ).then((state) => {
      if (state) {
        this.#profilesNeedingReconciliation.delete(key);
      }

      return state;
    }).finally(() => {
      if (this.#reconciliationTasks.get(key) === task) {
        this.#reconciliationTasks.delete(key);
      }
    });
    this.#reconciliationTasks.set(key, task);
    return task;
  }

  async #reconcileBindingOnce(binding: ProfileBinding): Promise<ProfileState | undefined> {
    if (!this.#repositoryReader) {
      return this.#store.getProfileState(binding.guildId, binding.profileSlug);
    }

    const remote = await this.#repositoryReader.readProfile(binding.profileSlug);

    if (!remote) {
      if (
        binding.status === 'provisioning'
        && this.#now().getTime() - Date.parse(binding.createdAt) >= 30 * 60 * 1000
      ) {
        this.#store.removeProvisioningBinding(binding.guildId, binding.discordUserId);
        return undefined;
      }

      if (binding.status === 'provisioning') {
        return undefined;
      }

      throw new ProfileServiceError(
        'repository_profile_missing',
        'The bot-managed profile is missing from the repository; writes remain blocked.',
      );
    }

    if (binding.status === 'provisioning') {
      if (
        !binding.provisioningOperationId
        || remote.operationId !== binding.provisioningOperationId
      ) {
        throw new ProfileServiceError(
          'registration_proof_mismatch',
          'The remote profile does not match the interrupted registration operation.',
        );
      }
    }

    const existing = this.#store.getProfileState(binding.guildId, binding.profileSlug);

    if (
      existing?.profileBlobSha === remote.profileBlobSha
      && existing.photoBlobSha === remote.photoBlobSha
      && binding.status !== 'provisioning'
    ) {
      return existing;
    }

    const recoveredStatus = await this.#getRecoveredDeploymentStatus(remote);
    const recoveredInput = {
      profileSlug: binding.profileSlug,
      profileJson: serializeProfile(remote.profile),
      profileBlobSha: remote.profileBlobSha,
      ...(remote.photoBlobSha ? { photoBlobSha: remote.photoBlobSha } : {}),
      lastCommitSha: remote.commitSha,
      lastDeploymentStatus: recoveredStatus,
    };

    if (binding.status === 'provisioning') {
      return this.#store.activateBindingWithProfileState(
        binding.guildId,
        binding.discordUserId,
        binding.provisioningOperationId!,
        recoveredInput,
      ).state;
    }

    return this.#store.saveProfileState({ guildId: binding.guildId, ...recoveredInput });
  }

  async #withProfileOperationLock<T>(
    guildId: string,
    profileSlug: string,
    kind: 'mutation' | 'recovery',
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${guildId}\0${profileSlug}`;
    const previous = this.#profileOperationTails.get(key);

    if (kind === 'mutation' && previous) {
      throw new ProfileServiceError(
        'profile_busy',
        'This profile is being recovered or updated. Reopen `/profile` and try again shortly.',
      );
    }

    const waitForPrevious = previous ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = waitForPrevious.then(() => current);
    this.#profileOperationTails.set(key, tail);

    await waitForPrevious;

    try {
      return await operation();
    } finally {
      release();
      if (this.#profileOperationTails.get(key) === tail) {
        this.#profileOperationTails.delete(key);
      }
    }
  }

  #assertSameProfileBinding(expected: ProfileBinding, current: ProfileBinding) {
    if (expected.profileSlug !== current.profileSlug) {
      throw new ProfileServiceError(
        'profile_binding_changed',
        'The profile binding changed while this operation was waiting. Reopen `/profile`.',
      );
    }
  }

  #assertExpectedRevision(state: ProfileState, expectedRevision: string) {
    if (profileStateRevision(state) !== expectedRevision) {
      throw profileChangedError();
    }
  }

  #markReconciliationNeededAfterAmbiguousPublish(error: unknown, binding: ProfileBinding) {
    if (isPublicationTimeout(error)) {
      this.#profilesNeedingReconciliation.add(profileKey(binding.guildId, binding.profileSlug));
    }
  }

  async #getRecoveredDeploymentStatus(remote: RepositoryProfileSnapshot) {
    if (!remote.operationId || !this.#checkpointLookup) {
      return 'published_status_unknown';
    }

    const checkpoint = await this.#checkpointLookup.load(remote.operationId);

    if (!isRecord(checkpoint) || checkpoint.stage !== 'completed' || !isRecord(checkpoint.result)) {
      return 'published_status_unknown';
    }

    if (
      checkpoint.result.profileBlobSha !== remote.profileBlobSha
      || checkpoint.result.commitSha !== remote.commitSha
    ) {
      return 'published_status_unknown';
    }

    const status = checkpoint.result.status;
    return status === 'deployed' || status === 'no_change' || status === 'published_deploy_failed'
      ? status
      : 'published_status_unknown';
  }

  #requireBinding(guildId: string, userId: string) {
    const binding = this.#store.getBinding(guildId, userId);

    if (!binding) {
      throw new ProfileServiceError('not_registered', 'No profile is registered to this Discord account.');
    }

    return binding;
  }

  #requireState(guildId: string, slug: string) {
    const state = this.#store.getProfileState(guildId, slug);

    if (!state) {
      throw new ProfileServiceError(
        'profile_state_missing',
        'The published profile state is unavailable. An owner must repair the binding.',
      );
    }

    return state;
  }

  async #runOperation<T extends ProfileOperationResult>(
    actor: DiscordActor,
    kind: string,
    operation: (operationId: string) => Promise<T>,
  ): Promise<T> {
    this.#assertActor(actor);
    const operationId = this.#newOperationId();
    const started = this.#store.beginInteraction(actor.interactionId, operationId, kind);

    if (!started) {
      const receipt = this.#store.getInteractionReceipt(actor.interactionId);

      if (receipt?.kind !== kind) {
        throw new ProfileServiceError('interaction_mismatch', 'This interaction was already used for another action.');
      }

      if (receipt.status === 'completed') {
        return parseJson<T>(receipt.responseJson);
      }

      throw new ProfileServiceError(
        receipt.status === 'processing' ? 'operation_in_progress' : 'operation_failed',
        receipt.status === 'processing'
          ? 'This profile operation is already in progress.'
          : 'This profile operation previously failed. Start it again from the profile panel.',
      );
    }

    try {
      const result = await operation(operationId);
      this.#store.finishInteraction(actor.interactionId, 'completed', result);
      return result;
    } catch (error) {
      this.#store.finishInteraction(actor.interactionId, 'failed', { error: toErrorMessage(error) });
      throw error;
    }
  }

  #savePublishedState(
    guildId: string,
    slug: string,
    profile: MemberProfile,
    result: ProfilePublishResult,
    photoChange?: 'upsert' | 'delete',
    previous?: ProfileState,
  ) {
    let photoBlobSha = previous?.photoBlobSha;

    if (photoChange === 'upsert') {
      if (!result.photoBlobSha) {
        throw new ProfileServiceError('publisher_contract', 'Publisher did not return the new photo revision.');
      }

      photoBlobSha = result.photoBlobSha;
    } else if (photoChange === 'delete') {
      photoBlobSha = undefined;
    }

    return this.#store.saveProfileState({
      guildId,
      ...this.#publishedStateInput(slug, profile, result, photoBlobSha, previous),
    });
  }

  #publishedStateInput(
    slug: string,
    profile: MemberProfile,
    result: ProfilePublishResult,
    photoBlobSha?: string,
    previous?: ProfileState,
  ) {
    const lastCommitSha = result.commitSha ?? previous?.lastCommitSha;
    const lastDeploymentStatus =
      result.status === 'no_change' && previous
        ? previous.lastDeploymentStatus
        : result.status;
    return {
      profileSlug: slug,
      profileJson: serializeProfile(profile),
      profileBlobSha: result.profileBlobSha,
      ...(photoBlobSha ? { photoBlobSha } : {}),
      ...(lastCommitSha ? { lastCommitSha } : {}),
      lastDeploymentStatus,
    };
  }

  #operationResult(binding: ProfileBinding, state: ProfileState): ProfileOperationResult {
    const result: ProfileOperationResult = {
      snapshot: this.#snapshot(binding, state),
      deploymentStatus: state.lastDeploymentStatus,
    };

    if (state.lastCommitSha) {
      result.commitSha = state.lastCommitSha;
    }

    return result;
  }

  #snapshot(binding: ProfileBinding, state: ProfileState): ProfileSnapshot {
    const snapshot: ProfileSnapshot = {
      profileSlug: binding.profileSlug,
      profile: parseProfile(state.profileJson),
      bindingStatus: binding.status,
      stateRevision: profileStateRevision(state),
      lastDeploymentStatus: state.lastDeploymentStatus,
    };

    if (state.lastCommitSha) {
      snapshot.lastCommitSha = state.lastCommitSha;
    }

    if (this.#membersPageUrl) {
      snapshot.membersPageUrl = this.#membersPageUrl;
    }

    return snapshot;
  }

  #assertActor(actor: DiscordActor) {
    this.#assertGuild(actor.guildId);

    if (!actor.interactionId || !actor.userId) {
      throw new ProfileServiceError('invalid_actor', 'Discord interaction identity is missing.');
    }
  }

  #assertGuild(guildId: string) {
    if (guildId !== this.#guildId) {
      throw new ProfileServiceError('wrong_guild', 'This bot can only be used in the configured Discord server.');
    }
  }

  #assertOwner(actor: DiscordActor) {
    this.#assertActor(actor);

    if (actor.userId !== this.#ownerUserId) {
      throw new ProfileServiceError('owner_only', 'This recovery action is restricted to the bot owner.');
    }
  }

  #audit(
    actor: DiscordActor,
    slug: string | undefined,
    action: string,
    result: ProfileOperationResult,
    detail?: unknown,
  ) {
    this.#store.recordAuditEvent({
      interactionId: actor.interactionId,
      guildId: actor.guildId,
      discordUserId: actor.userId,
      ...(slug ? { profileSlug: slug } : {}),
      action,
      ...(result.commitSha ? { commitSha: result.commitSha } : {}),
      ...(result.deploymentStatus ? { deploymentStatus: result.deploymentStatus } : {}),
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

function serializeProfile(profile: MemberProfile) {
  return `${JSON.stringify(profile, null, 2)}\n`;
}

function parseProfile(json: string) {
  const value: unknown = JSON.parse(json);
  assertMemberProfile(value);
  return value;
}

function parseJson<T>(value: string | undefined): T {
  if (!value) {
    throw new ProfileServiceError('receipt_missing', 'The cached interaction result is unavailable.');
  }

  return JSON.parse(value) as T;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'unknown profile operation error';
}

function isContentConflict(error: unknown) {
  return isRecord(error) && error.code === 'content_conflict';
}

function isPublicationTimeout(error: unknown) {
  return isRecord(error) && error.code === 'publication_timeout';
}

function profileKey(guildId: string, profileSlug: string) {
  return `${guildId}\0${profileSlug}`;
}

function profileStateRevision(state: ProfileState) {
  return createHash('sha256')
    .update(state.profileBlobSha)
    .update('\0')
    .update(state.photoBlobSha ?? '')
    .digest('hex')
    .slice(0, 20);
}

function createStagedPhotoId(baseId: string, revision: string) {
  const maxBaseLength = 64 - 1 - revision.length;
  return `${baseId.slice(0, maxBaseLength)}-${revision}`;
}

function stagedPhotoRevision(stagedPhotoId: string) {
  return /-([0-9a-f]{20})$/.exec(stagedPhotoId)?.[1];
}

function profileChangedError() {
  return new ProfileServiceError(
    'profile_changed',
    'The profile changed after this panel was opened. Reopen `/profile` and try again.',
  );
}

function isDefinitelyUnpublishedRegistrationFailure(error: unknown) {
  if (!isRecord(error) || typeof error.code !== 'string') {
    return false;
  }

  return new Set([
    'invalid_input',
    'unexpected_diff',
    'validation_workflow_not_found',
    'validation_failed',
    'validation_timeout',
    'main_update_rejected',
  ]).has(error.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
