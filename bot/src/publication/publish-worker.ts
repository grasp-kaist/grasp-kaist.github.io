import { randomUUID } from 'node:crypto';

import type {
  ProfilePublishInput,
  ProfilePublishResult,
} from '../service/profile-service.js';
import {
  SqliteStore,
  type ProfilePublicationJob,
} from '../storage/sqlite-store.js';

type TerminalProfilePublishResult = Exclude<ProfilePublishResult, { status: 'queued' }>;

export type BatchProfilePublisher = {
  publishBatch(inputs: readonly ProfilePublishInput[]): Promise<TerminalProfilePublishResult[]>;
};

export type ProfilePublishWorkerOptions = {
  store: SqliteStore;
  backend: BatchProfilePublisher;
  workerId?: string;
  batchWindowMs?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  newLeaseToken?: () => string;
  onDrainError?: (error: unknown) => void;
  onDrainHealthy?: () => void;
};

const DEFAULT_BATCH_WINDOW_MS = 2_000;
const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFINITELY_UNPUBLISHED_ERROR_CODES = new Set([
  'content_conflict',
  'invalid_input',
  'main_conflict',
  'unexpected_diff',
  'validation_workflow_not_found',
  'validation_unavailable',
  'validation_failed',
  'validation_timeout',
  'main_update_rejected',
]);

class PublicationWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PublicationWorkerError';
    this.code = code;
  }
}

export class ProfilePublishWorker {
  readonly #store: SqliteStore;
  readonly #backend: BatchProfilePublisher;
  readonly #workerId: string;
  readonly #batchWindowMs: number;
  readonly #leaseMs: number;
  readonly #retryDelayMs: number;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #newLeaseToken: () => string;
  readonly #onDrainError: (error: unknown) => void;
  readonly #onDrainHealthy: () => void;
  #drainPromise: Promise<void> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #stopping = false;
  #wakeRequested = false;

  constructor(options: ProfilePublishWorkerOptions) {
    this.#store = options.store;
    this.#backend = options.backend;
    this.#workerId = options.workerId?.trim() || randomUUID();
    this.#batchWindowMs = nonNegativeInteger(
      options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      'batchWindowMs',
    );
    this.#leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, 'leaseMs');
    this.#retryDelayMs = positiveInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      'retryDelayMs',
    );
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? delay;
    this.#newLeaseToken = options.newLeaseToken ?? randomUUID;
    this.#onDrainError = options.onDrainError ?? (() => undefined);
    this.#onDrainHealthy = options.onDrainHealthy ?? (() => undefined);
  }

  get workerId() {
    return this.#workerId;
  }

  recoverLeases() {
    return this.#store.recoverPublicationLeases();
  }

  drain() {
    if (this.#stopping) {
      return this.waitForIdle();
    }
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#wakeRequested = true;
    if (!this.#drainPromise) {
      this.#drainPromise = this.#runDrain()
        .then(() => {
          if (this.#store.countNonterminalPublicationJobs() === 0) {
            this.#onDrainHealthy();
          } else {
            const recoveryDelay = this.nextRecoveryDelayMs();
            if (recoveryDelay !== undefined) {
              this.#scheduleRetry(recoveryDelay);
            }
          }
        })
        .catch((error: unknown) => {
          this.#scheduleRetry();
          this.#onDrainError(error);
          throw error;
        })
        .finally(() => {
          this.#drainPromise = undefined;
          if (this.#wakeRequested && !this.#stopping) {
            void this.drain().catch(() => undefined);
          }
        });
    }
    return this.#drainPromise;
  }

  async recoverAndDrain() {
    this.recoverLeases();
    await this.drain();
  }

  stop() {
    this.#stopping = true;
    this.#wakeRequested = false;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    return this.waitForIdle();
  }

  waitForIdle() {
    return this.#drainPromise ?? Promise.resolve();
  }

  nextRecoveryDelayMs() {
    const now = this.#now().getTime();
    let delay: number | undefined;

    for (const job of this.#store.listPublicationRecoveryCandidates()) {
      const parsedLeaseExpiry = job.status === 'leased' && job.leaseExpiresAt
        ? Date.parse(job.leaseExpiresAt)
        : Number.NaN;
      const candidate = Number.isFinite(parsedLeaseExpiry)
        ? Math.max(1, parsedLeaseExpiry - now + 1)
        : this.#retryDelayMs;
      delay = delay === undefined ? candidate : Math.min(delay, candidate);
    }

    return delay;
  }

  async #runDrain() {
    while (true) {
      if (this.#stopping) {
        return;
      }
      this.#wakeRequested = false;
      this.recoverLeases();

      const unapplied = this.#store.listUnappliedPublicationJobs();
      if (unapplied.length > 0) {
        try {
          this.#applyRecordedBatch(unapplied);
        } catch (error) {
          this.#scheduleRetry();
          throw error;
        }
        continue;
      }

      const createdAt = this.#store.getOldestQueuedPublicationCreatedAt();

      if (!createdAt) {
        if (this.#wakeRequested) continue;
        return;
      }

      const remainingWindow = Date.parse(createdAt) + this.#batchWindowMs - this.#now().getTime();
      if (remainingWindow > 0) {
        await this.#sleep(remainingWindow);
      }

      if (this.#stopping) {
        return;
      }

      const leaseToken = this.#newLeaseToken();
      const jobs = this.#store.claimPublicationJobs({
        workerId: this.#workerId,
        leaseToken,
        leaseExpiresAt: new Date(this.#now().getTime() + this.#leaseMs),
        limit: 20,
      });

      if (jobs.length === 0) {
        if (this.#wakeRequested) continue;
        return;
      }

      let outcome: 'completed' | 'retry_later';
      try {
        outcome = await this.#publishClaimedBatch(jobs, leaseToken);
      } catch (error) {
        this.#scheduleRetry();
        throw error;
      }
      if (outcome === 'retry_later') {
        this.#wakeRequested = false;
        this.#scheduleRetry();
        return;
      }
    }
  }

  async #publishClaimedBatch(jobs: ProfilePublicationJob[], leaseToken: string) {
    const inputs = jobs.map(toPublishInput);
    const heartbeatMilliseconds = Math.max(100, Math.floor(this.#leaseMs / 3));
    const heartbeat = setInterval(() => {
      try {
        this.#store.renewPublicationLease({
          workerId: this.#workerId,
          leaseToken,
          leaseExpiresAt: new Date(this.#now().getTime() + this.#leaseMs),
        });
      } catch {
        // Completion uses owner, token, and generation CAS. A lost heartbeat
        // therefore cannot let this worker finalize a lease it no longer owns.
      }
    }, heartbeatMilliseconds);
    heartbeat.unref();

    let results: TerminalProfilePublishResult[];
    try {
      results = await this.#backend.publishBatch(inputs);
    } catch (error) {
      clearInterval(heartbeat);
      const leasedJobs = jobs.map((job) => ({
        operationId: job.operationId,
        leaseGeneration: job.leaseGeneration,
      }));
      const errorJson = serializePublicationError(error);

      if (isDefinitelyUnpublishedFailure(error)) {
        this.#store.applyPublicationBatchFailure({
          workerId: this.#workerId,
          leaseToken,
          jobs: leasedJobs,
          errorJson,
        });
        return 'completed';
      }

      this.#releaseClaimedBatchForRetry(jobs, leaseToken, errorJson);
      return 'retry_later';
    }
    clearInterval(heartbeat);

    if (results.length !== jobs.length) {
      const mismatch = new PublicationWorkerError(
        'publication_result_mismatch',
        'Batch publisher returned a different number of results than inputs.',
      );
      this.#releaseClaimedBatchForRetry(jobs, leaseToken, serializePublicationError(mismatch));
      return 'retry_later';
    }

    const recordedResults = jobs.map((job, index) => {
      const result = assertPublishResult(results[index]);
      return {
        operationId: job.operationId,
        leaseGeneration: job.leaseGeneration,
        resultJson: JSON.stringify(result),
      };
    });
    this.#store.recordPublicationBatchSuccess({
      workerId: this.#workerId,
      leaseToken,
      results: recordedResults,
    });
    this.#applyRecordedBatch(
      recordedResults.map(({ operationId }) => this.#store.getPublicationJob(operationId)!),
    );
    return 'completed';
  }

  #applyRecordedBatch(jobs: ProfilePublicationJob[]) {
    this.#store.applyRecordedPublicationBatchSuccess({
      results: jobs.map((job) => {
        const result = parseRecordedPublishResult(job);
        return {
          operationId: job.operationId,
          resultJson: job.resultJson!,
          state: publishedState(job, result, this.#store),
        };
      }),
    });
  }

  #releaseClaimedBatchForRetry(
    jobs: ProfilePublicationJob[],
    leaseToken: string,
    errorJson: string,
  ) {
    this.#store.releasePublicationBatchForRetry({
      workerId: this.#workerId,
      leaseToken,
      jobs: jobs.map((job) => ({
        operationId: job.operationId,
        leaseGeneration: job.leaseGeneration,
      })),
      errorJson,
    });
  }

  #scheduleRetry(delayMs = this.#retryDelayMs) {
    if (this.#retryTimer || this.#stopping) {
      return;
    }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.drain().catch(() => undefined);
    }, delayMs);
    this.#retryTimer.unref();
  }
}

function toPublishInput(job: ProfilePublicationJob): ProfilePublishInput {
  return {
    operationId: job.operationId,
    slug: job.profileSlug,
    action: job.action,
    profile: {
      json: job.profileJson,
      expectedSha: job.profileExpectedSha,
    },
    ...(job.photo?.kind === 'upsert'
      ? {
          photo: {
            kind: 'upsert' as const,
            bytes: new Uint8Array(job.photo.bytes),
            expectedSha: job.photo.expectedSha,
          },
        }
      : job.photo?.kind === 'delete'
        ? { photo: { kind: 'delete' as const, expectedSha: job.photo.expectedSha } }
        : {}),
  };
}

function publishedState(
  job: ProfilePublicationJob,
  result: TerminalProfilePublishResult,
  store: SqliteStore,
) {
  const previous = store.getProfileState(job.context.guildId, job.profileSlug);
  let photoBlobSha = previous?.photoBlobSha;

  if (job.photo?.kind === 'upsert') {
    if (!result.photoBlobSha) {
      throw new Error('Batch publisher omitted the uploaded photo revision.');
    }
    photoBlobSha = result.photoBlobSha;
  } else if (job.photo?.kind === 'delete') {
    photoBlobSha = undefined;
  }

  const lastCommitSha = result.commitSha ?? previous?.lastCommitSha;
  return {
    profileSlug: job.profileSlug,
    profileJson: job.profileJson,
    profileBlobSha: result.profileBlobSha,
    ...(photoBlobSha ? { photoBlobSha } : {}),
    ...(lastCommitSha ? { lastCommitSha } : {}),
    lastDeploymentStatus:
      result.status === 'no_change' && previous
        ? previous.lastDeploymentStatus
        : result.status,
  };
}

function assertPublishResult(
  value: TerminalProfilePublishResult | undefined,
): TerminalProfilePublishResult {
  if (
    !value
    || !(
      value.status === 'deployed'
      || value.status === 'no_change'
      || value.status === 'published_deploy_failed'
      || value.status === 'sandbox'
    )
    || typeof value.profileBlobSha !== 'string'
    || !value.profileBlobSha
    || !Number.isInteger(value.attempts)
    || value.attempts < 1
  ) {
    throw new Error('Batch publisher returned an invalid profile result.');
  }
  return value;
}

function parseRecordedPublishResult(job: ProfilePublicationJob) {
  if (!job.resultJson) {
    throw new Error('Recorded publication success is missing its result.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.resultJson);
  } catch (error) {
    throw new Error('Recorded publication success contains invalid JSON.', { cause: error });
  }
  return assertPublishResult(parsed as TerminalProfilePublishResult);
}

function serializePublicationError(error: unknown) {
  const record = isRecord(error) ? error : undefined;
  const code = record && typeof record.code === 'string' ? record.code : undefined;
  const message = code && error instanceof Error
    ? error.message
    : 'The website publisher reported an unexpected or ambiguous error.';
  return JSON.stringify({
    error: message || 'Unknown publication error',
    ...(code ? { code } : {}),
  });
}

function isDefinitelyUnpublishedFailure(error: unknown) {
  return isRecord(error)
    && typeof error.code === 'string'
    && DEFINITELY_UNPUBLISHED_ERROR_CODES.has(error.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
