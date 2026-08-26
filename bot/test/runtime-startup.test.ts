import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createHealthApp } from '../src/http-app.js';
import {
  closeHttpServerWithin,
  finishPublicationQueueStartup,
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

test('publication readiness waits for the initial drain and rejects incomplete backlog', async () => {
  const gate = Promise.withResolvers<void>();
  let ready = false;
  const startup = finishPublicationQueueStartup({
    drain: () => gate.promise,
    countRemaining: () => 0,
    markReady: () => {
      ready = true;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  gate.resolve();
  await startup;
  assert.equal(ready, true);

  ready = false;
  await assert.rejects(
    finishPublicationQueueStartup({
      drain: async () => undefined,
      countRemaining: () => 1,
      markReady: () => {
        ready = true;
      },
    }),
    /left 1 unapplied or actively leased job/,
  );
  assert.equal(ready, false);
});

test('publication drain failure propagates without marking the service ready', async () => {
  let ready = false;
  await assert.rejects(
    finishPublicationQueueStartup({
      drain: async () => {
        throw new Error('apply failed');
      },
      countRemaining: () => 0,
      markReady: () => {
        ready = true;
      },
    }),
    /apply failed/,
  );
  assert.equal(ready, false);
});

test('publication startup waits for an unexpired lease instead of restart-looping', async () => {
  let remaining = 1;
  let drains = 0;
  const sleeps: number[] = [];
  let ready = false;

  await finishPublicationQueueStartup({
    drain: async () => {
      drains += 1;
      if (drains === 2) remaining = 0;
    },
    countRemaining: () => remaining,
    nextAttemptDelayMs: () => remaining ? 900_001 : undefined,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    markReady: () => {
      ready = true;
    },
  });

  assert.equal(drains, 2);
  assert.deepEqual(sleeps, [900_001]);
  assert.equal(ready, true);
});

test('publication startup retries a local drain error before becoming ready', async () => {
  let drains = 0;
  const errors: unknown[] = [];
  let ready = false;

  await finishPublicationQueueStartup({
    drain: async () => {
      drains += 1;
      if (drains === 1) throw new Error('temporary apply error');
    },
    countRemaining: () => drains === 1 ? 1 : 0,
    nextAttemptDelayMs: () => 30_000,
    sleep: async () => undefined,
    onAttemptError: (error) => errors.push(error),
    markReady: () => {
      ready = true;
    },
  });

  assert.equal(drains, 2);
  assert.equal(errors.length, 1);
  assert.equal(ready, true);
});

test('health server exposes the current readiness snapshot', async () => {
  let ready = false;
  const app = createHealthApp(() => ({
    ready,
    gateway: ready ? 'ready' : 'starting',
    profileRecovery: ready ? 'ready' : 'running',
    publicationMode: 'sandbox',
    publicationQueue: 'disabled',
    queuedPublications: 0,
    storage: 'ready',
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
