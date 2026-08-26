import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Collection,
  Events,
  GatewayIntentBits,
  type Interaction,
} from 'discord.js';

import {
  acknowledgeGatewayInteraction,
  dispatchGatewayInteraction,
  toRouterInteraction,
} from '../src/discord/gateway-adapter.js';
import {
  createDiscordGatewayClient,
  DiscordGatewayRuntime,
} from '../src/discord/gateway.js';
import {
  attachDiscordGatewayHealthEvents,
  type DiscordGatewayHealthState,
} from '../src/discord/gateway-health.js';
import type {
  DiscordInteraction,
  InteractionRouteResult,
} from '../src/discord/types.js';

function fakeChatInputInteraction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'interaction-id',
    applicationId: 'application-id',
    type: 2,
    token: 'interaction-token',
    version: 1,
    user: { id: 'user-id' },
    guildId: 'guild-id',
    commandName: 'profile',
    commandType: 1,
    options: { data: [], resolved: null },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isMessageComponent: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    ...overrides,
  } as unknown as Interaction;
}

test('Gateway client requests only the Guilds intent', async () => {
  const client = createDiscordGatewayClient();

  assert.equal(client.options.intents.bitfield, GatewayIntentBits.Guilds);
  assert.deepEqual(client.options.intents.toArray(), ['Guilds']);
  await client.destroy();
});

test('Gateway adapter preserves command actor and option data for the existing router', () => {
  const converted = toRouterInteraction(
    fakeChatInputInteraction({
      commandName: 'register',
      options: {
        resolved: null,
        data: [{ name: 'category', type: 4, value: 2 }],
      },
    }),
  );

  assert.deepEqual(converted, {
    id: 'interaction-id',
    application_id: 'application-id',
    type: 2,
    token: 'interaction-token',
    version: 1,
    user: { id: 'user-id' },
    guild_id: 'guild-id',
    member: { user: { id: 'user-id' } },
    data: {
      name: 'register',
      type: 1,
      options: [{ name: 'category', type: 4, value: 2 }],
    },
  });
});

test('Gateway adapter preserves modal values and resolved file attachments', () => {
  const attachment = {
    id: 'attachment-id',
    name: 'portrait.png',
    size: 123,
    url: 'https://cdn.discordapp.com/portrait.png',
    proxyURL: 'https://media.discordapp.net/portrait.png',
    contentType: 'image/png',
    width: 640,
    height: 800,
    ephemeral: true,
  };
  const interaction = fakeChatInputInteraction({
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    customId: 'profile:edit',
    fields: {
      resolved: {
        attachments: new Collection([['attachment-id', attachment]]),
      },
      components: [
        {
          id: 1,
          component: { type: 4, id: 2, customId: 'name', value: 'Ada' },
        },
        {
          id: 3,
          component: {
            type: 19,
            id: 4,
            customId: 'photo',
            values: ['attachment-id'],
          },
        },
      ],
    },
    components: [
      {
        id: 1,
        component: { type: 4, id: 2, customId: 'name', value: 'Ada' },
      },
      {
        id: 3,
        component: {
          type: 19,
          id: 4,
          customId: 'photo',
          values: ['attachment-id'],
        },
      },
    ],
  });

  const converted = toRouterInteraction(interaction);

  assert.deepEqual(converted.data, {
    custom_id: 'profile:edit',
    components: [
      {
        type: 18,
        id: 1,
        component: { type: 4, id: 2, custom_id: 'name', value: 'Ada' },
      },
      {
        type: 18,
        id: 3,
        component: {
          type: 19,
          id: 4,
          custom_id: 'photo',
          values: ['attachment-id'],
        },
      },
    ],
    resolved: {
      attachments: {
        'attachment-id': {
          id: 'attachment-id',
          filename: 'portrait.png',
          size: 123,
          url: 'https://cdn.discordapp.com/portrait.png',
          proxy_url: 'https://media.discordapp.net/portrait.png',
          content_type: 'image/png',
          width: 640,
          height: 800,
          ephemeral: true,
        },
      },
    },
  });
});

test('Gateway ACK maps immediate messages and Discord mention fields', async () => {
  let replyOptions: unknown;
  const interaction = {
    isRepliable: () => true,
    reply: async (options: unknown) => {
      replyOptions = options;
    },
  } as unknown as Interaction;

  await acknowledgeGatewayInteraction(interaction, {
    type: 4,
    data: {
      content: 'hello',
      flags: 64,
      allowed_mentions: {
        parse: [],
        users: ['user-id'],
        replied_user: false,
      },
    },
  });

  assert.deepEqual(replyOptions, {
    content: 'hello',
    flags: 64,
    allowedMentions: {
      parse: [],
      users: ['user-id'],
      repliedUser: false,
    },
  });
});

test('Gateway ACK maps response types 5, 6, 7, 8, and 9', async () => {
  const calls: Array<[string, unknown?]> = [];

  await acknowledgeGatewayInteraction(
    {
      isRepliable: () => true,
      deferReply: async (options: unknown) => calls.push(['deferReply', options]),
    } as unknown as Interaction,
    { type: 5, data: { flags: 64 } },
  );
  await acknowledgeGatewayInteraction(
    {
      deferUpdate: async () => calls.push(['deferUpdate']),
    } as unknown as Interaction,
    { type: 6 },
  );
  const updatedComponents = [{ type: 17, components: [] }];
  await acknowledgeGatewayInteraction(
    {
      update: async (options: unknown) => calls.push(['update', options]),
    } as unknown as Interaction,
    {
      type: 7,
      data: {
        content: null,
        embeds: [],
        attachments: [],
        components: updatedComponents,
        flags: 32_768,
        allowed_mentions: { parse: [] },
      },
    },
  );
  await acknowledgeGatewayInteraction(
    {
      isAutocomplete: () => true,
      respond: async (choices: unknown) => calls.push(['respond', choices]),
    } as unknown as Interaction,
    {
      type: 8,
      data: { choices: [{ name: 'Member', value: 'member' }] },
    },
  );
  const modal = {
    title: 'Edit profile',
    custom_id: 'profile:edit',
    components: [],
  };
  await acknowledgeGatewayInteraction(
    {
      showModal: async (data: unknown) => calls.push(['showModal', data]),
    } as unknown as Interaction,
    { type: 9, data: modal },
  );

  assert.deepEqual(calls, [
    ['deferReply', { flags: 64 }],
    ['deferUpdate'],
    [
      'update',
      {
        content: null,
        embeds: [],
        attachments: [],
        components: updatedComponents,
        flags: 32_768,
        allowedMentions: { parse: [] },
      },
    ],
    ['respond', [{ name: 'Member', value: 'member' }]],
    ['showModal', modal],
  ]);
});

test('afterResponse runs only after a successful Gateway ACK', async () => {
  const order: string[] = [];
  const interaction = fakeChatInputInteraction({
    deferReply: async () => {
      order.push('ack');
    },
  });
  const router = {
    route: async (_interaction: DiscordInteraction): Promise<InteractionRouteResult> => ({
      response: { type: 5, data: { flags: 64 } },
      afterResponse: async () => {
        order.push('after');
      },
    }),
  };

  await dispatchGatewayInteraction(interaction, router);
  assert.deepEqual(order, ['ack', 'after']);

  let afterRan = false;
  const failedInteraction = fakeChatInputInteraction({
    deferReply: async () => {
      throw new Error('Discord rejected ACK');
    },
  });
  const failedRouter = {
    route: async (_interaction: DiscordInteraction): Promise<InteractionRouteResult> => ({
      response: { type: 5, data: { flags: 64 } },
      afterResponse: async () => {
        afterRan = true;
      },
    }),
  };

  await assert.rejects(
    dispatchGatewayInteraction(failedInteraction, failedRouter),
    /Discord rejected ACK/,
  );
  assert.equal(afterRan, false);
});

test('Gateway runtime syncs before login and destroys idempotently', async () => {
  const events: string[] = [];
  const client = createDiscordGatewayClient();
  let destroyCount = 0;
  const runtime = new DiscordGatewayRuntime({
    applicationId: 'application-id',
    botToken: 'bot-token',
    router: {
      route: async (): Promise<InteractionRouteResult> => ({ response: { type: 4 } }),
    },
    client,
    syncCommands: async () => {
      events.push('sync');
      return { changed: false, commandCount: 3 };
    },
    login: async () => {
      events.push('login');
    },
    fetchApplication: async () => {
      events.push('fetchApplication');
      return { interactionsEndpointURL: null };
    },
    destroyClient: async () => {
      destroyCount += 1;
    },
  });

  assert.deepEqual(await runtime.start(), { changed: false, commandCount: 3 });
  assert.deepEqual(await runtime.start(), { changed: false, commandCount: 3 });
  assert.deepEqual(events, ['sync', 'login', 'fetchApplication']);
  assert.equal(client.listenerCount(Events.InteractionCreate), 1);

  await Promise.all([runtime.destroy(), runtime.destroy()]);
  assert.equal(destroyCount, 1);
  assert.equal(client.listenerCount(Events.InteractionCreate), 0);
});

test('Gateway runtime removes its listener when login fails', async () => {
  const client = createDiscordGatewayClient();
  const runtime = new DiscordGatewayRuntime({
    applicationId: 'application-id',
    botToken: 'bot-token',
    router: {
      route: async (): Promise<InteractionRouteResult> => ({ response: { type: 4 } }),
    },
    client,
    syncCommands: async () => ({ changed: false, commandCount: 3 }),
    login: async () => {
      throw new Error('login failed');
    },
    fetchApplication: async () => ({ interactionsEndpointURL: null }),
    destroyClient: async () => undefined,
  });

  await assert.rejects(runtime.start(), /login failed/);
  assert.equal(client.listenerCount(Events.InteractionCreate), 0);
  await runtime.destroy();
});

test('Gateway runtime drains admitted interactions after its listener is stopped', async () => {
  const client = createDiscordGatewayClient();
  let releaseAfterResponse: (() => void) | undefined;
  const afterResponseGate = new Promise<void>((resolve) => {
    releaseAfterResponse = resolve;
  });
  const runtime = new DiscordGatewayRuntime({
    applicationId: 'application-id',
    botToken: 'bot-token',
    router: {
      route: async (): Promise<InteractionRouteResult> => ({
        response: { type: 5, data: { flags: 64 } },
        afterResponse: async () => afterResponseGate,
      }),
    },
    client,
    syncCommands: async () => ({ changed: false, commandCount: 3 }),
    login: async () => undefined,
    fetchApplication: async () => ({ interactionsEndpointURL: null }),
    destroyClient: async () => undefined,
  });
  await runtime.start();

  client.emit(
    Events.InteractionCreate,
    fakeChatInputInteraction({ deferReply: async () => undefined }),
  );
  await runtime.destroy();

  assert.equal(await runtime.waitForIdle(5), false);
  releaseAfterResponse?.();
  assert.equal(await runtime.waitForIdle(1_000), true);
});

test('Gateway runtime fails fast when an HTTP interactions endpoint is configured', async () => {
  const client = createDiscordGatewayClient();
  const runtime = new DiscordGatewayRuntime({
    applicationId: 'application-id',
    botToken: 'bot-token',
    router: {
      route: async (): Promise<InteractionRouteResult> => ({ response: { type: 4 } }),
    },
    client,
    syncCommands: async () => ({ changed: false, commandCount: 3 }),
    login: async () => undefined,
    fetchApplication: async () => ({
      interactionsEndpointURL: 'https://example.com/interactions',
    }),
    destroyClient: async () => undefined,
  });

  await assert.rejects(
    runtime.start(),
    /clear Interactions Endpoint URL, save changes, and restart the bot/,
  );
  assert.equal(client.listenerCount(Events.InteractionCreate), 0);
  await runtime.destroy();
});

test('Gateway health follows reconnect, resume, ready, and disconnect shard events', async () => {
  const client = createDiscordGatewayClient();
  const health: DiscordGatewayHealthState = {
    ready: false,
    gateway: 'starting',
  };
  let startupComplete = false;
  let serviceOperational = true;
  let shuttingDown = false;
  let fatalDisconnects = 0;
  const detach = attachDiscordGatewayHealthEvents({
    client,
    health,
    isStartupComplete: () => startupComplete,
    isServiceOperational: () => serviceOperational,
    isShuttingDown: () => shuttingDown,
    onUnrecoverableDisconnect: async () => {
      fatalDisconnects += 1;
      throw new Error('simulated shutdown callback failure');
    },
  });

  client.emit(Events.ShardReady, 0, undefined);
  assert.deepEqual(health, { ready: false, gateway: 'starting' });

  startupComplete = true;
  client.emit(Events.ShardReady, 0, undefined);
  assert.deepEqual(health, { ready: true, gateway: 'ready' });

  client.emit(Events.ShardReconnecting, 0);
  assert.deepEqual(health, { ready: false, gateway: 'reconnecting' });
  assert.equal(fatalDisconnects, 0);

  client.emit(Events.ShardResume, 0, 4);
  assert.deepEqual(health, { ready: true, gateway: 'ready' });

  serviceOperational = false;
  health.ready = false;
  client.emit(Events.ShardResume, 0, 5);
  assert.deepEqual(health, { ready: false, gateway: 'ready' });
  serviceOperational = true;

  client.emit(Events.ShardDisconnect, {} as CloseEvent, 0);
  assert.deepEqual(health, { ready: false, gateway: 'disconnected' });
  assert.equal(fatalDisconnects, 1);

  client.emit(Events.ShardDisconnect, {} as CloseEvent, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fatalDisconnects, 1);

  shuttingDown = true;
  client.emit(Events.ShardDisconnect, {} as CloseEvent, 0);
  client.emit(Events.ShardResume, 0, 0);
  assert.deepEqual(health, { ready: false, gateway: 'disconnected' });
  assert.equal(fatalDisconnects, 1);

  detach();
  assert.equal(client.listenerCount(Events.ShardReconnecting), 0);
  assert.equal(client.listenerCount(Events.ShardResume), 0);
  await client.destroy();
});
