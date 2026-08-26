import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GuildProfileRuntimeRegistry } from '../src/service/guild-profile-runtime.js';
import type {
  ProfilePublishInput,
  ProfilePublishResult,
} from '../src/service/profile-service.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

const PRODUCTION_GUILD = '222222222222222222';
const SANDBOX_GUILD = '333333333333333333';
const SECOND_SANDBOX_GUILD = '444444444444444444';
const OWNER_ID = '555555555555555555';
const USER_ID = '666666666666666666';

test('only the configured production guild receives the GitHub publisher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grasp-guild-runtime-'));
  const store = new SqliteStore(':memory:');
  const productionCalls: ProfilePublishInput[] = [];
  const productionPublisher = {
    publish: async (input: ProfilePublishInput): Promise<ProfilePublishResult> => {
      productionCalls.push(input);
      return {
        status: 'deployed',
        profileBlobSha: `profile-${productionCalls.length}`,
        attempts: 1,
        commitSha: `commit-${productionCalls.length}`,
      };
    },
  };
  const registry = new GuildProfileRuntimeRegistry({
    store,
    ownerUserId: OWNER_ID,
    sandboxDirectory: directory,
    production: {
      guildId: PRODUCTION_GUILD,
      publisher: productionPublisher,
      repositoryReader: { readProfile: async () => null },
      membersPageUrl: 'https://example.test/members/',
    },
  });

  try {
    const sandbox = registry.resolve(SANDBOX_GUILD);
    const production = registry.resolve(PRODUCTION_GUILD);

    assert.equal(sandbox.publicationMode, 'sandbox');
    assert.equal(production.publicationMode, 'production');
    assert.equal(registry.resolve(SANDBOX_GUILD), sandbox);

    await sandbox.service.register(actor(SANDBOX_GUILD, 'sandbox-register'), member());
    assert.equal(productionCalls.length, 0);
    await production.service.register(actor(PRODUCTION_GUILD, 'production-register'), member());
    assert.equal(productionCalls.length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the same user and slug are isolated between sandbox guilds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grasp-guild-isolation-'));
  const store = new SqliteStore(':memory:');
  const registry = new GuildProfileRuntimeRegistry({
    store,
    ownerUserId: OWNER_ID,
    sandboxDirectory: directory,
  });

  try {
    const first = await registry.resolve(SANDBOX_GUILD).service.register(
      actor(SANDBOX_GUILD, 'first-register'),
      member(),
    );
    const second = await registry.resolve(SECOND_SANDBOX_GUILD).service.register(
      actor(SECOND_SANDBOX_GUILD, 'second-register'),
      member(),
    );

    assert.equal(first.snapshot?.profileSlug, 'example-member');
    assert.equal(second.snapshot?.profileSlug, 'example-member');
    assert.deepEqual(store.listGuildIds(), [SANDBOX_GUILD, SECOND_SANDBOX_GUILD]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function actor(guildId: string, interactionId: string) {
  return { guildId, interactionId, userId: USER_ID };
}

function member() {
  return {
    name: 'Example Member',
    position: 'Undergraduate Student',
    order: 4 as const,
  };
}
