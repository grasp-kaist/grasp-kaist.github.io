import assert from 'node:assert/strict';
import test from 'node:test';

import { createHttpApp, MAX_INTERACTION_BODY_BYTES } from '../src/http-app.js';
import type { DiscordHttpInteractionResult } from '../src/discord/http.js';

test('health endpoint is small and credential-free', async () => {
  const app = createFixture().app;
  const response = await app.request('/healthz');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('interaction adapter preserves raw bytes and signature headers', async () => {
  let handled: Parameters<FixtureHandler['handle']>[0] | undefined;
  let scheduled: DiscordHttpInteractionResult | undefined;
  const fixture = createFixture({
    handle: async (input) => {
      handled = input;
      return { status: 200, body: { type: 1 }, afterResponse: async () => undefined };
    },
    schedule: (result) => {
      scheduled = result;
    },
  });
  const body = '{"type":1,"unicode":"한글"}';
  const response = await fixture.app.request('/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': 'signature',
      'x-signature-timestamp': 'timestamp',
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.equal(new TextDecoder().decode(handled?.rawBody), body);
  assert.equal(handled?.signature, 'signature');
  assert.equal(handled?.timestamp, 'timestamp');
  assert.equal(scheduled?.afterResponse instanceof Function, true);
});

test('oversized Discord bodies are rejected before signature processing', async () => {
  let calls = 0;
  const fixture = createFixture({
    handle: async () => {
      calls += 1;
      return { status: 200, body: { type: 1 } };
    },
  });
  const response = await fixture.app.request('/interactions', {
    method: 'POST',
    headers: { 'content-length': String(MAX_INTERACTION_BODY_BYTES + 1) },
    body: '{}',
  });

  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

type FixtureHandler = {
  handle(input: {
    rawBody: Uint8Array;
    signature: string | undefined;
    timestamp: string | undefined;
  }): Promise<DiscordHttpInteractionResult>;
};

function createFixture(overrides: {
  handle?: FixtureHandler['handle'];
  schedule?: (result: DiscordHttpInteractionResult) => void;
} = {}) {
  const interactionHandler: FixtureHandler = {
    handle: overrides.handle ?? (async () => ({ status: 401, body: { error: 'invalid' } })),
  };
  return {
    app: createHttpApp({
      interactionHandler,
      scheduleAfterResponse: overrides.schedule ?? (() => undefined),
    }),
  };
}
