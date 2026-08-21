import type { DiscordInteractionRouter } from './router.js';
import { verifyAndParseDiscordInteraction } from './signature.js';
import type { DiscordInteractionResponse } from './types.js';

export type DiscordHttpInteractionResult = {
  status: 200 | 400 | 401;
  body: DiscordInteractionResponse | { error: string };
  afterResponse?: () => Promise<void>;
};

/**
 * Framework-neutral HTTP boundary. The adapter must preserve the exact raw
 * request body, return `body` first, and only then run `afterResponse`.
 */
export class DiscordInteractionHttpHandler {
  readonly #publicKey: string;
  readonly #router: Pick<DiscordInteractionRouter, 'route'>;

  constructor(publicKey: string, router: Pick<DiscordInteractionRouter, 'route'>) {
    this.#publicKey = publicKey;
    this.#router = router;
  }

  async handle(input: {
    rawBody: Uint8Array;
    signature: string | null | undefined;
    timestamp: string | null | undefined;
  }): Promise<DiscordHttpInteractionResult> {
    let interaction;

    try {
      interaction = await verifyAndParseDiscordInteraction({
        rawBody: input.rawBody,
        signature: input.signature,
        timestamp: input.timestamp,
        publicKey: this.#publicKey,
      });
    } catch {
      return { status: 400, body: { error: 'invalid interaction body' } };
    }

    if (!interaction) {
      return { status: 401, body: { error: 'invalid request signature' } };
    }

    const routed = await this.#router.route(interaction);
    return {
      status: 200,
      body: routed.response,
      ...(routed.afterResponse ? { afterResponse: routed.afterResponse } : {}),
    };
  }
}

/**
 * Convenience for Node adapters after they have constructed/returned their
 * HTTP response. Errors are reported instead of becoming unhandled rejections.
 */
export function scheduleDiscordAfterResponse(
  result: DiscordHttpInteractionResult,
  reportError: (error: unknown) => void = console.error,
) {
  if (!result.afterResponse) {
    return;
  }

  const task = result.afterResponse;
  setImmediate(() => {
    void task().catch(reportError);
  });
}
