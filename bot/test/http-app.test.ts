import assert from 'node:assert/strict';
import test from 'node:test';

import { createHealthApp, type BotHealthSnapshot } from '../src/http-app.js';

test('health endpoint stays unavailable until the Gateway is ready', async () => {
  let snapshot: BotHealthSnapshot = {
    ready: false,
    gateway: 'starting',
    profileRecovery: 'running',
    publicationMode: 'sandbox',
    publicationQueue: 'disabled',
    queuedPublications: 0,
    storage: 'ready',
  };
  const app = createHealthApp(() => snapshot);

  const starting = await app.request('/healthz');
  assert.equal(starting.status, 503);
  assert.deepEqual(await starting.json(), {
    status: 'starting',
    gateway: 'starting',
    profileRecovery: 'running',
    publicationMode: 'sandbox',
    publicationQueue: 'disabled',
    queuedPublications: 0,
    storage: 'ready',
  });

  snapshot = {
    ...snapshot,
    ready: true,
    gateway: 'ready',
    profileRecovery: 'ready',
    publicationQueue: 'disabled',
    queuedPublications: 0,
    storage: 'ready',
  };
  const ready = await app.request('/healthz');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    status: 'ok',
    gateway: 'ready',
    profileRecovery: 'ready',
    publicationMode: 'sandbox',
    publicationQueue: 'disabled',
    queuedPublications: 0,
    storage: 'ready',
  });
});

test('health service exposes no Discord interaction route', async () => {
  const app = createHealthApp(() => ({
    ready: true,
    gateway: 'ready',
    profileRecovery: 'ready',
    publicationMode: 'production',
    publicationQueue: 'ready',
    queuedPublications: 3,
    storage: 'ready',
  }));

  const response = await app.request('/interactions', { method: 'POST' });
  assert.equal(response.status, 404);
});
