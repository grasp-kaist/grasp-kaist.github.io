import { Hono } from 'hono';

import type {
  DiscordHttpInteractionResult,
  DiscordInteractionHttpHandler,
} from './discord/http.js';

export const MAX_INTERACTION_BODY_BYTES = 1024 * 1024;

export function createHttpApp(options: {
  interactionHandler: Pick<DiscordInteractionHttpHandler, 'handle'>;
  scheduleAfterResponse: (result: DiscordHttpInteractionResult) => void;
}) {
  const app = new Hono();

  app.get('/healthz', (context) => {
    return context.json({ status: 'ok' });
  });

  app.post('/interactions', async (context) => {
    const declaredLength = context.req.header('content-length');

    if (declaredLength) {
      const parsedLength = Number(declaredLength);

      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        return context.json({ error: 'invalid content length' }, 400);
      }

      if (parsedLength > MAX_INTERACTION_BODY_BYTES) {
        return context.json({ error: 'interaction body too large' }, 413);
      }
    }

    const rawBody = new Uint8Array(await context.req.arrayBuffer());

    if (rawBody.byteLength > MAX_INTERACTION_BODY_BYTES) {
      return context.json({ error: 'interaction body too large' }, 413);
    }

    const result = await options.interactionHandler.handle({
      rawBody,
      signature: context.req.header('x-signature-ed25519'),
      timestamp: context.req.header('x-signature-timestamp'),
    });
    options.scheduleAfterResponse(result);
    return context.json(result.body, result.status);
  });

  app.notFound((context) => context.json({ error: 'not found' }, 404));
  return app;
}
