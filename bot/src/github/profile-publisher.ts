import { createHash } from 'node:crypto';

import { assertMemberProfile, type MemberProfile } from '../domain/member-profile.js';

const API_VERSION = '2026-03-10';
const PROFILE_DIRECTORY = 'src/data/members';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const PROFILE_PUBLISH_REQUEST_TIMEOUT_MS = 10_000;

export type GitHubResponse = {
  data: unknown;
  status?: number;
  headers?: Record<string, string | number | undefined>;
};

export type GitHubRequest = (
  route: string,
  parameters: Record<string, unknown>,
) => Promise<GitHubResponse>;

export type ProfilePublishAction =
  | 'PROFILE_CREATE'
  | 'PROFILE_UPDATE'
  | 'PROFILE_REPLACE_PHOTO'
  | 'PROFILE_REMOVE_PHOTO'
  | 'PROFILE_SET_LISTED';

export type PhotoPublishMutation =
  | {
      kind: 'upsert';
      bytes: Uint8Array;
      expectedSha: string | null;
    }
  | {
      kind: 'delete';
      expectedSha: string;
    };

export type ProfilePublishInput = {
  operationId: string;
  slug: string;
  action: ProfilePublishAction;
  profile: {
    json: string;
    expectedSha: string | null;
  };
  photo?: PhotoPublishMutation;
};

export type PublishResult = {
  status: 'deployed' | 'no_change' | 'published_deploy_failed';
  attempts: number;
  profileBlobSha: string;
  photoBlobSha?: string;
  commitSha?: string;
  workflowRunUrl?: string;
  pageStatus?: string;
  failure?: string;
};

export type PublishCheckpoint =
  | {
      version: 1;
      stage: 'main_updated';
      operationId: string;
      fingerprint: string;
      slug: string;
      commitSha: string;
      attempts: number;
      profileBlobSha: string;
      photoBlobSha?: string;
    }
  | {
      version: 1;
      stage: 'completed';
      operationId: string;
      fingerprint: string;
      slug: string;
      result: PublishResult;
    };

export interface PublishStateStore {
  load(operationId: string): Promise<PublishCheckpoint | null>;
  save(checkpoint: PublishCheckpoint): Promise<void>;
  clear(operationId: string): Promise<void>;
}

export type PublisherErrorCode =
  | 'invalid_input'
  | 'content_conflict'
  | 'unexpected_diff'
  | 'validation_workflow_not_found'
  | 'validation_failed'
  | 'validation_timeout'
  | 'main_conflict'
  | 'main_update_rejected'
  | 'deploy_workflow_not_found'
  | 'deploy_failed'
  | 'deploy_timeout'
  | 'pages_timeout'
  | 'github_response_invalid';

export class ProfilePublisherError extends Error {
  readonly code: PublisherErrorCode;

  constructor(code: PublisherErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProfilePublisherError';
    this.code = code;
  }
}

export type GitHubProfilePublisherOptions = {
  request: GitHubRequest;
  owner: string;
  repo: string;
  defaultBranch?: string;
  validateWorkflow?: string;
  deployWorkflow?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  workflowDiscoveryTimeoutMs?: number;
  validationTimeoutMs?: number;
  deployTimeoutMs?: number;
  pagesTimeoutMs?: number;
  maxConflictAttempts?: number;
  stateStore?: PublishStateStore;
  onWarning?: (message: string, error: unknown) => void;
};

type NormalizedOptions = {
  request: GitHubRequest;
  owner: string;
  repo: string;
  defaultBranch: string;
  validateWorkflow: string;
  deployWorkflow: string;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  workflowDiscoveryTimeoutMs: number;
  validationTimeoutMs: number;
  deployTimeoutMs: number;
  pagesTimeoutMs: number;
  maxConflictAttempts: number;
  stateStore?: PublishStateStore;
  onWarning: (message: string, error: unknown) => void;
};

type PreparedInput = ProfilePublishInput & {
  parsedProfile: MemberProfile;
  profilePath: string;
  photoPath: string;
  fingerprint: string;
};

type DiffExpectation = {
  path: string;
  status: 'added' | 'modified' | 'removed';
};

type Candidate = {
  baseSha: string;
  headSha?: string;
  profileBlobSha: string;
  photoBlobSha?: string | null;
  expectedDiff: DiffExpectation[];
};

type WorkflowRun = {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
};

class RetryableMainConflict extends Error {}

export class GitHubProfilePublisher {
  readonly options: NormalizedOptions;

  constructor(options: GitHubProfilePublisherOptions) {
    this.options = normalizeOptions(options);
  }

  async publish(input: ProfilePublishInput): Promise<PublishResult> {
    const prepared = prepareInput(input);
    const prior = await this.options.stateStore?.load(prepared.operationId);

    if (prior) {
      assertMatchingCheckpoint(prior, prepared);

      if (prior.stage === 'completed') {
        return prior.result;
      }

      const resumed = await this.observeDeployment(
        prior.commitSha,
        prior.attempts,
        prior.profileBlobSha,
        prior.photoBlobSha,
      );
      await this.saveCompleted(prepared, resumed);
      return resumed;
    }

    for (let attempt = 1; attempt <= this.options.maxConflictAttempts; attempt += 1) {
      let temporaryRef: string | undefined;

      try {
        const candidate = await this.createCandidate(prepared);

        if (!candidate.headSha) {
          const noChange = resultWithOptionalPhoto({
            status: 'no_change',
            attempts: attempt,
            profileBlobSha: candidate.profileBlobSha,
          }, candidate.photoBlobSha);
          await this.saveCompleted(prepared, noChange);
          return noChange;
        }

        temporaryRef = temporaryBranchName(prepared, attempt);
        await this.createTemporaryRef(temporaryRef, candidate.headSha);
        await this.awaitWorkflow({
          workflow: this.options.validateWorkflow,
          branch: temporaryRef,
          headSha: candidate.headSha,
          discoveryErrorCode: 'validation_workflow_not_found',
          failureErrorCode: 'validation_failed',
          timeoutErrorCode: 'validation_timeout',
          completionTimeoutMs: this.options.validationTimeoutMs,
        });

        await this.promoteMain(candidate.baseSha, candidate.headSha);
        await this.saveMainUpdated(prepared, candidate, attempt);
        await this.cleanupTemporaryRef(temporaryRef);
        temporaryRef = undefined;

        const result = await this.observeDeployment(
          candidate.headSha,
          attempt,
          candidate.profileBlobSha,
          candidate.photoBlobSha,
        );
        await this.saveCompleted(prepared, result);
        return result;
      } catch (error) {
        if (!(error instanceof RetryableMainConflict)) {
          throw error;
        }

        if (attempt === this.options.maxConflictAttempts) {
          throw new ProfilePublisherError(
            'main_conflict',
            `The ${this.options.defaultBranch} branch kept moving; publication stopped after ${attempt} attempts.`,
            { cause: error },
          );
        }
      } finally {
        if (temporaryRef) {
          await this.cleanupTemporaryRef(temporaryRef);
        }
      }
    }

    throw new ProfilePublisherError('main_conflict', 'Publication attempts were exhausted.');
  }

  private async createCandidate(input: PreparedInput): Promise<Candidate> {
    const baseSha = await this.getBranchSha(this.options.defaultBranch);
    const commit = await this.requestData(
      'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
      { commit_sha: baseSha },
    );
    const baseTreeSha = requireNestedString(commit, ['tree', 'sha'], 'base commit tree SHA');

    const currentProfileSha = await this.getContentSha(input.profilePath, baseSha);
    assertExpectedSha(input.profilePath, input.profile.expectedSha, currentProfileSha);

    let currentPhotoSha: string | null | undefined;
    if (input.photo) {
      currentPhotoSha = await this.getContentSha(input.photoPath, baseSha);
      assertExpectedSha(input.photoPath, input.photo.expectedSha, currentPhotoSha);
    }

    const profileBlobSha = await this.createBlob(input.profile.json, 'utf-8');
    const treeEntries: Record<string, unknown>[] = [
      {
        path: input.profilePath,
        mode: '100644',
        type: 'blob',
        sha: profileBlobSha,
      },
    ];
    const expectedDiff: DiffExpectation[] = [];

    if (profileBlobSha !== currentProfileSha) {
      expectedDiff.push({
        path: input.profilePath,
        status: currentProfileSha ? 'modified' : 'added',
      });
    }

    let photoBlobSha: string | null | undefined;
    if (input.photo?.kind === 'upsert') {
      photoBlobSha = await this.createBlob(Buffer.from(input.photo.bytes).toString('base64'), 'base64');
      treeEntries.push({
        path: input.photoPath,
        mode: '100644',
        type: 'blob',
        sha: photoBlobSha,
      });

      if (photoBlobSha !== currentPhotoSha) {
        expectedDiff.push({
          path: input.photoPath,
          status: currentPhotoSha ? 'modified' : 'added',
        });
      }
    } else if (input.photo?.kind === 'delete') {
      photoBlobSha = null;
      treeEntries.push({
        path: input.photoPath,
        mode: '100644',
        type: 'blob',
        sha: null,
      });
      expectedDiff.push({ path: input.photoPath, status: 'removed' });
    }

    const tree = await this.requestData('POST /repos/{owner}/{repo}/git/trees', {
      base_tree: baseTreeSha,
      tree: treeEntries,
    });
    const treeSha = requireStringField(tree, 'sha', 'new tree SHA');

    if (treeSha === baseTreeSha) {
      if (expectedDiff.length !== 0) {
        throw invalidGitHubResponse('GitHub returned the base tree despite expected file changes.');
      }

      return candidateWithOptionalPhoto({
        baseSha,
        profileBlobSha,
        expectedDiff,
      }, photoBlobSha);
    }

    const createdCommit = await this.requestData('POST /repos/{owner}/{repo}/git/commits', {
      message: `Profile: ${input.action.toLowerCase().replaceAll('_', ' ')} ${input.slug}\n\nProfile-Operation: ${input.operationId}`,
      tree: treeSha,
      parents: [baseSha],
    });
    const headSha = requireStringField(createdCommit, 'sha', 'created commit SHA');
    await this.assertExpectedDiff(baseSha, headSha, expectedDiff);

    return candidateWithOptionalPhoto({
      baseSha,
      headSha,
      profileBlobSha,
      expectedDiff,
    }, photoBlobSha);
  }

  private async assertExpectedDiff(
    baseSha: string,
    headSha: string,
    expected: DiffExpectation[],
  ) {
    const comparison = await this.requestData(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      { basehead: `${baseSha}...${headSha}` },
    );
    const status = optionalStringField(comparison, 'status');
    const aheadBy = optionalNumberField(comparison, 'ahead_by');
    const totalCommits = optionalNumberField(comparison, 'total_commits');
    const files = comparison.files;

    if (status !== 'ahead' || aheadBy !== 1 || totalCommits !== 1 || !Array.isArray(files)) {
      throw new ProfilePublisherError(
        'unexpected_diff',
        'The candidate commit is not exactly one commit ahead of its base.',
      );
    }

    const actual = files.map((file) => {
      if (!isRecord(file)) {
        throw invalidGitHubResponse('The compare response contains an invalid file entry.');
      }

      const path = requireStringField(file, 'filename', 'changed file name');
      const fileStatus = requireStringField(file, 'status', 'changed file status');

      if (fileStatus !== 'added' && fileStatus !== 'modified' && fileStatus !== 'removed') {
        throw new ProfilePublisherError(
          'unexpected_diff',
          `Unexpected change status ${fileStatus} for ${path}.`,
        );
      }

      return { path, status: fileStatus } satisfies DiffExpectation;
    }).sort(compareDiffExpectations);
    const sortedExpected = [...expected].sort(compareDiffExpectations);

    if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
      throw new ProfilePublisherError(
        'unexpected_diff',
        `Candidate changed unexpected files: ${actual.map((entry) => entry.path).join(', ') || '(none)'}.`,
      );
    }
  }

  private async createBlob(content: string, encoding: 'utf-8' | 'base64') {
    const blob = await this.requestData('POST /repos/{owner}/{repo}/git/blobs', {
      content,
      encoding,
    });
    return requireStringField(blob, 'sha', 'blob SHA');
  }

  private async createTemporaryRef(branch: string, headSha: string) {
    await this.requestData('POST /repos/{owner}/{repo}/git/refs', {
      ref: `refs/heads/${branch}`,
      sha: headSha,
    });
  }

  private async promoteMain(baseSha: string, headSha: string) {
    const currentSha = await this.getBranchSha(this.options.defaultBranch);

    if (currentSha === headSha) {
      return;
    }

    if (currentSha !== baseSha) {
      throw new RetryableMainConflict();
    }

    try {
      await this.updateMain(headSha);
      return;
    } catch (firstError) {
      const afterFirstFailure = await this.getBranchSha(this.options.defaultBranch);

      if (afterFirstFailure === headSha) {
        return;
      }

      if (afterFirstFailure !== baseSha) {
        throw new RetryableMainConflict();
      }

      const firstStatus = getErrorStatus(firstError);
      if (firstStatus === 403 || firstStatus === 409 || firstStatus === 422) {
        throw new ProfilePublisherError(
          'main_update_rejected',
          `GitHub rejected the fast-forward update of ${this.options.defaultBranch}.`,
          { cause: firstError },
        );
      }

      try {
        await this.updateMain(headSha);
      } catch (secondError) {
        const afterSecondFailure = await this.getBranchSha(this.options.defaultBranch);

        if (afterSecondFailure === headSha) {
          return;
        }

        if (afterSecondFailure !== baseSha) {
          throw new RetryableMainConflict();
        }

        throw new ProfilePublisherError(
          'main_update_rejected',
          `GitHub did not accept the fast-forward update of ${this.options.defaultBranch}.`,
          { cause: secondError },
        );
      }
    }
  }

  private async updateMain(headSha: string) {
    await this.requestData('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
      ref: `heads/${this.options.defaultBranch}`,
      sha: headSha,
      force: false,
    });
  }

  private async observeDeployment(
    commitSha: string,
    attempts: number,
    profileBlobSha: string,
    photoBlobSha?: string | null,
  ): Promise<PublishResult> {
    try {
      const deployRun = await this.awaitWorkflow({
        workflow: this.options.deployWorkflow,
        branch: this.options.defaultBranch,
        headSha: commitSha,
        discoveryErrorCode: 'deploy_workflow_not_found',
        failureErrorCode: 'deploy_failed',
        timeoutErrorCode: 'deploy_timeout',
        completionTimeoutMs: this.options.deployTimeoutMs,
      });
      const pageStatus = await this.awaitPagesDeployment(commitSha);
      const deployed = resultWithOptionalPhoto({
        status: 'deployed',
        attempts,
        profileBlobSha,
        commitSha,
        pageStatus,
        ...(deployRun.html_url ? { workflowRunUrl: deployRun.html_url } : {}),
      }, photoBlobSha);
      return deployed;
    } catch (error) {
      return resultWithOptionalPhoto({
        status: 'published_deploy_failed',
        attempts,
        profileBlobSha,
        commitSha,
        failure: error instanceof Error ? error.message : String(error),
      }, photoBlobSha);
    }
  }

  private async awaitWorkflow(input: {
    workflow: string;
    branch: string;
    headSha: string;
    discoveryErrorCode: 'validation_workflow_not_found' | 'deploy_workflow_not_found';
    failureErrorCode: 'validation_failed' | 'deploy_failed';
    timeoutErrorCode: 'validation_timeout' | 'deploy_timeout';
    completionTimeoutMs: number;
  }): Promise<WorkflowRun> {
    const discoveryDeadline = this.options.now() + this.options.workflowDiscoveryTimeoutMs;
    let found: WorkflowRun | undefined;

    while (this.options.now() <= discoveryDeadline) {
      const listed = await this.requestData(
        'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs',
        {
          workflow_id: input.workflow,
          branch: input.branch,
          event: 'push',
          head_sha: input.headSha,
          per_page: 10,
        },
      );
      const workflowRuns = listed.workflow_runs;

      if (!Array.isArray(workflowRuns)) {
        throw invalidGitHubResponse('Workflow run listing did not contain workflow_runs.');
      }

      found = workflowRuns
        .map(parseWorkflowRun)
        .filter((run) => (
          run.head_sha === input.headSha
          && run.head_branch === input.branch
          && run.event === 'push'
        ))
        .sort((left, right) => right.id - left.id)[0];

      if (found) {
        break;
      }

      await this.options.sleep(this.options.pollIntervalMs);
    }

    if (!found) {
      throw new ProfilePublisherError(
        input.discoveryErrorCode,
        `GitHub did not create ${input.workflow} for ${input.headSha}.`,
      );
    }

    const completionDeadline = this.options.now() + input.completionTimeoutMs;

    while (this.options.now() <= completionDeadline) {
      const runData = await this.requestData(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
        { run_id: found.id },
      );
      const run = parseWorkflowRun(runData);

      if (run.head_sha !== input.headSha || run.head_branch !== input.branch || run.event !== 'push') {
        throw invalidGitHubResponse('Workflow run identity changed while polling.');
      }

      if (run.status === 'completed') {
        if (run.conclusion !== 'success') {
          throw new ProfilePublisherError(
            input.failureErrorCode,
            `${input.workflow} completed with conclusion ${run.conclusion ?? 'unknown'}.`,
          );
        }

        return run;
      }

      await this.options.sleep(this.options.pollIntervalMs);
    }

    throw new ProfilePublisherError(
      input.timeoutErrorCode,
      `Timed out waiting for ${input.workflow} to complete.`,
    );
  }

  private async awaitPagesDeployment(commitSha: string) {
    const deadline = this.options.now() + this.options.pagesTimeoutMs;
    let lastStatus = 'not-created';

    while (this.options.now() <= deadline) {
      try {
        const data = await this.requestData(
          'GET /repos/{owner}/{repo}/pages/deployments/{pages_deployment_id}',
          { pages_deployment_id: commitSha },
        );
        lastStatus = optionalStringField(data, 'status') ?? 'unknown';

        if (lastStatus === 'succeed') {
          return lastStatus;
        }
      } catch (error) {
        if (getErrorStatus(error) !== 404) {
          throw error;
        }
      }

      await this.options.sleep(this.options.pollIntervalMs);
    }

    throw new ProfilePublisherError(
      'pages_timeout',
      `Timed out waiting for the Pages deployment (${lastStatus}).`,
    );
  }

  private async getBranchSha(branch: string) {
    const reference = await this.requestData(
      'GET /repos/{owner}/{repo}/git/ref/{ref}',
      { ref: `heads/${branch}` },
    );
    return requireNestedString(reference, ['object', 'sha'], `${branch} ref SHA`);
  }

  private async getContentSha(path: string, ref: string): Promise<string | null> {
    try {
      const data = await this.requestData('GET /repos/{owner}/{repo}/contents/{path}', {
        path,
        ref,
      });

      if (optionalStringField(data, 'type') !== 'file') {
        throw invalidGitHubResponse(`${path} is not a regular file.`);
      }

      return requireStringField(data, 'sha', `${path} blob SHA`);
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        return null;
      }

      throw error;
    }
  }

  private async cleanupTemporaryRef(branch: string) {
    try {
      await this.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
        ref: `heads/${branch}`,
      });
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        this.options.onWarning(`Could not delete temporary branch ${branch}.`, error);
      }
    }
  }

  private async saveMainUpdated(input: PreparedInput, candidate: Candidate, attempts: number) {
    if (!this.options.stateStore || !candidate.headSha) {
      return;
    }

    const checkpoint = checkpointWithOptionalPhoto({
      version: 1,
      stage: 'main_updated',
      operationId: input.operationId,
      fingerprint: input.fingerprint,
      slug: input.slug,
      commitSha: candidate.headSha,
      attempts,
      profileBlobSha: candidate.profileBlobSha,
    }, candidate.photoBlobSha);

    try {
      await this.options.stateStore.save(checkpoint);
    } catch (error) {
      this.options.onWarning('Could not persist the main_updated publish checkpoint.', error);
    }
  }

  private async saveCompleted(input: PreparedInput, result: PublishResult) {
    if (!this.options.stateStore) {
      return;
    }

    try {
      await this.options.stateStore.save({
        version: 1,
        stage: 'completed',
        operationId: input.operationId,
        fingerprint: input.fingerprint,
        slug: input.slug,
        result,
      });
    } catch (error) {
      this.options.onWarning('Could not persist the completed publish checkpoint.', error);
    }
  }

  private async requestData(route: string, parameters: Record<string, unknown>) {
    const response = await this.request(route, parameters);

    if (!isRecord(response.data)) {
      throw invalidGitHubResponse(`${route} returned a non-object response.`);
    }

    return response.data;
  }

  private async request(route: string, parameters: Record<string, unknown>) {
    return this.options.request(route, {
      owner: this.options.owner,
      repo: this.options.repo,
      ...parameters,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
      },
    });
  }
}

function normalizeOptions(options: GitHubProfilePublisherOptions): NormalizedOptions {
  if (!options.owner.trim() || !options.repo.trim()) {
    throw new ProfilePublisherError('invalid_input', 'GitHub owner and repo are required.');
  }

  // Together with the runtime's per-request timeout, these limits keep two
  // complete validation attempts and deployment observation below Discord's
  // 15-minute interaction-token window, including webhook-edit headroom.
  return {
    request: options.request,
    owner: options.owner.trim(),
    repo: options.repo.trim(),
    defaultBranch: options.defaultBranch?.trim() || 'main',
    validateWorkflow: options.validateWorkflow?.trim() || 'validate-profile-bot.yml',
    deployWorkflow: options.deployWorkflow?.trim() || 'deploy.yml',
    sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    now: options.now ?? Date.now,
    pollIntervalMs: positiveInteger(options.pollIntervalMs, 2_000, 'pollIntervalMs'),
    workflowDiscoveryTimeoutMs: positiveInteger(
      options.workflowDiscoveryTimeoutMs,
      10_000,
      'workflowDiscoveryTimeoutMs',
    ),
    validationTimeoutMs: positiveInteger(options.validationTimeoutMs, 120_000, 'validationTimeoutMs'),
    deployTimeoutMs: positiveInteger(options.deployTimeoutMs, 150_000, 'deployTimeoutMs'),
    pagesTimeoutMs: positiveInteger(options.pagesTimeoutMs, 30_000, 'pagesTimeoutMs'),
    maxConflictAttempts: conflictAttemptCount(options.maxConflictAttempts),
    ...(options.stateStore ? { stateStore: options.stateStore } : {}),
    onWarning: options.onWarning ?? (() => undefined),
  };
}

function prepareInput(input: ProfilePublishInput): PreparedInput {
  if (!SLUG_PATTERN.test(input.slug) || input.slug.length > 64) {
    throw new ProfilePublisherError('invalid_input', 'Profile slug is invalid.');
  }

  if (!OPERATION_ID_PATTERN.test(input.operationId)) {
    throw new ProfilePublisherError('invalid_input', 'Operation ID is invalid.');
  }

  assertExpectedShaSyntax(input.profile.expectedSha, 'profile expected SHA');
  if (input.photo) {
    assertExpectedShaSyntax(input.photo.expectedSha, 'photo expected SHA');
  }

  if (input.photo?.kind === 'upsert' && input.photo.bytes.byteLength === 0) {
    throw new ProfilePublisherError('invalid_input', 'Photo bytes must not be empty.');
  }

  let parsedProfile: unknown;
  try {
    parsedProfile = JSON.parse(input.profile.json);
  } catch (error) {
    throw new ProfilePublisherError('invalid_input', 'Profile JSON is invalid.', { cause: error });
  }

  try {
    assertMemberProfile(parsedProfile);
  } catch (error) {
    throw new ProfilePublisherError('invalid_input', 'Profile JSON does not match the member schema.', {
      cause: error,
    });
  }

  const expectedPhotoName = `${input.slug}.webp`;
  if (parsedProfile.photo && parsedProfile.photo !== expectedPhotoName) {
    throw new ProfilePublisherError(
      'invalid_input',
      `Bot-managed profiles may only reference ${expectedPhotoName}.`,
    );
  }

  if (input.photo?.kind === 'upsert' && parsedProfile.photo !== expectedPhotoName) {
    throw new ProfilePublisherError('invalid_input', 'Photo upsert requires the profile photo field.');
  }

  if (input.photo?.kind === 'delete' && parsedProfile.photo !== '') {
    throw new ProfilePublisherError('invalid_input', 'Photo deletion requires an empty profile photo field.');
  }

  const fingerprint = fingerprintInput(input);
  return {
    ...input,
    parsedProfile,
    profilePath: `${PROFILE_DIRECTORY}/${input.slug}.json`,
    photoPath: `${PROFILE_DIRECTORY}/${expectedPhotoName}`,
    fingerprint,
  };
}

function fingerprintInput(input: ProfilePublishInput) {
  const hash = createHash('sha256');
  hash.update(input.slug);
  hash.update('\0');
  hash.update(input.action);
  hash.update('\0');
  hash.update(input.profile.expectedSha ?? 'missing');
  hash.update('\0');
  hash.update(input.profile.json);
  hash.update('\0');

  if (!input.photo) {
    hash.update('photo:unchanged');
  } else {
    hash.update(`photo:${input.photo.kind}:${input.photo.expectedSha ?? 'missing'}`);
    if (input.photo.kind === 'upsert') {
      hash.update(input.photo.bytes);
    }
  }

  return hash.digest('hex');
}

function assertMatchingCheckpoint(checkpoint: PublishCheckpoint, input: PreparedInput) {
  if (checkpoint.version !== 1 || checkpoint.slug !== input.slug || checkpoint.fingerprint !== input.fingerprint) {
    throw new ProfilePublisherError(
      'invalid_input',
      'Operation ID was already used for a different profile publication.',
    );
  }
}

function assertExpectedSha(path: string, expected: string | null, actual: string | null) {
  if (expected !== actual) {
    throw new ProfilePublisherError(
      'content_conflict',
      `${path} changed since the profile editor was opened.`,
    );
  }
}

function assertExpectedShaSyntax(value: string | null, label: string) {
  if (value !== null && !SHA_PATTERN.test(value)) {
    throw new ProfilePublisherError('invalid_input', `${label} must be a full Git SHA.`);
  }
}

function temporaryBranchName(input: PreparedInput, attempt: number) {
  return `bot/profile/${input.slug}/${input.operationId}/a${attempt}`;
}

function parseWorkflowRun(value: unknown): WorkflowRun {
  if (!isRecord(value)) {
    throw invalidGitHubResponse('Workflow run response is invalid.');
  }

  const id = optionalNumberField(value, 'id');
  if (!Number.isSafeInteger(id) || id === undefined) {
    throw invalidGitHubResponse('Workflow run ID is invalid.');
  }

  const conclusionValue = value.conclusion;
  if (conclusionValue !== null && typeof conclusionValue !== 'string') {
    throw invalidGitHubResponse('Workflow conclusion is invalid.');
  }

  const htmlUrl = optionalStringField(value, 'html_url');
  return {
    id,
    head_sha: requireStringField(value, 'head_sha', 'workflow head SHA'),
    head_branch: requireStringField(value, 'head_branch', 'workflow head branch'),
    event: requireStringField(value, 'event', 'workflow event'),
    status: requireStringField(value, 'status', 'workflow status'),
    conclusion: conclusionValue,
    ...(htmlUrl ? { html_url: htmlUrl } : {}),
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new ProfilePublisherError('invalid_input', `${name} must be a positive integer.`);
  }
  return selected;
}

function conflictAttemptCount(value: number | undefined) {
  const selected = positiveInteger(value, 2, 'maxConflictAttempts');
  if (selected > 2) {
    throw new ProfilePublisherError('invalid_input', 'maxConflictAttempts cannot exceed 2.');
  }
  return selected;
}

function compareDiffExpectations(left: DiffExpectation, right: DiffExpectation) {
  return left.path.localeCompare(right.path) || left.status.localeCompare(right.status);
}

function getErrorStatus(error: unknown) {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.status === 'number' ? error.status : undefined;
}

function invalidGitHubResponse(message: string) {
  return new ProfilePublisherError('github_response_invalid', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireStringField(value: Record<string, unknown>, field: string, label: string) {
  const selected = value[field];
  if (typeof selected !== 'string' || !selected) {
    throw invalidGitHubResponse(`GitHub response is missing ${label}.`);
  }
  return selected;
}

function optionalStringField(value: Record<string, unknown>, field: string) {
  const selected = value[field];
  return typeof selected === 'string' ? selected : undefined;
}

function optionalNumberField(value: Record<string, unknown>, field: string) {
  const selected = value[field];
  return typeof selected === 'number' ? selected : undefined;
}

function requireNestedString(value: Record<string, unknown>, path: string[], label: string) {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) {
      throw invalidGitHubResponse(`GitHub response is missing ${label}.`);
    }
    current = current[part];
  }

  if (typeof current !== 'string' || !current) {
    throw invalidGitHubResponse(`GitHub response is missing ${label}.`);
  }
  return current;
}

function candidateWithOptionalPhoto(
  candidate: Omit<Candidate, 'photoBlobSha'>,
  photoBlobSha: string | null | undefined,
): Candidate {
  return photoBlobSha === undefined ? candidate : { ...candidate, photoBlobSha };
}

function resultWithOptionalPhoto(
  result: Omit<PublishResult, 'photoBlobSha'>,
  photoBlobSha: string | null | undefined,
): PublishResult {
  return typeof photoBlobSha === 'string' ? { ...result, photoBlobSha } : result;
}

function checkpointWithOptionalPhoto(
  checkpoint: Omit<Extract<PublishCheckpoint, { stage: 'main_updated' }>, 'photoBlobSha'>,
  photoBlobSha: string | null | undefined,
): Extract<PublishCheckpoint, { stage: 'main_updated' }> {
  return typeof photoBlobSha === 'string' ? { ...checkpoint, photoBlobSha } : checkpoint;
}
