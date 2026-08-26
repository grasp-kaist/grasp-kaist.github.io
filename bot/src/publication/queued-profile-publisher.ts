import type {
  ProfilePublishContext,
  ProfilePublishInput,
  ProfilePublishResult,
} from '../service/profile-service.js';
import {
  SqliteStore,
} from '../storage/sqlite-store.js';
import {
  ProfilePublishWorker,
  type BatchProfilePublisher,
  type ProfilePublishWorkerOptions,
} from './publish-worker.js';

export type QueuedProfilePublisherOptions = Omit<
  ProfilePublishWorkerOptions,
  'backend' | 'guildId' | 'store'
> & {
  store: SqliteStore;
  guildId: string;
  backend: BatchProfilePublisher;
  foregroundWaitMs?: number;
  terminalPollMs?: number;
  terminalWaitMs?: number;
};

export class QueuedPublicationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'QueuedPublicationError';
    this.code = code;
  }
}

export class QueuedProfilePublisher {
  readonly usesDurableQueue = true;
  readonly #store: SqliteStore;
  readonly #guildId: string;
  readonly #worker: ProfilePublishWorker;
  readonly #foregroundWaitMs: number;
  readonly #terminalPollMs: number;
  readonly #terminalWaitMs: number;

  constructor(options: QueuedProfilePublisherOptions) {
    this.#store = options.store;
    this.#guildId = options.guildId;
    this.#foregroundWaitMs = positiveInteger(
      options.foregroundWaitMs ?? 6_000,
      'foregroundWaitMs',
    );
    this.#terminalPollMs = positiveInteger(options.terminalPollMs ?? 200, 'terminalPollMs');
    this.#terminalWaitMs = positiveInteger(
      options.terminalWaitMs ?? 15 * 60_000,
      'terminalWaitMs',
    );
    this.#worker = new ProfilePublishWorker(options);
  }

  async publish(
    input: ProfilePublishInput,
    context?: ProfilePublishContext,
  ): Promise<ProfilePublishResult> {
    if (!context) {
      throw new QueuedPublicationError(
        'publication_context_missing',
        'Durable production publication requires Discord operation context.',
      );
    }
    if (context.guildId !== this.#guildId) {
      throw new QueuedPublicationError(
        'wrong_publication_guild',
        'This publication queue only accepts the configured production guild.',
      );
    }

    this.#store.enqueuePublicationJob({
      operationId: input.operationId,
      context: {
        guildId: context.guildId,
        actorUserId: context.actorUserId,
        targetUserId: context.targetUserId,
        interactionId: context.interactionId,
        receiptKind: context.receiptKind,
        ...(context.stagedPhotoId ? { stagedPhotoId: context.stagedPhotoId } : {}),
        ...(context.adminAction ? { adminAction: context.adminAction } : {}),
      },
      profileSlug: input.slug,
      action: input.action,
      profileJson: input.profile.json,
      profileExpectedSha: input.profile.expectedSha,
      ...(input.photo?.kind === 'upsert'
        ? {
            photo: {
              kind: 'upsert' as const,
              bytes: Buffer.from(input.photo.bytes),
              expectedSha: input.photo.expectedSha,
            },
          }
        : input.photo?.kind === 'delete'
          ? { photo: { kind: 'delete' as const, expectedSha: input.photo.expectedSha } }
          : {}),
    });
    void this.#worker.drain().catch(() => undefined);
    const terminal = await this.#waitForTerminal(
      input.operationId,
      context.awaitCompletion ? this.#terminalWaitMs : this.#foregroundWaitMs,
    );
    if (terminal) {
      return terminal;
    }
    if (context.awaitCompletion) {
      throw new QueuedPublicationError(
        'publication_queue_timeout',
        'The website update is still queued. Reopen `/profile` to check its recovered state.',
      );
    }
    return { status: 'queued', operationId: input.operationId, attempts: 0 };
  }

  recoverLeases() {
    return this.#worker.recoverLeases();
  }

  drain() {
    return this.#worker.drain();
  }

  recoverAndDrain() {
    return this.#worker.recoverAndDrain();
  }

  stop() {
    return this.#worker.stop();
  }

  waitForIdle() {
    return this.#worker.waitForIdle();
  }

  nextRecoveryDelayMs() {
    return this.#worker.nextRecoveryDelayMs();
  }

  async #waitForTerminal(operationId: string, waitMs: number) {
    const deadline = Date.now() + waitMs;

    while (true) {
      const job = this.#store.getPublicationJobOutcome(operationId);
      if (!job) {
        throw new QueuedPublicationError(
          'publication_job_missing',
          'The durable publication job disappeared before completion.',
        );
      }
      if (job.status === 'completed' && job.appliedAt) {
        return { ...parsePublishResult(job.resultJson), stateApplied: true };
      }
      if (job.status === 'failed') {
        throw parsePublicationError(job.errorJson);
      }
      if (Date.now() >= deadline) {
        return undefined;
      }
      await delay(Math.min(this.#terminalPollMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function parsePublishResult(value: string | undefined): ProfilePublishResult {
  const parsed: unknown = value ? JSON.parse(value) : undefined;
  if (
    !isRecord(parsed)
    || !(
      parsed.status === 'deployed'
      || parsed.status === 'no_change'
      || parsed.status === 'published_deploy_failed'
      || parsed.status === 'sandbox'
    )
    || typeof parsed.profileBlobSha !== 'string'
    || !Number.isInteger(parsed.attempts)
    || (parsed.attempts as number) < 1
  ) {
    throw new QueuedPublicationError(
      'publication_result_corrupt',
      'The durable publication result could not be read safely.',
    );
  }
  return parsed as unknown as ProfilePublishResult;
}

function parsePublicationError(value: string | undefined) {
  const parsed: unknown = value ? JSON.parse(value) : undefined;
  return new QueuedPublicationError(
    isRecord(parsed) && typeof parsed.code === 'string' ? parsed.code : 'publication_failed',
    isRecord(parsed) && typeof parsed.error === 'string'
      ? parsed.error
      : 'The durable website publication failed.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
