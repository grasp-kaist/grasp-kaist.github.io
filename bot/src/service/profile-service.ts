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
import {
  BindingConflictError,
  ProfileDraftConflictError,
  PublicationJobConflictError,
  SqliteStore,
  type ProfileBinding,
  type ProfileState,
  type ProfileStateInput,
} from '../storage/sqlite-store.js';

const STARTUP_RECONCILIATION_CONCURRENCY = 4;

export type DiscordActor = {
  interactionId: string;
  guildId: string;
  userId: string;
};

export type ProfileSnapshot = {
  profileSlug: string;
  profile: MemberProfile;
  bindingStatus: 'provisioning' | 'active';
  stateRevision: string;
  lastCommitSha?: string;
  lastDeploymentStatus?: string;
  membersPageUrl?: string;
  draft?: {
    profile: MemberProfile;
    revision: string;
    baseStateRevision: string;
    isPublishing: boolean;
    stale: boolean;
  };
};

export type ProfileOperationResult = {
  snapshot?: ProfileSnapshot;
  commitSha?: string;
  deploymentStatus?: string;
  queued?: boolean;
  operationId?: string;
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

export type ProfilePublishResult =
  | {
      status: 'queued';
      operationId: string;
      attempts: 0;
    }
  | {
      status: 'deployed' | 'no_change' | 'published_deploy_failed' | 'sandbox';
      commitSha?: string;
      profileBlobSha: string;
      photoBlobSha?: string | null;
      attempts: number;
      workflowRunUrl?: string;
      pageStatus?: string;
      stateApplied?: boolean;
    };

export type ProfilePublishContext = {
  guildId: string;
  actorUserId: string;
  targetUserId: string;
  interactionId: string;
  receiptKind: string;
  stagedPhotoId?: string;
  awaitCompletion?: boolean;
};

export interface ProfilePublisher {
  readonly usesDurableQueue?: boolean;
  publish(
    input: ProfilePublishInput,
    context?: ProfilePublishContext,
  ): Promise<ProfilePublishResult>;
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
  readonly #membersPageUrl: string | undefined;
  readonly #now: () => Date;
  readonly #newOperationId: () => string;
  readonly #newStageId: () => string;
  readonly #reconciliationTasks = new Map<string, Promise<ProfileState | undefined>>();
  readonly #profileOperationTails = new Map<string, Promise<void>>();
  readonly #registrationTails = new Map<string, Promise<void>>();
  readonly #profilesNeedingReconciliation = new Set<string>();

  constructor(options: {
    store: SqliteStore;
    publisher: ProfilePublisher;
    repositoryReader?: ProfileRepositoryReader;
    checkpointLookup?: PublishCheckpointLookup;
    guildId: string;
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

    // A durable publication job owns reconciliation for this slug until it is
    // atomically applied. Reading main here could observe the just-published
    // commit first and make the worker's binding/receipt CAS impossible.
    if (this.#store.hasNonterminalPublicationJob(guildId, binding.profileSlug)) {
      return state ? this.#snapshot(binding, state) : null;
    }

    if (
      this.#repositoryReader
      && (
        !state
        || this.#profilesNeedingReconciliation.has(profileKey(guildId, binding.profileSlug))
      )
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

    const pendingBindings = this.#store.listBindings(this.#guildId).filter(
      (binding) => !this.#store.hasNonterminalPublicationJob(
        binding.guildId,
        binding.profileSlug,
      ),
    );
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
      let existingBinding = this.#store.getBinding(actor.guildId, actor.userId);

      if (existingBinding) {
        if (
          existingBinding.status === 'provisioning'
          && await this.#releaseUnpublishedProvisioningBinding(existingBinding)
        ) {
          existingBinding = undefined;
        }
      }

      if (existingBinding) {
        throw new ProfileServiceError(
          existingBinding.status === 'provisioning' ? 'registration_recovering' : 'already_registered',
          existingBinding.status === 'provisioning'
            ? 'A previous registration is still being recovered. Try `/profile` again shortly.'
            : 'This Discord account is already registered.',
        );
      }

      const profile = createEmptyProfile(input);
      const slug = await this.#reserveAvailableBinding(actor, profile, operationId);
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
            }, this.#publishContext(actor, actor.userId, 'PROFILE_CREATE'));

            if (publishResult.status === 'queued') {
              return this.#queuedResult(publishResult.operationId);
            }

            published = true;

            if (publishResult.stateApplied) {
              return this.#currentOperationResult(actor.guildId, actor.userId, slug);
            }

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

  stageOwnProfileDraft(
    actor: DiscordActor,
    patch: EditableProfilePatch,
    expectedRevision: string,
  ): ProfileSnapshot {
    this.#assertActor(actor);
    const binding = this.#requireBinding(actor.guildId, actor.userId);
    this.#assertProfileAvailableForDraftEdit(binding);

    if (binding.status !== 'active') {
      throw new ProfileServiceError(
        'profile_not_active',
        'This profile is not active yet. Try again shortly.',
      );
    }

    const state = this.#requireState(actor.guildId, binding.profileSlug);
    const existing = this.#store.getProfileDraft(actor.guildId, actor.userId);
    let source: MemberProfile;
    let baseStateRevision: string;

    if (existing) {
      if (existing.profileSlug !== binding.profileSlug) {
        throw new ProfileServiceError(
          'draft_binding_changed',
          'The saved profile draft no longer matches this account.',
        );
      }
      if (existing.draftRevision !== expectedRevision) {
        throw profileDraftChangedError();
      }
      source = parseProfile(existing.profileJson);
      baseStateRevision = existing.baseStateRevision;
    } else {
      this.#assertExpectedRevision(state, expectedRevision);
      source = parseProfile(state.profileJson);
      baseStateRevision = profileStateRevision(state);
    }

    const profile = normalizeMemberProfile({ ...source, ...patch });
    const profileJson = serializeProfile(profile);

    if (profileJson === state.profileJson) {
      if (
        existing
        && !this.#store.deleteProfileDraft(
          actor.guildId,
          actor.userId,
          existing.draftRevision,
        )
      ) {
        throw profileDraftChangedError();
      }
      return this.#snapshot(binding, state);
    }

    if (existing?.profileJson === profileJson) {
      return this.#snapshot(binding, state);
    }

    const draftRevision = profileDraftRevision(
      baseStateRevision,
      profileJson,
      existing?.draftRevision,
    );

    try {
      this.#store.saveProfileDraft(
        {
          guildId: actor.guildId,
          discordUserId: actor.userId,
          profileSlug: binding.profileSlug,
          baseStateRevision,
          draftRevision,
          profileJson,
        },
        existing?.draftRevision ?? null,
      );
    } catch (error) {
      if (error instanceof ProfileDraftConflictError) {
        throw profileDraftChangedError();
      }
      throw error;
    }

    return this.#snapshot(binding, state);
  }

  discardOwnProfileDraft(
    actor: DiscordActor,
    expectedDraftRevision: string,
  ): ProfileSnapshot {
    this.#assertActor(actor);
    const binding = this.#requireBinding(actor.guildId, actor.userId);
    this.#assertProfileAvailableForDraftEdit(binding);
    const state = this.#requireState(actor.guildId, binding.profileSlug);
    const draft = this.#store.getProfileDraft(actor.guildId, actor.userId);

    if (!draft) {
      throw new ProfileServiceError('draft_missing', 'There is no saved profile draft to discard.');
    }
    if (
      draft.profileSlug !== binding.profileSlug
      || draft.draftRevision !== expectedDraftRevision
      || !this.#store.deleteProfileDraft(
        actor.guildId,
        actor.userId,
        expectedDraftRevision,
      )
    ) {
      throw profileDraftChangedError();
    }

    return this.#snapshot(binding, state);
  }

  async saveOwnProfileDraft(
    actor: DiscordActor,
    expectedDraftRevision: string,
  ): Promise<ProfileOperationResult> {
    this.#assertActor(actor);
    const binding = this.#requireBinding(actor.guildId, actor.userId);
    this.#assertProfileAvailableForDraftEdit(binding);
    const state = this.#requireState(actor.guildId, binding.profileSlug);
    const draft = this.#store.getProfileDraft(actor.guildId, actor.userId);

    if (!draft) {
      throw new ProfileServiceError('draft_missing', 'There is no saved profile draft to publish.');
    }
    if (draft.profileSlug !== binding.profileSlug || draft.draftRevision !== expectedDraftRevision) {
      throw profileDraftChangedError();
    }
    if (draft.baseStateRevision !== profileStateRevision(state)) {
      throw profileChangedError();
    }

    const profile = parseProfile(draft.profileJson);
    return this.updateOwnProfile(
      actor,
      editableProfilePatch(profile),
      draft.baseStateRevision,
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
      const normalizedError = publicationConflictError(error);
      this.#store.finishInteraction(
        actor.interactionId,
        'failed',
        { error: toErrorMessage(normalizedError) },
      );
      throw normalizedError;
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
              }, this.#publishContext(
                actor,
                actor.userId,
                'PROFILE_REPLACE_PHOTO',
                { stagedPhotoId },
              ));

              if (publishResult.status === 'queued') {
                return this.#queuedResult(publishResult.operationId);
              }

              if (publishResult.stateApplied) {
                this.#store.deleteStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);
                return this.#currentOperationResult(
                  actor.guildId,
                  actor.userId,
                  binding.profileSlug,
                );
              }

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
    const binding = this.#store.getBinding(actor.guildId, actor.userId);
    if (binding) {
      this.#assertNoPendingPublication(binding);
    }
    const staged = this.#store.getStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);

    if (staged?.status === 'publishing') {
      throw new ProfileServiceError('photo_publishing', 'This photo is already being published.');
    }

    try {
      this.#store.deleteStagedPhoto(actor.guildId, actor.userId, stagedPhotoId);
    } catch (error) {
      throw publicationConflictError(error);
    }
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
            }, this.#publishContext(actor, actor.userId, 'PROFILE_REMOVE_PHOTO'));

            if (publishResult.status === 'queued') {
              return this.#queuedResult(publishResult.operationId);
            }

            if (publishResult.stateApplied) {
              return this.#currentOperationResult(
                actor.guildId,
                actor.userId,
                binding.profileSlug,
              );
            }

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
      expectedRevision,
    );
  }

  async #mutateTargetProfile(
    actor: DiscordActor,
    targetUserId: string,
    action: ProfilePublishInput['action'],
    mutate: (profile: MemberProfile) => MemberProfile,
    photo?: ProfilePublishInput['photo'],
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
            this.#assertNoPendingPublication(binding);
            if (action === 'PROFILE_SET_LISTED') {
              this.#assertNoProfileDraft(binding, targetUserId);
            }
            recoveryBinding = binding;

            if (binding.status !== 'active') {
              throw new ProfileServiceError(
                'profile_not_active',
                'This profile is not active yet. Try again shortly.',
              );
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
            }, this.#publishContext(actor, targetUserId, action));

            if (publishResult.status === 'queued') {
              return this.#queuedResult(publishResult.operationId);
            }

            if (publishResult.stateApplied) {
              return this.#currentOperationResult(
                actor.guildId,
                targetUserId,
                binding.profileSlug,
              );
            }

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
    this.#assertNoPendingPublication(binding);
    this.#assertNoProfileDraft(binding, actor.userId);

    if (binding.status !== 'active') {
      throw new ProfileServiceError(
        'profile_not_active',
        'This profile is not active yet. Try again shortly.',
      );
    }

    const state = this.#requireState(actor.guildId, binding.profileSlug);
    return { binding, state, profile: parseProfile(state.profileJson) };
  }

  #assertNoPendingPublication(binding: ProfileBinding) {
    if (this.#store.hasNonterminalPublicationJob(binding.guildId, binding.profileSlug)) {
      throw new ProfileServiceError(
        'publication_pending',
        'A website update for this profile is already queued or publishing. Try again after it finishes.',
      );
    }
  }

  #assertProfileAvailableForDraftEdit(binding: ProfileBinding) {
    this.#assertNoPendingPublication(binding);
    if (this.#profileOperationTails.has(profileKey(binding.guildId, binding.profileSlug))) {
      throw new ProfileServiceError(
        'profile_busy',
        'This profile is being recovered or updated. Reopen `/profile` and try again shortly.',
      );
    }
  }

  #assertNoProfileDraft(binding: ProfileBinding, userId: string) {
    const draft = this.#store.getProfileDraft(binding.guildId, userId);
    if (!draft) {
      return;
    }

    const state = this.#store.getProfileState(binding.guildId, binding.profileSlug);
    if (
      state
      && draft.profileSlug === binding.profileSlug
      && draft.profileJson === state.profileJson
    ) {
      this.#store.clearProfileDraftIfProfileMatches(
        binding.guildId,
        userId,
        binding.profileSlug,
        state.profileJson,
      );
      return;
    }

    throw new ProfileServiceError(
      'profile_draft_exists',
      'Save or discard the profile draft before changing listing or photo settings.',
    );
  }

  async #reconcileBinding(binding: ProfileBinding): Promise<ProfileState | undefined> {
    if (this.#store.hasNonterminalPublicationJob(binding.guildId, binding.profileSlug)) {
      return this.#store.getProfileState(binding.guildId, binding.profileSlug);
    }

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
        && binding.provisioningOperationId
        && this.#checkpointLookup
        && await this.#checkpointLookup.load(binding.provisioningOperationId)
      ) {
        throw new ProfileServiceError(
          'registration_remote_pending',
          'Publication evidence exists, but the profile is not currently visible in the repository; the binding was preserved.',
        );
      }

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
      const completed = this.#store.activateBindingWithProfileState(
        binding.guildId,
        binding.discordUserId,
        binding.provisioningOperationId!,
        recoveredInput,
      );
      this.#completeRecoveredInteraction(
        completed.binding,
        completed.state,
        binding.provisioningOperationId!,
        'PROFILE_CREATE',
        binding.discordUserId,
      );
      return completed.state;
    }

    return this.#store.saveProfileState({ guildId: binding.guildId, ...recoveredInput });
  }

  #completeRecoveredInteraction(
    binding: ProfileBinding,
    state: ProfileState,
    operationId: string,
    kind: string,
    actorUserId: string,
    detail: unknown = { recovered: true },
  ) {
    const result = this.#operationResult(binding, state);
    const receipt = this.#store.completeProcessingInteractionByOperation(
      operationId,
      kind,
      result,
    );

    if (!receipt) {
      return;
    }

    this.#audit(
      {
        interactionId: receipt.interactionId,
        guildId: binding.guildId,
        userId: actorUserId,
      },
      binding.profileSlug,
      kind,
      result,
      detail,
    );
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

  async #reserveAvailableBinding(
    actor: DiscordActor,
    profile: MemberProfile,
    operationId: string,
  ) {
    return this.#withRegistrationLock(actor.guildId, async () => {
      const takenSlugs = new Set(
        this.#store.listBindings(actor.guildId).map((binding) => binding.profileSlug),
      );
      const baseSlug = generateProfileSlug(profile.name, new Set());

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const slug = numericSlugCandidate(baseSlug, attempt);

        if (takenSlugs.has(slug)) {
          continue;
        }

        if (this.#repositoryReader && await this.#repositoryReader.readProfile(slug)) {
          takenSlugs.add(slug);
          continue;
        }

        try {
          this.#store.reserveBinding(actor.guildId, actor.userId, slug, operationId);
          return slug;
        } catch (error) {
          if (!(error instanceof BindingConflictError)) {
            throw error;
          }

          const ownBinding = this.#store.getBinding(actor.guildId, actor.userId);
          if (ownBinding) {
            throw new ProfileServiceError(
              'already_registered',
              'This Discord account is already registered.',
            );
          }
          takenSlugs.add(slug);
        }
      }

      throw new ProfileServiceError(
        'slug_exhausted',
        'No safe profile identifier was available for this name.',
      );
    });
  }

  async #releaseUnpublishedProvisioningBinding(binding: ProfileBinding) {
    if (this.#profileOperationTails.has(profileKey(binding.guildId, binding.profileSlug))) {
      return false;
    }

    try {
      const recovered = await this.#reconcileBinding(binding);
      const current = this.#store.getBinding(binding.guildId, binding.discordUserId);

      if (!current) {
        return true;
      }

      if (recovered || current.status !== 'provisioning') {
        return false;
      }
    } catch (error) {
      if (!(error instanceof ProfileServiceError) || error.code !== 'registration_proof_mismatch') {
        throw error;
      }

      this.#store.removeProvisioningBinding(binding.guildId, binding.discordUserId);
      return true;
    }

    const checkpoint = binding.provisioningOperationId && this.#checkpointLookup
      ? await this.#checkpointLookup.load(binding.provisioningOperationId)
      : null;

    if (checkpoint) {
      return false;
    }

    if (this.#now().getTime() - Date.parse(binding.createdAt) < 30 * 60 * 1000) {
      return false;
    }

    this.#store.removeProvisioningBinding(binding.guildId, binding.discordUserId);
    return true;
  }

  async #withRegistrationLock<T>(guildId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#registrationTails.get(guildId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#registrationTails.set(guildId, tail);

    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (this.#registrationTails.get(guildId) === tail) {
        this.#registrationTails.delete(guildId);
      }
    }
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

      if (result.queued) {
        return result;
      }

      this.#store.finishInteraction(actor.interactionId, 'completed', result);
      return result;
    } catch (error) {
      const normalizedError = publicationConflictError(error);
      this.#store.finishInteraction(
        actor.interactionId,
        'failed',
        { error: toErrorMessage(normalizedError) },
      );
      throw normalizedError;
    }
  }

  #savePublishedState(
    guildId: string,
    slug: string,
    profile: MemberProfile,
    result: Exclude<ProfilePublishResult, { status: 'queued' }>,
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
    result: Exclude<ProfilePublishResult, { status: 'queued' }>,
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

  #queuedResult(operationId: string): ProfileOperationResult {
    return {
      queued: true,
      operationId,
      deploymentStatus: 'queued',
    };
  }

  #currentOperationResult(
    guildId: string,
    targetUserId: string,
    expectedSlug: string,
  ) {
    const binding = this.#requireBinding(guildId, targetUserId);

    if (binding.profileSlug !== expectedSlug) {
      throw new ProfileServiceError(
        'profile_binding_changed',
        'The queued publication completed for a profile whose binding has changed.',
      );
    }

    const state = this.#requireState(guildId, expectedSlug);
    return this.#operationResult(binding, state);
  }

  #publishContext(
    actor: DiscordActor,
    targetUserId: string,
    receiptKind: string,
    optional: Pick<ProfilePublishContext, 'stagedPhotoId'> = {},
  ): ProfilePublishContext {
    return {
      guildId: actor.guildId,
      actorUserId: actor.userId,
      targetUserId,
      interactionId: actor.interactionId,
      receiptKind,
      ...optional,
    };
  }

  #snapshot(binding: ProfileBinding, state: ProfileState): ProfileSnapshot {
    const profile = parseProfile(state.profileJson);
    const stateRevision = profileStateRevision(state);
    const snapshot: ProfileSnapshot = {
      profileSlug: binding.profileSlug,
      profile,
      bindingStatus: binding.status,
      stateRevision,
      lastDeploymentStatus: state.lastDeploymentStatus,
    };

    const storedDraft = this.#store.getProfileDraft(binding.guildId, binding.discordUserId);
    if (storedDraft?.profileSlug === binding.profileSlug) {
      if (storedDraft.profileJson === state.profileJson) {
        this.#store.clearProfileDraftIfProfileMatches(
          binding.guildId,
          binding.discordUserId,
          binding.profileSlug,
          state.profileJson,
        );
      } else {
        snapshot.draft = {
          profile: parseProfile(storedDraft.profileJson),
          revision: storedDraft.draftRevision,
          baseStateRevision: storedDraft.baseStateRevision,
          isPublishing: this.#store.hasNonterminalPublicationJob(
            binding.guildId,
            binding.profileSlug,
          ),
          stale: storedDraft.baseStateRevision !== stateRevision,
        };
      }
    }

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

function publicationConflictError(error: unknown) {
  return error instanceof PublicationJobConflictError
    ? new ProfileServiceError(
        'publication_pending',
        'A website update for this profile is already queued or publishing. Try again after it finishes.',
      )
    : error;
}

function isPublicationTimeout(error: unknown) {
  return isRecord(error) && error.code === 'publication_timeout';
}

function profileKey(guildId: string, profileSlug: string) {
  return `${guildId}\0${profileSlug}`;
}

function numericSlugCandidate(baseSlug: string, attempt: number) {
  if (attempt === 0) {
    return baseSlug;
  }

  const suffix = `-${attempt + 1}`;
  return `${baseSlug.slice(0, 64 - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

function profileStateRevision(state: ProfileState) {
  return createHash('sha256')
    .update(state.profileBlobSha)
    .update('\0')
    .update(state.photoBlobSha ?? '')
    .digest('hex')
    .slice(0, 20);
}

function profileDraftRevision(
  baseStateRevision: string,
  profileJson: string,
  previousDraftRevision = '',
) {
  return createHash('sha256')
    .update('profile-draft\0')
    .update(baseStateRevision)
    .update('\0')
    .update(previousDraftRevision)
    .update('\0')
    .update(profileJson)
    .digest('hex')
    .slice(0, 20);
}

function editableProfilePatch(profile: MemberProfile): EditableProfilePatch {
  return {
    name: profile.name,
    position: profile.position,
    order: profile.order,
    details: profile.details,
    researchInterests: profile.researchInterests,
    contact: profile.contact,
    website: profile.website,
  };
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

function profileDraftChangedError() {
  return new ProfileServiceError(
    'draft_changed',
    'The profile draft changed after this form was opened. Reopen `/profile` and try again.',
  );
}

function isDefinitelyUnpublishedRegistrationFailure(error: unknown) {
  if (!isRecord(error) || typeof error.code !== 'string') {
    return false;
  }

  return new Set([
    'content_conflict',
    'invalid_input',
    'main_conflict',
    'unexpected_diff',
    'validation_workflow_not_found',
    'validation_unavailable',
    'validation_failed',
    'validation_timeout',
    'main_update_rejected',
  ]).has(error.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
