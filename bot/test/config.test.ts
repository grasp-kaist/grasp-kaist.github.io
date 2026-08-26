import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { ConfigurationError, loadConfig } from '../src/config.js';

const completeEnv = {
  DISCORD_APPLICATION_ID: 'application',
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_OWNER_USER_ID: 'owner',
};

const productionEnv = {
  ...completeEnv,
  PROFILE_PUBLISH_MODE: 'production',
  PROFILE_PRODUCTION_GUILD_ID: '222222222222222222',
  GITHUB_APP_ID: '123',
  GITHUB_INSTALLATION_ID: '456',
  GITHUB_APP_PRIVATE_KEY: 'private-key',
};

test('defaults to sandbox publication without GitHub credentials', () => {
  const config = loadConfig(completeEnv);

  assert.equal(config.port, 3000);
  assert.equal(config.publication.mode, 'sandbox');
  assert.equal(config.storage.persistentRequired, false);
  assert.match(config.storage.backupDirectory, /data[\\/]sandbox[\\/]backups$/);
  assert.match(config.databasePath, /data[\\/]sandbox[\\/]grasp-profile-bot\.sqlite$/);
  assert.equal(config.membersPageUrl, undefined);
  assert.match(
    config.publication.sandboxDirectory,
    /sandbox-profiles$/,
  );
});

test('fails closed in a production container when no Railway volume is attached', () => {
  assert.throws(
    () => loadConfig({
      ...completeEnv,
      NODE_ENV: 'production',
      PROFILE_REQUIRE_PERSISTENT_STORAGE: 'false',
    }),
    (error: unknown) =>
      error instanceof ConfigurationError
      && error.message.includes('RAILWAY_VOLUME_MOUNT_PATH'),
  );
});

test('keeps all durable paths inside the attached Railway volume', () => {
  const volume = resolve('test-railway-volume');
  const config = loadConfig({
    ...completeEnv,
    NODE_ENV: 'production',
    RAILWAY_VOLUME_MOUNT_PATH: volume,
    PROFILE_STORAGE_ID: '8e99c82b-441b-4ce0-a763-cfe01340f39b',
    DATABASE_PATH: join(volume, 'state', 'profiles.sqlite'),
    SANDBOX_PROFILE_DIRECTORY: join(volume, 'sandbox-profiles'),
  });

  assert.equal(config.storage.persistentRequired, true);
  assert.equal(config.storage.volumeMountPath, volume);
  assert.equal(config.storage.backupDirectory, join(volume, 'backups'));
  assert.throws(
    () => loadConfig({
      ...completeEnv,
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: volume,
      PROFILE_STORAGE_ID: '8e99c82b-441b-4ce0-a763-cfe01340f39b',
      DATABASE_PATH: resolve('ephemeral', 'profiles.sqlite'),
    }),
    (error: unknown) =>
      error instanceof ConfigurationError
      && error.message === 'DATABASE_PATH must be inside RAILWAY_VOLUME_MOUNT_PATH.',
  );
});

test('requires one stable storage identity for an attached volume', () => {
  const volume = resolve('test-railway-volume');

  assert.throws(
    () => loadConfig({
      ...completeEnv,
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: volume,
    }),
    (error: unknown) =>
      error instanceof ConfigurationError
      && error.message === 'PROFILE_STORAGE_ID is required when a persistent volume is attached.',
  );
  assert.throws(
    () => loadConfig({
      ...completeEnv,
      NODE_ENV: 'production',
      RAILWAY_VOLUME_MOUNT_PATH: volume,
      PROFILE_STORAGE_ID: 'not-a-uuid',
    }),
    (error: unknown) =>
      error instanceof ConfigurationError
      && error.message === 'PROFILE_STORAGE_ID must be a UUID.',
  );
  assert.throws(
    () => loadConfig({
      ...completeEnv,
      PROFILE_ADOPT_EXISTING_STORAGE: 'true',
    }),
    (error: unknown) =>
      error instanceof ConfigurationError
      && error.message === 'Storage initialization requires RAILWAY_VOLUME_MOUNT_PATH.',
  );
});

test('loads production GitHub identifiers only for the configured production guild', () => {
  const config = loadConfig(productionEnv);

  assert.equal(config.publication.mode, 'production');
  assert.equal(config.publication.mode === 'production' ? config.publication.github.appId : 0, 123);
  assert.equal(
    config.publication.mode === 'production' ? config.publication.github.installationId : 0,
    456,
  );
  assert.equal(
    config.publication.mode === 'production' ? config.publication.github.owner : '',
    'grasp-kaist',
  );
  assert.equal(config.membersPageUrl, 'https://grasp-kaist.github.io/members/');
  assert.equal(
    config.publication.mode === 'production' ? config.publication.productionGuildId : '',
    '222222222222222222',
  );
});

test('fails closed when the production guild is missing or invalid', () => {
  const { PROFILE_PRODUCTION_GUILD_ID: _omitted, ...missingGuild } = productionEnv;
  assert.throws(
    () => loadConfig(missingGuild),
    (error: unknown) =>
      error instanceof ConfigurationError
      && error.message === 'PROFILE_PRODUCTION_GUILD_ID is required.',
  );
  assert.throws(
    () => loadConfig({ ...productionEnv, PROFILE_PRODUCTION_GUILD_ID: 'not-a-guild' }),
    (error: unknown) =>
      error instanceof ConfigurationError
      && error.message === 'PROFILE_PRODUCTION_GUILD_ID must be a Discord snowflake.',
  );
});

test('a legacy DISCORD_GUILD_ID cannot restrict routing', () => {
  const config = loadConfig({ ...completeEnv, DISCORD_GUILD_ID: '999999999999999999' });

  assert.equal('guildId' in config.discord, false);
  assert.equal(config.publication.mode, 'sandbox');
});

test('fails closed when the Gateway bot token is not configured', () => {
  const { DISCORD_BOT_TOKEN: _omitted, ...missingToken } = completeEnv;
  assert.throws(
    () => loadConfig(missingToken),
    (error: unknown) =>
      error instanceof ConfigurationError && error.message === 'DISCORD_BOT_TOKEN is required.',
  );
});
