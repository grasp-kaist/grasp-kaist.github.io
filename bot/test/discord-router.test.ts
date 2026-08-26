import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyProfile } from '../src/domain/member-profile.js';
import { DiscordInteractionRouter } from '../src/discord/router.js';
import type {
  AttachmentDownloader,
  DiscordAttachment,
  DiscordInteraction,
  DiscordMessageFile,
  DiscordMessagePayload,
  InteractionWebhookClient,
  ProfileService,
  ProfileSnapshot,
} from '../src/discord/types.js';

const APPLICATION_ID = '111111111111111111';
const GUILD_ID = '222222222222222222';
const USER_ID = '333333333333333333';
const STATE_REVISION = '0123456789abcdefabcd';
const DRAFT_REVISION = 'fedcba9876543210fedc';

test('register uses only a local probe before opening a current Label modal', async () => {
  let localProbes = 0;
  let profileReads = 0;
  const harness = createHarness({
    getOwnProfileLocal: () => {
      localProbes += 1;
      return { hasBinding: false, snapshot: null };
    },
    getOwnProfile: async () => {
      profileReads += 1;
      return null;
    },
  });
  const valid = await harness.router.route(
    commandInteraction('register', [
      { type: 4, name: 'category', value: 4 },
    ]),
  );
  assert.equal(valid.response.type, 9);
  assert.equal(valid.response.data?.custom_id, 'register:v1:production:4');
  assert.equal(localProbes, 1);
  assert.equal(profileReads, 0);

  const invalidCategory = await harness.router.route(
    commandInteraction('register', [
      { type: 4, name: 'category', value: 99 },
    ]),
  );
  assert.equal(invalidCategory.response.type, 4);
  assert.equal(localProbes, 1);
  assert.equal(profileReads, 0);

  const wrongGuild = await harness.router.route({
    ...commandInteraction('profile'),
    guild_id: '999999999999999999',
  });
  assert.equal(wrongGuild.response.type, 4);
  assert.equal(localProbes, 1);
  assert.equal(profileReads, 0);
});

test('register renders an existing local profile without a repository read', async () => {
  let profileReads = 0;
  const current = snapshot();
  const harness = createHarness({
    getOwnProfileLocal: () => ({ hasBinding: true, snapshot: current }),
    getOwnProfile: async () => {
      profileReads += 1;
      return current;
    },
  });

  const routed = await harness.router.route(
    commandInteraction('register', [{ type: 4, name: 'category', value: 4 }]),
  );

  assert.equal(routed.response.type, 4);
  assert.equal(profileReads, 0);
});

test('register does not reopen the modal while a local binding is being recovered', async () => {
  let profileReads = 0;
  const harness = createHarness({
    getOwnProfileLocal: () => ({ hasBinding: true, snapshot: null }),
    getOwnProfile: async () => {
      profileReads += 1;
      return null;
    },
  });

  const routed = await harness.router.route(
    commandInteraction('register', [{ type: 4, name: 'category', value: 4 }]),
  );

  assert.equal(routed.response.type, 4);
  assert.notEqual(routed.response.type, 9);
  assert.equal(profileReads, 0);
});

test('profile defers ephemerally before any potentially networked reconciliation', async () => {
  let profileReads = 0;
  const harness = createHarness({
    getOwnProfile: async () => {
      profileReads += 1;
      return snapshot();
    },
  });
  const interaction = commandInteraction('profile');

  const routed = await harness.router.route(interaction);
  assert.equal(routed.response.type, 5);
  assert.equal(routed.response.data?.flags, 64);
  assert.equal(profileReads, 0);
  assert.ok(routed.afterResponse);

  await routed.afterResponse();
  assert.equal(profileReads, 1);
  assert.equal(harness.edits[0]?.token, interaction.token);
  assert.equal(harness.edits[0]?.payload.flags, 32768);
  const components = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  assert.equal(components[0]?.type, 17);
});

test('profile explains registration delay when no usable profile is available', async () => {
  const harness = createHarness({
    getOwnProfile: async () => null,
  });
  const interaction = commandInteraction('profile');

  const routed = await harness.router.route(interaction);
  await routed.afterResponse?.();

  const components = harness.edits[0]?.payload.components as Array<
    Record<string, unknown>
  >;
  assert.equal(
    components[0]?.content,
    'It may take a few minutes for your profile to appear after `/register`. If it still does not appear after a while, please DM Taein Oh.',
  );
});

test('profile edit button opens its modal from local state without a repository read', async () => {
  let localProbes = 0;
  let profileReads = 0;
  const harness = createHarness({
    getOwnProfileLocal: () => {
      localProbes += 1;
      return { hasBinding: true, snapshot: snapshot() };
    },
    getOwnProfile: async () => {
      profileReads += 1;
      return snapshot();
    },
  });

  const routed = await harness.router.route(componentInteraction('profile:edit-basic'));
  assert.equal(routed.response.type, 9);
  assert.equal(
    routed.response.data?.custom_id,
    `profile-basic:v1:${STATE_REVISION}`,
  );
  assert.equal(localProbes, 1);
  assert.equal(profileReads, 0);
});

test('register modal defers before invoking the mutation and edits the webhook afterward', async () => {
  let registerInput: unknown;
  const harness = createHarness({
    register: async (actor, input) => {
      registerInput = { actor, input };
      return { commitSha: 'abc123', deploymentStatus: 'success' };
    },
  });
  const interaction = modalInteraction('register:v1:production:4', [
    labelText('name', 'Taein Oh'),
    labelText('position', 'Undergraduate Student, KAIST'),
    {
      type: 18,
      component: { type: 22, custom_id: 'consent', values: ['accepted'] },
    },
  ]);

  const routed = await harness.router.route(interaction);
  assert.equal(routed.response.type, 5);
  assert.equal(routed.response.data?.flags, 64);
  assert.equal(registerInput, undefined);
  assert.ok(routed.afterResponse);

  await routed.afterResponse();
  assert.deepEqual(registerInput, {
    actor: { interactionId: interaction.id, guildId: GUILD_ID, userId: USER_ID },
    input: {
      name: 'Taein Oh',
      position: 'Undergraduate Student, KAIST',
      order: 4,
    },
  });
  assert.equal(harness.edits.length, 1);
  assert.equal(harness.edits[0]?.token, interaction.token);
  assert.equal(harness.edits[0]?.payload.flags, 32768);
});

test('register rejects a sandbox modal submitted after switching to production', async () => {
  let registerCalls = 0;
  const harness = createHarness({
    register: async () => {
      registerCalls += 1;
      return {};
    },
  });
  const staleInteraction = modalInteraction('register:v1:sandbox:4', [
    labelText('name', 'Taein Oh'),
    labelText('position', 'Undergraduate Student, KAIST'),
    {
      type: 18,
      component: { type: 22, custom_id: 'consent', values: ['accepted'] },
    },
  ]);

  const routed = await harness.router.route(staleInteraction);

  assert.equal(routed.response.type, 4);
  assert.equal(routed.afterResponse, undefined);
  assert.equal(registerCalls, 0);
  const components = routed.response.data?.components as Array<Record<string, unknown>>;
  assert.match(String(components[0]?.content), /publication mode changed/i);
});

test('profile edit modal defers before updating only a draft and renders the review panel', async () => {
  let draftInput: unknown;
  let publishCalls = 0;
  const drafted = snapshotWithDraft({ name: 'Updated Member', position: 'Graduate Student' });
  const harness = createHarness({
    stageOwnProfileDraft: (actor, patch, expectedRevision) => {
      draftInput = { actor, patch, expectedRevision };
      return drafted;
    },
    updateOwnProfile: async () => {
      publishCalls += 1;
      return {};
    },
  });
  const interaction = modalInteraction(`profile-basic:v1:${STATE_REVISION}`, [
    labelText('name', 'Updated Member'),
    labelText('position', 'Graduate Student'),
  ]);

  const routed = await harness.router.route(interaction);
  assert.equal(routed.response.type, 6);
  assert.equal(draftInput, undefined);
  assert.equal(publishCalls, 0);
  await routed.afterResponse?.();
  assert.deepEqual(draftInput, {
    actor: { interactionId: interaction.id, guildId: GUILD_ID, userId: USER_ID },
    patch: { name: 'Updated Member', position: 'Graduate Student' },
    expectedRevision: STATE_REVISION,
  });
  const components = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  assert.equal(components[0]?.type, 10);
  assert.match(String(components[0]?.content), /Nothing has been published yet/i);
  const panel = components.find((component) => component.type === 17)!;
  const summary = (panel.components as Array<Record<string, unknown>>).find(
    (component) => component.type === 10 && /Updated Member/.test(String(component.content)),
  );
  assert.match(String(summary?.content), /Updated Member/);
});

test('text and category forms merge into drafts without publishing', async () => {
  const calls: unknown[] = [];
  let publishCalls = 0;
  const harness = createHarness({
    stageOwnProfileDraft: (_actor, patch, expectedRevision) => {
      calls.push({ patch, expectedRevision });
      return snapshotWithDraft(patch);
    },
    updateOwnProfile: async () => {
      publishCalls += 1;
      return {};
    },
  });
  const text = await harness.router.route(
    modalInteraction(`profile-text:v1:${STATE_REVISION}`, [
      labelText('details', 'First detail\nSecond detail'),
      labelText('research_interests', 'Verification'),
      labelText('contact', ''),
      labelText('website', 'example.org'),
    ]),
  );
  const category = await harness.router.route(
    modalInteraction(`profile-category:v1:${STATE_REVISION}`, [
      {
        type: 18,
        component: { type: 3, custom_id: 'category', values: ['2'] },
      },
    ]),
  );

  assert.equal(text.response.type, 6);
  assert.equal(category.response.type, 6);
  assert.deepEqual(calls, []);
  await text.afterResponse?.();
  await category.afterResponse?.();
  assert.equal(publishCalls, 0);
  assert.deepEqual(calls, [
    {
      patch: {
        details: ['First detail', 'Second detail'],
        researchInterests: ['Verification'],
        contact: [],
        website: 'example.org',
      },
      expectedRevision: STATE_REVISION,
    },
    { patch: { order: 2 }, expectedRevision: STATE_REVISION },
  ]);
});

test('Save changes is the only profile-edit action that invokes publication', async () => {
  let saved: unknown;
  const harness = createHarness({
    saveOwnProfileDraft: async (actor, expectedDraftRevision) => {
      saved = { actor, expectedDraftRevision };
      return { queued: true, operationId: 'draft-operation', deploymentStatus: 'queued' };
    },
  });
  const interaction = componentInteraction(`profile:save-draft:${DRAFT_REVISION}`);
  const routed = await harness.router.route(interaction);
  assert.equal(routed.response.type, 6);
  assert.equal(saved, undefined);
  await routed.afterResponse?.();
  assert.deepEqual(saved, {
    actor: { interactionId: interaction.id, guildId: GUILD_ID, userId: USER_ID },
    expectedDraftRevision: DRAFT_REVISION,
  });
  const components = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  assert.match(String(components[0]?.content), /GitHub may be temporarily unavailable/i);
});

test('a profile publication already in progress is shown as waiting, not failed', async () => {
  const pendingError = Object.assign(new Error('publication pending'), {
    code: 'publication_pending',
  });
  const harness = createHarness({
    saveOwnProfileDraft: async () => {
      throw pendingError;
    },
  });
  const interaction = componentInteraction(`profile:save-draft:${DRAFT_REVISION}`);

  const routed = await harness.router.route(interaction);
  await routed.afterResponse?.();

  const components = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  assert.equal(
    components[0]?.content,
    'Your profile registration or previous update is being published and may take a few minutes. Run `/profile` again shortly.',
  );
  assert.deepEqual(harness.errors, []);
});

test('Discard draft clears only the selected revision without publishing', async () => {
  let discarded: unknown;
  const harness = createHarness({
    discardOwnProfileDraft: (actor, expectedDraftRevision) => {
      discarded = { actor, expectedDraftRevision };
      return snapshot();
    },
  });
  const interaction = componentInteraction(`profile:discard-draft:${DRAFT_REVISION}`);

  const routed = await harness.router.route(interaction);

  assert.equal(routed.response.type, 6);
  assert.equal(discarded, undefined);
  await routed.afterResponse?.();
  assert.deepEqual(discarded, {
    actor: { interactionId: interaction.id, guildId: GUILD_ID, userId: USER_ID },
    expectedDraftRevision: DRAFT_REVISION,
  });
  const components = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  assert.match(String(components[0]?.content), /Draft discarded/i);
});

test('an unchanged profile form says there is no draft to save', async () => {
  const harness = createHarness({
    stageOwnProfileDraft: () => snapshot(),
  });
  const routed = await harness.router.route(
    modalInteraction(`profile-basic:v1:${STATE_REVISION}`, [
      labelText('name', 'Taein Oh'),
      labelText('position', 'Undergraduate Student, KAIST'),
    ]),
  );

  assert.equal(routed.response.type, 6);
  await routed.afterResponse?.();

  const components = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  assert.match(String(components[0]?.content), /No draft changes to save/i);
  assert.equal(JSON.stringify(components).includes('profile:save-draft:'), false);
});

test('photo modal resolves and downloads the selected attachment only after deferring', async () => {
  const selected = attachment('777777777777777777', 'selected.png');
  let downloaded: DiscordAttachment | undefined;
  let preparedInput: { filename: string; contentType?: string; bytes: Uint8Array } | undefined;
  const harness = createHarness(
    {
      prepareOwnPhoto: async (_actor, input) => {
        preparedInput = input;
        return {
          stagedPhotoId: 'stage_123',
          previewBytes: new Uint8Array([9, 8, 7]),
          width: 800,
          height: 1000,
        };
      },
    },
    {
      download: async (input) => {
        downloaded = input;
        return new Uint8Array([1, 2, 3]);
      },
    },
  );
  const interaction = modalInteraction(
    'profile-photo:v1',
    [
      {
        type: 18,
        component: {
          type: 19,
          custom_id: 'photo',
          values: [selected.id],
        },
      },
    ],
    {
      attachments: {
        '666666666666666666': attachment('666666666666666666', 'other.png'),
        [selected.id]: selected,
      },
    },
  );

  const routed = await harness.router.route(interaction);
  assert.equal(routed.response.type, 6);
  assert.equal(downloaded, undefined);
  assert.equal(preparedInput, undefined);

  await routed.afterResponse?.();
  assert.equal(downloaded?.id, selected.id);
  assert.deepEqual(preparedInput, {
    filename: 'selected.png',
    contentType: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.equal(harness.edits[0]?.files?.[0]?.filename, 'profile-preview.webp');
  const previewComponents = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  const row = previewComponents.find((component) => component.type === 1)!;
  assert.deepEqual(
    (row.components as Array<Record<string, unknown>>).map((button) => button.custom_id),
    ['profile:photo-confirm:stage_123', 'profile:photo-cancel:stage_123'],
  );
});

test('photo confirmation defers an update and service revalidates the staged ID', async () => {
  let confirmed: string | undefined;
  const harness = createHarness({
    confirmOwnPhoto: async (_actor, stagedPhotoId) => {
      confirmed = stagedPhotoId;
      return { snapshot: snapshot(), commitSha: 'photo-commit' };
    },
  });
  const interaction = componentInteraction('profile:photo-confirm:stage_123');

  const routed = await harness.router.route(interaction);
  assert.equal(routed.response.type, 6);
  assert.equal(confirmed, undefined);

  await routed.afterResponse?.();
  assert.equal(confirmed, 'stage_123');
  assert.deepEqual(harness.edits[0]?.payload.attachments, []);
  const components = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  assert.equal(components.some((component) => component.type === 17), true);
});

test('direct profile actions pass the panel state revision to the service', async () => {
  const calls: unknown[] = [];
  const harness = createHarness({
    removeOwnPhoto: async (actor, expectedRevision) => {
      calls.push({ action: 'remove', actor, expectedRevision });
      return {};
    },
    setOwnListed: async (actor, listed, expectedRevision) => {
      calls.push({ action: 'listed', actor, listed, expectedRevision });
      return {};
    },
  });

  const remove = await harness.router.route(
    componentInteraction(`profile:remove-photo:${STATE_REVISION}`),
  );
  const listed = await harness.router.route(
    componentInteraction(`profile:set-listed:1:${STATE_REVISION}`),
  );
  assert.equal(remove.response.type, 6);
  assert.equal(listed.response.type, 6);
  assert.deepEqual(calls, []);

  await remove.afterResponse?.();
  await listed.afterResponse?.();
  assert.deepEqual(calls, [
    {
      action: 'remove',
      actor: {
        interactionId: '999999999999999999',
        guildId: GUILD_ID,
        userId: USER_ID,
      },
      expectedRevision: STATE_REVISION,
    },
    {
      action: 'listed',
      actor: {
        interactionId: '999999999999999999',
        guildId: GUILD_ID,
        userId: USER_ID,
      },
      listed: true,
      expectedRevision: STATE_REVISION,
    },
  ]);
});

test('photo cancellation discards only the staged photo named by the button', async () => {
  let discarded: string | undefined;
  const harness = createHarness({
    discardOwnPhoto: async (_actor, stagedPhotoId) => {
      discarded = stagedPhotoId;
    },
  });

  const routed = await harness.router.route(
    componentInteraction('profile:photo-cancel:stage_456'),
  );
  assert.equal(routed.response.type, 6);
  assert.equal(discarded, undefined);
  await routed.afterResponse?.();
  assert.equal(discarded, 'stage_456');
  assert.deepEqual(harness.edits[0]?.payload.attachments, []);
  const components = harness.edits[0]?.payload.components as Array<Record<string, unknown>>;
  assert.equal(components.some((component) => component.type === 17), true);
});

function createHarness(
  serviceOverrides: Partial<ProfileService> = {},
  downloaderOverride?: AttachmentDownloader,
  publicationMode: 'sandbox' | 'production' = 'production',
) {
  const edits: Array<{
    token: string;
    payload: DiscordMessagePayload;
    files?: readonly DiscordMessageFile[];
  }> = [];
  const errors: unknown[] = [];
  const webhook: InteractionWebhookClient = {
    editOriginal: async (token, payload, files) => {
      edits.push({ token, payload, ...(files ? { files } : {}) });
    },
  };
  const service = { ...defaultService(), ...serviceOverrides } satisfies ProfileService;
  const router = new DiscordInteractionRouter({
    config: {
      applicationId: APPLICATION_ID,
      guildId: GUILD_ID,
      publicationMode,
    },
    service,
    webhook,
    attachmentDownloader: downloaderOverride ?? {
      download: async () => new Uint8Array([1]),
    },
    reportError: (error) => errors.push(error),
  });

  return { router, edits, errors, service };
}

function defaultService(): ProfileService {
  return {
    getOwnProfileLocal: () => ({ hasBinding: true, snapshot: snapshot() }),
    getOwnProfile: async () => snapshot(),
    register: async () => ({}),
    updateOwnProfile: async () => ({}),
    stageOwnProfileDraft: () => snapshotWithDraft({}),
    discardOwnProfileDraft: () => snapshot(),
    saveOwnProfileDraft: async () => ({}),
    prepareOwnPhoto: async () => ({
      stagedPhotoId: 'stage_default',
      previewBytes: new Uint8Array([1]),
      width: 1,
      height: 1,
    }),
    confirmOwnPhoto: async () => ({}),
    discardOwnPhoto: async () => undefined,
    removeOwnPhoto: async () => ({}),
    setOwnListed: async () => ({}),
  };
}

function snapshot(): ProfileSnapshot {
  return {
    profileSlug: 'taein-oh',
    stateRevision: STATE_REVISION,
    bindingStatus: 'active',
    profile: createEmptyProfile({
      name: 'Taein Oh',
      position: 'Undergraduate Student, KAIST',
      order: 4,
    }),
  };
}

function snapshotWithDraft(
  patch: Partial<ProfileSnapshot['profile']>,
): ProfileSnapshot {
  const current = snapshot();
  current.draft = {
    profile: { ...current.profile, ...patch },
    revision: DRAFT_REVISION,
    baseStateRevision: STATE_REVISION,
    isPublishing: false,
    stale: false,
  };
  return current;
}

function commandInteraction(
  name: string,
  options: NonNullable<DiscordInteraction['data']>['options'] = [],
  userId = USER_ID,
): DiscordInteraction {
  return {
    ...baseInteraction(2, userId),
    data: { name, type: 1, options },
  };
}

function componentInteraction(customId: string): DiscordInteraction {
  return {
    ...baseInteraction(3),
    data: { component_type: 2, custom_id: customId },
  };
}

function modalInteraction(
  customId: string,
  components: NonNullable<DiscordInteraction['data']>['components'],
  resolved?: NonNullable<DiscordInteraction['data']>['resolved'],
): DiscordInteraction {
  return {
    ...baseInteraction(5),
    data: { custom_id: customId, components, ...(resolved ? { resolved } : {}) },
  };
}

function baseInteraction(type: number, userId = USER_ID): DiscordInteraction {
  return {
    id: '999999999999999999',
    application_id: APPLICATION_ID,
    type,
    token: 'interaction-token',
    guild_id: GUILD_ID,
    member: { user: { id: userId } },
  };
}

function labelText(customId: string, value: string) {
  return {
    type: 18 as const,
    component: { type: 4 as const, custom_id: customId, value },
  };
}

function attachment(id: string, filename: string): DiscordAttachment {
  return {
    id,
    filename,
    size: 3,
    content_type: 'image/png',
    url: `https://cdn.discordapp.com/ephemeral-attachments/1/${id}/${filename}`,
    proxy_url: `https://media.discordapp.net/ephemeral-attachments/1/${id}/${filename}`,
    ephemeral: true,
  };
}
