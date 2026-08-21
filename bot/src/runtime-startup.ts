import { serve, type ServerType } from '@hono/node-server';

type FetchCallback = Parameters<typeof serve>[0]['fetch'];

export function startHttpBeforeRecovery<T>(options: {
  fetch: FetchCallback;
  port: number;
  hostname?: string;
  recover: () => Promise<T>;
}): { server: ServerType; recovery: Promise<T> } {
  const server = serve({
    fetch: options.fetch,
    port: options.port,
    ...(options.hostname ? { hostname: options.hostname } : {}),
  });
  const recovery = Promise.resolve().then(options.recover);
  return { server, recovery };
}

export function startOnNextTurn(task: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      try {
        void task().then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
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
