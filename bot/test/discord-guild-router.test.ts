import assert from 'node:assert/strict';
import test from 'node:test';

import { DiscordGuildRouter } from '../src/discord/guild-router.js';
import type { DiscordInteraction } from '../src/discord/types.js';

const APPLICATION_ID = '111111111111111111';
const FIRST_GUILD = '222222222222222222';
const SECOND_GUILD = '333333333333333333';

test('routes every installed guild to its own cached inner router', async () => {
  const created: string[] = [];
  const routed: string[] = [];
  const router = new DiscordGuildRouter({
    applicationId: APPLICATION_ID,
    createRouter: (guildId) => {
      created.push(guildId);
      return {
        route: async () => {
          routed.push(guildId);
          return { response: { type: 4, data: { content: guildId } } };
        },
      };
    },
  });

  await router.route(interaction(FIRST_GUILD));
  await router.route(interaction(SECOND_GUILD));
  await router.route(interaction(FIRST_GUILD));

  assert.deepEqual(created, [FIRST_GUILD, SECOND_GUILD]);
  assert.deepEqual(routed, [FIRST_GUILD, SECOND_GUILD, FIRST_GUILD]);
});

test('rejects DMs and wrong applications without creating a guild runtime', async () => {
  let created = 0;
  const router = new DiscordGuildRouter({
    applicationId: APPLICATION_ID,
    createRouter: () => {
      created += 1;
      return { route: async () => ({ response: { type: 4 } }) };
    },
  });

  const dm = await router.route({ ...interaction(FIRST_GUILD), guild_id: undefined });
  const wrongApplication = await router.route({
    ...interaction(FIRST_GUILD),
    application_id: '999999999999999999',
  });

  assert.equal(dm.response.type, 4);
  assert.match(JSON.stringify(dm.response.data?.components), /Discord server/);
  assert.equal(wrongApplication.response.type, 4);
  assert.equal(created, 0);
});

test('answers a Discord ping without creating a guild runtime', async () => {
  let created = 0;
  const router = new DiscordGuildRouter({
    applicationId: APPLICATION_ID,
    createRouter: () => {
      created += 1;
      return { route: async () => ({ response: { type: 4 } }) };
    },
  });

  const result = await router.route({ ...interaction(FIRST_GUILD), type: 1 });

  assert.equal(result.response.type, 1);
  assert.equal(created, 0);
});

function interaction(guildId: string): DiscordInteraction {
  return {
    id: '444444444444444444',
    application_id: APPLICATION_ID,
    type: 2,
    token: 'token',
    guild_id: guildId,
    member: { user: { id: '555555555555555555' } },
    data: { name: 'profile' },
  };
}
