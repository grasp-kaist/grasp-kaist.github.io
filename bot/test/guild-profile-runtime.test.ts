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
const USER_ID = '666666666666666666';

test('production mode routes the current guild through the GitHub publisher', async () => {
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
    sandboxDirectory: directory,
    production: {
      publisher: productionPublisher,
      repositoryReader: { readProfile: async () => null },
      membersPageUrl: 'https://example.test/members/',
    },
  });

  try {
    const runtime = registry.resolve(PRODUCTION_GUILD);

    assert.equal(runtime.publicationMode, 'production');
    assert.equal(registry.resolve(PRODUCTION_GUILD), runtime);

    const registration = await runtime.service.register(
      actor(PRODUCTION_GUILD, 'register'),
      member(),
    );
    assert.equal(registration.snapshot?.profileSlug, 'example-member');
    assert.equal(productionCalls.length, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sandbox mode keeps the current guild in its local repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grasp-guild-isolation-'));
  const store = new SqliteStore(':memory:');
  const registry = new GuildProfileRuntimeRegistry({
    store,
    sandboxDirectory: directory,
  });

  try {
    const registration = await registry.resolve(SANDBOX_GUILD).service.register(
      actor(SANDBOX_GUILD, 'register'),
      member(),
    );

    assert.equal(registration.snapshot?.profileSlug, 'example-member');
    assert.deepEqual(store.listGuildIds(), [SANDBOX_GUILD]);
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
