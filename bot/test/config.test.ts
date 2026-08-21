import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigurationError, loadConfig } from '../src/config.js';

const completeEnv = {
  DISCORD_APPLICATION_ID: 'application',
  DISCORD_PUBLIC_KEY: 'public-key',
  DISCORD_GUILD_ID: 'guild',
  DISCORD_OWNER_USER_ID: 'owner',
  GITHUB_APP_ID: '123',
  GITHUB_INSTALLATION_ID: '456',
  GITHUB_APP_PRIVATE_KEY: 'private-key',
};

test('loads deployment identifiers and safe defaults', () => {
  const config = loadConfig(completeEnv);

  assert.equal(config.port, 3000);
  assert.equal(config.github.appId, 123);
  assert.equal(config.github.installationId, 456);
  assert.equal(config.github.owner, 'grasp-kaist');
  assert.equal(config.membersPageUrl, 'https://grasp-kaist.github.io/members/');
});

test('fails closed when the GitHub installation is not configured', () => {
  const { GITHUB_INSTALLATION_ID: _omitted, ...missingInstallation } = completeEnv;
  assert.throws(
    () => loadConfig(missingInstallation),
    (error: unknown) =>
      error instanceof ConfigurationError && error.message === 'GITHUB_INSTALLATION_ID is required.',
  );
});
