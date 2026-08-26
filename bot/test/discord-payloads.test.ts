import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyProfile } from '../src/domain/member-profile.js';
import { guildCommands } from '../src/discord/commands.js';
import {
  categoryModalResponse,
  editBasicModalResponse,
  editTextModalResponse,
  IS_COMPONENTS_V2_FLAG,
  operationCompleteEdit,
  photoUploadModalResponse,
  preparedPhotoPreviewEdit,
  profilePanelResponse,
  registerModalResponse,
} from '../src/discord/payloads.js';
import type { ProfileSnapshot } from '../src/discord/types.js';

const STATE_REVISION = '0123456789abcdefabcd';

test('guild commands expose only register and profile with fixed category choices', () => {
  const register = guildCommands.find((command) => command.name === 'register');
  assert.deepEqual(
    register?.options?.[0]?.choices?.map((choice) => choice.value),
    [0, 1, 2, 3, 4, 5],
  );

  assert.deepEqual(guildCommands.map((command) => command.name), ['register', 'profile']);
});

test('registration and file upload modals use Label-based current components', () => {
  const registration = registerModalResponse(4);
  const registerComponents = registration.data?.components as Array<Record<string, unknown>>;
  assert.equal(registration.type, 9);
  assert.equal(registration.data?.custom_id, 'register:v1:production:4');
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

test('sandbox UI states clearly that the live website is not being changed', () => {
  const registration = registerModalResponse(4, 'sandbox');
  const registerComponents = registration.data?.components as Array<Record<string, unknown>>;
  assert.match(String(registerComponents[0]?.content), /sandbox/i);
  assert.match(String(registerComponents[0]?.content), /website will not change/i);
  assert.equal(registration.data?.custom_id, 'register:v1:sandbox:4');

  const response = profilePanelResponse(
    { ...snapshot(), lastDeploymentStatus: 'sandbox' },
    'sandbox',
  );
  const container = (response.data?.components as Array<Record<string, unknown>>)[0]!;
  const components = container.components as Array<Record<string, unknown>>;
  const summary = String(components.find((component) => component.type === 10)?.content);
  assert.match(summary, /Sandbox listing flag/);
  assert.match(summary, /Last sandbox save/);
  const labels = components
    .filter((component) => component.type === 1)
    .flatMap((row) => row.components as Array<Record<string, unknown>>)
    .map((button) => button.label);
  assert.ok(labels.includes('Mark listed (sandbox)'));
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

  const actionCustomIds = rows.flatMap((row) =>
    (row.components as Array<Record<string, unknown>>).map((button) => button.custom_id),
  );
  assert.ok(actionCustomIds.includes(`profile:remove-photo:${STATE_REVISION}`));
  assert.ok(actionCustomIds.includes(`profile:set-listed:1:${STATE_REVISION}`));
});

test('profile edit modals bind submissions to the rendered state revision', () => {
  const current = snapshot();

  assert.equal(
    editBasicModalResponse(current).data?.custom_id,
    `profile-basic:v1:${STATE_REVISION}`,
  );
  assert.equal(
    editTextModalResponse(current).data?.custom_id,
    `profile-text:v1:${STATE_REVISION}`,
  );
  assert.equal(
    categoryModalResponse(current).data?.custom_id,
    `profile-category:v1:${STATE_REVISION}`,
  );
  assert.equal(photoUploadModalResponse().data?.custom_id, 'profile-photo:v1');
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

test('queued publications tell the user to reopen the profile instead of claiming completion', () => {
  const payload = operationCompleteEdit(
    'Your profile was updated.',
    { queued: true, operationId: 'operation-1', deploymentStatus: 'queued' },
  );
  const content = String(
    (payload.components as Array<Record<string, unknown>>)[0]?.content,
  );

  assert.match(content, /safely queued/i);
  assert.match(content, /\/profile/);
  assert.doesNotMatch(content, /Your profile was updated/);
});

function snapshot(): ProfileSnapshot {
  return {
    profileSlug: 'example',
    stateRevision: STATE_REVISION,
    bindingStatus: 'active',
    profile: createEmptyProfile({
      name: 'Example Member',
      position: 'Undergraduate Student, KAIST',
      order: 4,
    }),
  };
}
