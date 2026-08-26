import { existsSync, readFileSync } from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative as pathRelative,
  resolve,
  sep as pathSeparator,
} from 'node:path';

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
      sandboxDirectory: string;
      github: GitHubConfig;
    };

export type AppConfig = {
  port: number;
  databasePath: string;
  membersPageUrl?: string;
  storage: {
    persistentRequired: boolean;
    volumeMountPath?: string;
    expectedStorageId?: string;
    initializeStorage: boolean;
    adoptExistingStorage: boolean;
    backupDirectory: string;
    backupIntervalMs: number;
    backupRetentionCount: number;
  };
  discord: {
    applicationId: string;
    botToken: string;
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
  const storage = loadStorageConfig(env, databasePath, publication.sandboxDirectory);

  return {
    port: parsePort(env.PORT),
    databasePath,
    ...(publication.mode === 'production'
      ? {
          membersPageUrl:
            env.MEMBERS_PAGE_URL?.trim() || 'https://grasp-kaist.github.io/members/',
        }
      : {}),
    storage,
    discord: {
      applicationId: requireValue(env, 'DISCORD_APPLICATION_ID'),
      botToken: requireValue(env, 'DISCORD_BOT_TOKEN'),
    },
    publication,
  };
}

function loadStorageConfig(
  env: NodeJS.ProcessEnv,
  databasePath: string,
  sandboxDirectory: string,
): AppConfig['storage'] {
  const explicitlyRequired = parseBoolean(
    env.PROFILE_REQUIRE_PERSISTENT_STORAGE,
    false,
    'PROFILE_REQUIRE_PERSISTENT_STORAGE',
  );
  const persistentRequired = env.NODE_ENV?.trim().toLowerCase() === 'production'
    || explicitlyRequired;
  const configuredMount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  const volumeMountPath = configuredMount ? resolve(configuredMount) : undefined;
  const expectedStorageId = env.PROFILE_STORAGE_ID?.trim().toLowerCase();
  const initializeStorage = parseBoolean(
    env.PROFILE_INITIALIZE_STORAGE,
    false,
    'PROFILE_INITIALIZE_STORAGE',
  );
  const adoptExistingStorage = parseBoolean(
    env.PROFILE_ADOPT_EXISTING_STORAGE,
    false,
    'PROFILE_ADOPT_EXISTING_STORAGE',
  );

  if (persistentRequired && !volumeMountPath) {
    throw new ConfigurationError(
      'Persistent storage is required, but Railway did not provide RAILWAY_VOLUME_MOUNT_PATH. Attach a volume before starting the bot.',
    );
  }

  if (volumeMountPath && !expectedStorageId) {
    throw new ConfigurationError(
      'PROFILE_STORAGE_ID is required when a persistent volume is attached.',
    );
  }
  if (expectedStorageId && !isUuid(expectedStorageId)) {
    throw new ConfigurationError('PROFILE_STORAGE_ID must be a UUID.');
  }
  if ((initializeStorage || adoptExistingStorage) && !volumeMountPath) {
    throw new ConfigurationError(
      'Storage initialization requires RAILWAY_VOLUME_MOUNT_PATH.',
    );
  }
  if (adoptExistingStorage && !initializeStorage) {
    throw new ConfigurationError(
      'PROFILE_ADOPT_EXISTING_STORAGE requires PROFILE_INITIALIZE_STORAGE=true.',
    );
  }

  if (volumeMountPath) {
    assertPathInsideVolume(databasePath, volumeMountPath, 'DATABASE_PATH');
    assertPathInsideVolume(sandboxDirectory, volumeMountPath, 'SANDBOX_PROFILE_DIRECTORY');
  }

  const backupDirectory = resolve(
    env.PROFILE_BACKUP_DIRECTORY?.trim()
      || join(volumeMountPath ?? dirname(databasePath), 'backups'),
  );

  if (volumeMountPath) {
    assertPathInsideVolume(backupDirectory, volumeMountPath, 'PROFILE_BACKUP_DIRECTORY');
  }

  return {
    persistentRequired,
    ...(volumeMountPath ? { volumeMountPath } : {}),
    ...(expectedStorageId ? { expectedStorageId } : {}),
    initializeStorage,
    adoptExistingStorage,
    backupDirectory,
    backupIntervalMs: parsePositiveIntegerWithDefault(
      env.PROFILE_BACKUP_INTERVAL_MS,
      6 * 60 * 60 * 1_000,
      'PROFILE_BACKUP_INTERVAL_MS',
    ),
    backupRetentionCount: parsePositiveIntegerWithDefault(
      env.PROFILE_BACKUP_RETENTION_COUNT,
      28,
      'PROFILE_BACKUP_RETENTION_COUNT',
    ),
  };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function assertPathInsideVolume(path: string, volumeMountPath: string, name: string) {
  const relative = pathRelative(volumeMountPath, path);

  if (!relative || relative === '..' || relative.startsWith(`..${pathSeparator}`) || isAbsolute(relative)) {
    throw new ConfigurationError(`${name} must be inside RAILWAY_VOLUME_MOUNT_PATH.`);
  }
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

  return {
    mode,
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

function parsePositiveIntegerWithDefault(
  value: string | undefined,
  defaultValue: number,
  name: string,
) {
  return value?.trim() ? parsePositiveInteger(value, name) : defaultValue;
}

function parseBoolean(value: string | undefined, defaultValue: boolean, name: string) {
  if (!value?.trim()) {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
      return true;
    case '0':
    case 'false':
    case 'no':
      return false;
    default:
      throw new ConfigurationError(`${name} must be true or false.`);
  }
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
