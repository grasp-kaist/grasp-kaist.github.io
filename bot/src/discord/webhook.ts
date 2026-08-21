import type {
  AttachmentDownloader,
  DiscordAttachment,
  DiscordMessageFile,
  DiscordMessagePayload,
  InteractionWebhookClient,
} from './types.js';

const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10_000;
const ALLOWED_DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export class DiscordWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordWebhookError';
  }
}

export class DiscordAttachmentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordAttachmentDownloadError';
  }
}

export class DiscordInteractionWebhookClient implements InteractionWebhookClient {
  readonly #applicationId: string;
  readonly #fetch: typeof fetch;

  constructor(applicationId: string, fetchImplementation: typeof fetch = fetch) {
    this.#applicationId = applicationId;
    this.#fetch = fetchImplementation;
  }

  async editOriginal(
    interactionToken: string,
    payload: DiscordMessagePayload,
    files: readonly DiscordMessageFile[] = [],
  ) {
    const endpoint = new URL(
      `https://discord.com/api/v10/webhooks/${encodeURIComponent(this.#applicationId)}/` +
        `${encodeURIComponent(interactionToken)}/messages/@original`,
    );
    const init: RequestInit = { method: 'PATCH', signal: AbortSignal.timeout(10_000) };

    if (files.length === 0) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(payload);
    } else {
      const form = new FormData();
      form.set('payload_json', JSON.stringify(payload));

      files.forEach((file, index) => {
        const blob = new Blob([Buffer.from(file.bytes)], {
          type: file.contentType ?? 'application/octet-stream',
        });
        form.set(`files[${index}]`, blob, file.filename);
      });
      init.body = form;
    }

    const response = await this.#fetch(endpoint, init);

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new DiscordWebhookError(
        `Discord interaction response edit failed (${response.status}): ${detail}`,
      );
    }
  }
}

export class DiscordCdnAttachmentDownloader implements AttachmentDownloader {
  readonly #fetch: typeof fetch;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;

  constructor(options: {
    fetchImplementation?: typeof fetch;
    maxBytes?: number;
    timeoutMs?: number;
  } = {}) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new TypeError('maxBytes must be a positive safe integer.');
    }

    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a positive safe integer.');
    }
  }

  async download(attachment: DiscordAttachment) {
    if (attachment.size > this.#maxBytes) {
      throw new DiscordAttachmentDownloadError(
        `The uploaded photo exceeds the ${this.#maxBytes}-byte processing limit.`,
      );
    }

    const url = assertAllowedDiscordCdnUrl(attachment.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'image/*' },
      });

      if (!response.ok) {
        throw new DiscordAttachmentDownloadError(
          `Discord attachment download failed with status ${response.status}.`,
        );
      }

      if (response.url) {
        assertAllowedDiscordCdnUrl(response.url);
      }

      const declaredLength = response.headers.get('content-length');

      if (declaredLength) {
        const parsedLength = Number(declaredLength);

        if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
          throw new DiscordAttachmentDownloadError('Discord returned an invalid content length.');
        }

        if (parsedLength > this.#maxBytes) {
          throw new DiscordAttachmentDownloadError('The downloaded photo is too large.');
        }
      }

      return await readResponseWithLimit(response, this.#maxBytes);
    } catch (error) {
      if (error instanceof DiscordAttachmentDownloadError) {
        throw error;
      }

      if (controller.signal.aborted) {
        throw new DiscordAttachmentDownloadError('The Discord attachment download timed out.');
      }

      throw new DiscordAttachmentDownloadError('Unable to download the Discord attachment.');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function assertAllowedDiscordCdnUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new DiscordAttachmentDownloadError('Discord attachment URL is invalid.');
  }

  if (url.protocol !== 'https:' || !ALLOWED_DISCORD_CDN_HOSTS.has(url.hostname)) {
    throw new DiscordAttachmentDownloadError('Discord attachment URL host is not allowed.');
  }

  return url;
}

async function readResponseWithLimit(response: Response, maxBytes: number) {
  if (!response.body) {
    throw new DiscordAttachmentDownloadError('Discord attachment response had no body.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      total += value.byteLength;

      if (total > maxBytes) {
        await reader.cancel();
        throw new DiscordAttachmentDownloadError('The downloaded photo is too large.');
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
}
