import { PROFILE_PUBLISH_REQUEST_TIMEOUT_MS } from './profile-publisher.js';

export function createBoundedGitHubFetch(
  fetchImplementation: typeof fetch = globalThis.fetch,
  timeoutMs = PROFILE_PUBLISH_REQUEST_TIMEOUT_MS,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const signals = [AbortSignal.timeout(timeoutMs)];

    if (input instanceof Request) {
      signals.push(input.signal);
    }
    if (init?.signal) {
      signals.push(init.signal);
    }

    return fetchImplementation(input, {
      ...init,
      signal: AbortSignal.any(signals),
    });
  }) as typeof fetch;
}

export function withGitHubRequestLimits(
  parameters: Record<string, unknown>,
  operationSignal?: AbortSignal,
  timeoutMs = PROFILE_PUBLISH_REQUEST_TIMEOUT_MS,
) {
  const requestOptions = isRecord(parameters.request) ? parameters.request : {};
  const requestSignal = AbortSignal.timeout(timeoutMs);
  const signal = operationSignal
    ? AbortSignal.any([operationSignal, requestSignal])
    : requestSignal;

  return {
    ...parameters,
    request: {
      ...requestOptions,
      retries: 0,
      signal,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
