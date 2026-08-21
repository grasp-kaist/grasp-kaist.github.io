import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createHttpApp } from '../src/http-app.js';
import {
  closeHttpServerWithin,
  startHttpBeforeRecovery,
  startOnNextTurn,
} from '../src/runtime-startup.js';

test('deferred work is represented by a promise before it starts', async () => {
  let started = false;
  const task = startOnNextTurn(async () => {
    started = true;
  });

  assert.equal(started, false);
  await task;
  assert.equal(started, true);
});

test('health is available while startup repository recovery is still pending', async () => {
  const gate = Promise.withResolvers<void>();
  let recoveryStarted = false;
  const app = createHttpApp({
    interactionHandler: {
      handle: async () => ({ status: 200, body: { type: 1 } }),
    },
    scheduleAfterResponse: () => undefined,
  });
  const { server, recovery } = startHttpBeforeRecovery({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
    recover: async () => {
      recoveryStarted = true;
      await gate.promise;
    },
  });

  try {
    if (!server.listening) {
      await once(server, 'listening');
    }
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);

    assert.equal(recoveryStarted, true);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    gate.resolve();
    await recovery;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('HTTP shutdown force-closes a request that exceeds its close window', async () => {
  const requestStarted = Promise.withResolvers<void>();
  const releaseRequest = Promise.withResolvers<void>();
  const { server, recovery } = startHttpBeforeRecovery({
    fetch: async () => {
      requestStarted.resolve();
      await releaseRequest.promise;
      return new Response('late response');
    },
    hostname: '127.0.0.1',
    port: 0,
    recover: async () => undefined,
  });
  let request: Promise<Response> | undefined;

  try {
    if (!server.listening) {
      await once(server, 'listening');
    }
    const address = server.address() as AddressInfo;
    request = fetch(`http://127.0.0.1:${address.port}/slow`);
    await requestStarted.promise;

    const result = await closeHttpServerWithin(server, 25);

    assert.equal(result.timedOut, true);
    await assert.rejects(request);
  } finally {
    releaseRequest.resolve();
    await recovery;
    await request?.catch(() => undefined);
    if (server.listening) {
      await closeHttpServerWithin(server, 100);
    }
  }
});
