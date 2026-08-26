import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  ProfileService,
  ProfileServiceError,
  type ProfilePublishInput,
  type ProfilePublishResult,
  type ProfilePublisher,
  type ProfileRepositoryReader,
  type RepositoryProfileSnapshot,
} from '../src/service/profile-service.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const guildId = 'guild';
const ownerUserId = 'owner';

class RecordingPublisher implements ProfilePublisher {
  readonly calls: ProfilePublishInput[] = [];
  failNext: Error | undefined;
  nextStatus: ProfilePublishResult['status'] | undefined;
  pauseNext: Promise<void> | undefined;

  async publish(input: ProfilePublishInput): Promise<ProfilePublishResult> {
    this.calls.push(input);

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
    ownerUserId,
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
    ownerUserId,
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

test('owner recovery is runtime-guarded and revoked users cannot edit', async () => {
  const { store, service } = createFixture();

  try {
    await registerMember(service);
    await assert.rejects(
      () => service.ownerRevoke(actor('bad-owner'), 'member'),
      (error: unknown) => error instanceof ProfileServiceError && error.code === 'owner_only',
    );

    const revoked = await service.ownerRevoke(actor('revoke', ownerUserId), 'member');
    assert.equal(revoked.snapshot?.bindingStatus, 'revoked');
    await assert.rejects(
      () => service.updateOwnProfile(
        actor('revoked-edit'),
        { name: 'Blocked' },
        currentRevision(service),
      ),
      (error: unknown) => error instanceof ProfileServiceError && error.code === 'profile_revoked',
    );

    await service.ownerRestore(actor('restore', ownerUserId), 'member');
    const transferred = await service.ownerTransfer(
      actor('transfer', ownerUserId),
      'member',
      'new-member',
    );
    assert.equal(transferred.snapshot?.bindingStatus, 'active');
    assert.equal(store.getBinding(guildId, 'new-member')?.profileSlug, 'example-member');
  } finally {
    store.close();
  }
});

test('owner hide prevents relisting until an explicit owner unhide', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    await service.setOwnListed(actor('list-before-hide'), true, currentRevision(service));

    const hidden = await service.ownerHide(actor('owner-hide', ownerUserId), 'member');
    assert.equal(hidden.snapshot?.profile.listed, false);
    assert.equal(hidden.snapshot?.listingPolicy, 'force_hidden');
    assert.equal(store.getBinding(guildId, 'member')?.listingPolicy, 'force_hidden');

    const callsBeforeBlockedRelist = publisher.calls.length;
    await assert.rejects(
      () => service.setOwnListed(actor('blocked-relist'), true, currentRevision(service)),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'visibility_locked',
    );
    assert.equal(publisher.calls.length, callsBeforeBlockedRelist);

    const unhidden = await service.ownerUnhide(actor('owner-unhide', ownerUserId), 'member');
    assert.equal(unhidden.snapshot?.listingPolicy, 'user_controlled');
    assert.equal(unhidden.snapshot?.profile.listed, false);

    const relisted = await service.setOwnListed(
      actor('relist-after-unhide'),
      true,
      currentRevision(service),
    );
    assert.equal(relisted.snapshot?.profile.listed, true);
  } finally {
    store.close();
  }
});

test('owner revoke remains pending and active until the hidden profile publish succeeds', async () => {
  const { store, publisher, service } = createFixture();
  const releasePublish = Promise.withResolvers<void>();

  try {
    await registerMember(service);
    await service.setOwnListed(actor('list-before-revoke'), true, currentRevision(service));
    publisher.pauseNext = releasePublish.promise;

    const revoke = service.ownerRevoke(actor('owner-revoke', ownerUserId), 'member');
    while (publisher.calls.length < 3) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const pending = store.getBinding(guildId, 'member');
    assert.equal(pending?.status, 'active');
    assert.equal(pending?.listingPolicy, 'user_controlled');
    assert.equal(pending?.pendingAdminAction, 'revoke');
    assert.equal(
      JSON.parse(store.getProfileState(guildId, 'example-member')!.profileJson).listed,
      true,
    );

    releasePublish.resolve();
    const revoked = await revoke;
    assert.equal(revoked.snapshot?.profile.listed, false);
    assert.equal(revoked.snapshot?.bindingStatus, 'revoked');
    assert.equal(revoked.snapshot?.listingPolicy, 'force_hidden');
    assert.equal(store.getBinding(guildId, 'member')?.pendingAdminAction, undefined);
    assert.equal(JSON.parse(publisher.calls[2]!.profile.json).listed, false);
  } finally {
    releasePublish.resolve();
    store.close();
  }
});

test('a definitely unpublished revoke failure leaves the binding active and visible', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    await service.setOwnListed(actor('list-before-failed-revoke'), true, currentRevision(service));
    publisher.failNext = Object.assign(new Error('validation failed'), {
      code: 'validation_failed',
    });

    await assert.rejects(
      () => service.ownerRevoke(actor('failed-revoke', ownerUserId), 'member'),
      /validation failed/,
    );

    const binding = store.getBinding(guildId, 'member');
    assert.equal(binding?.status, 'active');
    assert.equal(binding?.listingPolicy, 'user_controlled');
    assert.equal(binding?.pendingAdminAction, undefined);
    assert.equal(
      JSON.parse(store.getProfileState(guildId, 'example-member')!.profileJson).listed,
      true,
    );
  } finally {
    store.close();
  }
});

test('owner restore recovers editing but preserves the force-hidden listing policy', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    await service.setOwnListed(actor('list-before-restore-test'), true, currentRevision(service));
    await service.ownerRevoke(actor('revoke-before-restore', ownerUserId), 'member');

    const restored = await service.ownerRestore(actor('owner-restore', ownerUserId), 'member');
    assert.equal(restored.snapshot?.bindingStatus, 'active');
    assert.equal(restored.snapshot?.listingPolicy, 'force_hidden');
    assert.equal(restored.snapshot?.profile.listed, false);

    const callsBeforeBlockedRelist = publisher.calls.length;
    await assert.rejects(
      () => service.setOwnListed(actor('blocked-restored-relist'), true, currentRevision(service)),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'visibility_locked',
    );
    assert.equal(publisher.calls.length, callsBeforeBlockedRelist);
    assert.equal(store.getBinding(guildId, 'member')?.status, 'active');
  } finally {
    store.close();
  }
});

for (const pendingAction of ['hide', 'revoke'] as const) {
  test(`startup recovery completes a pending owner ${pendingAction} from remote proof`, async () => {
    const { store, publisher, service } = createFixture();

    try {
      await registerMember(service);
      await service.setOwnListed(
        actor(`list-before-pending-${pendingAction}`),
        true,
        currentRevision(service),
      );
      const operationId = `pending-${pendingAction}-operation`;
      const interactionId = `pending-${pendingAction}-interaction`;
      store.beginInteraction(
        interactionId,
        operationId,
        pendingAction === 'revoke' ? 'PROFILE_OWNER_REVOKE' : 'PROFILE_OWNER_HIDE',
      );
      store.beginAdminAction(guildId, 'member', pendingAction, operationId);
      const hiddenProfile = profileSnapshot({ listed: false });
      const restarted = new ProfileService({
        store,
        publisher,
        repositoryReader: {
          readProfile: async () => ({
            profile: hiddenProfile,
            profileBlobSha: `recovered-${pendingAction}-profile`,
            commitSha: `recovered-${pendingAction}-commit`,
            operationId,
          }),
        },
        guildId,
        ownerUserId,
        now: () => new Date('2026-08-21T00:01:00.000Z'),
      });

      const summary = await restarted.reconcileKnownProfiles();
      assert.deepEqual(summary.issues, []);

      const recovered = store.getBinding(guildId, 'member');
      assert.equal(recovered?.pendingAdminAction, undefined);
      assert.equal(recovered?.pendingAdminOperationId, undefined);
      assert.equal(recovered?.listingPolicy, 'force_hidden');
      assert.equal(recovered?.status, pendingAction === 'revoke' ? 'revoked' : 'active');
      assert.equal(
        JSON.parse(store.getProfileState(guildId, 'example-member')!.profileJson).listed,
        false,
      );
      assert.equal(store.getInteractionReceipt(interactionId)?.status, 'completed');
    } finally {
      store.close();
    }
  });
}

test('owner transfer cannot change ownership during an active profile publication', async () => {
  const { store, publisher, service } = createFixture();
  const releasePublish = Promise.withResolvers<void>();

  try {
    await registerMember(service);
    const editRevision = currentRevision(service);
    publisher.pauseNext = releasePublish.promise;
    const edit = service.updateOwnProfile(actor('edit-before-transfer'), {
      website: 'in-flight.example',
    }, editRevision);

    while (publisher.calls.length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    await assert.rejects(
      service.ownerTransfer(
        actor('transfer-while-busy', ownerUserId),
        'member',
        'new-member',
      ),
      (error: unknown) =>
        error instanceof ProfileServiceError
        && error.code === 'profile_busy',
    );
    assert.equal(store.getBinding(guildId, 'member')?.profileSlug, 'example-member');
    assert.equal(store.getBinding(guildId, 'new-member'), undefined);

    releasePublish.resolve();
    await edit;
    const transferred = await service.ownerTransfer(
      actor('transfer-after-edit', ownerUserId),
      'member',
      'new-member',
    );
    assert.equal(transferred.snapshot?.profileSlug, 'example-member');
    assert.equal(store.getBinding(guildId, 'member'), undefined);
    assert.equal(store.getBinding(guildId, 'new-member')?.profileSlug, 'example-member');
  } finally {
    releasePublish.resolve();
    store.close();
  }
});

test('owner recovery does not mutate a provisioning binding without profile state', async () => {
  const { store, service } = createFixture();

  try {
    store.reserveBinding(guildId, 'pending-member', 'pending-member', 'pending-operation');

    await assert.rejects(
      () => service.ownerRevoke(actor('pending-revoke', ownerUserId), 'pending-member'),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'profile_state_missing',
    );
    assert.equal(store.getBinding(guildId, 'pending-member')?.status, 'provisioning');

    await assert.rejects(
      () => service.ownerRestore(actor('pending-restore', ownerUserId), 'pending-member'),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'profile_state_missing',
    );
    assert.equal(store.getBinding(guildId, 'pending-member')?.status, 'provisioning');

    await assert.rejects(
      () => service.ownerTransfer(
        actor('pending-transfer', ownerUserId),
        'pending-member',
        'destination-member',
      ),
      (error: unknown) =>
        error instanceof ProfileServiceError && error.code === 'profile_state_missing',
    );
    assert.equal(store.getBinding(guildId, 'pending-member')?.status, 'provisioning');
    assert.equal(store.getBinding(guildId, 'destination-member'), undefined);
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
    ownerUserId,
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
