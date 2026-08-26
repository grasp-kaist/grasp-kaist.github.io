import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type GitHubConfig = {
  appId: number;
  installationId: number;
  privateKey: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  validateWorkflow: string;
  deployWorkflow: string;
};

export type PublicationConfig =
  | {
      mode: 'sandbox';
      sandboxDirectory: string;
    }
  | {
      mode: 'production';
      productionGuildId: string;
      sandboxDirectory: string;
      github: GitHubConfig;
    };

export type AppConfig = {
  port: number;
  databasePath: string;
  membersPageUrl?: string;
  discord: {
    applicationId: string;
    botToken: string;
    ownerUserId: string;
  };
  publication: PublicationConfig;
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const publicationMode = parsePublicationMode(env.PROFILE_PUBLISH_MODE);
  const defaultDatabasePath = publicationMode === 'sandbox'
    ? './data/sandbox/grasp-profile-bot.sqlite'
    : './data/grasp-profile-bot.sqlite';
  const databasePath = resolve(env.DATABASE_PATH?.trim() || defaultDatabasePath);
  const publication = loadPublicationConfig(env, publicationMode, databasePath);

  return {
    port: parsePort(env.PORT),
    databasePath,
    ...(publication.mode === 'production'
      ? {
          membersPageUrl:
            env.MEMBERS_PAGE_URL?.trim() || 'https://grasp-kaist.github.io/members/',
        }
      : {}),
    discord: {
      applicationId: requireValue(env, 'DISCORD_APPLICATION_ID'),
      botToken: requireValue(env, 'DISCORD_BOT_TOKEN'),
      ownerUserId: requireValue(env, 'DISCORD_OWNER_USER_ID'),
    },
    publication,
  };
}

function loadPublicationConfig(
  env: NodeJS.ProcessEnv,
  mode: 'sandbox' | 'production',
  databasePath: string,
): PublicationConfig {
  const sandboxDirectory = resolve(
    env.SANDBOX_PROFILE_DIRECTORY?.trim() || join(dirname(databasePath), 'sandbox-profiles'),
  );

  if (mode === 'sandbox') {
    return {
      mode,
      sandboxDirectory,
    };
  }

  const productionGuildId = parseSnowflake(
    requireValue(env, 'PROFILE_PRODUCTION_GUILD_ID'),
    'PROFILE_PRODUCTION_GUILD_ID',
  );

  return {
    mode,
    productionGuildId,
    sandboxDirectory,
    github: {
      appId: parsePositiveInteger(requireValue(env, 'GITHUB_APP_ID'), 'GITHUB_APP_ID'),
      installationId: parsePositiveInteger(
        requireValue(env, 'GITHUB_INSTALLATION_ID'),
        'GITHUB_INSTALLATION_ID',
      ),
      privateKey: loadPrivateKey(env),
      owner: env.GITHUB_OWNER?.trim() || 'grasp-kaist',
      repo: env.GITHUB_REPO?.trim() || 'grasp-kaist.github.io',
      defaultBranch: env.GITHUB_DEFAULT_BRANCH?.trim() || 'main',
      validateWorkflow: env.GITHUB_VALIDATE_WORKFLOW?.trim() || 'validate-profile-bot.yml',
      deployWorkflow: env.GITHUB_DEPLOY_WORKFLOW?.trim() || 'deploy.yml',
    },
  };
}

function parseSnowflake(value: string, name: string) {
  if (!/^\d{17,20}$/.test(value)) {
    throw new ConfigurationError(`${name} must be a Discord snowflake.`);
  }

  return value;
}

function parsePublicationMode(value: string | undefined): 'sandbox' | 'production' {
  const mode = value?.trim().toLowerCase() || 'sandbox';

  if (mode !== 'sandbox' && mode !== 'production') {
    throw new ConfigurationError('PROFILE_PUBLISH_MODE must be sandbox or production.');
  }

  return mode;
}

function requireValue(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();

  if (!value) {
    throw new ConfigurationError(`${name} is required.`);
  }

  return value;
}

function parsePort(value: string | undefined) {
  if (!value?.trim()) {
    return 3000;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError('PORT must be an integer between 1 and 65535.');
  }

  return port;
}

function parsePositiveInteger(value: string, name: string) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer.`);
  }

  return parsed;
}

function loadPrivateKey(env: NodeJS.ProcessEnv) {
  const inline = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();

  if (inline) {
    return inline;
  }

  const configuredPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();

  if (!configuredPath) {
    throw new ConfigurationError(
      'GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required.',
    );
  }

  const privateKeyPath = resolve(configuredPath);

  if (!existsSync(privateKeyPath)) {
    throw new ConfigurationError(`GitHub App private key does not exist: ${privateKeyPath}`);
  }

  return readFileSync(privateKeyPath, 'utf8');
}
