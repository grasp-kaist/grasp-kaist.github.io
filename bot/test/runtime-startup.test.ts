import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createHealthApp } from '../src/http-app.js';
import {
  closeHttpServerWithin,
  startHealthServer,
  waitForPromiseWithin,
} from '../src/runtime-startup.js';

test('bounded promise waiting reports timeout without leaving a rejection unobserved', async () => {
  const gate = Promise.withResolvers<void>();
  assert.deepEqual(await waitForPromiseWithin(gate.promise, 5), { timedOut: true });
  gate.reject(new Error('late failure'));
  await new Promise((resolve) => setImmediate(resolve));

  const failed = await waitForPromiseWithin(Promise.reject(new Error('failure')), 100);
  assert.equal(failed.timedOut, false);
  assert.match(String(failed.error), /failure/);
});

test('health server exposes the current readiness snapshot', async () => {
  let ready = false;
  const app = createHealthApp(() => ({
    ready,
    gateway: ready ? 'ready' : 'starting',
    profileRecovery: ready ? 'ready' : 'running',
    publicationMode: 'sandbox',
  }));
  const server = startHealthServer({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
  });

  try {
    if (!server.listening) {
      await once(server, 'listening');
    }
    const address = server.address() as AddressInfo;
    const starting = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(starting.status, 503);

    ready = true;
    const healthy = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(healthy.status, 200);
  } finally {
    await closeHttpServerWithin(server, 100);
  }
});

test('HTTP shutdown force-closes a request that exceeds its close window', async () => {
  const requestStarted = Promise.withResolvers<void>();
  const releaseRequest = Promise.withResolvers<void>();
  const server = startHealthServer({
    fetch: async () => {
      requestStarted.resolve();
      await releaseRequest.promise;
      return new Response('late response');
    },
    hostname: '127.0.0.1',
    port: 0,
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
    await request?.catch(() => undefined);
    if (server.listening) {
      await closeHttpServerWithin(server, 100);
    }
  }
});
