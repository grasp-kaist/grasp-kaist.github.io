import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { assertMemberProfile, type MemberProfile } from '../domain/member-profile.js';

const API_VERSION = '2026-03-10';
const PROFILE_DIRECTORY = 'src/data/members';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export const PROFILE_PUBLISH_BATCH_MAX_SIZE = 20;

export const PROFILE_PUBLISH_REQUEST_TIMEOUT_MS = 10_000;
export const PROFILE_PUBLISH_TIMEOUT_MS = 810_000;

export type GitHubResponse = {
  data: unknown;
  status?: number;
  headers?: Record<string, string | number | undefined>;
};

export type GitHubRequest = (
  route: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
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
      stage: 'candidate_validated';
      operationId: string;
      fingerprint: string;
      slug: string;
      baseSha: string;
      commitSha: string;
      attempts: number;
      profileBlobSha: string;
      photoBlobSha?: string;
    }
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

type CandidateValidatedCheckpoint = Extract<PublishCheckpoint, { stage: 'candidate_validated' }>;
type MainUpdatedCheckpoint = Extract<PublishCheckpoint, { stage: 'main_updated' }>;
type PendingPublishCheckpoint = CandidateValidatedCheckpoint | MainUpdatedCheckpoint;

export interface PublishStateStore {
  load(operationId: string): Promise<PublishCheckpoint | null>;
  save(checkpoint: PublishCheckpoint): Promise<void>;
  /** Persist every checkpoint atomically when the backing store supports batches. */
  saveBatch?(checkpoints: readonly PublishCheckpoint[]): Promise<void>;
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
  | 'publication_timeout'
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
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  workflowDiscoveryTimeoutMs?: number;
  validationTimeoutMs?: number;
  deployTimeoutMs?: number;
  pagesTimeoutMs?: number;
  publishTimeoutMs?: number;
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
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  workflowDiscoveryTimeoutMs: number;
  validationTimeoutMs: number;
  deployTimeoutMs: number;
  pagesTimeoutMs: number;
  publishTimeoutMs: number;
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
  items: CandidateItem[];
  expectedDiff: DiffExpectation[];
};

type CandidateItem = {
  input: PreparedInput;
  profileBlobSha: string;
  photoBlobSha?: string | null;
  changed: boolean;
};

type DeploymentObservation = Omit<PublishResult, 'profileBlobSha' | 'photoBlobSha'>;

type PendingCheckpointEntry = {
  checkpoint: PendingPublishCheckpoint;
  input: PreparedInput;
  index: number;
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
    const [result] = await this.publishBatch([input]);
    return result!;
  }

  async publishBatch(inputs: readonly ProfilePublishInput[]): Promise<PublishResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(publicationTimeoutError());
    }, this.options.publishTimeoutMs);

    try {
      return await this.publishBatchWithSignal(inputs, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw publicationTimeoutReason(controller.signal, error);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async publishBatchWithSignal(
    inputs: readonly ProfilePublishInput[],
    signal: AbortSignal,
  ): Promise<PublishResult[]> {
    const prepared = prepareBatchInputs(inputs);
    const results = Array<PublishResult | undefined>(prepared.length).fill(undefined);
    const priors = await Promise.all(prepared.map(async (input) => {
      const prior = await this.options.stateStore?.load(input.operationId) ?? null;
      signal.throwIfAborted();

      if (prior) {
        assertMatchingCheckpoint(prior, input);
        if (prior.stage === 'completed') {
          results[prepared.indexOf(input)] = prior.result;
        }
      }

      return prior;
    }));
    const resumed = await this.resumeCheckpointedBatch(prepared, priors, results, signal);

    if (resumed) {
      return resumed;
    }

    const active = prepared.filter((_input, index) => results[index] === undefined);

    if (active.length === 0) {
      return requireBatchResults(results);
    }

    for (let attempt = 1; attempt <= this.options.maxConflictAttempts; attempt += 1) {
      let temporaryRef: string | undefined;
      let validatedOperationIds: string[] = [];

      try {
        const candidate = await this.createCandidate(active, signal);
        const unchangedItems = candidate.items.filter((candidateItem) => !candidateItem.changed);

        for (const item of unchangedItems) {
          const noChange = resultWithOptionalPhoto({
            status: 'no_change',
            attempts: attempt,
            profileBlobSha: item.profileBlobSha,
          }, item.photoBlobSha);
          results[prepared.indexOf(item.input)] = noChange;
        }

        if (!candidate.headSha) {
          for (const item of unchangedItems) {
            await this.saveCompleted(item.input, results[prepared.indexOf(item.input)]!);
          }
          return requireBatchResults(results);
        }

        const changedItems = candidate.items.filter((item) => item.changed);
        temporaryRef = temporaryBranchName(changedItems.map((item) => item.input), candidate.expectedDiff, attempt);
        await this.createTemporaryRef(temporaryRef, candidate.headSha, signal);
        await this.awaitWorkflow({
          workflow: this.options.validateWorkflow,
          branch: temporaryRef,
          headSha: candidate.headSha,
          discoveryErrorCode: 'validation_workflow_not_found',
          failureErrorCode: 'validation_failed',
          timeoutErrorCode: 'validation_timeout',
          completionTimeoutMs: this.options.validationTimeoutMs,
        }, signal);

        await this.saveValidatedBatch(changedItems, candidate.baseSha, candidate.headSha, attempt);
        validatedOperationIds = changedItems.map((item) => item.input.operationId);
        await this.promoteMain(candidate.baseSha, candidate.headSha, signal);
        await this.saveMainUpdatedBatch(changedItems, candidate.headSha, attempt);
        await this.cleanupTemporaryRef(temporaryRef);
        temporaryRef = undefined;

        const observation = await this.observeDeployment(
          candidate.headSha,
          attempt,
          signal,
        );

        for (const item of changedItems) {
          const result = resultWithOptionalPhoto({
            ...observation,
            profileBlobSha: item.profileBlobSha,
          }, item.photoBlobSha);
          results[prepared.indexOf(item.input)] = result;
          await this.saveCompleted(item.input, result);
        }

        for (const item of unchangedItems) {
          await this.saveCompleted(item.input, results[prepared.indexOf(item.input)]!);
        }

        return requireBatchResults(results);
      } catch (error) {
        if (!(error instanceof RetryableMainConflict)) {
          throw error;
        }

        await this.clearValidatedCheckpoints(validatedOperationIds);

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

  private async resumeCheckpointedBatch(
    inputs: PreparedInput[],
    priors: Array<PublishCheckpoint | null>,
    results: Array<PublishResult | undefined>,
    signal: AbortSignal,
  ): Promise<PublishResult[] | null> {
    const pending: PendingCheckpointEntry[] = [];
    priors.forEach((checkpoint, index) => {
      if (checkpoint?.stage === 'candidate_validated' || checkpoint?.stage === 'main_updated') {
        pending.push({ checkpoint, input: inputs[index]!, index });
      }
    });

    if (pending.length === 0) {
      return results.every(Boolean) ? requireBatchResults(results) : null;
    }

    const groups = new Map<string, typeof pending>();
    for (const entry of pending) {
      const group = groups.get(entry.checkpoint.commitSha) ?? [];
      group.push(entry);
      groups.set(entry.checkpoint.commitSha, group);
    }

    for (const [commitSha, entries] of groups) {
      const attempts = entries[0]!.checkpoint.attempts;

      if (entries.some(({ checkpoint }) => checkpoint.attempts !== attempts)) {
        throw new ProfilePublisherError(
          'github_response_invalid',
          'Profile operation checkpoints disagree about the candidate attempt.',
        );
      }

      const alreadyMainUpdated = entries.some(({ checkpoint }) => checkpoint.stage === 'main_updated');

      if (!alreadyMainUpdated) {
        const validatedEntries = entries.filter(
          (entry): entry is PendingCheckpointEntry & { checkpoint: CandidateValidatedCheckpoint } => (
            entry.checkpoint.stage === 'candidate_validated'
          ),
        );
        const baseSha = validatedEntries[0]!.checkpoint.baseSha;

        if (validatedEntries.some(({ checkpoint }) => checkpoint.baseSha !== baseSha)) {
          throw new ProfilePublisherError(
            'github_response_invalid',
            'Profile operation checkpoints disagree about the candidate base.',
          );
        }

        const candidateParentSha = await this.getCommitParentSha(commitSha, signal);
        if (candidateParentSha !== baseSha) {
          throw new ProfilePublisherError(
            'github_response_invalid',
            'Validated candidate checkpoint does not match the commit parent.',
          );
        }

        try {
          const currentMain = await this.getBranchSha(this.options.defaultBranch, signal);

          if (currentMain === baseSha) {
            await this.promoteMain(baseSha, commitSha, signal);
          } else if (
            currentMain !== commitSha
            && !await this.isCommitIncludedInMain(commitSha, currentMain, signal)
          ) {
            await this.clearValidatedCheckpoints(entries.map(({ input }) => input.operationId));
            continue;
          }
        } catch (error) {
          if (!(error instanceof RetryableMainConflict)) {
            throw error;
          }

          await this.clearValidatedCheckpoints(entries.map(({ input }) => input.operationId));
          continue;
        }

        await this.saveMainUpdatedCheckpoints(validatedEntries.map(({ checkpoint }) => checkpoint));
      }

      const observation = await this.observeDeployment(commitSha, attempts, signal);

      for (const { checkpoint, input, index } of entries) {
        const result = resultWithOptionalPhoto({
          ...observation,
          profileBlobSha: checkpoint.profileBlobSha,
        }, checkpoint.photoBlobSha);
        results[index] = result;
        await this.saveCompleted(input, result);
      }
    }

    return results.every(Boolean) ? requireBatchResults(results) : null;
  }

  private async createCandidate(inputs: PreparedInput[], signal: AbortSignal): Promise<Candidate> {
    const baseSha = await this.getBranchSha(this.options.defaultBranch, signal);
    const commit = await this.requestData(
      'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
      { commit_sha: baseSha },
      signal,
    );
    const baseTreeSha = requireNestedString(commit, ['tree', 'sha'], 'base commit tree SHA');

    const treeEntries: Record<string, unknown>[] = [];
    const expectedDiff: DiffExpectation[] = [];
    const items: CandidateItem[] = [];

    for (const input of inputs) {
      const itemDiff: DiffExpectation[] = [];
      const currentProfileSha = await this.getContentSha(input.profilePath, baseSha, signal);
      assertExpectedSha(input.profilePath, input.profile.expectedSha, currentProfileSha);

      let currentPhotoSha: string | null | undefined;
      if (input.photo) {
        currentPhotoSha = await this.getContentSha(input.photoPath, baseSha, signal);
        assertExpectedSha(input.photoPath, input.photo.expectedSha, currentPhotoSha);
      }

      const profileBlobSha = await this.createBlob(input.profile.json, 'utf-8', signal);
      treeEntries.push({
        path: input.profilePath,
        mode: '100644',
        type: 'blob',
        sha: profileBlobSha,
      });

      if (profileBlobSha !== currentProfileSha) {
        itemDiff.push({
          path: input.profilePath,
          status: currentProfileSha ? 'modified' : 'added',
        });
      }

      let photoBlobSha: string | null | undefined;
      if (input.photo?.kind === 'upsert') {
        photoBlobSha = await this.createBlob(
          Buffer.from(input.photo.bytes).toString('base64'),
          'base64',
          signal,
        );
        treeEntries.push({
          path: input.photoPath,
          mode: '100644',
          type: 'blob',
          sha: photoBlobSha,
        });

        if (photoBlobSha !== currentPhotoSha) {
          itemDiff.push({
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
        itemDiff.push({ path: input.photoPath, status: 'removed' });
      }

      expectedDiff.push(...itemDiff);
      items.push(candidateItemWithOptionalPhoto({
        input,
        profileBlobSha,
        changed: itemDiff.length > 0,
      }, photoBlobSha));
    }

    const tree = await this.requestData('POST /repos/{owner}/{repo}/git/trees', {
      base_tree: baseTreeSha,
      tree: treeEntries,
    }, signal);
    const treeSha = requireStringField(tree, 'sha', 'new tree SHA');

    if (treeSha === baseTreeSha) {
      if (expectedDiff.length !== 0) {
        throw invalidGitHubResponse('GitHub returned the base tree despite expected file changes.');
      }

      return {
        baseSha,
        items,
        expectedDiff,
      };
    }

    const createdCommit = await this.requestData('POST /repos/{owner}/{repo}/git/commits', {
      message: batchCommitMessage(items.filter((item) => item.changed).map((item) => item.input)),
      tree: treeSha,
      parents: [baseSha],
    }, signal);
    const headSha = requireStringField(createdCommit, 'sha', 'created commit SHA');
    await this.assertExpectedDiff(baseSha, headSha, expectedDiff, signal);

    return {
      baseSha,
      headSha,
      items,
      expectedDiff,
    };
  }

  private async assertExpectedDiff(
    baseSha: string,
    headSha: string,
    expected: DiffExpectation[],
    signal: AbortSignal,
  ) {
    const comparison = await this.requestData(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      { basehead: `${baseSha}...${headSha}` },
      signal,
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

  private async createBlob(
    content: string,
    encoding: 'utf-8' | 'base64',
    signal: AbortSignal,
  ) {
    const blob = await this.requestData('POST /repos/{owner}/{repo}/git/blobs', {
      content,
      encoding,
    }, signal);
    return requireStringField(blob, 'sha', 'blob SHA');
  }

  private async createTemporaryRef(branch: string, headSha: string, signal: AbortSignal) {
    const create = () => this.requestData('POST /repos/{owner}/{repo}/git/refs', {
      ref: `refs/heads/${branch}`,
      sha: headSha,
    }, signal);

    try {
      await create();
      return;
    } catch (error) {
      if (getErrorStatus(error) !== 422) {
        throw error;
      }
    }

    try {
      const existingSha = await this.getBranchSha(branch, signal);
      if (existingSha === headSha) {
        return;
      }
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        throw error;
      }
    }

    await this.cleanupTemporaryRef(branch);
    signal.throwIfAborted();
    await create();
  }

  private async promoteMain(baseSha: string, headSha: string, signal: AbortSignal) {
    const currentSha = await this.getBranchSha(this.options.defaultBranch, signal);

    if (currentSha === headSha) {
      return;
    }

    if (currentSha !== baseSha) {
      throw new RetryableMainConflict();
    }

    try {
      await this.updateMain(headSha, signal);
      return;
    } catch (firstError) {
      const afterFirstFailure = await this.getBranchSha(this.options.defaultBranch, signal);

      if (afterFirstFailure === headSha) {
        return;
      }

      if (afterFirstFailure !== baseSha) {
        if (await this.isCommitIncludedInMain(headSha, afterFirstFailure, signal)) {
          return;
        }

        if (isExplicitRefUpdateRejection(firstError)) {
          throw new RetryableMainConflict();
        }

        throw firstError;
      }

      if (isExplicitRefUpdateRejection(firstError)) {
        throw new ProfilePublisherError(
          'main_update_rejected',
          `GitHub rejected the fast-forward update of ${this.options.defaultBranch}.`,
          { cause: firstError },
        );
      }

      try {
        await this.updateMain(headSha, signal);
      } catch (secondError) {
        const afterSecondFailure = await this.getBranchSha(this.options.defaultBranch, signal);

        if (afterSecondFailure === headSha) {
          return;
        }

        if (afterSecondFailure !== baseSha) {
          if (await this.isCommitIncludedInMain(headSha, afterSecondFailure, signal)) {
            return;
          }

          if (isExplicitRefUpdateRejection(secondError)) {
            throw new RetryableMainConflict();
          }

          throw secondError;
        }

        if (!isExplicitRefUpdateRejection(secondError)) {
          throw secondError;
        }

        throw new ProfilePublisherError(
          'main_update_rejected',
          `GitHub did not accept the fast-forward update of ${this.options.defaultBranch}.`,
          { cause: secondError },
        );
      }
    }
  }

  private async updateMain(headSha: string, signal: AbortSignal) {
    await this.requestData('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
      ref: `heads/${this.options.defaultBranch}`,
      sha: headSha,
      force: false,
    }, signal);
  }

  private async observeDeployment(
    commitSha: string,
    attempts: number,
    signal: AbortSignal,
  ): Promise<DeploymentObservation> {
    try {
      const deployRun = await this.awaitWorkflow({
        workflow: this.options.deployWorkflow,
        branch: this.options.defaultBranch,
        headSha: commitSha,
        discoveryErrorCode: 'deploy_workflow_not_found',
        failureErrorCode: 'deploy_failed',
        timeoutErrorCode: 'deploy_timeout',
        completionTimeoutMs: this.options.deployTimeoutMs,
      }, signal);
      const pageStatus = await this.awaitPagesDeployment(commitSha, signal);
      return {
        status: 'deployed',
        attempts,
        commitSha,
        pageStatus,
        ...(deployRun.html_url ? { workflowRunUrl: deployRun.html_url } : {}),
      };
    } catch (error) {
      return {
        status: 'published_deploy_failed',
        attempts,
        commitSha,
        failure: error instanceof Error ? error.message : String(error),
      };
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
  }, signal: AbortSignal): Promise<WorkflowRun> {
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
        signal,
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

      await this.pollSleep(signal);
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
        signal,
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

      await this.pollSleep(signal);
    }

    throw new ProfilePublisherError(
      input.timeoutErrorCode,
      `Timed out waiting for ${input.workflow} to complete.`,
    );
  }

  private async awaitPagesDeployment(commitSha: string, signal: AbortSignal) {
    const deadline = this.options.now() + this.options.pagesTimeoutMs;
    let lastStatus = 'not-created';

    while (this.options.now() <= deadline) {
      try {
        const data = await this.requestData(
          'GET /repos/{owner}/{repo}/pages/deployments/{pages_deployment_id}',
          { pages_deployment_id: commitSha },
          signal,
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

      await this.pollSleep(signal);
    }

    throw new ProfilePublisherError(
      'pages_timeout',
      `Timed out waiting for the Pages deployment (${lastStatus}).`,
    );
  }

  private async getBranchSha(branch: string, signal: AbortSignal) {
    const reference = await this.requestData(
      'GET /repos/{owner}/{repo}/git/ref/{ref}',
      { ref: `heads/${branch}` },
      signal,
    );
    return requireNestedString(reference, ['object', 'sha'], `${branch} ref SHA`);
  }

  private async getCommitParentSha(commitSha: string, signal: AbortSignal) {
    const commit = await this.requestData(
      'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
      { commit_sha: commitSha },
      signal,
    );
    const parents = commit.parents;

    if (!Array.isArray(parents) || parents.length !== 1 || !isRecord(parents[0])) {
      throw invalidGitHubResponse('Validated profile commit must have exactly one parent.');
    }

    return requireStringField(parents[0], 'sha', 'validated commit parent SHA');
  }

  private async isCommitIncludedInMain(
    commitSha: string,
    mainSha: string,
    signal: AbortSignal,
  ) {
    const comparison = await this.requestData(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      { basehead: `${commitSha}...${mainSha}` },
      signal,
    );
    const status = requireStringField(comparison, 'status', 'commit comparison status');

    if (status === 'ahead' || status === 'identical') {
      return true;
    }

    if (status === 'behind' || status === 'diverged') {
      return false;
    }

    throw invalidGitHubResponse(`GitHub returned an unknown commit comparison status: ${status}.`);
  }

  private async getContentSha(
    path: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    try {
      const data = await this.requestData('GET /repos/{owner}/{repo}/contents/{path}', {
        path,
        ref,
      }, signal);

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
    const signal = AbortSignal.timeout(PROFILE_PUBLISH_REQUEST_TIMEOUT_MS);

    try {
      await this.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
        ref: `heads/${branch}`,
      }, signal);
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        this.options.onWarning(`Could not delete temporary branch ${branch}.`, error);
      }
    }
  }

  private async saveValidatedBatch(
    items: CandidateItem[],
    baseSha: string,
    commitSha: string,
    attempts: number,
  ) {
    if (!this.options.stateStore) {
      return;
    }

    const checkpoints = items.map((item) => candidateCheckpointWithOptionalPhoto({
      version: 1,
      stage: 'candidate_validated',
      operationId: item.input.operationId,
      fingerprint: item.input.fingerprint,
      slug: item.input.slug,
      baseSha,
      commitSha,
      attempts,
      profileBlobSha: item.profileBlobSha,
    }, item.photoBlobSha));

    if (this.options.stateStore.saveBatch) {
      try {
        await this.options.stateStore.saveBatch(checkpoints);
      } catch (error) {
        await this.clearValidatedCheckpoints(checkpoints.map((checkpoint) => checkpoint.operationId));
        throw error;
      }
      return;
    }

    const saved: string[] = [];

    try {
      for (const checkpoint of checkpoints) {
        await this.options.stateStore.save(checkpoint);
        saved.push(checkpoint.operationId);
      }
    } catch (error) {
      await this.clearValidatedCheckpoints(saved);
      throw error;
    }
  }

  private async saveMainUpdatedBatch(
    items: CandidateItem[],
    commitSha: string,
    attempts: number,
  ) {
    await this.saveMainUpdatedCheckpoints(items.map((item) => mainUpdatedCheckpointWithOptionalPhoto({
      version: 1,
      stage: 'main_updated',
      operationId: item.input.operationId,
      fingerprint: item.input.fingerprint,
      slug: item.input.slug,
      commitSha,
      attempts,
      profileBlobSha: item.profileBlobSha,
    }, item.photoBlobSha)));
  }

  private async saveMainUpdatedCheckpoints(
    checkpoints: PendingPublishCheckpoint[],
  ) {
    if (!this.options.stateStore) {
      return;
    }

    const mainUpdated = checkpoints.map((checkpoint) => mainUpdatedCheckpointWithOptionalPhoto({
      version: 1,
      stage: 'main_updated',
      operationId: checkpoint.operationId,
      fingerprint: checkpoint.fingerprint,
      slug: checkpoint.slug,
      commitSha: checkpoint.commitSha,
      attempts: checkpoint.attempts,
      profileBlobSha: checkpoint.profileBlobSha,
    }, checkpoint.photoBlobSha));

    if (this.options.stateStore.saveBatch) {
      try {
        await this.options.stateStore.saveBatch(mainUpdated);
      } catch (error) {
        this.options.onWarning('Could not persist the main_updated publish checkpoints.', error);
      }
      return;
    }

    for (const checkpoint of mainUpdated) {
      try {
        await this.options.stateStore.save(checkpoint);
      } catch (error) {
        this.options.onWarning('Could not persist the main_updated publish checkpoint.', error);
      }
    }
  }

  private async clearValidatedCheckpoints(operationIds: string[]) {
    if (!this.options.stateStore) {
      return;
    }

    await Promise.all(operationIds.map(async (operationId) => {
      try {
        await this.options.stateStore!.clear(operationId);
      } catch (error) {
        this.options.onWarning(`Could not clear publish checkpoint ${operationId}.`, error);
      }
    }));
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

  private async pollSleep(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.options.sleep(this.options.pollIntervalMs, signal);
    signal.throwIfAborted();
  }

  private async requestData(
    route: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const response = await this.request(route, parameters, signal);

    if (!isRecord(response.data)) {
      throw invalidGitHubResponse(`${route} returned a non-object response.`);
    }

    return response.data;
  }

  private async request(
    route: string,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return this.options.request(route, {
      owner: this.options.owner,
      repo: this.options.repo,
      ...parameters,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
      },
    }, signal);
  }
}

function normalizeOptions(options: GitHubProfilePublisherOptions): NormalizedOptions {
  if (!options.owner.trim() || !options.repo.trim()) {
    throw new ProfilePublisherError('invalid_input', 'GitHub owner and repo are required.');
  }

  // The global publication deadline is authoritative. Phase deadlines remain
  // narrower so a stalled workflow fails with the most specific available code.
  return {
    request: options.request,
    owner: options.owner.trim(),
    repo: options.repo.trim(),
    defaultBranch: options.defaultBranch?.trim() || 'main',
    validateWorkflow: options.validateWorkflow?.trim() || 'validate-profile-bot.yml',
    deployWorkflow: options.deployWorkflow?.trim() || 'deploy.yml',
    sleep: options.sleep ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal })),
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
    publishTimeoutMs: publicationTimeout(options.publishTimeoutMs),
    maxConflictAttempts: conflictAttemptCount(options.maxConflictAttempts),
    ...(options.stateStore ? { stateStore: options.stateStore } : {}),
    onWarning: options.onWarning ?? (() => undefined),
  };
}

function prepareBatchInputs(inputs: readonly ProfilePublishInput[]) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > PROFILE_PUBLISH_BATCH_MAX_SIZE) {
    throw new ProfilePublisherError(
      'invalid_input',
      `Profile publish batches must contain between 1 and ${PROFILE_PUBLISH_BATCH_MAX_SIZE} items.`,
    );
  }

  const prepared = inputs.map(prepareInput);
  const slugs = new Set<string>();
  const operationIds = new Set<string>();

  for (const input of prepared) {
    if (slugs.has(input.slug)) {
      throw new ProfilePublisherError('invalid_input', `Profile slug ${input.slug} appears twice in one batch.`);
    }
    if (operationIds.has(input.operationId)) {
      throw new ProfilePublisherError(
        'invalid_input',
        `Operation ID ${input.operationId} appears twice in one batch.`,
      );
    }
    slugs.add(input.slug);
    operationIds.add(input.operationId);
  }

  return prepared;
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
  if (
    checkpoint.version !== 1
    || checkpoint.operationId !== input.operationId
    || checkpoint.slug !== input.slug
    || checkpoint.fingerprint !== input.fingerprint
  ) {
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

function temporaryBranchName(
  inputs: PreparedInput[],
  expectedDiff: DiffExpectation[],
  attempt: number,
) {
  if (inputs.length === 1) {
    const [input] = inputs;
    return `bot/profile/${input!.slug}/${input!.operationId}/a${attempt}`;
  }

  const identity = createHash('sha256');
  for (const input of [...inputs].sort((left, right) => left.slug.localeCompare(right.slug))) {
    identity.update(input.slug);
    identity.update('\0');
    identity.update(input.operationId);
    identity.update('\0');
    identity.update(input.fingerprint);
    identity.update('\n');
  }

  return `bot/profile-batch/${identity.digest('hex').slice(0, 24)}/${diffManifestHash(expectedDiff)}/a${attempt}`;
}

function diffManifestHash(expectedDiff: DiffExpectation[]) {
  const status = { added: 'A', modified: 'M', removed: 'D' } as const;
  const manifest = expectedDiff
    .map((entry) => `${status[entry.status]}\t${entry.path}\n`)
    .sort()
    .join('');
  return createHash('sha256').update(manifest).digest('hex');
}

function batchCommitMessage(inputs: PreparedInput[]) {
  const noun = inputs.length === 1 ? 'profile update' : 'profile updates';
  const trailers = inputs
    .map((input) => `Profile-Operation: ${input.slug} ${input.operationId}`)
    .join('\n');
  return `Profiles: publish ${inputs.length} ${noun}\n\n${trailers}`;
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

function publicationTimeout(value: number | undefined) {
  const selected = positiveInteger(value, PROFILE_PUBLISH_TIMEOUT_MS, 'publishTimeoutMs');
  if (selected > PROFILE_PUBLISH_TIMEOUT_MS) {
    throw new ProfilePublisherError(
      'invalid_input',
      `publishTimeoutMs cannot exceed ${PROFILE_PUBLISH_TIMEOUT_MS}.`,
    );
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

function isExplicitRefUpdateRejection(error: unknown) {
  const status = getErrorStatus(error);
  return status === 403 || status === 409 || status === 422;
}

function invalidGitHubResponse(message: string) {
  return new ProfilePublisherError('github_response_invalid', message);
}

function publicationTimeoutError(cause?: unknown) {
  return new ProfilePublisherError(
    'publication_timeout',
    'Profile publication exceeded its safety deadline.',
    cause === undefined ? undefined : { cause },
  );
}

function isPublicationTimeoutError(error: unknown) {
  return error instanceof ProfilePublisherError && error.code === 'publication_timeout';
}

function publicationTimeoutReason(signal: AbortSignal, cause?: unknown) {
  return isPublicationTimeoutError(signal.reason)
    ? signal.reason
    : publicationTimeoutError(cause);
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

function candidateItemWithOptionalPhoto(
  candidate: Omit<CandidateItem, 'photoBlobSha'>,
  photoBlobSha: string | null | undefined,
): CandidateItem {
  return photoBlobSha === undefined ? candidate : { ...candidate, photoBlobSha };
}

function requireBatchResults(results: Array<PublishResult | undefined>) {
  if (results.length === 0 || results.some((result) => result === undefined)) {
    throw invalidGitHubResponse('Profile publish batch completed without every item result.');
  }
  return results as PublishResult[];
}

function resultWithOptionalPhoto(
  result: Omit<PublishResult, 'photoBlobSha'>,
  photoBlobSha: string | null | undefined,
): PublishResult {
  return typeof photoBlobSha === 'string' ? { ...result, photoBlobSha } : result;
}

function candidateCheckpointWithOptionalPhoto(
  checkpoint: Omit<CandidateValidatedCheckpoint, 'photoBlobSha'>,
  photoBlobSha: string | null | undefined,
): CandidateValidatedCheckpoint {
  return typeof photoBlobSha === 'string' ? { ...checkpoint, photoBlobSha } : checkpoint;
}

function mainUpdatedCheckpointWithOptionalPhoto(
  checkpoint: Omit<MainUpdatedCheckpoint, 'photoBlobSha'>,
  photoBlobSha: string | null | undefined,
): MainUpdatedCheckpoint {
  return typeof photoBlobSha === 'string' ? { ...checkpoint, photoBlobSha } : checkpoint;
}
