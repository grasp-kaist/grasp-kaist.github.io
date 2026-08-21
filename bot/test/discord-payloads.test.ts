import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyProfile } from '../src/domain/member-profile.js';
import { guildCommands, registerGuildCommands } from '../src/discord/commands.js';
import {
  IS_COMPONENTS_V2_FLAG,
  photoUploadModalResponse,
  preparedPhotoPreviewEdit,
  profilePanelResponse,
  registerModalResponse,
} from '../src/discord/payloads.js';
import type { ProfileSnapshot } from '../src/discord/types.js';

test('guild commands expose fixed category choices and no destructive delete command', () => {
  const register = guildCommands.find((command) => command.name === 'register');
  assert.deepEqual(
    register?.options?.[0]?.choices?.map((choice) => choice.value),
    [0, 1, 2, 3, 4, 5],
  );

  const admin = guildCommands.find((command) => command.name === 'profile-admin');
  assert.equal(admin && 'default_member_permissions' in admin, false);
  assert.deepEqual(
    admin?.options?.map((option) => option.name),
    ['hide', 'revoke', 'restore', 'transfer', 'set-category'],
  );
});

test('command registration uses the guild bulk-overwrite endpoint', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await registerGuildCommands(
    { applicationId: '123', guildId: '456', botToken: 'secret' },
    fakeFetch,
  );

  assert.equal(
    requestUrl,
    'https://discord.com/api/v10/applications/123/guilds/456/commands',
  );
  assert.equal(requestInit?.method, 'PUT');
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, 'Bot secret');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), guildCommands);
});

test('registration and file upload modals use Label-based current components', () => {
  const registration = registerModalResponse(4);
  const registerComponents = registration.data?.components as Array<Record<string, unknown>>;
  assert.equal(registration.type, 9);
  assert.equal(registerComponents[0]?.type, 10);
  assert.equal(registerComponents.some((component) => component.type === 1), false);
  assert.deepEqual(
    registerComponents.slice(1).map((component) => ({
      type: component.type,
      childType: (component.component as Record<string, unknown>).type,
    })),
    [
      { type: 18, childType: 4 },
      { type: 18, childType: 4 },
      { type: 18, childType: 22 },
    ],
  );

  const upload = photoUploadModalResponse();
  const uploadLabel = (upload.data?.components as Array<Record<string, unknown>>)[0]!;
  const fileComponent = uploadLabel.component as Record<string, unknown>;
  assert.equal(uploadLabel.type, 18);
  assert.equal(fileComponent.type, 19);
  assert.deepEqual(fileComponent.file_types, ['.jpg', '.jpeg', '.png', '.webp']);
  assert.equal(upload.data?.flags, undefined);
});

test('profile panel is ephemeral Components V2 with bounded action rows', () => {
  const response = profilePanelResponse({
    ...snapshot(),
    lastDeploymentStatus: 'success',
    lastCommitSha: 'abcdef1234567890',
  });
  assert.equal(response.type, 4);
  assert.equal(response.data?.flags, 64 | IS_COMPONENTS_V2_FLAG);
  assert.equal(response.data?.content, undefined);
  assert.equal(response.data?.embeds, undefined);

  const container = (response.data?.components as Array<Record<string, unknown>>)[0]!;
  assert.equal(container.type, 17);
  const containerComponents = container.components as Array<Record<string, unknown>>;
  const summary = containerComponents.find((component) => component.type === 10)?.content;
  assert.match(String(summary), /Last deployment: \*\*success\*\*/);
  assert.match(String(summary), /Last commit: `abcdef123456`/);
  const rows = containerComponents.filter(
    (component) => component.type === 1,
  );
  assert.ok(rows.length >= 2);
  assert.ok(
    rows.every(
      (row) => (row.components as Array<Record<string, unknown>>).length <= 5,
    ),
  );
});

test('prepared photo preview attaches WebP and binds confirm/cancel to its token', () => {
  const preview = preparedPhotoPreviewEdit({
    stagedPhotoId: 'stage_abc-123',
    previewBytes: new Uint8Array([1, 2, 3]),
    width: 800,
    height: 1000,
  });

  assert.equal(preview.payload.flags, IS_COMPONENTS_V2_FLAG);
  assert.deepEqual(preview.payload.attachments, [
    {
      id: 0,
      filename: 'profile-preview.webp',
      description: 'Processed GRASP profile photo preview',
    },
  ]);
  assert.equal(preview.files[0]?.filename, 'profile-preview.webp');

  const components = preview.payload.components as Array<Record<string, unknown>>;
  const gallery = components.find((component) => component.type === 12)!;
  assert.equal(
    ((gallery.items as Array<Record<string, unknown>>)[0]?.media as Record<string, unknown>).url,
    'attachment://profile-preview.webp',
  );
  const row = components.find((component) => component.type === 1)!;
  assert.deepEqual(
    (row.components as Array<Record<string, unknown>>).map((button) => button.custom_id),
    ['profile:photo-confirm:stage_abc-123', 'profile:photo-cancel:stage_abc-123'],
  );
});

function snapshot(): ProfileSnapshot {
  return {
    profileSlug: 'example',
    bindingStatus: 'active',
    profile: createEmptyProfile({
      name: 'Example Member',
      position: 'Undergraduate Student, KAIST',
      order: 4,
    }),
  };
}
