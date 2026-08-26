import type {
  ProfilePublisher,
  ProfileRepositoryReader,
  PublishCheckpointLookup,
} from './profile-service.js';
import { ProfileService } from './profile-service.js';
import { SandboxProfileRepository } from './sandbox-profile-repository.js';
import type { SqliteStore } from '../storage/sqlite-store.js';

export type GuildPublicationMode = 'sandbox' | 'production';

export type GuildProfileRuntime = {
  service: ProfileService;
  publicationMode: GuildPublicationMode;
};

export type ProductionProfileRuntime = {
  guildId: string;
  publisher: ProfilePublisher;
  repositoryReader: ProfileRepositoryReader;
  checkpointLookup?: PublishCheckpointLookup;
  membersPageUrl?: string;
};

type ReconciliationSummary = {
  reconciled: number;
  unchanged: number;
  released: number;
  issues: Array<{ guildId: string; profileSlug: string; message: string }>;
};

/**
 * Creates one guild-bound ProfileService per Discord server. The existing
 * service-level guild assertion remains in place as defense in depth, while
 * only the explicitly configured production guild ever receives GitHub
 * credentials. Every other installed guild is isolated under its own sandbox
 * directory.
 */
export class GuildProfileRuntimeRegistry {
  readonly #store: SqliteStore;
  readonly #ownerUserId: string;
  readonly #sandboxDirectory: string;
  readonly #production: ProductionProfileRuntime | undefined;
  readonly #runtimes = new Map<string, GuildProfileRuntime>();

  constructor(options: {
    store: SqliteStore;
    ownerUserId: string;
    sandboxDirectory: string;
    production?: ProductionProfileRuntime;
  }) {
    this.#store = options.store;
    this.#ownerUserId = options.ownerUserId;
    this.#sandboxDirectory = options.sandboxDirectory;
    this.#production = options.production;
  }

  resolve(guildId: string): GuildProfileRuntime {
    const existing = this.#runtimes.get(guildId);

    if (existing) {
      return existing;
    }

    const production = this.#production?.guildId === guildId ? this.#production : undefined;
    const sandbox = production
      ? undefined
      : new SandboxProfileRepository({
          rootDirectory: this.#sandboxDirectory,
          guildId,
        });
    const runtime: GuildProfileRuntime = {
      publicationMode: production ? 'production' : 'sandbox',
      service: new ProfileService({
        store: this.#store,
        publisher: production?.publisher ?? sandbox!,
        repositoryReader: production?.repositoryReader ?? sandbox!,
        ...(production?.checkpointLookup
          ? { checkpointLookup: production.checkpointLookup }
          : {}),
        guildId,
        ownerUserId: this.#ownerUserId,
        ...(production?.membersPageUrl ? { membersPageUrl: production.membersPageUrl } : {}),
      }),
    };
    this.#runtimes.set(guildId, runtime);
    return runtime;
  }

  async reconcileKnownProfiles(): Promise<ReconciliationSummary> {
    const guildIds = new Set([
      ...this.#store.listGuildIds(),
      ...this.#runtimes.keys(),
      ...(this.#production ? [this.#production.guildId] : []),
    ]);
    const combined: ReconciliationSummary = {
      reconciled: 0,
      unchanged: 0,
      released: 0,
      issues: [],
    };

    for (const guildId of guildIds) {
      const summary = await this.resolve(guildId).service.reconcileKnownProfiles();
      combined.reconciled += summary.reconciled;
      combined.unchanged += summary.unchanged;
      combined.released += summary.released;
      combined.issues.push(
        ...summary.issues.map((issue) => ({ guildId, ...issue })),
      );
    }

    return combined;
  }
}
