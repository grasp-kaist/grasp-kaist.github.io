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
