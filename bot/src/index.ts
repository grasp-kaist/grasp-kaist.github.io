import { App as GitHubApp, Octokit } from 'octokit';

import { loadConfig } from './config.js';
import {
  DiscordAttachmentDownloadError,
  DiscordCdnAttachmentDownloader,
  DiscordInteractionHttpHandler,
  DiscordInteractionRouter,
  DiscordInteractionWebhookClient,
  type DiscordHttpInteractionResult,
} from './discord/index.js';
import {
  GitHubProfilePublisher,
  GitHubProfileReader,
  ProfilePublisherError,
  SqlitePublishStateStore,
  type GitHubRequest,
  createBoundedGitHubFetch,
  withGitHubRequestLimits,
} from './github/index.js';
import { createHttpApp } from './http-app.js';
import { ProfilePhotoError } from './image/process-profile-photo.js';
import {
  closeHttpServerWithin,
  startHttpBeforeRecovery,
  startOnNextTurn,
} from './runtime-startup.js';
import { ProfileService, ProfileServiceError } from './service/profile-service.js';
import { SqliteStore } from './storage/sqlite-store.js';

const config = loadConfig();
const store = new SqliteStore(config.databasePath);
const stagedRecovery = store.recoverInterruptedStagedPhotos();
const publishStateStore = new SqlitePublishStateStore(config.databasePath);
const PublisherOctokit = Octokit.defaults({
  retry: { enabled: false },
  throttle: { enabled: false },
  request: { fetch: createBoundedGitHubFetch() },
});
const githubApp = new GitHubApp({
  appId: config.github.appId,
  privateKey: config.github.privateKey,
  Octokit: PublisherOctokit,
});
const installationOctokit = await githubApp.getInstallationOctokit(
  config.github.installationId,
);
const githubRequest: GitHubRequest = async (route, parameters, operationSignal) => {
  const requestParameters = withGitHubRequestLimits(parameters, operationSignal);
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
const publisher = new GitHubProfilePublisher({
  request: githubRequest,
  owner: config.github.owner,
  repo: config.github.repo,
  defaultBranch: config.github.defaultBranch,
  validateWorkflow: config.github.validateWorkflow,
  deployWorkflow: config.github.deployWorkflow,
  stateStore: publishStateStore,
  onWarning: (message, error) => reportError(error, message),
});
const repositoryReader = new GitHubProfileReader({
  request: githubRequest,
  owner: config.github.owner,
  repo: config.github.repo,
  defaultBranch: config.github.defaultBranch,
});
const profileService = new ProfileService({
  store,
  publisher,
  repositoryReader,
  checkpointLookup: publishStateStore,
  guildId: config.discord.guildId,
  ownerUserId: config.discord.ownerUserId,
  membersPageUrl: config.membersPageUrl,
});
const router = new DiscordInteractionRouter({
  config: {
    applicationId: config.discord.applicationId,
    guildId: config.discord.guildId,
    ownerUserId: config.discord.ownerUserId,
  },
  service: profileService,
  webhook: new DiscordInteractionWebhookClient(config.discord.applicationId),
  attachmentDownloader: new DiscordCdnAttachmentDownloader(),
  formatError: formatUserError,
  reportError,
});
const interactionHandler = new DiscordInteractionHttpHandler(
  config.discord.publicKey,
  router,
);
const inFlightTasks = new Set<Promise<void>>();
const app = createHttpApp({
  interactionHandler,
  scheduleAfterResponse: scheduleAfterResponseTask,
});
const { server, recovery: startupRecovery } = startHttpBeforeRecovery({
  fetch: app.fetch,
  port: config.port,
  recover: reconcileProfilesAtStartup,
});
const stagedPhotoCleanupTimer = setInterval(() => {
  store.deleteExpiredStagedPhotos();
}, 60_000);
stagedPhotoCleanupTimer.unref();

process.stdout.write(`GRASP profile bot listening on port ${config.port}.\n`);
if (stagedRecovery.recovered > 0 || stagedRecovery.expired > 0) {
  process.stdout.write(
    `Recovered ${stagedRecovery.recovered} staged photo(s); removed ${stagedRecovery.expired} expired photo(s).\n`,
  );
}

let shuttingDown = false;
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

trackInFlight(startupRecovery, 'Startup profile reconciliation failed', true);

function scheduleAfterResponseTask(result: DiscordHttpInteractionResult) {
  if (!result.afterResponse) {
    return;
  }

  trackInFlight(
    startOnNextTurn(result.afterResponse),
    'Deferred Discord operation failed',
  );
}

function trackInFlight(task: Promise<void>, context: string, fatal = false) {
  const tracked = task
    .catch((error) => {
      reportError(error, context);
      if (fatal) {
        setImmediate(() => void shutdown(context, 1));
      }
    })
    .finally(() => inFlightTasks.delete(tracked));
  inFlightTasks.add(tracked);
}

async function reconcileProfilesAtStartup() {
  const reconciliation = await profileService.reconcileKnownProfiles();

  for (const issue of reconciliation.issues) {
    reportError(
      new Error(issue.message),
      `Profile reconciliation failed for ${issue.profileSlug}`,
    );
  }

  process.stdout.write(
    `Startup profile recovery complete: ${reconciliation.reconciled} reconciled, ${reconciliation.released} released, ${reconciliation.issues.length} issue(s).\n`,
  );
}

async function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(stagedPhotoCleanupTimer);
  const deadline = Date.now() + 25_000;
  process.stdout.write(`Stopping new HTTP requests (${reason}).\n`);
  const closeResult = await closeHttpServerWithin(server, 5_000);
  if (closeResult.error) {
    reportError(closeResult.error, 'HTTP server shutdown failed');
  }
  if (closeResult.timedOut) {
    reportError(
      new Error('Active HTTP connections exceeded the 5 second close window and were terminated.'),
      'HTTP server shutdown deadline expired',
    );
  }

  while (inFlightTasks.size > 0 && Date.now() < deadline) {
    await Promise.race([
      ...inFlightTasks,
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
  }

  if (inFlightTasks.size > 0) {
    reportError(
      new Error(`${inFlightTasks.size} deferred operation(s) were still running.`),
      'Graceful shutdown deadline expired',
    );
    process.exit(1);
  }

  publishStateStore.close();
  store.close();
  process.exit(exitCode);
}

function formatUserError(error: unknown) {
  if (
    error instanceof ProfileServiceError
    || error instanceof ProfilePhotoError
    || error instanceof DiscordAttachmentDownloadError
  ) {
    return error.message;
  }

  if (error instanceof ProfilePublisherError) {
    switch (error.code) {
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
        return 'GitHub could not safely publish this profile operation.';
    }
  }

  return 'No website changes were published. Please try again.';
}

function reportError(error: unknown, context = 'GRASP profile bot error') {
  const safe = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
      }
    : { message: String(error) };
  console.error(JSON.stringify({ level: 'error', context, error: safe }));
}
