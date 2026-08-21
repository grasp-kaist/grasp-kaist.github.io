import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';

import { getUploadedAttachment } from '../src/discord/inputs.js';
import { DiscordInteractionHttpHandler } from '../src/discord/http.js';
import {
  verifyAndParseDiscordInteraction,
  verifyDiscordSignature,
} from '../src/discord/signature.js';
import type { DiscordInteraction } from '../src/discord/types.js';
import {
  DiscordAttachmentDownloadError,
  DiscordCdnAttachmentDownloader,
  DiscordInteractionWebhookClient,
} from '../src/discord/webhook.js';

test('Discord Ed25519 signatures are checked against the exact raw body', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const discordPublicKey = publicDer.subarray(-32).toString('hex');
  const timestamp = '1777000000';
  const body = JSON.stringify({
    id: '111111111111111111',
    application_id: '222222222222222222',
    type: 1,
    token: 'interaction-token',
  });
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]),
    privateKey,
  ).toString('hex');

  assert.equal(
    await verifyDiscordSignature({
      rawBody: body,
      signature,
      timestamp,
      publicKey: discordPublicKey,
    }),
    true,
  );
  assert.equal(
    await verifyDiscordSignature({
      rawBody: `${body} `,
      signature,
      timestamp,
      publicKey: discordPublicKey,
    }),
    false,
  );

  const parsed = await verifyAndParseDiscordInteraction({
    rawBody: body,
    signature,
    timestamp,
    publicKey: discordPublicKey,
  });
  assert.equal(parsed?.type, 1);
});

test('HTTP boundary rejects unsigned payloads before routing and accepts a signed ping', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const discordPublicKey = publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex');
  let routeCalls = 0;
  const handler = new DiscordInteractionHttpHandler(discordPublicKey, {
    route: async () => {
      routeCalls += 1;
      return { response: { type: 1 } };
    },
  });
  const rawBody = Buffer.from(
    JSON.stringify({
      id: '111111111111111111',
      application_id: '222222222222222222',
      type: 1,
      token: 'token',
    }),
  );
  const timestamp = '1777000000';

  const denied = await handler.handle({
    rawBody,
    signature: '00',
    timestamp,
  });
  assert.equal(denied.status, 401);
  assert.equal(routeCalls, 0);

  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), rawBody]),
    privateKey,
  ).toString('hex');
  const accepted = await handler.handle({ rawBody, signature, timestamp });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { type: 1 });
  assert.equal(routeCalls, 1);
});

test('file upload parser resolves the submitted attachment ID rather than object order', () => {
  const interaction = {
    id: '111111111111111111',
    application_id: '222222222222222222',
    type: 5,
    token: 'token',
    data: {
      custom_id: 'profile-photo:v1',
      components: [
        {
          type: 18,
          component: {
            type: 19,
            custom_id: 'photo',
            values: ['444444444444444444'],
          },
        },
      ],
      resolved: {
        attachments: {
          '333333333333333333': attachment('333333333333333333', 'wrong.png'),
          '444444444444444444': attachment('444444444444444444', 'right.png'),
        },
      },
    },
  } satisfies DiscordInteraction;

  assert.equal(getUploadedAttachment(interaction).filename, 'right.png');
});

test('Discord CDN downloader rejects non-Discord URLs and declared oversize files before fetch', async () => {
  let fetchCalls = 0;
  const fakeFetch = (async () => {
    fetchCalls += 1;
    return new Response(new Uint8Array([1]));
  }) as typeof fetch;
  const downloader = new DiscordCdnAttachmentDownloader({
    fetchImplementation: fakeFetch,
    maxBytes: 4,
  });

  await assert.rejects(
    downloader.download({
      ...attachment('444444444444444444', 'photo.png'),
      url: 'https://example.com/photo.png',
    }),
    DiscordAttachmentDownloadError,
  );
  await assert.rejects(
    downloader.download({
      ...attachment('444444444444444444', 'photo.png'),
      size: 5,
    }),
    DiscordAttachmentDownloadError,
  );
  assert.equal(fetchCalls, 0);
});

test('Discord CDN downloader enforces the streamed byte limit', async () => {
  const fakeFetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 })) as typeof fetch;
  const downloader = new DiscordCdnAttachmentDownloader({
    fetchImplementation: fakeFetch,
    maxBytes: 4,
  });

  await assert.rejects(
    downloader.download({
      ...attachment('444444444444444444', 'photo.png'),
      size: 4,
    }),
    /too large/,
  );
});

test('interaction webhook client creates multipart edit payloads without authorization headers', async () => {
  let requestInit: RequestInit | undefined;
  const fakeFetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    requestInit = init;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const client = new DiscordInteractionWebhookClient('222222222222222222', fakeFetch);

  await client.editOriginal(
    'interaction-token',
    {
      flags: 32768,
      attachments: [{ id: 0, filename: 'preview.webp' }],
      components: [],
    },
    [
      {
        filename: 'preview.webp',
        bytes: new Uint8Array([1, 2, 3]),
        contentType: 'image/webp',
      },
    ],
  );

  assert.equal(requestInit?.method, 'PATCH');
  assert.equal(requestInit?.headers, undefined);
  assert.ok(requestInit?.body instanceof FormData);
  const form = requestInit.body as FormData;
  assert.equal(
    JSON.parse(String(form.get('payload_json'))).attachments[0].filename,
    'preview.webp',
  );
  const file = form.get('files[0]');
  assert.ok(file instanceof File);
  assert.equal(file.name, 'preview.webp');
  assert.equal(file.type, 'image/webp');
});

function attachment(id: string, filename: string) {
  return {
    id,
    filename,
    size: 3,
    content_type: 'image/png',
    url: `https://cdn.discordapp.com/ephemeral-attachments/1/${id}/${filename}?ex=abc`,
    proxy_url: `https://media.discordapp.net/ephemeral-attachments/1/${id}/${filename}?ex=abc`,
    ephemeral: true,
  };
}
