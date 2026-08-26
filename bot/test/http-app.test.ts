import assert from 'node:assert/strict';
import test from 'node:test';

import { createHealthApp, type BotHealthSnapshot } from '../src/http-app.js';

test('health endpoint stays unavailable until the Gateway is ready', async () => {
  let snapshot: BotHealthSnapshot = {
    ready: false,
    gateway: 'starting',
    profileRecovery: 'running',
    publicationMode: 'sandbox',
  };
  const app = createHealthApp(() => snapshot);

  const starting = await app.request('/healthz');
  assert.equal(starting.status, 503);
  assert.deepEqual(await starting.json(), {
    status: 'starting',
    gateway: 'starting',
    profileRecovery: 'running',
    publicationMode: 'sandbox',
  });

  snapshot = {
    ...snapshot,
    ready: true,
    gateway: 'ready',
    profileRecovery: 'ready',
  };
  const ready = await app.request('/healthz');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: 'ok',
    gateway: 'ready',
    profileRecovery: 'ready',
    publicationMode: 'sandbox',
  });
});

test('health service exposes no Discord interaction route', async () => {
  const app = createHealthApp(() => ({
    ready: true,
    gateway: 'ready',
    profileRecovery: 'ready',
    publicationMode: 'production',
  }));

  const response = await app.request('/interactions', { method: 'POST' });
  assert.equal(response.status, 404);
});
