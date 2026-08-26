import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ProfilePublishWorker,
  QueuedProfilePublisher,
  type BatchProfilePublisher,
} from '../src/publication/index.js';
import type {
  ProfilePublishContext,
  ProfilePublishInput,
  ProfilePublishResult,
} from '../src/service/profile-service.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

type TerminalResult = Exclude<ProfilePublishResult, { status: 'queued' }>;

class CountingSqliteStore extends SqliteStore {
  fullJobReads = 0;
  fullJobListReads = 0;
  outcomeReads = 0;
  recoveryCandidateReads = 0;

  override getPublicationJob(operationId: string) {
    this.fullJobReads += 1;
    return super.getPublicationJob(operationId);
  }

  override listPublicationJobs(guildId: string) {
    this.fullJobListReads += 1;
    return super.listPublicationJobs(guildId);
  }

  override getPublicationJobOutcome(operationId: string) {
    this.outcomeReads += 1;
    return super.getPublicationJobOutcome(operationId);
  }

  override listPublicationRecoveryCandidates(guildId: string) {
    this.recoveryCandidateReads += 1;
    return super.listPublicationRecoveryCandidates(guildId);
  }
}

test('twenty foreground publications coalesce into one durable batch and apply atomically', async () => {
  const store = new SqliteStore(':memory:');
  const batches: ProfilePublishInput[][] = [];
  const backend: BatchProfilePublisher = {
    async publishBatch(inputs) {
      batches.push([...inputs]);
      return inputs.map((input) => successfulResult(input, 'batch-commit'));
    },
  };
  const publisher = new QueuedProfilePublisher({
    store,
    guildId: 'production-guild',
    backend,
    batchWindowMs: 20,
    foregroundWaitMs: 1_000,
    terminalPollMs: 1,
  });

  try {
    const operations = Array.from({ length: 20 }, (_unused, index) => {
      const suffix = String(index + 1).padStart(2, '0');
      const operationId = `operation-${suffix}`;
      const interactionId = `interaction-${suffix}`;
      const userId = `user-${suffix}`;
      const slug = `member-${suffix}`;
      store.reserveBinding('production-guild', userId, slug, operationId);
      assert.equal(store.beginInteraction(interactionId, operationId, 'PROFILE_CREATE'), true);
      return {
        input: {
          operationId,
          slug,
          action: 'PROFILE_CREATE' as const,
          profile: { json: JSON.stringify({ name: `Member ${suffix}` }), expectedSha: null },
        },
        context: {
          guildId: 'production-guild',
          actorUserId: userId,
          targetUserId: userId,
          interactionId,
          receiptKind: 'PROFILE_CREATE',
        },
      };
    });

    const results = await Promise.all(
      operations.map(({ input, context }) => publisher.publish(input, context)),
    );
    await publisher.drain();

    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.length, 20);
    assert.deepEqual(batches[0]?.map((input) => input.slug), operations.map(({ input }) => input.slug));
    assert.ok(results.every((result) => result.status === 'deployed' && result.stateApplied === true));
    assert.equal(store.countNonterminalPublicationJobs('production-guild'), 0);

    for (const { input, context } of operations) {
      const job = store.getPublicationJob(input.operationId);
      assert.equal(job?.status, 'completed');
      assert.ok(job?.appliedAt);
      assert.equal(store.getBinding(context.guildId, context.targetUserId)?.status, 'active');
      assert.equal(store.getProfileState(context.guildId, input.slug)?.profileBlobSha, `blob-${input.slug}`);
      assert.deepEqual(
        JSON.parse(store.getInteractionReceipt(context.interactionId)?.responseJson ?? ''),
        { commitSha: 'batch-commit', deploymentStatus: 'deployed' },
      );
    }
  } finally {
    store.close();
  }
});

test('two workers compete for a queue without publishing any job twice', async () => {
  const store = new SqliteStore(':memory:');
  let batchCalls = 0;
  const backend: BatchProfilePublisher = {
    async publishBatch(inputs) {
      batchCalls += 1;
      await Promise.resolve();
      return inputs.map((input) => successfulResult(input, 'competition-commit'));
    },
  };
  const first = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    backend,
    workerId: 'worker-one',
    batchWindowMs: 0,
  });
  const second = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    backend,
    workerId: 'worker-two',
    batchWindowMs: 0,
  });

  try {
    for (let index = 1; index <= 5; index += 1) {
      const slug = `member-${index}`;
      const userId = `user-${index}`;
      const operationId = `operation-${index}`;
      const interactionId = `interaction-${index}`;
      createActiveProfile(store, 'production-guild', userId, slug);
      store.beginInteraction(interactionId, operationId, 'PROFILE_UPDATE');
      store.enqueuePublicationJob({
        operationId,
        context: publicationContext(userId, interactionId, 'PROFILE_UPDATE'),
        profileSlug: slug,
        action: 'PROFILE_UPDATE',
        profileJson: JSON.stringify({ name: `Updated ${index}` }),
        profileExpectedSha: `before-${slug}`,
      });
    }

    await Promise.all([first.drain(), second.drain()]);

    assert.equal(batchCalls, 1);
    assert.ok(store.listPublicationJobs('production-guild').every((job) => (
      job.status === 'completed' && job.attempts === 1 && job.leaseGeneration === 1
    )));
  } finally {
    first.stop();
    second.stop();
    store.close();
  }
});

test('startup recovery waits for lease expiry before reclaiming a photo job from disk', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasp-publish-worker-'));
  const databasePath = join(directory, 'queue.sqlite');
  let now = new Date('2026-08-21T00:00:00.000Z');
  let store = new SqliteStore(databasePath, { now: () => now });

  try {
    createActiveProfile(store, 'production-guild', 'photo-user', 'photo-member');
    store.stagePhoto({
      id: 'staged-photo',
      guildId: 'production-guild',
      discordUserId: 'photo-user',
      profileSlug: 'photo-member',
      bytes: Buffer.from([0, 10, 20, 255]),
      width: 400,
      height: 500,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    store.claimStagedPhoto('production-guild', 'photo-user', 'staged-photo');
    store.beginInteraction('photo-interaction', 'photo-operation', 'PROFILE_REPLACE_PHOTO');
    store.enqueuePublicationJob({
      operationId: 'photo-operation',
      context: {
        ...publicationContext('photo-user', 'photo-interaction', 'PROFILE_REPLACE_PHOTO'),
        stagedPhotoId: 'staged-photo',
      },
      profileSlug: 'photo-member',
      action: 'PROFILE_REPLACE_PHOTO',
      profileJson: '{"name":"Photo Member","photo":"photo-member.webp"}',
      profileExpectedSha: 'before-photo-member',
      photo: {
        kind: 'upsert',
        bytes: Buffer.from([0, 10, 20, 255]),
        expectedSha: null,
      },
    });
    store.claimPublicationJobs({
      guildId: 'production-guild',
      workerId: 'crashed-worker',
      leaseToken: 'crashed-lease',
      leaseExpiresAt: new Date('2026-08-21T00:05:00.000Z'),
    });
    store.close();

    store = new SqliteStore(databasePath, { now: () => now });
    const worker = new ProfilePublishWorker({
      store,
      guildId: 'production-guild',
      batchWindowMs: 0,
      now: () => now,
      backend: {
        async publishBatch(inputs) {
          assert.equal(inputs.length, 1);
          assert.deepEqual(
            inputs[0]?.photo?.kind === 'upsert' ? Buffer.from(inputs[0].photo.bytes) : undefined,
            Buffer.from([0, 10, 20, 255]),
          );
          return [{
            ...successfulResult(inputs[0]!, 'recovered-commit'),
            photoBlobSha: 'photo-after',
          }];
        },
      },
    });

    try {
      assert.equal(worker.recoverLeases(), 0);
      assert.equal(store.getPublicationJob('photo-operation')?.status, 'leased');
      assert.equal(worker.nextRecoveryDelayMs(), 300_001);

      now = new Date('2026-08-21T00:05:00.000Z');
      await worker.recoverAndDrain();
      const job = store.getPublicationJob('photo-operation');
      assert.equal(job?.status, 'completed');
      assert.equal(job?.attempts, 2);
      assert.equal(job?.leaseGeneration, 2);
      assert.equal(store.getProfileState('production-guild', 'photo-member')?.photoBlobSha, 'photo-after');
      assert.equal(store.getStagedPhoto('production-guild', 'photo-user', 'staged-photo'), undefined);
      assert.equal(store.getInteractionReceipt('photo-interaction')?.status, 'completed');
      assert.equal(worker.nextRecoveryDelayMs(), undefined);
    } finally {
      worker.stop();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an idle worker wakes itself when another process lease expires', async () => {
  const store = new SqliteStore(':memory:');
  prepareRegistrationJob(store, 'lease-timer');
  store.claimPublicationJobs({
    guildId: 'production-guild',
    workerId: 'crashed-worker',
    leaseToken: 'crashed-token',
    leaseExpiresAt: new Date(Date.now() + 200),
  });
  let backendCalls = 0;
  const worker = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    batchWindowMs: 0,
    retryDelayMs: 5,
    backend: {
      async publishBatch(inputs) {
        backendCalls += 1;
        return inputs.map((input) => successfulResult(input, 'lease-timer-commit'));
      },
    },
  });

  try {
    await worker.drain();
    assert.equal(store.getPublicationJob('lease-timer-operation')?.status, 'leased');
    await waitUntil(() => Boolean(store.getPublicationJob('lease-timer-operation')?.appliedAt));
    assert.equal(backendCalls, 1);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('recovery delay reads only the lightweight nonterminal projection', async () => {
  const store = new CountingSqliteStore(':memory:');
  prepareRegistrationJob(store, 'recovery-projection');
  store.fullJobReads = 0;
  store.fullJobListReads = 0;
  const worker = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    batchWindowMs: 0,
    retryDelayMs: 123,
    backend: {
      async publishBatch() {
        throw new Error('The recovery-delay query must not start publication.');
      },
    },
  });

  try {
    assert.equal(worker.nextRecoveryDelayMs(), 123);
    assert.equal(store.recoveryCandidateReads, 1);
    assert.equal(store.fullJobReads, 0);
    assert.equal(store.fullJobListReads, 0);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('recorded GitHub success is applied after restart without publishing twice', async () => {
  const store = new SqliteStore(':memory:');
  prepareRegistrationJob(store, 'recorded');
  let backendCalls = 0;
  const backend: BatchProfilePublisher = {
    async publishBatch(inputs) {
      backendCalls += 1;
      return inputs.map((input) => successfulResult(input, 'recorded-commit'));
    },
  };
  const first = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    backend,
    batchWindowMs: 0,
  });
  const applyRecorded = store.applyRecordedPublicationBatchSuccess.bind(store);
  store.applyRecordedPublicationBatchSuccess = () => {
    throw new Error('simulated local apply failure');
  };

  try {
    await assert.rejects(first.drain(), /simulated local apply failure/);
    const recorded = store.getPublicationJob('recorded-operation');
    assert.equal(recorded?.status, 'completed');
    assert.equal(recorded?.appliedAt, undefined);
    assert.equal(store.countNonterminalPublicationJobs('production-guild'), 1);
    assert.equal(store.getBinding('production-guild', 'recorded-user')?.status, 'provisioning');
    assert.equal(store.getInteractionReceipt('recorded-interaction')?.status, 'processing');

    await first.stop();
    store.applyRecordedPublicationBatchSuccess = applyRecorded;
    const recovered = new ProfilePublishWorker({
      store,
      guildId: 'production-guild',
      backend,
      batchWindowMs: 0,
    });
    try {
      await recovered.drain();
    } finally {
      await recovered.stop();
    }

    assert.equal(backendCalls, 1);
    assert.ok(store.getPublicationJob('recorded-operation')?.appliedAt);
    assert.equal(store.countNonterminalPublicationJobs('production-guild'), 0);
    assert.equal(store.getBinding('production-guild', 'recorded-user')?.status, 'active');
    assert.equal(store.getInteractionReceipt('recorded-interaction')?.status, 'completed');
  } finally {
    store.applyRecordedPublicationBatchSuccess = applyRecorded;
    await first.stop();
    store.close();
  }
});

test('a local apply failure retries in the same process without republishing', async () => {
  const store = new SqliteStore(':memory:');
  prepareRegistrationJob(store, 'same-process');
  let backendCalls = 0;
  const applyRecorded = store.applyRecordedPublicationBatchSuccess.bind(store);
  let applyAttempts = 0;
  store.applyRecordedPublicationBatchSuccess = (input) => {
    applyAttempts += 1;
    if (applyAttempts === 1) {
      throw new Error('temporary local apply failure');
    }
    return applyRecorded(input);
  };
  const drainStates: string[] = [];
  const worker = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    batchWindowMs: 0,
    retryDelayMs: 5,
    onDrainError: () => drainStates.push('error'),
    onDrainHealthy: () => drainStates.push('healthy'),
    backend: {
      async publishBatch(inputs) {
        backendCalls += 1;
        return inputs.map((input) => successfulResult(input, 'same-process-commit'));
      },
    },
  });

  try {
    await assert.rejects(worker.drain(), /temporary local apply failure/);
    await waitUntil(() => Boolean(store.getPublicationJob('same-process-operation')?.appliedAt));
    assert.equal(backendCalls, 1);
    assert.equal(applyAttempts, 2);
    assert.deepEqual(drainStates, ['error', 'healthy']);
    assert.equal(store.getBinding('production-guild', 'same-process-user')?.status, 'active');
  } finally {
    store.applyRecordedPublicationBatchSuccess = applyRecorded;
    await worker.stop();
    store.close();
  }
});

test('successful owner update preserves a revoked binding while applying local state', async () => {
  const store = new SqliteStore(':memory:');
  createActiveProfile(store, 'production-guild', 'revoked-user', 'revoked-member');
  store.setBindingStatus('production-guild', 'revoked-user', 'revoked');
  store.beginInteraction('revoked-interaction', 'revoked-operation', 'PROFILE_UPDATE');
  store.enqueuePublicationJob({
    operationId: 'revoked-operation',
    context: {
      ...publicationContext('revoked-user', 'revoked-interaction', 'PROFILE_UPDATE'),
      actorUserId: 'owner',
    },
    profileSlug: 'revoked-member',
    action: 'PROFILE_UPDATE',
    profileJson: '{"name":"Revoked Member","order":3}',
    profileExpectedSha: 'before-revoked-member',
  });
  const worker = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    batchWindowMs: 0,
    backend: {
      async publishBatch(inputs) {
        return inputs.map((input) => successfulResult(input, 'revoked-update-commit'));
      },
    },
  });

  try {
    await worker.drain();
    assert.equal(store.getBinding('production-guild', 'revoked-user')?.status, 'revoked');
    assert.equal(
      store.getProfileState('production-guild', 'revoked-member')?.profileJson,
      '{"name":"Revoked Member","order":3}',
    );
    assert.ok(store.getPublicationJob('revoked-operation')?.appliedAt);
  } finally {
    await worker.stop();
    store.close();
  }
});

test('ambiguous publisher errors stay queued without rolling back domain state', async () => {
  const store = new SqliteStore(':memory:');
  const ambiguous = Object.assign(new Error('publication deadline elapsed'), {
    code: 'publication_timeout',
  });
  const worker = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    batchWindowMs: 0,
    retryDelayMs: 60_000,
    backend: {
      async publishBatch() {
        throw ambiguous;
      },
    },
  });

  try {
    prepareRegistrationJob(store, 'ambiguous');
    await worker.drain();

    const job = store.getPublicationJob('ambiguous-operation');
    assert.equal(job?.status, 'queued');
    assert.equal(job?.attempts, 1);
    assert.equal(job?.appliedAt, undefined);
    assert.deepEqual(JSON.parse(job?.errorJson ?? ''), {
      error: 'publication deadline elapsed',
      code: 'publication_timeout',
    });
    assert.equal(store.getBinding('production-guild', 'ambiguous-user')?.status, 'provisioning');
    assert.equal(store.getInteractionReceipt('ambiguous-interaction')?.status, 'processing');
    assert.equal(store.countNonterminalPublicationJobs('production-guild'), 1);
  } finally {
    worker.stop();
    store.close();
  }
});

test('a malformed batch result is released for retry instead of stranding its lease', async () => {
  const store = new SqliteStore(':memory:');
  const worker = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    batchWindowMs: 0,
    retryDelayMs: 60_000,
    backend: {
      async publishBatch() {
        return [];
      },
    },
  });

  try {
    prepareRegistrationJob(store, 'mismatch');
    await worker.drain();

    const job = store.getPublicationJob('mismatch-operation');
    assert.equal(job?.status, 'queued');
    assert.equal(job?.leaseOwner, undefined);
    assert.equal(job?.appliedAt, undefined);
    assert.deepEqual(JSON.parse(job?.errorJson ?? ''), {
      error: 'Batch publisher returned a different number of results than inputs.',
      code: 'publication_result_mismatch',
    });
    assert.equal(store.getBinding('production-guild', 'mismatch-user')?.status, 'provisioning');
    assert.equal(store.getInteractionReceipt('mismatch-interaction')?.status, 'processing');
  } finally {
    worker.stop();
    store.close();
  }
});

test('definite pre-publication failures atomically fail the receipt and release registration', async () => {
  const store = new SqliteStore(':memory:');
  const definite = Object.assign(new Error('profile input was rejected'), { code: 'invalid_input' });
  const worker = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    batchWindowMs: 0,
    backend: {
      async publishBatch() {
        throw definite;
      },
    },
  });

  try {
    prepareRegistrationJob(store, 'definite');
    await worker.drain();

    const job = store.getPublicationJob('definite-operation');
    assert.equal(job?.status, 'failed');
    assert.ok(job?.appliedAt);
    assert.equal(store.getBinding('production-guild', 'definite-user'), undefined);
    assert.equal(store.getInteractionReceipt('definite-interaction')?.status, 'failed');
    assert.deepEqual(
      JSON.parse(store.getInteractionReceipt('definite-interaction')?.responseJson ?? ''),
      { error: 'profile input was rejected', code: 'invalid_input' },
    );
  } finally {
    worker.stop();
    store.close();
  }
});

test('foreground publishing polls a lightweight outcome, returns queued, then exposes completion', async () => {
  const store = new CountingSqliteStore(':memory:');
  createActiveProfile(store, 'production-guild', 'foreground-user', 'foreground-member');
  store.beginInteraction('foreground-interaction', 'foreground-operation', 'PROFILE_UPDATE');

  let releaseBackend!: () => void;
  const backendGate = new Promise<void>((resolve) => {
    releaseBackend = resolve;
  });
  const backend: BatchProfilePublisher = {
    async publishBatch(inputs) {
      await backendGate;
      return inputs.map((input) => successfulResult(input, 'foreground-commit'));
    },
  };
  const publisher = new QueuedProfilePublisher({
    store,
    guildId: 'production-guild',
    backend,
    batchWindowMs: 0,
    foregroundWaitMs: 10,
    terminalPollMs: 1,
  });
  const input: ProfilePublishInput = {
    operationId: 'foreground-operation',
    slug: 'foreground-member',
    action: 'PROFILE_UPDATE',
    profile: {
      json: '{"name":"Foreground Updated"}',
      expectedSha: 'before-foreground-member',
    },
  };
  const context = publicationContext(
    'foreground-user',
    'foreground-interaction',
    'PROFILE_UPDATE',
  );

  try {
    const queued = await publisher.publish(input, context);
    assert.deepEqual(queued, {
      status: 'queued',
      operationId: 'foreground-operation',
      attempts: 0,
    });
    assert.ok(store.outcomeReads >= 1);
    assert.equal(
      store.fullJobReads,
      3,
      'only enqueue and the worker claim may read the full photo-bearing row',
    );
    assert.equal(store.getInteractionReceipt('foreground-interaction')?.status, 'processing');

    releaseBackend();
    await publisher.drain();
    const terminal = await publisher.publish(input, { ...context, awaitCompletion: true });
    assert.equal(terminal.status, 'deployed');
    assert.equal(terminal.stateApplied, true);
    assert.equal(store.getInteractionReceipt('foreground-interaction')?.status, 'completed');
  } finally {
    store.close();
  }
});

test('stop waits for the claimed batch and prevents any later claim', async () => {
  const store = new SqliteStore(':memory:');
  createActiveProfile(store, 'production-guild', 'first-user', 'first-member');
  store.beginInteraction('first-interaction', 'first-operation', 'PROFILE_UPDATE');
  store.enqueuePublicationJob({
    operationId: 'first-operation',
    context: publicationContext('first-user', 'first-interaction', 'PROFILE_UPDATE'),
    profileSlug: 'first-member',
    action: 'PROFILE_UPDATE',
    profileJson: '{"name":"First Updated"}',
    profileExpectedSha: 'before-first-member',
  });

  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    announceStarted = resolve;
  });
  let releaseBackend!: () => void;
  const backendGate = new Promise<void>((resolve) => {
    releaseBackend = resolve;
  });
  const worker = new ProfilePublishWorker({
    store,
    guildId: 'production-guild',
    batchWindowMs: 0,
    backend: {
      async publishBatch(inputs) {
        announceStarted();
        await backendGate;
        return inputs.map((input) => successfulResult(input, 'shutdown-commit'));
      },
    },
  });

  try {
    void worker.drain();
    await started;
    const stopped = worker.stop();

    createActiveProfile(store, 'production-guild', 'second-user', 'second-member');
    store.beginInteraction('second-interaction', 'second-operation', 'PROFILE_UPDATE');
    store.enqueuePublicationJob({
      operationId: 'second-operation',
      context: publicationContext('second-user', 'second-interaction', 'PROFILE_UPDATE'),
      profileSlug: 'second-member',
      action: 'PROFILE_UPDATE',
      profileJson: '{"name":"Second Updated"}',
      profileExpectedSha: 'before-second-member',
    });

    let stopSettled = false;
    void stopped.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    assert.equal(stopSettled, false);

    releaseBackend();
    await stopped;
    await worker.waitForIdle();
    assert.equal(store.getPublicationJob('first-operation')?.status, 'completed');
    assert.equal(store.getPublicationJob('second-operation')?.status, 'queued');
    assert.equal(store.getInteractionReceipt('second-interaction')?.status, 'processing');
  } finally {
    await worker.stop();
    store.close();
  }
});

function successfulResult(input: ProfilePublishInput, commitSha: string): TerminalResult {
  return {
    status: 'deployed',
    commitSha,
    profileBlobSha: `blob-${input.slug}`,
    attempts: 1,
  };
}

function publicationContext(
  userId: string,
  interactionId: string,
  receiptKind: string,
): ProfilePublishContext {
  return {
    guildId: 'production-guild',
    actorUserId: userId,
    targetUserId: userId,
    interactionId,
    receiptKind,
  };
}

function createActiveProfile(
  store: SqliteStore,
  guildId: string,
  userId: string,
  slug: string,
) {
  store.reserveBinding(guildId, userId, slug);
  store.activateBinding(guildId, userId);
  store.saveProfileState({
    guildId,
    profileSlug: slug,
    profileJson: JSON.stringify({ name: slug }),
    profileBlobSha: `before-${slug}`,
    lastCommitSha: `commit-before-${slug}`,
    lastDeploymentStatus: 'deployed',
  });
}

function prepareRegistrationJob(store: SqliteStore, prefix: string) {
  const operationId = `${prefix}-operation`;
  const interactionId = `${prefix}-interaction`;
  const userId = `${prefix}-user`;
  const slug = `${prefix}-member`;
  store.reserveBinding('production-guild', userId, slug, operationId);
  store.beginInteraction(interactionId, operationId, 'PROFILE_CREATE');
  store.enqueuePublicationJob({
    operationId,
    context: publicationContext(userId, interactionId, 'PROFILE_CREATE'),
    profileSlug: slug,
    action: 'PROFILE_CREATE',
    profileJson: JSON.stringify({ name: `${prefix} member` }),
    profileExpectedSha: null,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the publication worker condition.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
