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
const EDIT_REVISION = '11111111111111111111';
const DRAFT_EDIT_REVISION = '22222222222222222222';

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
  const position = registerComponents.find((component) => component.label === 'Position');
  assert.equal(
    (position?.component as Record<string, unknown>).placeholder,
    'Undergraduate Student',
  );
  assert.equal(
    position?.description,
    'KAIST is implied. Enter only the role, such as M.S. Student.',
  );
  const mastersPosition = (
    registerModalResponse(3).data?.components as Array<Record<string, unknown>>
  ).find((component) => component.label === 'Position');
  assert.equal(
    (mastersPosition?.component as Record<string, unknown>).placeholder,
    'M.S. Student',
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
  assert.ok(labels.includes('Edit profile'));
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
  assert.equal(rows.length, 1);
  assert.ok(
    rows.every(
      (row) => (row.components as Array<Record<string, unknown>>).length <= 5,
    ),
  );

  const actionCustomIds = rows.flatMap((row) =>
    (row.components as Array<Record<string, unknown>>).map((button) => button.custom_id),
  );
  assert.deepEqual(actionCustomIds, ['profile:edit']);
  assert.equal(JSON.stringify(actionCustomIds).includes('set-listed'), false);
  assert.equal(JSON.stringify(actionCustomIds).includes('remove-photo'), false);
});

test('profile edit modals bind submissions to the current published or draft revision', () => {
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

  current.draft = {
    profile: { ...current.profile, name: 'Draft Member' },
    revision: 'fedcba9876543210fedc',
    baseStateRevision: STATE_REVISION,
    isPublishing: false,
    stale: false,
  };
  assert.equal(
    editBasicModalResponse(current).data?.custom_id,
    'profile-basic:v1:fedcba9876543210fedc',
  );
  const draftName = (
    editBasicModalResponse(current).data?.components as Array<Record<string, unknown>>
  ).find((component) => component.label === 'Public name');
  assert.equal((draftName?.component as Record<string, unknown>).value, 'Draft Member');

  const basicComponents = editBasicModalResponse(current).data?.components as Array<
    Record<string, unknown>
  >;
  const position = basicComponents.find((component) => component.label === 'Position');
  assert.equal(
    position?.description,
    'KAIST is implied. Enter only the role, such as M.S. Student.',
  );

  const textComponents = editTextModalResponse(current).data?.components as Array<
    Record<string, unknown>
  >;
  const contact = textComponents.find((component) => component.label === 'Contact');
  assert.equal(
    contact?.description,
    'To deter scraping, obfuscate contact details if needed. For @kaist.ac.kr, use only @kaist.',
  );

  const categoryComponents = categoryModalResponse(current).data?.components as Array<
    Record<string, unknown>
  >;
  const visibility = categoryComponents.find(
    (component) => component.label === 'Members page visibility',
  );
  assert.equal((visibility?.component as Record<string, unknown>).type, 3);
});

test('profile edit modals save drafts and do not contain an immediate publish confirmation', () => {
  const current = snapshot();
  const modals = [
    editBasicModalResponse(current),
    editTextModalResponse(current),
    categoryModalResponse(current),
  ];

  for (const modal of modals) {
    const components = modal.data?.components as Array<Record<string, unknown>>;
    assert.equal(
      components.some((component) => component.label === 'Confirm save and publish'),
      false,
    );
    assert.match(String(components[0]?.content), /updates your pending changes only/i);
    assert.match(String(components[0]?.content), /Save changes/);
  }

  assert.equal(
    (editTextModalResponse(current).data?.components as Array<Record<string, unknown>>).length,
    5,
  );
});

test('a draft panel previews draft values and exposes one explicit final save', () => {
  const current = snapshot();
  const draftRevision = 'fedcba9876543210fedc';
  current.draft = {
    profile: { ...current.profile, name: 'Draft Member', order: 3 },
    revision: draftRevision,
    baseStateRevision: STATE_REVISION,
    isPublishing: false,
    stale: false,
  };
  current.editRevision = DRAFT_EDIT_REVISION;

  const response = profilePanelResponse(current);
  const container = (response.data?.components as Array<Record<string, unknown>>)[0]!;
  const children = container.components as Array<Record<string, unknown>>;
  const text = children
    .filter((component) => component.type === 10)
    .map((component) => String(component.content))
    .join('\n');
  assert.match(text, /Pending changes.*not published/i);
  assert.match(text, /Draft Member/);
  assert.match(text, /M\\\.S\\\. Student/);

  const buttons = children
    .filter((component) => component.type === 1)
    .flatMap((row) => row.components as Array<Record<string, unknown>>);
  const byLabel = (label: string) => buttons.find((button) => button.label === label);
  assert.equal(byLabel('Save changes')?.custom_id, `profile:save-edits:${DRAFT_EDIT_REVISION}`);
  assert.equal(byLabel('Save changes')?.disabled, undefined);
  assert.equal(byLabel('Discard changes')?.custom_id, `profile:discard-edits:${DRAFT_EDIT_REVISION}`);
  assert.equal(byLabel('Change photo')?.disabled, undefined);
  assert.equal(byLabel('Remove photo')?.disabled, true);
  assert.equal(byLabel('Category & visibility')?.disabled, undefined);
});

test('an unchanged edit panel can return to the compact profile view', () => {
  const response = profilePanelResponse(snapshot(), undefined, 'production', true);
  const container = (response.data?.components as Array<Record<string, unknown>>)[0]!;
  const buttons = (container.components as Array<Record<string, unknown>>)
    .filter((component) => component.type === 1)
    .flatMap((row) => row.components as Array<Record<string, unknown>>);

  assert.equal(
    buttons.find((button) => button.label === 'Back')?.custom_id,
    'profile:view',
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
  const previewText = components
    .filter((component) => component.type === 10)
    .map((component) => String(component.content))
    .join('\n');
  assert.match(previewText, /not be published until.*Save changes/i);

  const gallery = components.find((component) => component.type === 12)!;
  assert.equal(
    ((gallery.items as Array<Record<string, unknown>>)[0]?.media as Record<string, unknown>).url,
    'attachment://profile-preview.webp',
  );
  const row = components.find((component) => component.type === 1)!;
  assert.deepEqual(
    (row.components as Array<Record<string, unknown>>).map((button) => button.custom_id),
    ['profile:photo-use:stage_abc-123', 'profile:photo-cancel:stage_abc-123'],
  );
});

test('queued publications explain normal delay and temporary GitHub failure without claiming completion', () => {
  const payload = operationCompleteEdit(
    'Your profile was updated.',
    { queued: true, operationId: 'operation-1', deploymentStatus: 'queued' },
  );
  const content = String(
    (payload.components as Array<Record<string, unknown>>)[0]?.content,
  );

  assert.match(content, /\/profile/);
  assert.match(content, /in a few minutes/i);
  assert.match(content, /GitHub may be temporarily unavailable/i);
  assert.match(content, /submit the update again later/i);
  assert.doesNotMatch(content, /Your profile was updated/);
});

function snapshot(): ProfileSnapshot {
  return {
    profileSlug: 'example',
    stateRevision: STATE_REVISION,
    editRevision: EDIT_REVISION,
    bindingStatus: 'active',
    profile: createEmptyProfile({
      name: 'Example Member',
      position: 'Undergraduate Student',
      order: 4,
    }),
  };
}
