import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitHubProfilePublisher,
  PROFILE_PUBLISH_REQUEST_TIMEOUT_MS,
  PROFILE_PUBLISH_TIMEOUT_MS,
  ProfilePublisherError,
  type GitHubRequest,
  type ProfilePublishInput,
  type PublishCheckpoint,
  type PublishStateStore,
} from '../src/github/profile-publisher.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const J = '1'.repeat(40);
const J2 = '2'.repeat(40);
const P = '3'.repeat(40);
const W = '4'.repeat(40);
const T0 = '5'.repeat(40);
const T1 = '6'.repeat(40);
const T2 = '7'.repeat(40);

type ScriptStep = {
  route: string;
  data?: unknown;
  error?: Error;
  inspect?: (parameters: Record<string, unknown>) => void;
};

class ScriptedGitHub {
  readonly calls: Array<{
    route: string;
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
  }> = [];
  readonly steps: ScriptStep[];

  constructor(steps: ScriptStep[]) {
    this.steps = [...steps];
  }

  readonly request: GitHubRequest = async (route, parameters, signal) => {
    this.calls.push({ route, parameters, ...(signal ? { signal } : {}) });
    const step = this.steps.shift();
    assert.ok(step, `Unexpected GitHub request: ${route}`);
    assert.equal(route, step.route);
    step.inspect?.(parameters);

    if (step.error) {
      throw step.error;
    }

    return { data: step.data ?? {} };
  };

  assertDone() {
    assert.deepEqual(this.steps.map((step) => step.route), []);
  }
}

class MemoryPublishStateStore implements PublishStateStore {
  readonly checkpoints = new Map<string, PublishCheckpoint>();
  readonly history: PublishCheckpoint[] = [];

  async load(operationId: string) {
    return this.checkpoints.get(operationId) ?? null;
  }

  async save(checkpoint: PublishCheckpoint) {
    this.checkpoints.set(checkpoint.operationId, checkpoint);
    this.history.push(checkpoint);
  }

  async clear(operationId: string) {
    this.checkpoints.delete(operationId);
  }
}

function profileJson(photo = '') {
  return `${JSON.stringify({
    listed: false,
    order: 4,
    name: 'Example Member',
    position: 'Undergraduate Student',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo,
  }, null, 2)}\n`;
}

function publishInput(overrides: Partial<ProfilePublishInput> = {}): ProfilePublishInput {
  return {
    operationId: 'operation-001',
    slug: 'example-member',
    action: 'PROFILE_UPDATE',
    profile: {
      json: profileJson(),
      expectedSha: J,
    },
    ...overrides,
  };
}

function refData(sha: string) {
  return { object: { sha } };
}

function commitData(treeSha: string) {
  return { tree: { sha: treeSha } };
}

function runData(input: {
  id: number;
  sha: string;
  branch: string;
  status?: string;
  conclusion?: string | null;
  url?: string;
}) {
  return {
    id: input.id,
    head_sha: input.sha,
    head_branch: input.branch,
    event: 'push',
    status: input.status ?? 'completed',
    conclusion: input.conclusion === undefined ? 'success' : input.conclusion,
    html_url: input.url ?? `https://github.test/actions/runs/${input.id}`,
  };
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function createPublisher(
  github: ScriptedGitHub,
  extra: Partial<ConstructorParameters<typeof GitHubProfilePublisher>[0]> = {},
) {
  let now = 0;
  return new GitHubProfilePublisher({
    request: github.request,
    owner: 'grasp-kaist',
    repo: 'grasp-kaist.github.io',
    pollIntervalMs: 1,
    workflowDiscoveryTimeoutMs: 5,
    validationTimeoutMs: 5,
    deployTimeoutMs: 5,
    pagesTimeoutMs: 5,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    now: () => now,
    ...extra,
  });
}

function validationSteps(branch: string, headSha: string, conclusion = 'success'): ScriptStep[] {
  const queued = runData({
    id: 10,
    sha: headSha,
    branch,
    status: 'queued',
    conclusion: null,
  });
  return [
    {
      route: 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
      data: { workflow_runs: [queued] },
      inspect: (parameters) => {
        assert.equal(parameters.workflow_id, 'validate-profile-bot.yml');
        assert.equal(parameters.head_sha, headSha);
        assert.equal(parameters.branch, branch);
      },
    },
    {
      route: 'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
      data: runData({ id: 10, sha: headSha, branch, conclusion }),
    },
  ];
}

function deploymentSteps(headSha: string): ScriptStep[] {
  return [
    {
      route: 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
      data: {
        workflow_runs: [runData({
          id: 20,
          sha: headSha,
          branch: 'main',
          status: 'queued',
          conclusion: null,
        })],
      },
      inspect: (parameters) => {
        assert.equal(parameters.workflow_id, 'deploy.yml');
        assert.equal(parameters.head_sha, headSha);
        assert.equal(parameters.branch, 'main');
      },
    },
    {
      route: 'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
      data: runData({ id: 20, sha: headSha, branch: 'main' }),
    },
    {
      route: 'GET /repos/{owner}/{repo}/pages/deployments/{pages_deployment_id}',
      error: httpError(404),
    },
    {
      route: 'GET /repos/{owner}/{repo}/pages/deployments/{pages_deployment_id}',
      data: { status: 'succeed' },
      inspect: (parameters) => assert.equal(parameters.pages_deployment_id, headSha),
    },
  ];
}

test('publishes a profile through validation, a non-force main update, and Pages', async () => {
  const branch = 'bot/profile/example-member/operation-001/a1';
  const store = new MemoryPublishStateStore();
  const github = new ScriptedGitHub([
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', data: commitData(T0) },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', data: { type: 'file', sha: J } },
    {
      route: 'POST /repos/{owner}/{repo}/git/blobs',
      data: { sha: P },
      inspect: (parameters) => {
        assert.equal(parameters.encoding, 'utf-8');
        assert.equal(parameters.content, profileJson());
      },
    },
    {
      route: 'POST /repos/{owner}/{repo}/git/trees',
      data: { sha: T1 },
      inspect: (parameters) => {
        assert.equal(parameters.base_tree, T0);
        assert.deepEqual(parameters.tree, [{
          path: 'src/data/members/example-member.json',
          mode: '100644',
          type: 'blob',
          sha: P,
        }]);
      },
    },
    { route: 'POST /repos/{owner}/{repo}/git/commits', data: { sha: C } },
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      data: {
        status: 'ahead',
        ahead_by: 1,
        total_commits: 1,
        files: [{ filename: 'src/data/members/example-member.json', status: 'modified' }],
      },
    },
    {
      route: 'POST /repos/{owner}/{repo}/git/refs',
      data: { ref: `refs/heads/${branch}` },
      inspect: (parameters) => {
        assert.equal(parameters.ref, `refs/heads/${branch}`);
        assert.equal(parameters.sha, C);
      },
    },
    ...validationSteps(branch, C),
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    {
      route: 'PATCH /repos/{owner}/{repo}/git/refs/{ref}',
      data: refData(C),
      inspect: (parameters) => {
        assert.equal(parameters.ref, 'heads/main');
        assert.equal(parameters.sha, C);
        assert.equal(parameters.force, false);
      },
    },
    {
      route: 'DELETE /repos/{owner}/{repo}/git/refs/{ref}',
      inspect: (parameters) => assert.equal(parameters.ref, `heads/${branch}`),
    },
    ...deploymentSteps(C),
  ]);
  const input = publishInput();
  const publisher = createPublisher(github, { stateStore: store });

  const result = await publisher.publish(input);

  assert.deepEqual(result, {
    status: 'deployed',
    attempts: 1,
    profileBlobSha: P,
    commitSha: C,
    pageStatus: 'succeed',
    workflowRunUrl: 'https://github.test/actions/runs/20',
  });
  github.assertDone();

  const cleanupCall = github.calls.find(
    (call) => call.route === 'DELETE /repos/{owner}/{repo}/git/refs/{ref}',
  );
  const operationCalls = github.calls.filter((call) => call !== cleanupCall);
  const operationSignal = operationCalls[0]?.signal;
  assert.ok(operationSignal, 'publisher requests must receive an operation signal');
  assert.equal(operationCalls.every((call) => call.signal === operationSignal), true);
  assert.ok(cleanupCall?.signal, 'temporary-ref cleanup must receive a signal');
  assert.notEqual(cleanupCall.signal, operationSignal, 'cleanup must use a fresh signal');

  const mainUpdated = store.history.find((checkpoint) => checkpoint.stage === 'main_updated');
  assert.ok(mainUpdated);
  store.checkpoints.set(input.operationId, mainUpdated);
  const resumeGitHub = new ScriptedGitHub(deploymentSteps(C));
  const resumed = await createPublisher(resumeGitHub, { stateStore: store }).publish(input);
  assert.deepEqual(resumed, result);
  resumeGitHub.assertDone();

  const noNetwork = new ScriptedGitHub([]);
  const replayed = await createPublisher(noNetwork, { stateStore: store }).publish(input);
  assert.deepEqual(replayed, result);
  noNetwork.assertDone();
});

test('rejects an optimistic profile conflict before creating Git objects', async () => {
  const github = new ScriptedGitHub([
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', data: commitData(T0) },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', data: { type: 'file', sha: J2 } },
  ]);

  await assert.rejects(
    createPublisher(github).publish(publishInput()),
    (error: unknown) => error instanceof ProfilePublisherError && error.code === 'content_conflict',
  );
  github.assertDone();
});

test('rejects unexpected compare paths before creating the validation branch', async () => {
  const github = new ScriptedGitHub([
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', data: commitData(T0) },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', data: { type: 'file', sha: J } },
    { route: 'POST /repos/{owner}/{repo}/git/blobs', data: { sha: P } },
    { route: 'POST /repos/{owner}/{repo}/git/trees', data: { sha: T1 } },
    { route: 'POST /repos/{owner}/{repo}/git/commits', data: { sha: C } },
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      data: {
        status: 'ahead',
        ahead_by: 1,
        total_commits: 1,
        files: [{ filename: 'README.md', status: 'modified' }],
      },
    },
  ]);

  await assert.rejects(
    createPublisher(github).publish(publishInput()),
    (error: unknown) => error instanceof ProfilePublisherError && error.code === 'unexpected_diff',
  );
  github.assertDone();
});

test('does not update main when remote validation fails and still deletes the temp branch', async () => {
  const branch = 'bot/profile/example-member/operation-001/a1';
  const github = new ScriptedGitHub([
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', data: commitData(T0) },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', data: { type: 'file', sha: J } },
    { route: 'POST /repos/{owner}/{repo}/git/blobs', data: { sha: P } },
    { route: 'POST /repos/{owner}/{repo}/git/trees', data: { sha: T1 } },
    { route: 'POST /repos/{owner}/{repo}/git/commits', data: { sha: C } },
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      data: {
        status: 'ahead',
        ahead_by: 1,
        total_commits: 1,
        files: [{ filename: 'src/data/members/example-member.json', status: 'modified' }],
      },
    },
    { route: 'POST /repos/{owner}/{repo}/git/refs', data: { ref: `refs/heads/${branch}` } },
    ...validationSteps(branch, C, 'failure'),
    { route: 'DELETE /repos/{owner}/{repo}/git/refs/{ref}' },
  ]);

  await assert.rejects(
    createPublisher(github).publish(publishInput()),
    (error: unknown) => error instanceof ProfilePublisherError && error.code === 'validation_failed',
  );
  assert.equal(
    github.calls.some((call) => call.route === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}'),
    false,
  );
  github.assertDone();
});

test('publication timeout aborts polling, cleans up separately, and never continues to main', async () => {
  const calls: Array<{ route: string; signal?: AbortSignal }> = [];
  let operationSignal: AbortSignal | undefined;
  let pollSignal: AbortSignal | undefined;
  let cleanupSignal: AbortSignal | undefined;
  const request: GitHubRequest = async (route, _parameters, signal) => {
    calls.push({ route, ...(signal ? { signal } : {}) });

    if (route === 'DELETE /repos/{owner}/{repo}/git/refs/{ref}') {
      cleanupSignal = signal;
      return { data: {} };
    }

    operationSignal ??= signal;
    assert.equal(signal, operationSignal);

    switch (route) {
      case 'GET /repos/{owner}/{repo}/git/ref/{ref}':
        return { data: refData(A) };
      case 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}':
        return { data: commitData(T0) };
      case 'GET /repos/{owner}/{repo}/contents/{path}':
        return { data: { type: 'file', sha: J } };
      case 'POST /repos/{owner}/{repo}/git/blobs':
        return { data: { sha: P } };
      case 'POST /repos/{owner}/{repo}/git/trees':
        return { data: { sha: T1 } };
      case 'POST /repos/{owner}/{repo}/git/commits':
        return { data: { sha: C } };
      case 'GET /repos/{owner}/{repo}/compare/{basehead}':
        return {
          data: {
            status: 'ahead',
            ahead_by: 1,
            total_commits: 1,
            files: [{ filename: 'src/data/members/example-member.json', status: 'modified' }],
          },
        };
      case 'POST /repos/{owner}/{repo}/git/refs':
        return { data: {} };
      case 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs':
        return { data: { workflow_runs: [] } };
      default:
        throw new Error(`Unexpected GitHub request: ${route}`);
    }
  };
  const publisher = new GitHubProfilePublisher({
    request,
    owner: 'grasp-kaist',
    repo: 'grasp-kaist.github.io',
    pollIntervalMs: 60_000,
    workflowDiscoveryTimeoutMs: 120_000,
    publishTimeoutMs: 30,
    sleep: async (_milliseconds, signal) => {
      pollSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }

        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });

  await assert.rejects(
    publisher.publish(publishInput()),
    (error: unknown) =>
      error instanceof ProfilePublisherError
      && error.code === 'publication_timeout',
  );

  assert.ok(operationSignal);
  assert.equal(pollSignal, operationSignal, 'poll sleep must receive the operation signal');
  assert.ok(cleanupSignal);
  assert.notEqual(cleanupSignal, operationSignal, 'cleanup after timeout must use a fresh signal');
  assert.equal(cleanupSignal.aborted, false);
  assert.equal(
    calls.some((call) => call.route === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}'),
    false,
  );

  const callCountAtRejection = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.length, callCountAtRejection, 'no GitHub work may continue after rejection');
});

test('timeout after main update records a completed deploy failure with the published commit', async () => {
  const branch = 'bot/profile/example-member/operation-001/a1';
  const store = new MemoryPublishStateStore();
  const github = new ScriptedGitHub([
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', data: commitData(T0) },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', data: { type: 'file', sha: J } },
    { route: 'POST /repos/{owner}/{repo}/git/blobs', data: { sha: P } },
    { route: 'POST /repos/{owner}/{repo}/git/trees', data: { sha: T1 } },
    { route: 'POST /repos/{owner}/{repo}/git/commits', data: { sha: C } },
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      data: {
        status: 'ahead',
        ahead_by: 1,
        total_commits: 1,
        files: [{ filename: 'src/data/members/example-member.json', status: 'modified' }],
      },
    },
    { route: 'POST /repos/{owner}/{repo}/git/refs', data: {} },
    ...validationSteps(branch, C),
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'PATCH /repos/{owner}/{repo}/git/refs/{ref}', data: refData(C) },
    { route: 'DELETE /repos/{owner}/{repo}/git/refs/{ref}', data: {} },
    {
      route: 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
      data: { workflow_runs: [] },
    },
  ]);
  const publisher = createPublisher(github, {
    stateStore: store,
    workflowDiscoveryTimeoutMs: 120_000,
    publishTimeoutMs: 30,
    sleep: async (_milliseconds, signal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }

        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });

  const result = await publisher.publish(publishInput());

  assert.equal(result.status, 'published_deploy_failed');
  assert.equal(result.commitSha, C);
  assert.match(result.failure ?? '', /exceeded its safety deadline/);
  assert.deepEqual(store.history.map((checkpoint) => checkpoint.stage), [
    'main_updated',
    'completed',
  ]);
  const completed = store.history[1];
  assert.equal(completed?.stage, 'completed');
  if (completed?.stage === 'completed') {
    assert.deepEqual(completed.result, result);
  }
  github.assertDone();
});

test('rebases and revalidates when main moves without changing the target blob', async () => {
  const branch1 = 'bot/profile/example-member/operation-001/a1';
  const branch2 = 'bot/profile/example-member/operation-001/a2';
  const github = new ScriptedGitHub([
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', data: commitData(T0) },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', data: { type: 'file', sha: J } },
    { route: 'POST /repos/{owner}/{repo}/git/blobs', data: { sha: P } },
    { route: 'POST /repos/{owner}/{repo}/git/trees', data: { sha: T1 } },
    { route: 'POST /repos/{owner}/{repo}/git/commits', data: { sha: C } },
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      data: {
        status: 'ahead', ahead_by: 1, total_commits: 1,
        files: [{ filename: 'src/data/members/example-member.json', status: 'modified' }],
      },
    },
    { route: 'POST /repos/{owner}/{repo}/git/refs', data: {} },
    ...validationSteps(branch1, C),
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(B) },
    { route: 'DELETE /repos/{owner}/{repo}/git/refs/{ref}' },

    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(B) },
    { route: 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', data: commitData(T1) },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', data: { type: 'file', sha: J } },
    { route: 'POST /repos/{owner}/{repo}/git/blobs', data: { sha: P } },
    {
      route: 'POST /repos/{owner}/{repo}/git/trees',
      data: { sha: T2 },
      inspect: (parameters) => assert.equal(parameters.base_tree, T1),
    },
    {
      route: 'POST /repos/{owner}/{repo}/git/commits',
      data: { sha: D },
      inspect: (parameters) => assert.deepEqual(parameters.parents, [B]),
    },
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      data: {
        status: 'ahead', ahead_by: 1, total_commits: 1,
        files: [{ filename: 'src/data/members/example-member.json', status: 'modified' }],
      },
    },
    { route: 'POST /repos/{owner}/{repo}/git/refs', data: {} },
    ...validationSteps(branch2, D),
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(B) },
    {
      route: 'PATCH /repos/{owner}/{repo}/git/refs/{ref}',
      data: refData(D),
      inspect: (parameters) => assert.equal(parameters.force, false),
    },
    { route: 'DELETE /repos/{owner}/{repo}/git/refs/{ref}' },
    ...deploymentSteps(D),
  ]);

  const result = await createPublisher(github).publish(publishInput());
  assert.equal(result.status, 'deployed');
  assert.equal(result.attempts, 2);
  assert.equal(result.commitSha, D);
  github.assertDone();
});

test('writes only the slug WebP and uses base64 for a photo replacement', async () => {
  const branch = 'bot/profile/example-member/photo-operation/a1';
  const photoBytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46]);
  const input = publishInput({
    operationId: 'photo-operation',
    action: 'PROFILE_REPLACE_PHOTO',
    profile: { json: profileJson('example-member.webp'), expectedSha: J },
    photo: { kind: 'upsert', bytes: photoBytes, expectedSha: null },
  });
  const github = new ScriptedGitHub([
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}', data: commitData(T0) },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', data: { type: 'file', sha: J } },
    { route: 'GET /repos/{owner}/{repo}/contents/{path}', error: httpError(404) },
    { route: 'POST /repos/{owner}/{repo}/git/blobs', data: { sha: P } },
    {
      route: 'POST /repos/{owner}/{repo}/git/blobs',
      data: { sha: W },
      inspect: (parameters) => {
        assert.equal(parameters.encoding, 'base64');
        assert.equal(parameters.content, Buffer.from(photoBytes).toString('base64'));
      },
    },
    {
      route: 'POST /repos/{owner}/{repo}/git/trees',
      data: { sha: T1 },
      inspect: (parameters) => assert.deepEqual(parameters.tree, [
        {
          path: 'src/data/members/example-member.json', mode: '100644', type: 'blob', sha: P,
        },
        {
          path: 'src/data/members/example-member.webp', mode: '100644', type: 'blob', sha: W,
        },
      ]),
    },
    { route: 'POST /repos/{owner}/{repo}/git/commits', data: { sha: C } },
    {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      data: {
        status: 'ahead', ahead_by: 1, total_commits: 1,
        files: [
          { filename: 'src/data/members/example-member.json', status: 'modified' },
          { filename: 'src/data/members/example-member.webp', status: 'added' },
        ],
      },
    },
    { route: 'POST /repos/{owner}/{repo}/git/refs', data: {} },
    ...validationSteps(branch, C),
    { route: 'GET /repos/{owner}/{repo}/git/ref/{ref}', data: refData(A) },
    { route: 'PATCH /repos/{owner}/{repo}/git/refs/{ref}', data: refData(C) },
    { route: 'DELETE /repos/{owner}/{repo}/git/refs/{ref}' },
    ...deploymentSteps(C),
  ]);

  const result = await createPublisher(github).publish(input);
  assert.equal(result.photoBlobSha, W);
  assert.equal(result.status, 'deployed');
  github.assertDone();
});

test('rejects unsafe slugs before making any GitHub request', async () => {
  const github = new ScriptedGitHub([]);
  await assert.rejects(
    createPublisher(github).publish(publishInput({ slug: '../someone-else' })),
    (error: unknown) => error instanceof ProfilePublisherError && error.code === 'invalid_input',
  );
  github.assertDone();
});

test('caps automatic main-conflict retries to preserve the Discord response window', () => {
  const github = new ScriptedGitHub([]);

  assert.throws(
    () => createPublisher(github, { maxConflictAttempts: 3 }),
    (error: unknown) =>
      error instanceof ProfilePublisherError
      && error.code === 'invalid_input'
      && /cannot exceed 2/.test(error.message),
  );
  github.assertDone();
});

test('default publication time limits reserve Discord webhook-edit headroom', () => {
  const github = new ScriptedGitHub([]);
  const publisher = new GitHubProfilePublisher({
    request: github.request,
    owner: 'grasp-kaist',
    repo: 'grasp-kaist.github.io',
  });

  assert.equal(PROFILE_PUBLISH_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(publisher.options.workflowDiscoveryTimeoutMs, 10_000);
  assert.equal(publisher.options.validationTimeoutMs, 120_000);
  assert.equal(publisher.options.deployTimeoutMs, 150_000);
  assert.equal(publisher.options.pagesTimeoutMs, 30_000);
  assert.equal(publisher.options.publishTimeoutMs, PROFILE_PUBLISH_TIMEOUT_MS);
  assert.equal(PROFILE_PUBLISH_TIMEOUT_MS, 810_000);
  assert.equal(publisher.options.maxConflictAttempts, 2);
  github.assertDone();
});
