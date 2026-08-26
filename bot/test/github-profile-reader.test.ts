import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitHubProfileReader,
  GitHubProfileReaderError,
} from '../src/github/profile-reader.js';
import type { GitHubRequest } from '../src/github/profile-publisher.js';

const MAIN = 'a'.repeat(40);
const PROFILE = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);

function canonicalProfile(photo = '') {
  return {
    listed: false,
    order: 4,
    name: 'Recovered Member',
    position: 'Undergraduate Student',
    details: [],
    researchInterests: [],
    contact: [],
    website: '',
    photo,
  };
}

test('reads and proves a canonical bot profile from main without downloading photo bytes', async () => {
  const routes: string[] = [];
  const request: GitHubRequest = async (route, parameters) => {
    routes.push(route);

    if (route.includes('/git/ref/')) {
      return { data: { object: { sha: MAIN } } };
    }

    if (route.endsWith('/contents/{path}')) {
      assert.equal(parameters.ref, MAIN);

      if (parameters.path === 'src/data/members/recovered-member.json') {
        return {
          data: {
            type: 'file',
            sha: PROFILE,
            encoding: 'base64',
            content: Buffer.from(JSON.stringify(canonicalProfile('recovered-member.webp'))).toString(
              'base64',
            ),
          },
        };
      }

      return {
        data: {
          type: 'file',
          sha: 'd'.repeat(40),
          encoding: 'base64',
          content: 'not-used',
        },
      };
    }

    assert.equal(route, 'GET /repos/{owner}/{repo}/commits');
    return {
      data: [
        {
          sha: COMMIT,
          commit: { message: 'Profile: profile create recovered-member\n\nProfile-Operation: op-123' },
        },
      ],
    };
  };
  const reader = new GitHubProfileReader({ request, owner: 'owner', repo: 'repo' });

  const result = await reader.readProfile('recovered-member');

  assert.equal(result?.profileBlobSha, PROFILE);
  assert.equal(result?.photoBlobSha, 'd'.repeat(40));
  assert.equal(result?.commitSha, COMMIT);
  assert.equal(result?.operationId, 'op-123');
  assert.equal(routes.filter((route) => route.endsWith('/contents/{path}')).length, 2);
});

test('selects the operation trailer for this slug from a batch commit', async () => {
  const request: GitHubRequest = async (route) => {
    if (route.includes('/git/ref/')) {
      return { data: { object: { sha: MAIN } } };
    }

    if (route.endsWith('/contents/{path}')) {
      return {
        data: {
          type: 'file',
          sha: PROFILE,
          encoding: 'base64',
          content: Buffer.from(JSON.stringify(canonicalProfile())).toString('base64'),
        },
      };
    }

    assert.equal(route, 'GET /repos/{owner}/{repo}/commits');
    return {
      data: [{
        sha: COMMIT,
        commit: {
          message: [
            'Profiles: publish 2 profile updates',
            '',
            'Profile-Operation: another-member another-operation',
            'Profile-Operation: recovered-member recovered-operation',
          ].join('\n'),
        },
      }],
    };
  };
  const reader = new GitHubProfileReader({ request, owner: 'owner', repo: 'repo' });

  const result = await reader.readProfile('recovered-member');

  assert.equal(result?.operationId, 'recovered-operation');
});

test('does not use a legacy trailer when a batch commit lacks this slug', async () => {
  const request: GitHubRequest = async (route) => {
    if (route.includes('/git/ref/')) {
      return { data: { object: { sha: MAIN } } };
    }

    if (route.endsWith('/contents/{path}')) {
      return {
        data: {
          type: 'file',
          sha: PROFILE,
          encoding: 'base64',
          content: Buffer.from(JSON.stringify(canonicalProfile())).toString('base64'),
        },
      };
    }

    return {
      data: [{
        sha: COMMIT,
        commit: {
          message: [
            'Profiles: publish profile updates',
            '',
            'Profile-Operation: another-member another-operation',
            'Profile-Operation: legacy-operation',
          ].join('\n'),
        },
      }],
    };
  };
  const reader = new GitHubProfileReader({ request, owner: 'owner', repo: 'repo' });

  const result = await reader.readProfile('recovered-member');

  assert.equal(result?.operationId, undefined);
});

test('rejects a bot binding whose profile points at another member photo', async () => {
  const request: GitHubRequest = async (route) => {
    if (route.includes('/git/ref/')) {
      return { data: { object: { sha: MAIN } } };
    }

    return {
      data: {
        type: 'file',
        sha: PROFILE,
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(canonicalProfile('someone-else.webp'))).toString('base64'),
      },
    };
  };
  const reader = new GitHubProfileReader({ request, owner: 'owner', repo: 'repo' });

  await assert.rejects(
    () => reader.readProfile('recovered-member'),
    GitHubProfileReaderError,
  );
});

test('uses a newer photo-only commit for recovery operation and deployment status', async () => {
  const photoCommit = 'd'.repeat(40);
  const request: GitHubRequest = async (route, parameters) => {
    if (route.includes('/git/ref/')) {
      return { data: { object: { sha: MAIN } } };
    }

    if (route.endsWith('/contents/{path}')) {
      const isPhoto = String(parameters.path).endsWith('.webp');
      return {
        data: {
          type: 'file',
          sha: isPhoto ? 'e'.repeat(40) : PROFILE,
          encoding: 'base64',
          content: isPhoto
            ? 'not-used'
            : Buffer.from(JSON.stringify(canonicalProfile('recovered-member.webp'))).toString(
                'base64',
              ),
        },
      };
    }

    if (route === 'GET /repos/{owner}/{repo}/commits') {
      assert.equal(parameters.sha, MAIN);
      const isPhoto = String(parameters.path).endsWith('.webp');
      return {
        data: [
          {
            sha: isPhoto ? photoCommit : COMMIT,
            commit: {
              message: `Profile update\n\nProfile-Operation: ${isPhoto ? 'photo-op' : 'json-op'}`,
            },
          },
        ],
      };
    }

    assert.equal(route, 'GET /repos/{owner}/{repo}/compare/{basehead}');
    return { data: { status: 'ahead' } };
  };
  const reader = new GitHubProfileReader({ request, owner: 'owner', repo: 'repo' });

  const result = await reader.readProfile('recovered-member');
  assert.equal(result?.commitSha, photoCommit);
  assert.equal(result?.operationId, 'photo-op');
});

test('pins path history queries to the captured main commit when the branch moves', async () => {
  const futureCommit = 'f'.repeat(40);
  const request: GitHubRequest = async (route, parameters) => {
    if (route.includes('/git/ref/')) {
      return { data: { object: { sha: MAIN } } };
    }

    if (route.endsWith('/contents/{path}')) {
      assert.equal(parameters.ref, MAIN);
      return {
        data: {
          type: 'file',
          sha: PROFILE,
          encoding: 'base64',
          content: Buffer.from(JSON.stringify(canonicalProfile())).toString('base64'),
        },
      };
    }

    assert.equal(route, 'GET /repos/{owner}/{repo}/commits');
    return parameters.sha === MAIN
      ? {
          data: [
            {
              sha: COMMIT,
              commit: { message: 'Snapshot update\n\nProfile-Operation: snapshot-op' },
            },
          ],
        }
      : {
          data: [
            {
              sha: futureCommit,
              commit: { message: 'Future update\n\nProfile-Operation: future-op' },
            },
          ],
        };
  };
  const reader = new GitHubProfileReader({ request, owner: 'owner', repo: 'repo' });

  const result = await reader.readProfile('recovered-member');

  assert.equal(result?.commitSha, COMMIT);
  assert.equal(result?.operationId, 'snapshot-op');
});
