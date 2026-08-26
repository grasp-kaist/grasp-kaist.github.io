import { serve, type ServerType } from '@hono/node-server';

type FetchCallback = Parameters<typeof serve>[0]['fetch'];

export function startHealthServer(options: {
  fetch: FetchCallback;
  port: number;
  hostname?: string;
}): ServerType {
  return serve({
    fetch: options.fetch,
    port: options.port,
    ...(options.hostname ? { hostname: options.hostname } : {}),
  });
}

export async function closeHttpServerWithin(
  server: ServerType,
  timeoutMs: number,
): Promise<{ timedOut: boolean; error?: Error }> {
  const closeResult = new Promise<{ timedOut: false; error?: Error }>((resolve) => {
    server.close((error) => resolve({
      timedOut: false,
      ...(error ? { error } : {}),
    }));
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<{ timedOut: true }>((resolve) => {
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([closeResult, timeoutResult]);

  if (timeout) {
    clearTimeout(timeout);
  }

  if (result.timedOut) {
    const forceClose = (server as ServerType & { closeAllConnections?: () => void })
      .closeAllConnections;
    forceClose?.call(server);
  }

  return result;
}

export async function waitForPromiseWithin(
  task: Promise<unknown>,
  timeoutMs: number,
): Promise<{ timedOut: boolean; error?: unknown }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('Promise timeout must be a finite, non-negative number.');
  }

  const completion = task.then(
    () => ({ timedOut: false as const }),
    (error: unknown) => ({ timedOut: false as const, error }),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<{ timedOut: true }>((resolve) => {
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  const result = await Promise.race([completion, timeoutResult]);

  if (timeout) {
    clearTimeout(timeout);
  }

  return result;
}

export async function finishPublicationQueueStartup(options: {
  drain: () => Promise<void>;
  countRemaining: () => number;
  nextAttemptDelayMs?: () => number | undefined;
  sleep?: (milliseconds: number) => Promise<void>;
  onAttemptError?: (error: unknown) => void;
  markReady: () => void;
}) {
  const sleep = options.sleep ?? delay;

  while (true) {
    let drainError: unknown;
    try {
      await options.drain();
    } catch (error) {
      drainError = error;
      options.onAttemptError?.(error);
    }

    const remaining = options.countRemaining();
    if (!drainError && remaining === 0) {
      options.markReady();
      return;
    }

    const retryDelay = options.nextAttemptDelayMs?.();
    if (retryDelay === undefined) {
      if (drainError) {
        throw drainError;
      }
      throw new Error(
        `Publication startup drain left ${remaining} unapplied or actively leased job(s).`,
      );
    }
    if (!Number.isFinite(retryDelay) || retryDelay < 0) {
      throw new Error('Publication startup recovery returned an invalid retry delay.');
    }
    await sleep(Math.max(1, retryDelay));
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
