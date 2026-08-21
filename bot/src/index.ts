import { serve } from '@hono/node-server';
import { App as GitHubApp } from 'octokit';

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
  PROFILE_PUBLISH_REQUEST_TIMEOUT_MS,
  ProfilePublisherError,
  SqlitePublishStateStore,
  type GitHubRequest,
} from './github/index.js';
import { createHttpApp } from './http-app.js';
import { ProfilePhotoError } from './image/process-profile-photo.js';
import { ProfileService, ProfileServiceError } from './service/profile-service.js';
import { SqliteStore } from './storage/sqlite-store.js';

const config = loadConfig();
const store = new SqliteStore(config.databasePath);
const stagedRecovery = store.recoverInterruptedStagedPhotos();
const publishStateStore = new SqlitePublishStateStore(config.databasePath);
const githubApp = new GitHubApp({
  appId: config.github.appId,
  privateKey: config.github.privateKey,
});
const installationOctokit = await githubApp.getInstallationOctokit(
  config.github.installationId,
);
const githubRequest: GitHubRequest = async (route, parameters) => {
  const requestParameters = {
    ...parameters,
    request: { signal: AbortSignal.timeout(PROFILE_PUBLISH_REQUEST_TIMEOUT_MS) },
  };
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
const reconciliation = await profileService.reconcileKnownProfiles();

for (const issue of reconciliation.issues) {
  reportError(
    new Error(issue.message),
    `Profile reconciliation failed for ${issue.profileSlug}`,
  );
}
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
const server = serve({ fetch: app.fetch, port: config.port });
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

function scheduleAfterResponseTask(result: DiscordHttpInteractionResult) {
  if (!result.afterResponse) {
    return;
  }

  setImmediate(() => {
    const task = result.afterResponse!()
      .catch((error) => reportError(error, 'Deferred Discord operation failed'))
      .finally(() => inFlightTasks.delete(task));
    inFlightTasks.add(task);
  });
}

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(stagedPhotoCleanupTimer);
  process.stdout.write(`Received ${signal}; stopping new HTTP requests.\n`);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }).catch((error) => reportError(error, 'HTTP server shutdown failed'));

  const deadline = Date.now() + 25_000;

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
  process.exit(0);
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
