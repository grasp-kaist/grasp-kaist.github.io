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
} from '../src/service/profile-service.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const guildId = 'guild';
const ownerUserId = 'owner';

class RecordingPublisher implements ProfilePublisher {
  readonly calls: ProfilePublishInput[] = [];
  failNext: Error | undefined;
  nextStatus: ProfilePublishResult['status'] | undefined;

  async publish(input: ProfilePublishInput): Promise<ProfilePublishResult> {
    this.calls.push(input);

    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
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

test('local profile probes never invoke repository reconciliation', async () => {
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

    const local = service.getOwnProfileLocal(guildId, 'member');
    assert.equal(local.hasBinding, true);
    assert.equal(local.snapshot?.bindingStatus, 'active');
    assert.equal(local.snapshot?.profile.name, 'Example Member');
    assert.equal(repositoryReads, 0);
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

test('profile edits carry the stored blob revision and listed is independently mutable', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    const updated = await service.updateOwnProfile(actor('edit-1'), {
      details: ['  B.S. student  ', ''],
      website: 'example.com',
    });
    const listed = await service.setOwnListed(actor('listed-1'), true);

    assert.equal(publisher.calls[1]?.profile.expectedSha, 'profile-1');
    assert.equal(publisher.calls[2]?.profile.expectedSha, 'profile-2');
    assert.deepEqual(updated.snapshot?.profile.details, ['B.S. student']);
    assert.equal(updated.snapshot?.profile.website, 'example.com');
    assert.equal(listed.snapshot?.profile.listed, true);
  } finally {
    store.close();
  }
});

test('a no-change publication preserves the last deployed commit for the profile panel', async () => {
  const { store, publisher, service } = createFixture();

  try {
    await registerMember(service);
    publisher.nextStatus = 'no_change';
    const result = await service.updateOwnProfile(actor('no-change'), {});

    assert.equal(result.snapshot?.lastCommitSha, 'commit-1');
    assert.equal(result.snapshot?.lastDeploymentStatus, 'deployed');
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
    await service.removeOwnPhoto(actor('photo-remove'));
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
      () => service.updateOwnProfile(actor('revoked-edit'), { name: 'Blocked' }),
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
    store.reserveBinding(guildId, 'recovered-user', 'recovered-member', 'registration-op');
    const recovered = await service.getOwnProfile(guildId, 'recovered-user');

    assert.equal(recovered?.bindingStatus, 'active');
    assert.equal(recovered?.lastDeploymentStatus, 'published_status_unknown');
    assert.equal(store.getProfileState(guildId, 'recovered-member')?.profileBlobSha, 'remote-profile');
  } finally {
    store.close();
  }
});

test('startup reconciliation reads independent bindings concurrently', async () => {
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
    store.reserveBinding(guildId, 'first-user', 'first-member', 'operation-first-member');
    store.reserveBinding(guildId, 'second-user', 'second-member', 'operation-second-member');

    const summary = await service.reconcileKnownProfiles();

    assert.equal(maximumActiveReads, 2);
    assert.equal(summary.reconciled, 2);
    assert.equal(summary.issues.length, 0);
    assert.equal(store.getBinding(guildId, 'first-user')?.status, 'active');
    assert.equal(store.getBinding(guildId, 'second-user')?.status, 'active');
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
