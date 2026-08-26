import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandSchemasEqual,
  globalGuildCommands,
  syncGlobalCommandsIfChanged,
  type DiscordCommandRest,
} from '../src/discord/command-sync.js';

test('global command schema is limited to guild installations and guild contexts', () => {
  assert.ok(globalGuildCommands.length > 0);

  for (const command of globalGuildCommands) {
    assert.deepEqual(command.integration_types, [0]);
    assert.deepEqual(command.contexts, [0]);
  }
});

test('command comparison ignores generated fields and top-level command order', () => {
  const deployed = structuredClone(globalGuildCommands)
    .reverse()
    .map((command, index) => ({
      ...command,
      id: `command-${index}`,
      application_id: 'application-id',
      version: `version-${index}`,
      dm_permission: false,
    }));

  assert.equal(commandSchemasEqual(deployed), true);
});

test('startup command sync skips PUT when the deployed schema matches', async () => {
  const puts: unknown[] = [];
  const rest: DiscordCommandRest = {
    get: async () => structuredClone(globalGuildCommands),
    put: async (...args) => {
      puts.push(args);
    },
  };

  const result = await syncGlobalCommandsIfChanged({
    applicationId: 'application-id',
    botToken: 'bot-token',
    rest,
  });

  assert.deepEqual(result, {
    changed: false,
    commandCount: globalGuildCommands.length,
  });
  assert.deepEqual(puts, []);
});

test('startup command sync bulk-overwrites global commands only on a schema change', async () => {
  const puts: Array<{ route: string; body: unknown }> = [];
  const deployed = structuredClone(globalGuildCommands);
  const first = deployed[0];
  assert.ok(first);
  first.description = 'stale description';

  const rest: DiscordCommandRest = {
    get: async () => deployed,
    put: async (route, options) => {
      puts.push({ route, body: options.body });
    },
  };

  const result = await syncGlobalCommandsIfChanged({
    applicationId: 'application-id',
    botToken: 'bot-token',
    rest,
  });

  assert.deepEqual(result, {
    changed: true,
    commandCount: globalGuildCommands.length,
  });
  assert.equal(puts.length, 1);
  assert.equal(puts[0]?.route, '/applications/application-id/commands');
  assert.deepEqual(puts[0]?.body, globalGuildCommands);
});
