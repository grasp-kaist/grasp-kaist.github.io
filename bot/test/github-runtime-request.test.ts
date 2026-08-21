import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { App as GitHubApp, Octokit } from 'octokit';

import {
  createBoundedGitHubFetch,
  withGitHubRequestLimits,
} from '../src/github/runtime-request.js';

test('bounded GitHub fetch applies cancellation to authentication requests too', async () => {
  let capturedSignal: AbortSignal | undefined;
  const fetchImplementation = (async (_input, init) => {
    capturedSignal = init?.signal as AbortSignal | undefined;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const operation = new AbortController();
  const boundedFetch = createBoundedGitHubFetch(fetchImplementation, 60_000);

  await boundedFetch('https://api.github.test/app/installations/1/access_tokens', {
    method: 'POST',
    signal: operation.signal,
  });

  assert.ok(capturedSignal);
  assert.equal(capturedSignal.aborted, false);
  operation.abort(new Error('cancel authentication'));
  assert.equal(capturedSignal.aborted, true);
});

test('bounded GitHub fetch times out a request with no caller signal', async () => {
  const fetchImplementation = (async (_input, init) => {
    const signal = init?.signal as AbortSignal;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    throw new Error('unreachable');
  }) as typeof fetch;
  const boundedFetch = createBoundedGitHubFetch(fetchImplementation, 10);

  await assert.rejects(
    boundedFetch('https://api.github.test/user'),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
});

test('GitHub App installation-token mint uses the bounded fetch', async () => {
  const calls: Array<{ url: string; signal: AbortSignal }> = [];
  const fetchImplementation = (async (input, init) => {
    const url = String(input);
    calls.push({ url, signal: init?.signal as AbortSignal });
    const body = url.endsWith('/app/installations/123/access_tokens')
      ? {
          token: 'installation-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
          permissions: { contents: 'write' },
          repository_selection: 'selected',
        }
      : { object: { sha: 'a'.repeat(40) } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const BoundedOctokit = Octokit.defaults({
    retry: { enabled: false },
    throttle: { enabled: false },
    request: {
      fetch: createBoundedGitHubFetch(fetchImplementation, 60_000),
    },
  });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const app = new GitHubApp({ appId: 1, privateKey, Octokit: BoundedOctokit });
  const installation = await app.getInstallationOctokit(123);

  await installation.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
    owner: 'grasp-kaist',
    repo: 'grasp-kaist.github.io',
    ref: 'heads/main',
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/app\/installations\/123\/access_tokens$/);
  assert.match(calls[1]!.url, /\/repos\/grasp-kaist\/grasp-kaist\.github\.io\/git\/ref\/heads%2Fmain$/);
  assert.equal(calls.every((call) => call.signal instanceof AbortSignal), true);
});

test('runtime GitHub requests disable retries and combine operation cancellation', () => {
  const operation = new AbortController();
  const parameters = withGitHubRequestLimits(
    { request: { marker: 'preserved' } },
    operation.signal,
    60_000,
  );
  const request = parameters.request as Record<string, unknown>;
  const signal = request.signal as AbortSignal;

  assert.equal(request.marker, 'preserved');
  assert.equal(request.retries, 0);
  assert.equal(signal.aborted, false);

  operation.abort(new Error('operation deadline'));
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as Error).message, 'operation deadline');
});

test('runtime GitHub requests retain a per-request timeout without an operation signal', async () => {
  const parameters = withGitHubRequestLimits({}, undefined, 10);
  const signal = (parameters.request as Record<string, unknown>).signal as AbortSignal;

  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  assert.equal(signal.aborted, true);
});
