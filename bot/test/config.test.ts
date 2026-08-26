import assert from 'node:assert/strict';
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
  assert.match(config.databasePath, /data[\\/]sandbox[\\/]grasp-profile-bot\.sqlite$/);
  assert.equal(config.membersPageUrl, undefined);
  assert.match(
    config.publication.sandboxDirectory,
    /sandbox-profiles$/,
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
