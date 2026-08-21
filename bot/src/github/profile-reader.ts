import { assertMemberProfile, type MemberProfile } from '../domain/member-profile.js';
import type { GitHubRequest } from './profile-publisher.js';

const API_VERSION = '2026-03-10';
const PROFILE_DIRECTORY = 'src/data/members';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PROFILE_JSON_BYTES = 64 * 1024;

export type PublishedProfileSnapshot = {
  profile: MemberProfile;
  profileBlobSha: string;
  photoBlobSha?: string;
  commitSha: string;
  operationId?: string;
};

export class GitHubProfileReaderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitHubProfileReaderError';
  }
}

export class GitHubProfileReader {
  readonly #githubRequest: GitHubRequest;
  readonly #owner: string;
  readonly #repo: string;
  readonly #defaultBranch: string;

  constructor(options: {
    request: GitHubRequest;
    owner: string;
    repo: string;
    defaultBranch?: string;
  }) {
    this.#githubRequest = options.request;
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#defaultBranch = options.defaultBranch?.trim() || 'main';
  }

  async readProfile(slug: string): Promise<PublishedProfileSnapshot | null> {
    if (!SLUG_PATTERN.test(slug) || slug.length > 64) {
      throw new GitHubProfileReaderError('Profile slug is invalid.');
    }

    const reference = await this.#requestData('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      ref: `heads/${this.#defaultBranch}`,
    });
    const commitSha = requireNestedString(reference, ['object', 'sha'], 'branch commit SHA');
    const profilePath = `${PROFILE_DIRECTORY}/${slug}.json`;
    const profileContent = await this.#getContent(profilePath, commitSha);

    if (!profileContent) {
      return null;
    }

    if (profileContent.encoding !== 'base64') {
      throw new GitHubProfileReaderError(`${profilePath} was not returned as base64 content.`);
    }

    const jsonBytes = decodeBase64(profileContent.content, profilePath);

    if (jsonBytes.byteLength > MAX_PROFILE_JSON_BYTES) {
      throw new GitHubProfileReaderError(`${profilePath} exceeds the profile JSON size limit.`);
    }

    let profile: unknown;

    try {
      profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes));
      assertMemberProfile(profile);
    } catch (error) {
      throw new GitHubProfileReaderError(`${profilePath} is not a canonical member profile.`, {
        cause: error,
      });
    }

    if (profile.photo !== '' && profile.photo !== `${slug}.webp`) {
      throw new GitHubProfileReaderError(
        `${profilePath} references a photo outside the bot-managed WebP path.`,
      );
    }

    let latestRelevantCommit = await this.#getLatestProfileCommit(profilePath, commitSha);
    const result: PublishedProfileSnapshot = {
      profile,
      profileBlobSha: profileContent.sha,
      commitSha: latestRelevantCommit.sha,
    };

    if (profile.photo) {
      const photoPath = `${PROFILE_DIRECTORY}/${slug}.webp`;
      const photoContent = await this.#getContent(photoPath, commitSha);

      if (!photoContent) {
        throw new GitHubProfileReaderError(`${profile.photo} is missing from the repository.`);
      }

      result.photoBlobSha = photoContent.sha;
      const latestPhotoCommit = await this.#getLatestProfileCommit(photoPath, commitSha);
      latestRelevantCommit = await this.#selectNewerCommit(
        latestRelevantCommit,
        latestPhotoCommit,
      );
      result.commitSha = latestRelevantCommit.sha;
    }

    const operationId = getOperationIdTrailer(latestRelevantCommit.message);

    if (operationId) {
      result.operationId = operationId;
    }

    return result;
  }

  async #getLatestProfileCommit(path: string, commitSha: string) {
    const response = await this.#request('GET /repos/{owner}/{repo}/commits', {
      path,
      sha: commitSha,
      per_page: 1,
    });

    if (!Array.isArray(response.data) || response.data.length !== 1) {
      throw new GitHubProfileReaderError(`GitHub did not return the latest commit for ${path}.`);
    }

    const entry = response.data[0];

    if (!isRecord(entry) || !isRecord(entry.commit)) {
      throw new GitHubProfileReaderError(`GitHub returned an invalid commit for ${path}.`);
    }

    return {
      sha: requireString(entry, 'sha', `${path} commit SHA`),
      message: requireString(entry.commit, 'message', `${path} commit message`),
    };
  }

  async #selectNewerCommit<T extends { sha: string; message: string }>(left: T, right: T) {
    if (left.sha === right.sha) {
      return left;
    }

    const comparison = await this.#requestData(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      { basehead: `${left.sha}...${right.sha}` },
    );

    if (comparison.status === 'ahead') {
      return right;
    }

    if (comparison.status === 'behind') {
      return left;
    }

    throw new GitHubProfileReaderError(
      'The latest profile JSON and photo commits are not on one linear history.',
    );
  }

  async #getContent(path: string, ref: string) {
    try {
      const data = await this.#requestData('GET /repos/{owner}/{repo}/contents/{path}', {
        path,
        ref,
      });

      if (data.type !== 'file') {
        throw new GitHubProfileReaderError(`${path} is not a regular file.`);
      }

      return {
        sha: requireString(data, 'sha', `${path} blob SHA`),
        content: requireString(data, 'content', `${path} content`),
        encoding: requireString(data, 'encoding', `${path} encoding`),
      };
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        return null;
      }

      throw error;
    }
  }

  async #requestData(route: string, parameters: Record<string, unknown>) {
    const response = await this.#request(route, parameters);

    if (!isRecord(response.data)) {
      throw new GitHubProfileReaderError(`${route} returned an invalid response.`);
    }

    return response.data;
  }

  async #request(route: string, parameters: Record<string, unknown>) {
    return this.#githubRequest(route, {
      owner: this.#owner,
      repo: this.#repo,
      ...parameters,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
      },
    });
  }
}

function getOperationIdTrailer(message: string) {
  const match = message.match(/(?:^|\n)Profile-Operation: ([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\n|$)/);
  return match?.[1];
}

function decodeBase64(content: string, path: string) {
  const compact = content.replace(/\s/g, '');

  if (
    compact.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
  ) {
    throw new GitHubProfileReaderError(`${path} contains invalid base64 data.`);
  }

  return Buffer.from(compact, 'base64');
}

function requireString(value: Record<string, unknown>, field: string, label: string) {
  const selected = value[field];

  if (typeof selected !== 'string' || !selected) {
    throw new GitHubProfileReaderError(`GitHub response is missing ${label}.`);
  }

  return selected;
}

function requireNestedString(value: Record<string, unknown>, path: string[], label: string) {
  let current: unknown = value;

  for (const part of path) {
    if (!isRecord(current)) {
      throw new GitHubProfileReaderError(`GitHub response is missing ${label}.`);
    }

    current = current[part];
  }

  if (typeof current !== 'string' || !current) {
    throw new GitHubProfileReaderError(`GitHub response is missing ${label}.`);
  }

  return current;
}

function getErrorStatus(error: unknown) {
  return isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
