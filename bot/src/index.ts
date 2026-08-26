import { Events } from 'discord.js';

import { type AppConfig, loadConfig } from './config.js';
import {
  DiscordAttachmentDownloadError,
  DiscordCdnAttachmentDownloader,
  DiscordGatewayRuntime,
  DiscordGuildRouter,
  DiscordInteractionRouter,
  DiscordInteractionWebhookClient,
  attachDiscordGatewayHealthEvents,
  ephemeralTextResponse,
  type DiscordInteraction,
} from './discord/index.js';
import { createHealthApp, type BotHealthSnapshot } from './http-app.js';
import { ProfilePhotoError } from './image/process-profile-photo.js';
import {
  closeHttpServerWithin,
  startHealthServer,
  waitForPromiseWithin,
} from './runtime-startup.js';
import {
  ProfileServiceError,
  type ProfilePublisher,
  type ProfileRepositoryReader,
  type PublishCheckpointLookup,
} from './service/profile-service.js';
import { GuildProfileRuntimeRegistry } from './service/guild-profile-runtime.js';
import {
  SandboxProfileRepositoryError,
} from './service/sandbox-profile-repository.js';
import { SqliteStore } from './storage/sqlite-store.js';

type PublicationRuntime = {
  publisher: ProfilePublisher;
  repositoryReader: ProfileRepositoryReader;
  checkpointLookup?: PublishCheckpointLookup;
  close(): void;
};

const SHUTDOWN_DEADLINE_MS = 25_000;

await run();

async function run() {
  const config = loadConfig();
  const store = new SqliteStore(config.databasePath);
  const stagedRecovery = store.recoverInterruptedStagedPhotos();
  const health: BotHealthSnapshot = {
    ready: false,
    gateway: 'starting',
    profileRecovery: 'running',
    publicationMode: config.publication.mode,
  };
  const healthApp = createHealthApp(() => ({ ...health }));
  const healthServer = startHealthServer({ fetch: healthApp.fetch, port: config.port });
  let publication: PublicationRuntime | undefined;
  let gateway: DiscordGatewayRuntime | undefined;
  let stagedPhotoCleanupTimer: ReturnType<typeof setInterval> | undefined;
  let startupComplete = false;
  let profileRecoveryComplete = false;
  let shuttingDown = false;

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    publication = await createProductionPublicationRuntime(config);
    const profileRuntimes = new GuildProfileRuntimeRegistry({
      store,
      ownerUserId: config.discord.ownerUserId,
      sandboxDirectory: config.publication.sandboxDirectory,
      ...(publication && config.publication.mode === 'production'
        ? {
            production: {
              guildId: config.publication.productionGuildId,
              publisher: publication.publisher,
              repositoryReader: publication.repositoryReader,
              ...(publication.checkpointLookup
                ? { checkpointLookup: publication.checkpointLookup }
                : {}),
              ...(config.membersPageUrl ? { membersPageUrl: config.membersPageUrl } : {}),
            },
          }
        : {}),
    });
    const webhook = new DiscordInteractionWebhookClient(config.discord.applicationId);
    const attachmentDownloader = new DiscordCdnAttachmentDownloader();
    const router = new DiscordGuildRouter({
      applicationId: config.discord.applicationId,
      createRouter: (guildId) => {
        const runtime = profileRuntimes.resolve(guildId);
        return new DiscordInteractionRouter({
          config: {
            applicationId: config.discord.applicationId,
            guildId,
            ownerUserId: config.discord.ownerUserId,
            publicationMode: runtime.publicationMode,
          },
          service: runtime.service,
          webhook,
          attachmentDownloader,
          formatError: formatUserError,
          reportError: (error) => reportError(error, 'Discord profile operation failed'),
        });
      },
      reportError: (error) => reportError(error, 'Discord profile operation failed'),
    });
    const guardedRouter = {
      route: (interaction: DiscordInteraction) => profileRecoveryComplete
        ? router.route(interaction)
        : Promise.resolve({
            response: ephemeralTextResponse(
              'The bot is finishing startup recovery. Please try this command again shortly.',
            ),
          }),
    };
    gateway = new DiscordGatewayRuntime({
      applicationId: config.discord.applicationId,
      botToken: config.discord.botToken,
      router: guardedRouter,
      reportError: (error) => reportError(error, 'Discord Gateway interaction failed'),
    });

    gateway.client.on(Events.Error, (error) => {
      reportError(error, 'Discord client error');
    });
    attachDiscordGatewayHealthEvents({
      client: gateway.client,
      health,
      isStartupComplete: () => startupComplete,
      isShuttingDown: () => shuttingDown,
      onUnrecoverableDisconnect: () => shutdown(
        'unrecoverable Discord shard disconnect',
        1,
      ),
    });

    const commandSync = await gateway.start();
    assertConnectedApplication(gateway, config.discord.applicationId);
    health.gateway = 'ready';

    const reconciliation = await profileRuntimes.reconcileKnownProfiles();

    for (const issue of reconciliation.issues) {
      reportError(
        new Error(issue.message),
        `Profile reconciliation failed for guild ${issue.guildId}, profile ${issue.profileSlug}`,
      );
    }

    profileRecoveryComplete = true;
    health.profileRecovery = 'ready';
    startupComplete = true;
    health.ready = true;

    stagedPhotoCleanupTimer = setInterval(() => {
      store.deleteExpiredStagedPhotos();
    }, 60_000);
    stagedPhotoCleanupTimer.unref();

    process.stdout.write(
      `GRASP profile bot ready; ${config.publication.mode === 'production'
        ? `guild ${config.publication.productionGuildId} is production and all other guilds are sandboxed`
        : 'all guilds are sandboxed'}; `
        + `${commandSync.commandCount} global command(s) ${commandSync.changed ? 'updated' : 'already current'}.\n`,
    );
    process.stdout.write(
      `Startup profile recovery: ${reconciliation.reconciled} reconciled, `
        + `${reconciliation.released} released, ${reconciliation.issues.length} issue(s).\n`,
    );

    if (stagedRecovery.recovered > 0 || stagedRecovery.expired > 0) {
      process.stdout.write(
        `Recovered ${stagedRecovery.recovered} staged photo(s); `
          + `removed ${stagedRecovery.expired} expired photo(s).\n`,
      );
    }
  } catch (error) {
    reportError(error, 'Bot startup failed');
    await shutdown('startup failure', 1);
  }

  async function shutdown(reason: string, requestedExitCode = 0) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    startupComplete = false;
    health.ready = false;
    health.gateway = 'stopping';

    if (stagedPhotoCleanupTimer) {
      clearInterval(stagedPhotoCleanupTimer);
    }

    let exitCode = requestedExitCode;
    const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
    process.stdout.write(`Stopping Discord Gateway and health service (${reason}).\n`);

    if (gateway) {
      try {
        const destroyResult = await waitForPromiseWithin(gateway.destroy(), 5_000);

        if (destroyResult.timedOut) {
          exitCode = 1;
          reportError(
            new Error('Discord Gateway close exceeded the 5 second window.'),
            'Discord Gateway shutdown deadline expired',
          );
        } else if (destroyResult.error) {
          throw destroyResult.error;
        }
      } catch (error) {
        exitCode = 1;
        reportError(error, 'Discord Gateway shutdown failed');
      }
    }

    const closeResult = await closeHttpServerWithin(healthServer, 5_000);

    if (closeResult.error) {
      exitCode = 1;
      reportError(closeResult.error, 'Health server shutdown failed');
    }

    if (closeResult.timedOut) {
      exitCode = 1;
      reportError(
        new Error('Active health connections exceeded the 5 second close window.'),
        'Health server shutdown deadline expired',
      );
    }

    if (gateway) {
      const idle = await gateway.waitForIdle(Math.max(0, deadline - Date.now()));

      if (!idle) {
        exitCode = 1;
        reportError(
          new Error('One or more admitted Discord interactions exceeded the shutdown deadline.'),
          'Gateway interaction drain deadline expired',
        );
      }
    }

    try {
      publication?.close();
    } catch (error) {
      exitCode = 1;
      reportError(error, 'Publication state shutdown failed');
    }

    try {
      store.close();
    } catch (error) {
      exitCode = 1;
      reportError(error, 'SQLite shutdown failed');
    }

    process.exit(exitCode);
  }
}

async function createProductionPublicationRuntime(
  config: AppConfig,
): Promise<PublicationRuntime | undefined> {
  if (config.publication.mode === 'sandbox') {
    return undefined;
  }

  const [{ App: GitHubApp, Octokit }, github] = await Promise.all([
    import('octokit'),
    import('./github/index.js'),
  ]);
  const githubConfig = config.publication.github;
  const publishStateStore = new github.SqlitePublishStateStore(config.databasePath);
  const PublisherOctokit = Octokit.defaults({
    retry: { enabled: false },
    throttle: { enabled: false },
    request: { fetch: github.createBoundedGitHubFetch() },
  });
  const githubApp = new GitHubApp({
    appId: githubConfig.appId,
    privateKey: githubConfig.privateKey,
    Octokit: PublisherOctokit,
  });
  const installationOctokit = await githubApp.getInstallationOctokit(
    githubConfig.installationId,
  );
  const githubRequest: import('./github/index.js').GitHubRequest = async (
    route,
    parameters,
    operationSignal,
  ) => {
    const requestParameters = github.withGitHubRequestLimits(parameters, operationSignal);
    const response = await installationOctokit.request(
      route as Parameters<typeof installationOctokit.request>[0],
      requestParameters as Parameters<typeof installationOctokit.request>[1],
    );
    return {
      data: response.data,
      status: response.status,
      headers: response.headers,
    };
  };
  const publisher = new github.GitHubProfilePublisher({
    request: githubRequest,
    owner: githubConfig.owner,
    repo: githubConfig.repo,
    defaultBranch: githubConfig.defaultBranch,
    validateWorkflow: githubConfig.validateWorkflow,
    deployWorkflow: githubConfig.deployWorkflow,
    stateStore: publishStateStore,
    onWarning: (message, error) => reportError(error, message),
  });
  const repositoryReader = new github.GitHubProfileReader({
    request: githubRequest,
    owner: githubConfig.owner,
    repo: githubConfig.repo,
    defaultBranch: githubConfig.defaultBranch,
  });

  return {
    publisher,
    repositoryReader,
    checkpointLookup: publishStateStore,
    close: () => publishStateStore.close(),
  };
}

function assertConnectedApplication(
  gateway: DiscordGatewayRuntime,
  expectedApplicationId: string,
) {
  if (!gateway.client.isReady()) {
    throw new Error('Discord login completed without a ready Gateway connection.');
  }

  const connectedApplicationId = gateway.client.application?.id ?? gateway.client.user?.id;

  if (connectedApplicationId !== expectedApplicationId) {
    throw new Error('The Discord Bot Token belongs to a different application.');
  }
}

function formatUserError(error: unknown) {
  if (
    error instanceof ProfileServiceError
    || error instanceof ProfilePhotoError
    || error instanceof DiscordAttachmentDownloadError
  ) {
    return error.message;
  }

  if (error instanceof SandboxProfileRepositoryError) {
    switch (error.code) {
      case 'invalid_input':
        return error.message;
      case 'content_conflict':
        return 'The sandbox profile changed elsewhere. Reopen `/profile` before trying again.';
      case 'storage_corrupt':
        return 'The saved sandbox profile needs owner repair before it can be changed.';
      default:
        return 'The sandbox profile could not be saved safely. Please try again.';
    }
  }

  switch (errorCode(error)) {
    case 'content_conflict':
      return 'The profile changed elsewhere. Reopen `/profile` before trying again.';
    case 'validation_failed':
    case 'unexpected_diff':
      return 'Repository validation rejected the profile update. No change was published.';
    case 'validation_timeout':
    case 'validation_workflow_not_found':
      return 'Repository validation did not finish. No change was published.';
    case 'main_conflict':
      return 'The website changed repeatedly during publication. Please try again.';
    case 'main_update_rejected':
      return 'GitHub did not allow the validated fast-forward update.';
    case 'publication_timeout':
      return 'GitHub reached the safe time limit. Reopen `/profile` so recovery can verify the result.';
    default:
      return 'No website changes were published. Please try again.';
  }
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function reportError(error: unknown, context = 'GRASP profile bot error') {
  const safe = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        ...(errorCode(error) ? { code: errorCode(error) } : {}),
      }
    : { message: String(error) };
  console.error(JSON.stringify({ level: 'error', context, error: safe }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
