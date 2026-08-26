import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
} from 'discord.js';

import {
  syncGlobalCommandsIfChanged,
  type GlobalCommandSyncResult,
} from './command-sync.js';
import { dispatchGatewayInteraction } from './gateway-adapter.js';
import type { DiscordInteractionRouter } from './router.js';

type GatewayRouter = Pick<DiscordInteractionRouter, 'route'>;

export type DiscordGatewayRuntimeOptions = {
  applicationId: string;
  botToken: string;
  router: GatewayRouter;
  client?: Client;
  reportError?: (error: unknown) => void;
  syncCommands?: (input: {
    applicationId: string;
    botToken: string;
  }) => Promise<GlobalCommandSyncResult>;
  login?: (client: Client, token: string) => Promise<unknown>;
  fetchApplication?: (client: Client) => Promise<{
    interactionsEndpointURL: string | null;
  }>;
  destroyClient?: (client: Client) => void | Promise<void>;
};

/** Create the bot client with the only Gateway intent this application needs. */
export function createDiscordGatewayClient() {
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}

/**
 * Own the Discord Gateway connection and its interaction listener. Commands
 * are synchronized before login so a failed schema deployment never leaves a
 * newly started process pretending to be ready.
 */
export class DiscordGatewayRuntime {
  readonly client: Client;

  private readonly applicationId: string;
  private readonly botToken: string;
  private readonly router: GatewayRouter;
  private readonly reportError: (error: unknown) => void;
  private readonly syncCommands: NonNullable<DiscordGatewayRuntimeOptions['syncCommands']>;
  private readonly loginClient: NonNullable<DiscordGatewayRuntimeOptions['login']>;
  private readonly fetchApplication: NonNullable<DiscordGatewayRuntimeOptions['fetchApplication']>;
  private readonly destroyClient: NonNullable<DiscordGatewayRuntimeOptions['destroyClient']>;
  private commandSyncResult: GlobalCommandSyncResult | undefined;
  private startPromise: Promise<GlobalCommandSyncResult> | undefined;
  private destroyPromise: Promise<void> | undefined;
  private readonly inFlight = new Set<Promise<unknown>>();
  private listening = false;
  private destroyed = false;

  constructor(options: DiscordGatewayRuntimeOptions) {
    this.applicationId = options.applicationId;
    this.botToken = options.botToken;
    this.router = options.router;
    this.client = options.client ?? createDiscordGatewayClient();
    this.reportError = options.reportError ?? console.error;
    this.syncCommands = options.syncCommands ?? syncGlobalCommandsIfChanged;
    this.loginClient = options.login ?? ((client, token) => client.login(token));
    this.fetchApplication = options.fetchApplication ?? fetchCurrentApplication;
    this.destroyClient = options.destroyClient ?? ((client) => client.destroy());
  }

  start(): Promise<GlobalCommandSyncResult> {
    if (this.destroyed) {
      return Promise.reject(new Error('The Discord Gateway runtime has been destroyed.'));
    }

    if (this.commandSyncResult) {
      return Promise.resolve(this.commandSyncResult);
    }

    if (!this.startPromise) {
      this.startPromise = this.startOnce();
    }

    return this.startPromise;
  }

  destroy(): Promise<void> {
    if (!this.destroyPromise) {
      this.destroyed = true;
      this.stopListening();
      this.destroyPromise = Promise.resolve(this.destroyClient(this.client));
    }

    return this.destroyPromise;
  }

  /**
   * Wait for interactions already accepted by this process to finish. Call
   * destroy() first during shutdown so no new Gateway events can be admitted.
   * Returns false if the deadline expires while work is still pending.
   */
  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('Gateway drain timeout must be a finite, non-negative number.');
    }

    const deadline = Date.now() + timeoutMs;

    while (this.inFlight.size > 0) {
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        return false;
      }

      const drained = await waitForBatch([...this.inFlight], remainingMs);

      if (!drained) {
        return false;
      }
    }

    return true;
  }

  private async startOnce() {
    const commandSyncResult = await this.syncCommands({
      applicationId: this.applicationId,
      botToken: this.botToken,
    });

    if (this.destroyed) {
      throw new Error('The Discord Gateway runtime was destroyed during startup.');
    }

    this.startListening();

    try {
      await this.loginClient(this.client, this.botToken);
      const application = await this.fetchApplication(this.client);

      if (application.interactionsEndpointURL !== null) {
        throw new Error(
          'Discord application still has an Interactions Endpoint URL configured. '
            + 'Gateway interaction delivery cannot be used while it is set. '
            + 'Open Discord Developer Portal > General Information, clear '
            + 'Interactions Endpoint URL, save changes, and restart the bot.',
        );
      }
    } catch (error) {
      this.stopListening();
      throw error;
    }

    if (this.destroyed) {
      throw new Error('The Discord Gateway runtime was destroyed during startup.');
    }

    this.commandSyncResult = commandSyncResult;
    return commandSyncResult;
  }

  private readonly handleInteraction = (interaction: Interaction) => {
    const operation = dispatchGatewayInteraction(
      interaction,
      this.router,
      this.reportError,
    );
    this.inFlight.add(operation);
    void operation.then(
      () => {
        this.inFlight.delete(operation);
      },
      (error: unknown) => {
        this.inFlight.delete(operation);
        this.reportSafely(error);
      },
    );
  };

  private reportSafely(error: unknown) {
    try {
      this.reportError(error);
    } catch {
      // Error reporters must never turn a handled interaction failure into an
      // unhandled rejection in the Gateway event emitter.
    }
  }

  private startListening() {
    if (!this.listening) {
      this.client.on(Events.InteractionCreate, this.handleInteraction);
      this.listening = true;
    }
  }

  private stopListening() {
    if (this.listening) {
      this.client.off(Events.InteractionCreate, this.handleInteraction);
      this.listening = false;
    }
  }
}

async function fetchCurrentApplication(client: Client) {
  if (!client.application) {
    throw new Error('Discord application metadata was unavailable after Gateway login.');
  }

  return client.application.fetch();
}

function waitForBatch(
  operations: readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(drained);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    void Promise.allSettled(operations).then(() => finish(true));
  });
}

export async function startDiscordGateway(
  options: DiscordGatewayRuntimeOptions,
): Promise<DiscordGatewayRuntime> {
  const runtime = new DiscordGatewayRuntime(options);
  await runtime.start();
  return runtime;
}
