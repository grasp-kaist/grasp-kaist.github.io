import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigurationError, loadConfig } from '../src/config.js';

const completeEnv = {
  DISCORD_APPLICATION_ID: 'application',
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_GUILD_ID: 'guild',
  DISCORD_OWNER_USER_ID: 'owner',
};

const productionEnv = {
  ...completeEnv,
  PROFILE_PUBLISH_MODE: 'production',
  PROFILE_PRODUCTION_GUILD_ID: 'guild',
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
    config.publication.mode === 'sandbox' ? config.publication.directory : '',
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
});

test('fails closed when the production guild does not match', () => {
  assert.throws(
    () => loadConfig({ ...productionEnv, PROFILE_PRODUCTION_GUILD_ID: 'different-guild' }),
    (error: unknown) =>
      error instanceof ConfigurationError
      && error.message
        === 'DISCORD_GUILD_ID must match PROFILE_PRODUCTION_GUILD_ID in production mode.',
  );
});

test('fails closed when the Gateway bot token is not configured', () => {
  const { DISCORD_BOT_TOKEN: _omitted, ...missingToken } = completeEnv;
  assert.throws(
    () => loadConfig(missingToken),
    (error: unknown) =>
      error instanceof ConfigurationError && error.message === 'DISCORD_BOT_TOKEN is required.',
  );
});
