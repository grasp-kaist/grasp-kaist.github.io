import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  ProfileService,
  ProfileServiceError,
  type ProfilePublishInput,
  type ProfilePublishContext,
  type ProfilePublishResult,
  type ProfilePublisher,
  type ProfileRepositoryReader,
  type RepositoryProfileSnapshot,
} from '../src/service/profile-service.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const guildId = 'guild';

class RecordingPublisher implements ProfilePublisher {
  readonly calls: ProfilePublishInput[] = [];
  readonly contexts: Array<ProfilePublishContext | undefined> = [];
  failNext: Error | undefined;
  nextStatus: Exclude<ProfilePublishResult['status'], 'queued'> | undefined;
  pauseNext: Promise<void> | undefined;
  queueNext = false;

  async publish(
    input: ProfilePublishInput,
    context?: ProfilePublishContext,
  ): Promise<ProfilePublishResult> {
    this.calls.push(input);
    this.contexts.push(context);

    if (this.queueNext) {
      this.queueNext = false;
      return { status: 'queued', operationId: input.operationId, attempts: 0 };
    }

    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }

    if (this.pauseNext) {
      const pause = this.pauseNext;
      this.pauseNext = undefined;
      await pause;
    }

    const sequence = this.calls.length;
    const result: ProfilePublishResult = {
      status: this.nextStatus ?? 'deployed',
      profileBlobSha: `profile-${sequence}`,
      attempts: 1,
    };
    this.nextStatus = undefined;

    if (result.status !== 'no_change') {
      result.commitSha = `commit-${sequence}`;
    }

    if (input.photo?.kind === 'upsert') {
      result.photoBlobSha = `photo-${sequence}`;
    }

    return result;
  }
}

function createFixture(options: { repositoryReader?: ProfileRepositoryReader } = {}) {
  const store = new SqliteStore(':memory:', {
    now: () => new Date('2026-08-21T00:00:00.000Z'),
  });
  const publisher = new RecordingPublisher();
  let operationSequence = 0;
  let stageSequence = 0;
  const service = new ProfileService({
    store,
    publisher,
    ...(options.repositoryReader ? { repositoryReader: options.repositoryReader } : {}),
    guildId,
    membersPageUrl: 'https://grasp-kaist.github.io/members/',
    now: () => new Date('2026-08-21T00:00:00.000Z'),
    newOperationId: () => `operation-${++operationSequence}`,
    newStageId: () => `stage-${++stageSequence}`,
  });
  return { store, publisher, service };
}

function actor(interactionId: string, userId = 'member') {
  return { interactionId, guildId, userId };
}

async function registerMember(service: ProfileService, userId = 'member') {
  return service.register(actor(`register-${userId}`, userId), {
    name: 'Example Member',
    position: 'Undergraduate Student, KAIST',
    order: 4,
  });
}

function currentRevision(service: ProfileService, userId = 'member') {
  const revision = service.getOwnProfileLocal(guildId, userId).snapshot?.stateRevision;
  assert.ok(revision);
  return revision;
}

function profileSnapshot(
  overrides: Partial<RepositoryProfileSnapshot['profile']> = {},
): RepositoryProfileSnapshot['profile'] {
  return {
    listed: false,
    order: 4,
    name: 'Example Member',
    position: 'Undergraduate Student, KAIST',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo: '',
    ...overrides,
  };
}

function enqueueRecordedPublisherCall(
  store: SqliteStore,
  publisher: RecordingPublisher,
  callIndex: number,
) {
  const call = publisher.calls[callIndex];
  const context = publisher.contexts[callIndex];
  assert.ok(call);
  assert.ok(context);

  return store.enqueuePublicationJob({
    operationId: call.operationId,
    context: {
      guildId: context.guildId,
      actorUserId: context.actorUserId,
      targetUserId: context.targetUserId,
      interactionId: context.interactionId,
      receiptKind: context.receiptKind,
      ...(context.stagedPhotoId ? { stagedPhotoId: context.stagedPhotoId } : {}),
    },
    profileSlug: call.slug,
    action: call.action,
    profileJson: call.profile.json,
    profileExpectedSha: call.profile.expectedSha,
    ...(call.photo ? { photo: call.photo } : {}),
  });
}

test('local profile probes do not add repository reads after registration preflight', async () => {
  let repositoryReads = 0;
  const { store, service } = createFixture({
    repositoryReader: {
      readProfile: async () => {
        repositoryReads += 1;
        return null;
      },
    },
  });

  try {
    assert.deepEqual(service.getOwnProfileLocal(guildId, 'member'), {
      hasBinding: false,
      snapshot: null,
    });
    await registerMember(service);
    const readsAfterRegistration = repositoryReads;

    const local = service.getOwnProfileLocal(guildId, 'member');
    assert.equal(local.hasBinding, true);
    assert.equal(local.snapshot?.bindingStatus, 'active');
    assert.equal(local.snapshot?.profile.name, 'Example Member');
    assert.equal(repositoryReads, readsAfterRegistration);
  } finally {
    store.close();
  }
});

test('registration immediately binds an unlisted canonical profile and is idempotent', async () => {
  const { store, publisher, service } = createFixture();

  try {
    const first = await registerMember(service);
    const repeated = await registerMember(service);

    assert.equal(publisher.calls.length, 1);
    assert.equal(publisher.calls[0]?.action, 'PROFILE_CREATE');
    assert.equal(publisher.calls[0]?.profile.expectedSha, null);
    assert.equal(first.snapshot?.profile.listed, false);
    assert.equal(first.snapshot?.profileSlug, 'example-member');
    assert.deepEqual(repeated, first);
    assert.equal(store.getBinding(guildId, 'member')?.status, 'active');
  } finally {
    store.close();
  }
});

test('a queued registration keeps its reservation and processing receipt for the worker', async () => {
  const { store, publisher, service } = createFixture();
  publisher.queueNext = true;

  try {
    const result = await registerMember(service);

    assert.deepEqual(result, {
      queued: true,
      operationId: 'operation-1',
      deploymentStatus: 'queued',
    });
    assert.equal(store.getBinding(guildId, 'member')?.status, 'provisioning');
    assert.equal(store.getInteractionReceipt('register-member')?.status, 'processing');
    assert.deepEqual(publisher.contexts[0], {
      guildId,
      actorUserId: 'member',
      targetUserId: 'member',
      interactionId: 'register-member',
      receiptKind: 'PROFILE_CREATE',
    });
  } finally {
    store.close();
  }
});

test('registration skips a remotely existing slug and allocates the numeric -2 suffix', async () => {
  const repositoryReads: string[] = [];
  const { store, publisher, service } = createFixture({
    repositoryReader: {
      readProfile: async (slug) => {
        repositoryReads.push(slug);
        return slug === 'example-member'
          ? {
              profile: profileSnapshot(),
              profileBlobSha: 'remote-profile',
              commitSha: 'remote-commit',
              operationId: 'pre-existing-operation',
            }
          : null;
      },
    },
  });

  try {
    const registered = await registerMember(service);

    assert.equal(registered.snapshot?.profileSlug, 'example-member-2');
    assert.equal(store.getBinding(guildId, 'member')?.profileSlug, 'example-member-2');
    assert.equal(publisher.calls[0]?.slug, 'example-member-2');
    assert.deepEqual(repositoryReads, ['example-member', 'example-member-2']);
  } finally {
    store.close();
  }
});

test('a definitely unpublished validation failure releases the provisional registration', async () => {
  const { store, publisher, service } = createFixture();
  publisher.failNext = Object.assign(new Error('validation failed'), {
    code: 'validation_failed',
  });

  try {
    await assert.rejects(() => registerMember(service), /validation failed/);
    assert.equal(store.getBinding(guildId, 'member'), undefined);
  } finally {
    store.close();
  }
});

for (const errorCode of ['content_conflict', 'main_conflict'] as const) {
  test(`${errorCode} releases the provisional registration`, async () => {
    const { store, publisher, service } = createFixture();
    publisher.failNext = Object.assign(new Error(errorCode), { code: errorCode });

    try {
      await assert.rejects(() => registerMember(service), new RegExp(errorCode));
      assert.equal(store.getBinding(guildId, 'member'), undefined);
    } finally {
      store.close();
    }
  });
}

test('an ambiguous initial publish failure keeps its reservation for remote reconciliation', async () => {
  const { store, publisher, service } = createFixture();
  publisher.failNext = new Error('connection ended after the main update');

  try {
    await assert.rejects(
      () => registerMember(service),
      /connection ended after the main update/,
    );
    const binding = store.getBinding(guildId, 'member');
    assert.equal(binding?.status, 'provisioning');
    assert.equal(binding?.provisioningOperationId, 'operation-1');
  } finally {
    store.close();
  }
});

test('registration and concurrent profile recovery finalize one active binding', async () => {
  const releasePublish = Promise.withResolvers<void>();
  let repositoryReads = 0;
  let remotePublished = false;
  const remoteProfile = {
    listed: false,
    order: 4 as const,
    name: 'Example Member',
    position: 'Undergraduate Student, KAIST',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo: '',
  };
  const { store, publisher, service } = createFixture({
    repositoryReader: {
      readProfile: async () => {
        repositoryReads += 1;
        return remotePublished ? {
          profile: remoteProfile,
          profileBlobSha: 'profile-1',
          commitSha: 'commit-1',
          operationId: 'operation-1',
        } : null;
      },
    },
  });

  try {
    publisher.pauseNext = releasePublish.promise;
    const registration = registerMember(service);

    while (publisher.calls.length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    remotePublished = true;
    const recovery = service.getOwnProfile(guildId, 'member');
    releasePublish.resolve();
    const [registered, recovered] = await Promise.all([registration, recovery]);

    assert.equal(registered.snapshot?.bindingStatus, 'active');
    assert.equal(recovered?.bindingStatus, 'active');
    assert.equal(repositoryReads, 2);
    assert.equal(store.getInteractionReceipt('register-member')?.status, 'completed');
  } finally {
    releasePublish.resolve();
    store.close();
  }
});

test('a second service cannot steal a fresh provisioning binding while publication is running', async () => {
  const { store, publisher, service } = createFixture();
  const releasePublish = Promise.withResolvers<void>();
  const secondService = new ProfileService({
    store,
    publisher,
    guildId,
    now: () => new Date('2026-08-21T00:00:00.000Z'),
    newOperationId: () => 'second-operation',
  });

  try {
    publisher.pauseNext = releasePublish.promise;
    const firstRegistration = registerMember(service);

    while (publisher.calls.length < 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    await assert.rejects(
      secondService.register(actor('register-from-second-service'), {
        name: 'Example Member',
        position: 'Undergraduate Student, KAIST',
        order: 4,
      }),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'registration_recovering',
    );
    assert.equal(
      store.getBinding(guildId, 'member')?.provisioningOperationId,
      'operation-1',
    );

    releasePublish.resolve();
    const completed = await firstRegistration;
    assert.equal(completed.snapshot?.bindingStatus, 'active');
  } finally {
    releasePublish.resolve();
    store.close();
  }
});

test('profile edits carry the stored blob revision and listed is independently mutable', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const updated = await service.updateOwnProfile(actor('edit-1'), {
      details: ['  B.S. student  ', ''],
      website: 'example.com',
    }, currentRevision(service));
    const listed = await service.setOwnListed(
      actor('listed-1'),
      true,
      updated.snapshot!.stateRevision,
    );

    assert.equal(publisher.calls[1]?.profile.expectedSha, 'profile-1');
    assert.equal(publisher.calls[2]?.profile.expectedSha, 'profile-2');
    assert.deepEqual(updated.snapshot?.profile.details, ['B.S. student']);
    assert.equal(updated.snapshot?.profile.website, 'example.com');
    assert.equal(listed.snapshot?.profile.listed, true);
  } finally {
    store.close();
  }
});

test('profile draft fields merge with revision CAS and can be discarded without publishing', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const first = service.stageOwnProfileDraft(
      actor('draft-details'),
      { details: ['  First detail  '] },
      currentRevision(service),
    );
    assert.deepEqual(first.draft?.profile.details, ['First detail']);
    assert.match(first.draft?.revision ?? '', /^[0-9a-f]{20}$/);
    assert.equal(publisher.calls.length, 1);

    const second = service.stageOwnProfileDraft(
      actor('draft-contact'),
      { contact: [' member@kaist '] },
      first.draft!.revision,
    );
    assert.deepEqual(second.draft?.profile.details, ['First detail']);
    assert.deepEqual(second.draft?.profile.contact, ['member@kaist']);

    assert.throws(
      () => service.stageOwnProfileDraft(
        actor('stale-draft-edit'),
        { website: 'stale.example' },
        first.draft!.revision,
      ),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'draft_changed',
    );

    const discarded = service.discardOwnProfileDraft(
      actor('discard-draft'),
      second.draft!.revision,
    );
    assert.equal(discarded.draft, undefined);
    assert.deepEqual(discarded.profile.details, []);
    assert.equal(publisher.calls.length, 1);
  } finally {
    store.close();
  }
});

test('saving a profile draft publishes the full editable draft exactly once', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const draft = service.stageOwnProfileDraft(
      actor('stage-full-draft'),
      {
        name: 'Drafted Member',
        details: ['Draft detail'],
        researchInterests: ['Reliable systems'],
        contact: ['member@kaist'],
        website: 'draft.example',
      },
      currentRevision(service),
    );

    const saved = await service.saveOwnProfileDraft(
      actor('save-full-draft'),
      draft.draft!.revision,
    );

    assert.equal(publisher.calls.length, 2);
    assert.equal(publisher.calls[1]?.action, 'PROFILE_UPDATE');
    assert.deepEqual(JSON.parse(publisher.calls[1]!.profile.json), draft.draft?.profile);
    assert.equal(saved.snapshot?.profile.name, 'Drafted Member');
    assert.equal(saved.snapshot?.profile.website, 'draft.example');
    assert.equal(saved.snapshot?.draft, undefined);
    assert.equal(store.getProfileDraft(guildId, 'member'), undefined);
  } finally {
    store.close();
  }
});

test('fields, visibility, and a selected photo publish together in one profile update', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const draft = service.stageOwnProfileDraft(
      actor('stage-combined-fields'),
      { details: ['Combined edit'], listed: true },
      currentRevision(service),
    );
    const source = await sharp({
      create: { width: 900, height: 1200, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    const preview = await service.prepareOwnPhoto(actor('prepare-combined-photo'), {
      bytes: source,
      filename: 'portrait.png',
    });
    const accepted = service.acceptOwnPhoto(
      actor('accept-combined-photo'),
      preview.stagedPhotoId,
    );

    assert.equal(publisher.calls.length, 1, 'draft editing and photo selection must not publish');
    assert.equal(accepted.draft?.profile.listed, true);
    assert.equal(accepted.draft?.profile.photo, 'example-member.webp');
    assert.equal(accepted.pendingPhoto?.stagedPhotoId, preview.stagedPhotoId);
    assert.notEqual(accepted.editRevision, draft.editRevision);

    const saved = await service.saveOwnProfileEdits(
      actor('save-combined-edit'),
      accepted.editRevision,
    );
    const call = publisher.calls[1];
    const publishedProfile = JSON.parse(call!.profile.json);

    assert.equal(publisher.calls.length, 2);
    assert.equal(call?.action, 'PROFILE_UPDATE');
    assert.equal(call?.photo?.kind, 'upsert');
    assert.deepEqual(publishedProfile.details, ['Combined edit']);
    assert.equal(publishedProfile.listed, true);
    assert.equal(publishedProfile.photo, 'example-member.webp');
    assert.equal(saved.snapshot?.draft, undefined);
    assert.equal(saved.snapshot?.pendingPhoto, undefined);
  } finally {
    store.close();
  }
});

test('photo-only replacement remains pending even when the profile JSON is unchanged', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const firstBytes = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#111111' },
    }).png().toBuffer();
    const first = await service.prepareOwnPhoto(actor('prepare-first-photo'), {
      bytes: firstBytes,
      filename: 'first.png',
    });
    await service.confirmOwnPhoto(actor('publish-first-photo'), first.stagedPhotoId);

    const replacementBytes = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#eeeeee' },
    }).png().toBuffer();
    const replacement = await service.prepareOwnPhoto(actor('prepare-replacement-photo'), {
      bytes: replacementBytes,
      filename: 'replacement.png',
    });
    const accepted = service.acceptOwnPhoto(
      actor('accept-replacement-photo'),
      replacement.stagedPhotoId,
    );

    assert.equal(accepted.draft, undefined);
    assert.equal(accepted.pendingPhoto?.stagedPhotoId, replacement.stagedPhotoId);
    assert.equal(publisher.calls.length, 2);

    await service.saveOwnProfileEdits(
      actor('save-replacement-photo'),
      accepted.editRevision,
    );

    assert.equal(publisher.calls.length, 3);
    assert.equal(publisher.calls[2]?.action, 'PROFILE_UPDATE');
    assert.equal(publisher.calls[2]?.photo?.kind, 'upsert');
  } finally {
    store.close();
  }
});

test('cancelling a new photo preview keeps the previously selected photo', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const firstBytes = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#112233' },
    }).png().toBuffer();
    const first = await service.prepareOwnPhoto(actor('prepare-selected-photo'), {
      bytes: firstBytes,
      filename: 'first.png',
    });
    service.acceptOwnPhoto(actor('accept-selected-photo'), first.stagedPhotoId);

    const secondBytes = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#445566' },
    }).png().toBuffer();
    const second = await service.prepareOwnPhoto(actor('prepare-cancelled-photo'), {
      bytes: secondBytes,
      filename: 'second.png',
    });
    await service.discardOwnPhoto(actor('cancel-second-photo'), second.stagedPhotoId);

    const afterCancel = service.getOwnProfileLocal(guildId, 'member').snapshot!;
    assert.equal(publisher.calls.length, 1);
    assert.equal(afterCancel.pendingPhoto?.stagedPhotoId, first.stagedPhotoId);
    assert.ok(store.getStagedPhoto(guildId, 'member', first.stagedPhotoId));
    assert.equal(store.getStagedPhoto(guildId, 'member', second.stagedPhotoId), undefined);
  } finally {
    store.close();
  }
});

test('photo removal joins field changes and publishes once on Save changes', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const source = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#abcdef' },
    }).png().toBuffer();
    const preview = await service.prepareOwnPhoto(actor('prepare-photo-for-removal'), {
      bytes: source,
      filename: 'portrait.png',
    });
    await service.confirmOwnPhoto(actor('publish-photo-for-removal'), preview.stagedPhotoId);

    const draft = service.stageOwnProfileDraft(
      actor('stage-field-before-removal'),
      { researchInterests: ['Unified editing'] },
      currentRevision(service),
    );
    const removed = service.stageOwnPhotoRemoval(
      actor('stage-photo-removal'),
      draft.editRevision,
    );
    assert.equal(publisher.calls.length, 2);
    assert.equal(removed.draft?.profile.photo, '');

    await service.saveOwnProfileEdits(actor('save-photo-removal'), removed.editRevision);
    const call = publisher.calls[2];

    assert.equal(call?.action, 'PROFILE_UPDATE');
    assert.deepEqual(call?.photo, { kind: 'delete', expectedSha: 'photo-2' });
    assert.deepEqual(JSON.parse(call!.profile.json).researchInterests, ['Unified editing']);
  } finally {
    store.close();
  }
});

test('discarding an edit session removes both profile fields and the selected photo', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    service.stageOwnProfileDraft(
      actor('stage-discard-fields'),
      { website: 'discard.example' },
      currentRevision(service),
    );
    const source = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#777777' },
    }).png().toBuffer();
    const preview = await service.prepareOwnPhoto(actor('prepare-discard-photo'), {
      bytes: source,
      filename: 'discard.png',
    });
    const accepted = service.acceptOwnPhoto(actor('accept-discard-photo'), preview.stagedPhotoId);

    const discarded = service.discardOwnProfileEdits(
      actor('discard-edit-session'),
      accepted.editRevision,
    );

    assert.equal(publisher.calls.length, 1);
    assert.equal(discarded.draft, undefined);
    assert.equal(discarded.pendingPhoto, undefined);
    assert.equal(store.getProfileDraft(guildId, 'member'), undefined);
    assert.equal(store.getStagedPhoto(guildId, 'member', preview.stagedPhotoId), undefined);
  } finally {
    store.close();
  }
});

test('a failed queued combined save keeps all pending changes for one retry', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    service.stageOwnProfileDraft(
      actor('stage-queued-combined-fields'),
      { contact: ['member@kaist'], listed: true },
      currentRevision(service),
    );
    const source = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#246824' },
    }).png().toBuffer();
    const preview = await service.prepareOwnPhoto(actor('prepare-queued-combined-photo'), {
      bytes: source,
      filename: 'portrait.png',
    });
    const accepted = service.acceptOwnPhoto(
      actor('accept-queued-combined-photo'),
      preview.stagedPhotoId,
    );

    publisher.queueNext = true;
    const queued = await service.saveOwnProfileEdits(
      actor('queue-combined-save'),
      accepted.editRevision,
    );
    const job = enqueueRecordedPublisherCall(store, publisher, 1);
    const lease = store.claimPublicationJobs({
      workerId: 'worker-combined',
      leaseToken: 'lease-combined',
      leaseExpiresAt: new Date('2026-08-21T00:05:00.000Z'),
    })[0]!;
    store.applyPublicationBatchFailure({
      workerId: 'worker-combined',
      leaseToken: 'lease-combined',
      jobs: [{ operationId: lease.operationId, leaseGeneration: lease.leaseGeneration }],
      errorJson: JSON.stringify({ code: 'validation_failed' }),
    });

    assert.equal(queued.queued, true);
    assert.equal(job.operationId, lease.operationId);
    const retryable = service.getOwnProfileLocal(guildId, 'member').snapshot!;
    assert.equal(retryable.draft?.profile.listed, true);
    assert.deepEqual(retryable.draft?.profile.contact, ['member@kaist']);
    assert.equal(retryable.pendingPhoto?.stagedPhotoId, preview.stagedPhotoId);
    assert.equal(retryable.pendingPhoto?.isPublishing, false);

    publisher.queueNext = true;
    const retryQueued = await service.saveOwnProfileEdits(
      actor('retry-combined-save'),
      retryable.editRevision,
    );
    const retryJob = enqueueRecordedPublisherCall(store, publisher, 2);
    const retryLease = store.claimPublicationJobs({
      workerId: 'worker-combined-retry',
      leaseToken: 'lease-combined-retry',
      leaseExpiresAt: new Date('2026-08-21T00:05:00.000Z'),
    })[0]!;
    const resultJson = JSON.stringify({
      status: 'deployed',
      commitSha: 'combined-commit',
      profileBlobSha: 'combined-profile-sha',
      photoBlobSha: 'combined-photo-sha',
      attempts: 1,
    });
    store.recordPublicationBatchSuccess({
      workerId: 'worker-combined-retry',
      leaseToken: 'lease-combined-retry',
      results: [{
        operationId: retryLease.operationId,
        leaseGeneration: retryLease.leaseGeneration,
        resultJson,
      }],
    });
    store.applyRecordedPublicationBatchSuccess({
      results: [{
        operationId: retryJob.operationId,
        resultJson,
        state: {
          profileSlug: retryJob.profileSlug,
          profileJson: retryJob.profileJson,
          profileBlobSha: 'combined-profile-sha',
          photoBlobSha: 'combined-photo-sha',
          lastCommitSha: 'combined-commit',
          lastDeploymentStatus: 'deployed',
        },
      }],
    });
    const completed = service.getOwnProfileLocal(guildId, 'member').snapshot!;
    assert.equal(retryQueued.queued, true);
    assert.equal(publisher.calls.length, 3);
    assert.equal(completed.draft, undefined);
    assert.equal(completed.pendingPhoto, undefined);
    assert.equal(completed.profile.listed, true);
  } finally {
    store.close();
  }
});

test('queued draft publication survives failure and clears after an applied success', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const draft = service.stageOwnProfileDraft(
      actor('stage-queued-draft'),
      { website: 'queued-draft.example' },
      currentRevision(service),
    );
    publisher.queueNext = true;
    const firstQueued = await service.saveOwnProfileDraft(
      actor('save-queued-draft-1'),
      draft.draft!.revision,
    );
    const firstJob = enqueueRecordedPublisherCall(store, publisher, 1);

    assert.equal(firstQueued.queued, true);
    assert.equal(
      service.getOwnProfileLocal(guildId, 'member').snapshot?.draft?.isPublishing,
      true,
    );

    const firstLease = store.claimPublicationJobs({
      workerId: 'worker-1',
      leaseToken: 'lease-1',
      leaseExpiresAt: new Date('2026-08-21T00:05:00.000Z'),
    })[0]!;
    store.applyPublicationBatchFailure({
      workerId: 'worker-1',
      leaseToken: 'lease-1',
      jobs: [{
        operationId: firstLease.operationId,
        leaseGeneration: firstLease.leaseGeneration,
      }],
      errorJson: JSON.stringify({ code: 'validation_failed' }),
    });
    assert.equal(firstJob.operationId, firstLease.operationId);
    assert.equal(store.getProfileDraft(guildId, 'member')?.draftRevision, draft.draft!.revision);

    publisher.queueNext = true;
    const secondQueued = await service.saveOwnProfileDraft(
      actor('save-queued-draft-2'),
      draft.draft!.revision,
    );
    const secondJob = enqueueRecordedPublisherCall(store, publisher, 2);
    const secondLease = store.claimPublicationJobs({
      workerId: 'worker-2',
      leaseToken: 'lease-2',
      leaseExpiresAt: new Date('2026-08-21T00:05:00.000Z'),
    })[0]!;
    const resultJson = JSON.stringify({
      status: 'deployed',
      commitSha: 'draft-commit',
      profileBlobSha: 'draft-profile-sha',
      attempts: 1,
    });
    store.recordPublicationBatchSuccess({
      workerId: 'worker-2',
      leaseToken: 'lease-2',
      results: [{
        operationId: secondLease.operationId,
        leaseGeneration: secondLease.leaseGeneration,
        resultJson,
      }],
    });
    store.applyRecordedPublicationBatchSuccess({
      results: [{
        operationId: secondJob.operationId,
        resultJson,
        state: {
          profileSlug: secondJob.profileSlug,
          profileJson: secondJob.profileJson,
          profileBlobSha: 'draft-profile-sha',
          lastCommitSha: 'draft-commit',
          lastDeploymentStatus: 'deployed',
        },
      }],
    });

    assert.equal(secondQueued.queued, true);
    const applied = service.getOwnProfileLocal(guildId, 'member').snapshot;
    assert.equal(applied?.profile.website, 'queued-draft.example');
    assert.equal(applied?.draft, undefined);
    assert.equal(store.getProfileDraft(guildId, 'member'), undefined);
  } finally {
    store.close();
  }
});

test('listing and photo mutations are blocked while a profile draft exists', async () => {
  const { store, service } = createFixture();

  try {
    await registerMember(service);
    service.stageOwnProfileDraft(
      actor('stage-blocking-draft'),
      { website: 'draft.example' },
      currentRevision(service),
    );

    await assert.rejects(
      service.setOwnListed(actor('listed-with-draft'), true, currentRevision(service)),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'profile_draft_exists',
    );
    await assert.rejects(
      service.removeOwnPhoto(actor('photo-with-draft'), currentRevision(service)),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'profile_draft_exists',
    );
  } finally {
    store.close();
  }
});

test('a queued edit leaves published state unchanged until the worker applies it', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    publisher.queueNext = true;
    const result = await service.updateOwnProfile(
      actor('queued-edit'),
      { website: 'queued.example' },
      currentRevision(service),
    );

    assert.equal(result.queued, true);
    assert.equal(
      service.getOwnProfileLocal(guildId, 'member').snapshot?.profile.website,
      '',
    );
    assert.equal(store.getInteractionReceipt('queued-edit')?.status, 'processing');
    assert.equal(publisher.contexts[1]?.receiptKind, 'PROFILE_UPDATE');
    assert.equal(publisher.contexts[1]?.targetUserId, 'member');
  } finally {
    store.close();
  }
});

test('durable queued work owns reconciliation until its atomic apply', async () => {
  let repositoryReads = 0;
  let remoteVisible = false;
  const { store, service } = createFixture({
    repositoryReader: {
      readProfile: async () => {
        repositoryReads += 1;
        return remoteVisible ? {
          profile: profileSnapshot({ website: 'remote-too-early.example' }),
          profileBlobSha: 'remote-too-early',
          commitSha: 'remote-commit',
          operationId: 'queued-operation',
        } : null;
      },
    },
  });

  try {
    await registerMember(service);
    repositoryReads = 0;
    remoteVisible = true;
    store.beginInteraction('queued-interaction', 'queued-operation', 'PROFILE_UPDATE');
    store.enqueuePublicationJob({
      operationId: 'queued-operation',
      context: {
        guildId,
        actorUserId: 'member',
        targetUserId: 'member',
        interactionId: 'queued-interaction',
        receiptKind: 'PROFILE_UPDATE',
      },
      profileSlug: 'example-member',
      action: 'PROFILE_UPDATE',
      profileJson: JSON.stringify(profileSnapshot({ website: 'queued.example' })),
      profileExpectedSha: 'profile-1',
    });

    const opened = await service.getOwnProfile(guildId, 'member');
    const summary = await service.reconcileKnownProfiles();

    assert.equal(repositoryReads, 0);
    assert.equal(opened?.profile.website, '');
    assert.deepEqual(summary, { reconciled: 0, unchanged: 0, released: 0, issues: [] });
    assert.equal(store.getProfileState(guildId, 'example-member')?.profileBlobSha, 'profile-1');
  } finally {
    store.close();
  }
});

test('a durable publication job blocks every conflicting profile mutation without changing local state', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    store.stagePhoto({
      id: 'staged-before-queue',
      guildId,
      discordUserId: 'member',
      profileSlug: 'example-member',
      bytes: Uint8Array.of(1, 2, 3),
      width: 1,
      height: 1,
      expiresAt: new Date('2026-08-21T00:10:00.000Z'),
    });

    const bindingBefore = store.getBinding(guildId, 'member');
    const stateBefore = store.getProfileState(guildId, 'example-member');
    assert.ok(bindingBefore);
    assert.ok(stateBefore);

    store.beginInteraction('durable-interaction', 'durable-operation', 'PROFILE_UPDATE');
    store.enqueuePublicationJob({
      operationId: 'durable-operation',
      context: {
        guildId,
        actorUserId: 'member',
        targetUserId: 'member',
        interactionId: 'durable-interaction',
        receiptKind: 'PROFILE_UPDATE',
      },
      profileSlug: 'example-member',
      action: 'PROFILE_UPDATE',
      profileJson: JSON.stringify(profileSnapshot({ website: 'queued.example' })),
      profileExpectedSha: stateBefore.profileBlobSha,
    });

    const blockedMutations: Array<() => Promise<unknown>> = [
      () => service.updateOwnProfile(
        actor('blocked-edit'),
        { website: 'must-not-apply.example' },
        currentRevision(service),
      ),
      () => service.setOwnListed(actor('blocked-list'), true, currentRevision(service)),
      () => service.prepareOwnPhoto(actor('blocked-photo-prepare'), {
        bytes: Uint8Array.of(0),
        filename: 'invalid.png',
      }),
      () => service.confirmOwnPhoto(actor('blocked-photo-confirm'), 'staged-before-queue'),
      () => service.discardOwnPhoto(actor('blocked-photo-discard'), 'staged-before-queue'),
      () => service.removeOwnPhoto(actor('blocked-photo-remove'), currentRevision(service)),
    ];

    for (const mutate of blockedMutations) {
      await assert.rejects(
        mutate,
        (error: unknown) =>
          error instanceof ProfileServiceError
          && error.code === 'publication_pending',
      );
    }

    assert.deepEqual(store.getBinding(guildId, 'member'), bindingBefore);
    assert.deepEqual(store.getProfileState(guildId, 'example-member'), stateBefore);
    assert.equal(store.getPublicationJob('durable-operation')?.status, 'queued');
    assert.equal(
      store.getStagedPhoto(guildId, 'member', 'staged-before-queue')?.status,
      'prepared',
    );
    assert.equal(publisher.calls.length, 1, 'blocked mutations must not reach the publisher');
  } finally {
    store.close();
  }
});

test('a stale profile form cannot overwrite a newer completed edit', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const observedRevision = currentRevision(service);
    const first = await service.updateOwnProfile(
      actor('fresh-edit'),
      { name: 'Fresh Name' },
      observedRevision,
    );

    await assert.rejects(
      service.updateOwnProfile(
        actor('stale-edit'),
        { website: 'stale.example' },
        observedRevision,
      ),
      (error: unknown) =>
        error instanceof ProfileServiceError
        && error.code === 'profile_changed',
    );

    assert.equal(publisher.calls.length, 2);
    assert.equal(first.snapshot?.profile.name, 'Fresh Name');
    assert.equal(service.getOwnProfileLocal(guildId, 'member').snapshot?.profile.website, '');
  } finally {
    store.close();
  }
});

test('a second mutation fails fast instead of outliving its Discord response token', async () => {
  const { store, publisher, service } = createFixture();
  const releasePublish = Promise.withResolvers<void>();

  try {
    await registerMember(service);
    const initialRevision = currentRevision(service);
    publisher.pauseNext = releasePublish.promise;
    const firstEdit = service.updateOwnProfile(actor('edit-running'), {
      website: 'first.example',
    }, initialRevision);

    while (publisher.calls.length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    await assert.rejects(
      service.updateOwnProfile(
        actor('edit-busy'),
        { website: 'second.example' },
        initialRevision,
      ),
      (error: unknown) =>
        error instanceof ProfileServiceError
        && error.code === 'profile_busy',
    );
    assert.equal(publisher.calls.length, 2);

    releasePublish.resolve();
    const result = await firstEdit;
    assert.equal(result.snapshot?.profile.website, 'first.example');
  } finally {
    releasePublish.resolve();
    store.close();
  }
});

test('a no-change publication preserves the last deployed commit for the profile panel', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    publisher.nextStatus = 'no_change';
    const result = await service.updateOwnProfile(
      actor('no-change'),
      {},
      currentRevision(service),
    );

    assert.equal(result.snapshot?.lastCommitSha, 'commit-1');
    assert.equal(result.snapshot?.lastDeploymentStatus, 'deployed');
  } finally {
    store.close();
  }
});

test('a publication timeout marks active state for remote verification on the next profile open', async () => {
  let repositoryReads = 0;
  let remotePublished = false;
  const remoteProfile = {
    listed: false,
    order: 4 as const,
    name: 'Example Member',
    position: 'Undergraduate Student, KAIST',
    details: [],
    researchInterests: [],
    contact: [],
    website: 'applied-before-timeout.example',
    photo: '',
  };
  const { store, publisher, service } = createFixture({
    repositoryReader: {
      readProfile: async () => {
        repositoryReads += 1;
        return remotePublished ? {
          profile: remoteProfile,
          profileBlobSha: 'remote-profile-2',
          commitSha: 'remote-commit-2',
          operationId: 'operation-2',
        } : null;
      },
    },
  });

  try {
    await registerMember(service);
    remotePublished = true;
    publisher.failNext = Object.assign(new Error('publication deadline exceeded'), {
      code: 'publication_timeout',
    });
    await assert.rejects(
      service.updateOwnProfile(
        actor('ambiguous-timeout-edit'),
        { website: remoteProfile.website },
        currentRevision(service),
      ),
      /publication deadline exceeded/,
    );
    assert.equal(service.getOwnProfileLocal(guildId, 'member').snapshot?.profile.website, '');

    const recovered = await service.getOwnProfile(guildId, 'member');

    assert.equal(repositoryReads, 2);
    assert.equal(recovered?.profile.website, remoteProfile.website);
    assert.equal(recovered?.lastCommitSha, 'remote-commit-2');
  } finally {
    store.close();
  }
});

test('photo upload is center-processed, staged for preview, then published on confirmation', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const source = await sharp({
      create: { width: 1200, height: 1000, channels: 3, background: '#4488cc' },
    })
      .jpeg()
      .toBuffer();
    const preview = await service.prepareOwnPhoto(actor('photo-prepare'), {
      bytes: source,
      filename: 'portrait.jpg',
      contentType: 'image/jpeg',
    });

    assert.equal(preview.width, 800);
    assert.equal(preview.height, 1000);
    assert.ok(preview.previewBytes.byteLength > 0);
    assert.equal(publisher.calls.length, 1, 'preparing a preview must not publish');

    const confirmed = await service.confirmOwnPhoto(actor('photo-confirm'), preview.stagedPhotoId);
    const call = publisher.calls[1];
    assert.equal(call?.action, 'PROFILE_REPLACE_PHOTO');
    assert.equal(call?.photo?.kind, 'upsert');
    assert.equal(call?.profile.expectedSha, 'profile-1');
    assert.equal(confirmed.snapshot?.profile.photo, 'example-member.webp');
    assert.equal(store.getStagedPhoto(guildId, 'member', preview.stagedPhotoId), undefined);
  } finally {
    store.close();
  }
});

test('a prepared photo cannot replace a profile that changed after its preview', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const source = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#eeeeee' },
    })
      .png()
      .toBuffer();
    const preview = await service.prepareOwnPhoto(actor('stale-photo-prepare'), {
      bytes: source,
      filename: 'portrait.png',
    });
    await service.updateOwnProfile(
      actor('edit-after-photo-preview'),
      { website: 'new.example' },
      currentRevision(service),
    );

    await assert.rejects(
      service.confirmOwnPhoto(actor('stale-photo-confirm'), preview.stagedPhotoId),
      (error: unknown) =>
        error instanceof ProfileServiceError
        && error.code === 'profile_changed',
    );

    assert.equal(publisher.calls.length, 2);
    assert.equal(store.getStagedPhoto(guildId, 'member', preview.stagedPhotoId), undefined);
  } finally {
    store.close();
  }
});

test('photo confirmation cannot cross Discord accounts and removal deletes the exact blob', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    await registerMember(service, 'other-member');
    const source = await sharp({
      create: { width: 400, height: 500, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const preview = await service.prepareOwnPhoto(actor('photo-prepare'), {
      bytes: source,
      filename: 'portrait.png',
    });

    await assert.rejects(
      () => service.confirmOwnPhoto(actor('wrong-confirm', 'other-member'), preview.stagedPhotoId),
      /missing, expired, or already being published/,
    );

    await service.confirmOwnPhoto(actor('right-confirm'), preview.stagedPhotoId);
    await service.removeOwnPhoto(actor('photo-remove'), currentRevision(service));
    const removeCall = publisher.calls.at(-1);
    assert.equal(removeCall?.action, 'PROFILE_REMOVE_PHOTO');
    assert.deepEqual(removeCall?.photo, { kind: 'delete', expectedSha: 'photo-3' });
  } finally {
    store.close();
  }
});

test('an interrupted registration is claimed only when its remote operation proof matches', async () => {
  const profile = {
    listed: false,
    order: 4 as const,
    name: 'Recovered Member',
    position: 'Undergraduate Student',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo: '',
  };
  const repositoryReader: ProfileRepositoryReader = {
    readProfile: async () => ({
      profile,
      profileBlobSha: 'remote-profile',
      commitSha: 'remote-commit',
      operationId: 'registration-op',
    }),
  };
  const { store, service } = createFixture({ repositoryReader });

  try {
    store.beginInteraction(
      'interrupted-registration-interaction',
      'registration-op',
      'PROFILE_CREATE',
    );
    store.reserveBinding(guildId, 'recovered-user', 'recovered-member', 'registration-op');
    const recovered = await service.getOwnProfile(guildId, 'recovered-user');

    assert.equal(recovered?.bindingStatus, 'active');
    assert.equal(recovered?.lastDeploymentStatus, 'published_status_unknown');
    assert.equal(store.getProfileState(guildId, 'recovered-member')?.profileBlobSha, 'remote-profile');
    assert.equal(
      store.getInteractionReceipt('interrupted-registration-interaction')?.status,
      'completed',
    );
  } finally {
    store.close();
  }
});

test('an aged provisioning binding with publication evidence survives a transient missing remote', async () => {
  const store = new SqliteStore(':memory:', {
    now: () => new Date('2026-08-21T00:00:00.000Z'),
  });
  store.reserveBinding(guildId, 'member', 'example-member', 'published-operation');
  const service = new ProfileService({
    store,
    publisher: new RecordingPublisher(),
    repositoryReader: { readProfile: async () => null },
    checkpointLookup: { load: async () => ({ stage: 'main_updated' }) },
    guildId,
    now: () => new Date('2026-08-21T00:31:00.000Z'),
  });

  try {
    await assert.rejects(
      () => service.getOwnProfile(guildId, 'member'),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'registration_remote_pending',
    );
    assert.equal(store.getBinding(guildId, 'member')?.provisioningOperationId, 'published-operation');
  } finally {
    store.close();
  }
});

test('startup reconciliation bounds concurrent repository reads', async () => {
  let activeReads = 0;
  let maximumActiveReads = 0;
  const repositoryReader: ProfileRepositoryReader = {
    readProfile: async (slug) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeReads -= 1;
      return {
        profile: {
          listed: false,
          order: 4,
          name: slug,
          position: 'Undergraduate Student',
          details: [],
          researchInterests: [],
          contact: [],
          website: '',
          photo: '',
        },
        profileBlobSha: `profile-${slug}`,
        commitSha: `commit-${slug}`,
        operationId: `operation-${slug}`,
      };
    },
  };
  const { store, service } = createFixture({ repositoryReader });

  try {
    for (let index = 1; index <= 6; index += 1) {
      store.reserveBinding(
        guildId,
        `user-${index}`,
        `member-${index}`,
        `operation-member-${index}`,
      );
    }

    const summary = await service.reconcileKnownProfiles();

    assert.equal(maximumActiveReads, 4);
    assert.equal(summary.reconciled, 6);
    assert.equal(summary.issues.length, 0);
    assert.equal(store.getBinding(guildId, 'user-1')?.status, 'active');
    assert.equal(store.getBinding(guildId, 'user-6')?.status, 'active');
  } finally {
    store.close();
  }
});

test('startup reconciliation repairs an active profile left stale after publication', async () => {
  let repositoryReads = 0;
  let remotePublished = false;
  const remoteProfile = {
    listed: true,
    order: 4 as const,
    name: 'Recovered Remote Member',
    position: 'Undergraduate Student',
    details: ['Published before the process stopped'],
    researchInterests: [],
    contact: [],
    website: '',
    photo: '',
  };
  const { store, service } = createFixture({
    repositoryReader: {
      readProfile: async () => {
        repositoryReads += 1;
        return remotePublished ? {
          profile: remoteProfile,
          profileBlobSha: 'remote-profile',
          commitSha: 'remote-commit',
          operationId: 'remote-operation',
        } : null;
      },
    },
  });

  try {
    await registerMember(service);
    remotePublished = true;

    const summary = await service.reconcileKnownProfiles();

    assert.equal(repositoryReads, 2);
    assert.equal(summary.reconciled, 1);
    assert.equal(summary.issues.length, 0);
    const recovered = service.getOwnProfileLocal(guildId, 'member').snapshot;
    assert.equal(recovered?.profile.name, 'Recovered Remote Member');
    assert.equal(recovered?.profile.listed, true);
    assert.equal(recovered?.lastCommitSha, 'remote-commit');
  } finally {
    store.close();
  }
});

test('concurrent startup and command recovery share one repository read', async () => {
  let repositoryReads = 0;
  const profile = {
    listed: false,
    order: 4 as const,
    name: 'Recovered Member',
    position: 'Undergraduate Student',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo: '',
  };
  const { store, service } = createFixture({
    repositoryReader: {
      readProfile: async () => {
        repositoryReads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          profile,
          profileBlobSha: 'remote-profile',
          commitSha: 'remote-commit',
          operationId: 'registration-op',
        };
      },
    },
  });

  try {
    store.reserveBinding(guildId, 'recovered-user', 'recovered-member', 'registration-op');

    const [summary, snapshot] = await Promise.all([
      service.reconcileKnownProfiles(),
      service.getOwnProfile(guildId, 'recovered-user'),
    ]);

    assert.equal(repositoryReads, 1);
    assert.equal(summary.reconciled, 1);
    assert.equal(snapshot?.bindingStatus, 'active');
    assert.equal(snapshot?.profile.name, 'Recovered Member');
  } finally {
    store.close();
  }
});

test('startup recovery rejects a mutation quickly and the retry uses recovered state', async () => {
  const readStarted = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  let recoveryEnabled = false;
  const remoteProfile = {
    listed: false,
    order: 4 as const,
    name: 'Remote Member',
    position: 'Undergraduate Student',
    details: ['Recovered detail'],
    researchInterests: [],
    contact: [],
    website: '',
    photo: '',
  };
  const { store, publisher, service } = createFixture({
    repositoryReader: {
      readProfile: async () => {
        if (!recoveryEnabled) {
          return null;
        }
        readStarted.resolve();
        await releaseRead.promise;
        return {
          profile: remoteProfile,
          profileBlobSha: 'remote-profile',
          commitSha: 'remote-commit',
          operationId: 'remote-operation',
        };
      },
    },
  });

  try {
    await registerMember(service);
    recoveryEnabled = true;
    const recovery = service.reconcileKnownProfiles();
    await readStarted.promise;
    await assert.rejects(
      service.updateOwnProfile(actor('edit-during-recovery'), {
        website: 'too-early.example',
      }, currentRevision(service)),
      (error: unknown) =>
        error instanceof ProfileServiceError
        && error.code === 'profile_busy',
    );
    assert.equal(publisher.calls.length, 1);

    releaseRead.resolve();
    await recovery;
    const edited = await service.updateOwnProfile(actor('edit-after-recovery'), {
      website: 'example.org',
    }, currentRevision(service));

    assert.equal(publisher.calls[1]?.profile.expectedSha, 'remote-profile');
    const publishedProfile = JSON.parse(publisher.calls[1]!.profile.json) as {
      name: string;
      details: string[];
      website: string;
    };
    assert.equal(publishedProfile.name, 'Remote Member');
    assert.deepEqual(publishedProfile.details, ['Recovered detail']);
    assert.equal(publishedProfile.website, 'example.org');
    assert.equal(edited.snapshot?.profile.name, 'Remote Member');
  } finally {
    releaseRead.resolve();
    store.close();
  }
});

test('failed reconciliation leaves the profile single-flight retryable', async () => {
  let repositoryReads = 0;
  const profile = {
    listed: false,
    order: 4 as const,
    name: 'Recovered Member',
    position: 'Undergraduate Student',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo: '',
  };
  const { store, service } = createFixture({
    repositoryReader: {
      readProfile: async () => {
        repositoryReads += 1;
        if (repositoryReads === 1) {
          throw new Error('temporary GitHub failure');
        }

        return {
          profile,
          profileBlobSha: 'remote-profile',
          commitSha: 'remote-commit',
          operationId: 'registration-op',
        };
      },
    },
  });

  try {
    store.reserveBinding(guildId, 'recovered-user', 'recovered-member', 'registration-op');
    await assert.rejects(
      service.getOwnProfile(guildId, 'recovered-user'),
      /temporary GitHub failure/,
    );

    const recovered = await service.getOwnProfile(guildId, 'recovered-user');

    assert.equal(repositoryReads, 2);
    assert.equal(recovered?.bindingStatus, 'active');
  } finally {
    store.close();
  }
});

test('an interrupted registration refuses a mismatched remote profile claim', async () => {
  const repositoryReader: ProfileRepositoryReader = {
    readProfile: async () => ({
      profile: {
        listed: false,
        order: 4,
        name: 'Unexpected Member',
        position: 'Undergraduate Student',
        details: [],
        researchInterests: [],
        contact: [],
        website: '',
        photo: '',
      },
      profileBlobSha: 'remote-profile',
      commitSha: 'remote-commit',
      operationId: 'someone-elses-operation',
    }),
  };
  const { store, service } = createFixture({ repositoryReader });

  try {
    store.reserveBinding(guildId, 'recovered-user', 'recovered-member', 'registration-op');
    await assert.rejects(
      () => service.getOwnProfile(guildId, 'recovered-user'),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'registration_proof_mismatch',
    );
    assert.equal(store.getBinding(guildId, 'recovered-user')?.status, 'provisioning');
  } finally {
    store.close();
  }
});
