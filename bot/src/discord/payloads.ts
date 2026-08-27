import { memberCategories, type MemberOrder } from '../domain/member-profile.js';
import type {
  DiscordInteractionResponse,
  DiscordMessageFile,
  DiscordMessagePayload,
  PreparedProfilePhoto,
  ProfileOperationResult,
  ProfileSnapshot,
} from './types.js';

export const EPHEMERAL_FLAG = 1 << 6;
export const IS_COMPONENTS_V2_FLAG = 1 << 15;
export const REGISTRATION_PENDING_TEXT =
  'Your registration was accepted and is being published. It may take a few minutes. '
  + 'Once it is ready, run `/profile` to finish setting it up. '
  + 'If it is still unavailable after a while, please DM Taein Oh.';

export type ProfileOperationKind = 'registration' | 'profile-update';

const PROFILE_ACCENT_COLOR = 0x315795;
const PHOTO_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROFILE_REVISION_PATTERN = /^[0-9a-f]{20}$/;

export function pongResponse(): DiscordInteractionResponse {
  return { type: 1 };
}

export function ephemeralTextResponse(message: string): DiscordInteractionResponse {
  return {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG | IS_COMPONENTS_V2_FLAG,
      allowed_mentions: { parse: [] },
      components: [{ type: 10, content: message }],
    },
  };
}

export function deferEphemeralResponse(): DiscordInteractionResponse {
  return { type: 5, data: { flags: EPHEMERAL_FLAG } };
}

export function deferUpdateResponse(): DiscordInteractionResponse {
  return { type: 6 };
}

export function registerModalResponse(
  order: MemberOrder,
  publicationMode: 'sandbox' | 'production' = 'production',
): DiscordInteractionResponse {
  const sandbox = publicationMode === 'sandbox';
  return {
    type: 9,
    data: {
      custom_id: `register:v1:${publicationMode}:${order}`,
      title: 'Create GRASP profile',
      components: [
        {
          type: 10,
          content: sandbox
            ? 'Test mode: your profile and photo will be stored only in the bot sandbox. The GRASP website will not change.'
            : 'Your profile information and photo will be stored in a public GitHub repository.',
        },
        {
          type: 18,
          label: 'Public name',
          component: {
            type: 4,
            custom_id: 'name',
            style: 1,
            min_length: 1,
            max_length: 80,
            required: true,
            placeholder: 'Taein Oh',
          },
        },
        {
          type: 18,
          label: 'Position',
          description: 'KAIST is implied. Enter only the role, such as M.S. Student.',
          component: {
            type: 4,
            custom_id: 'position',
            style: 1,
            min_length: 1,
            max_length: 160,
            required: true,
            placeholder: memberCategories[order].label,
          },
        },
        {
          type: 18,
          label: 'Public information confirmation',
          component: {
            type: 22,
            custom_id: 'consent',
            min_values: 1,
            max_values: 1,
            required: true,
            options: [
              {
                label: sandbox
                  ? 'I understand that this is sandbox test data.'
                  : 'I understand that this information will be public.',
                value: 'accepted',
              },
            ],
          },
        },
      ],
    },
  };
}

export function editBasicModalResponse(snapshot: ProfileSnapshot): DiscordInteractionResponse {
  const revision = editableRevision(snapshot);
  const profile = editableProfile(snapshot);
  return {
    type: 9,
    data: {
      custom_id: `profile-basic:v1:${revision}`,
      title: 'Edit name and position',
      components: [
        draftOnlyNotice(),
        {
          type: 18,
          label: 'Public name',
          component: {
            type: 4,
            custom_id: 'name',
            style: 1,
            min_length: 1,
            max_length: 80,
            required: true,
            value: profile.name,
          },
        },
        {
          type: 18,
          label: 'Position',
          description: 'KAIST is implied. Enter only the role, such as M.S. Student.',
          component: {
            type: 4,
            custom_id: 'position',
            style: 1,
            min_length: 1,
            max_length: 160,
            required: true,
            value: profile.position,
          },
        },
      ],
    },
  };
}

export function editTextModalResponse(snapshot: ProfileSnapshot): DiscordInteractionResponse {
  const revision = editableRevision(snapshot);
  const profile = editableProfile(snapshot);
  return {
    type: 9,
    data: {
      custom_id: `profile-text:v1:${revision}`,
      title: 'Edit profile information',
      components: [
        draftOnlyNotice(),
        paragraphInput('Details', 'details', profile.details, 2_000),
        paragraphInput(
          'Research interests',
          'research_interests',
          profile.researchInterests,
          2_000,
        ),
        paragraphInput(
          'Contact',
          'contact',
          profile.contact,
          1_000,
          'To deter scraping, obfuscate contact details if needed. '
          + 'For @kaist.ac.kr, use only @kaist.',
        ),
        {
          type: 18,
          label: 'Website',
          component: {
            type: 4,
            custom_id: 'website',
            style: 1,
            required: false,
            max_length: 500,
            value: profile.website,
          },
        },
      ],
    },
  };
}

export function categoryModalResponse(snapshot: ProfileSnapshot): DiscordInteractionResponse {
  const revision = editableRevision(snapshot);
  const profile = editableProfile(snapshot);
  return {
    type: 9,
    data: {
      custom_id: `profile-category:v1:${revision}`,
      title: 'Category and visibility',
      components: [
        draftOnlyNotice(),
        {
          type: 18,
          label: 'Member category',
          component: {
            type: 3,
            custom_id: 'category',
            min_values: 1,
            max_values: 1,
            required: true,
            options: memberCategories.map(({ order, label }) => ({
              label,
              value: String(order),
              default: order === profile.order,
            })),
          },
        },
        {
          type: 18,
          label: 'Members page visibility',
          component: {
            type: 3,
            custom_id: 'visibility',
            min_values: 1,
            max_values: 1,
            required: true,
            options: [
              {
                label: 'Show on the Members page',
                value: 'listed',
                default: profile.listed,
              },
              {
                label: 'Hide from the Members page',
                value: 'hidden',
                default: !profile.listed,
              },
            ],
          },
        },
      ],
    },
  };
}

export function photoUploadModalResponse(): DiscordInteractionResponse {
  return {
    type: 9,
    data: {
      custom_id: 'profile-photo:v1',
      title: 'Change profile photo',
      components: [
        {
          type: 18,
          label: 'Profile photo',
          description: 'The image will be center-cropped to 4:5 and resized automatically.',
          component: {
            type: 19,
            custom_id: 'photo',
            min_values: 1,
            max_values: 1,
            required: true,
            file_types: ['.jpg', '.jpeg', '.png', '.webp'],
          },
        },
      ],
    },
  };
}

export function profilePanelResponse(
  snapshot: ProfileSnapshot,
  publicationMode: 'sandbox' | 'production' = 'production',
  editing = hasPendingEdits(snapshot),
): DiscordInteractionResponse {
  return {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG | IS_COMPONENTS_V2_FLAG,
      allowed_mentions: { parse: [] },
      components: profilePanelComponents(snapshot, undefined, publicationMode, editing),
    },
  };
}

export function profilePanelEdit(
  snapshot: ProfileSnapshot,
  notice?: string,
  publicationMode: 'sandbox' | 'production' = 'production',
  editing = hasPendingEdits(snapshot),
): DiscordMessagePayload {
  return v2Edit(profilePanelComponents(snapshot, notice, publicationMode, editing), []);
}

export function profilePanelUpdateResponse(
  snapshot: ProfileSnapshot,
  notice?: string,
  publicationMode: 'sandbox' | 'production' = 'production',
  editing = true,
): DiscordInteractionResponse {
  return {
    type: 7,
    data: v2Edit(profilePanelComponents(snapshot, notice, publicationMode, editing), []),
  };
}

function profilePanelComponents(
  snapshot: ProfileSnapshot,
  notice: string | undefined,
  publicationMode: 'sandbox' | 'production',
  editing: boolean,
) {
  const editRevision = assertProfileRevision(snapshot.editRevision);
  const draft = snapshot.draft;
  const pendingPhoto = snapshot.pendingPhoto;
  const profile = draft?.profile ?? snapshot.profile;
  const missingPendingPhoto = Boolean(
    draft
    && !pendingPhoto
    && draft.profile.photo !== ''
    && draft.profile.photo !== snapshot.profile.photo,
  );
  const category = memberCategories.find(({ order }) => order === profile.order)?.label;
  const statusText = snapshot.bindingStatus === 'active' ? '' : `\nStatus: **${snapshot.bindingStatus}**`;
  const summary = [
    `## ${escapeDiscordMarkdown(profile.name)}`,
    escapeDiscordMarkdown(profile.position),
    category ? `Category: ${escapeDiscordMarkdown(category)}` : '',
    publicationMode === 'sandbox'
      ? `Sandbox listing flag: **${profile.listed ? 'listed' : 'hidden'}**${statusText}`
      : `Website listing: **${profile.listed ? 'shown' : 'hidden'}**${statusText}`,
    snapshot.lastDeploymentStatus
      ? `${publicationMode === 'sandbox' ? 'Last sandbox save' : 'Last deployment'}: **${escapeDiscordMarkdown(snapshot.lastDeploymentStatus)}**`
      : '',
    snapshot.lastCommitSha
      ? `${publicationMode === 'sandbox' ? 'Sandbox revision' : 'Last commit'}: \`${escapeInlineCode(snapshot.lastCommitSha.slice(0, 12))}\``
      : '',
    pendingPhoto
      ? `Pending photo: **new photo ready (${pendingPhoto.width}×${pendingPhoto.height})**`
      : missingPendingPhoto
        ? 'Pending photo: **upload it again before saving**'
      : draft && draft.profile.photo === '' && snapshot.profile.photo !== ''
        ? 'Pending photo: **remove current photo**'
        : '',
  ]
    .filter(Boolean)
    .join('\n');

  const containerChildren: Record<string, unknown>[] = [];

  const hasPending = hasPendingEdits(snapshot);
  const publishing = Boolean(draft?.isPublishing || pendingPhoto?.isPublishing);
  const stale = Boolean(draft?.stale || pendingPhoto?.stale);

  if (editing || hasPending) {
    const editStatus = publishing
      ? '## Changes are being published\nEditing is temporarily unavailable. Run `/profile` again shortly.'
      : stale
        ? '## Changes need review\nThe published profile changed. Discard these changes and edit again.'
        : missingPendingPhoto
          ? '## Photo needs attention\nThe prepared photo expired. Use **Change photo** to upload it again, or **Remove photo** to cancel that photo change.'
        : hasPending
          ? '## Pending changes — not published\nReview the preview below, then use **Save changes** once to publish everything together.'
          : '## Edit profile\nChange any sections you need, then use **Save changes** once.';
    containerChildren.push({ type: 10, content: editStatus });
  }

  containerChildren.push({ type: 10, content: summary });

  if (snapshot.bindingStatus === 'active') {
    if (!editing && !hasPending) {
      containerChildren.push({
        type: 1,
        components: [
          button('Edit profile', 'profile:edit', 1),
        ],
      });
    } else {
      const editLocked = publishing || stale;
      const hasPhoto = Boolean(pendingPhoto || profile.photo || snapshot.profile.photo);
      containerChildren.push(
        {
          type: 1,
          components: [
            button('Name & position', 'profile:edit-basic', 1, editLocked),
            button('Profile details', 'profile:edit-text', 2, editLocked),
            button('Category & visibility', 'profile:edit-category', 2, editLocked),
            button('Change photo', 'profile:replace-photo', 2, editLocked),
          ],
        },
        {
          type: 1,
          components: [
            button('Remove photo', `profile:stage-remove-photo:${editRevision}`, 4, editLocked || !hasPhoto),
            button(
              'Save changes',
              `profile:save-edits:${editRevision}`,
              3,
              editLocked || missingPendingPhoto || !hasPending,
            ),
            button('Discard changes', `profile:discard-edits:${editRevision}`, 2, publishing || !hasPending),
            ...(!hasPending ? [button('Back', 'profile:view', 2)] : []),
          ],
        },
      );
    }
  }

  if (snapshot.membersPageUrl) {
    containerChildren.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: 'Open Members page',
          url: snapshot.membersPageUrl,
        },
      ],
    });
  }

  return [
    ...(notice ? [{ type: 10, content: escapeDiscordMarkdown(notice) }] : []),
    {
      type: 17,
      accent_color: PROFILE_ACCENT_COLOR,
      components: containerChildren,
    },
  ];
}

export function operationCompleteEdit(
  message: string,
  result?: ProfileOperationResult,
  publicationMode: 'sandbox' | 'production' = 'production',
  operationKind: ProfileOperationKind = 'profile-update',
): DiscordMessagePayload {
  if (result?.queued) {
    return v2Edit(
      [
        {
          type: 10,
          content: operationKind === 'registration'
            ? REGISTRATION_PENDING_TEXT
            : 'The profile update was accepted and queued. Run `/profile` again in a few minutes to see the published result. '
              + 'If it is still unchanged, GitHub may be temporarily unavailable; please submit the update again later.',
        },
      ],
      [],
    );
  }

  if (result?.snapshot) {
    return profilePanelEdit(result.snapshot, message, publicationMode);
  }

  const details = [
    message,
    result?.commitSha ? `Commit: \`${escapeInlineCode(result.commitSha)}\`` : '',
    result?.deploymentStatus
      ? `Deployment: ${escapeDiscordMarkdown(result.deploymentStatus)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return v2Edit([{ type: 10, content: details }], []);
}

export function operationFailedEdit(message: string): DiscordMessagePayload {
  return v2Edit(
    [
      {
        type: 10,
        content: `The profile operation failed. ${escapeDiscordMarkdown(message)}`,
      },
    ],
    [],
  );
}

export function operationPendingEdit(
  operationKind: ProfileOperationKind = 'profile-update',
): DiscordMessagePayload {
  return v2Edit(
    [
      {
        type: 10,
        content: operationKind === 'registration'
          ? REGISTRATION_PENDING_TEXT
          : 'Your profile update is still being published and may take a few minutes. '
            + 'Run `/profile` again shortly.',
      },
    ],
    [],
  );
}

export function preparedPhotoPreviewEdit(prepared: PreparedProfilePhoto): {
  payload: DiscordMessagePayload;
  files: readonly DiscordMessageFile[];
} {
  const stagedPhotoId = assertPhotoToken(prepared.stagedPhotoId);
  const filename = 'profile-preview.webp';
  const components = [
    {
      type: 10,
      content:
        `## Profile photo preview\n` +
        `${prepared.width}×${prepared.height} WebP. Use this result in your pending changes? `
        + 'It will not be published until you use **Save changes**.',
    },
    {
      type: 12,
      items: [
        {
          media: { url: `attachment://${filename}` },
          description: 'Processed GRASP profile photo preview',
        },
      ],
    },
    {
      type: 1,
      components: [
        button('Use this photo', `profile:photo-use:${stagedPhotoId}`, 3),
        button('Cancel', `profile:photo-cancel:${stagedPhotoId}`, 2),
      ],
    },
  ];

  return {
    payload: v2Edit(components, [
      {
        id: 0,
        filename,
        description: 'Processed GRASP profile photo preview',
      },
    ]),
    files: [
      {
        filename,
        bytes: prepared.previewBytes,
        contentType: 'image/webp',
        description: 'Processed GRASP profile photo preview',
      },
    ],
  };
}

export function photoFlowFinishedEdit(message: string): DiscordMessagePayload {
  return v2Edit([{ type: 10, content: message }], []);
}

export function assertPhotoToken(value: string) {
  if (!PHOTO_TOKEN_PATTERN.test(value)) {
    throw new Error('Prepared photo token must be 1-64 URL-safe characters.');
  }

  return value;
}

function assertProfileRevision(value: string) {
  if (!PROFILE_REVISION_PATTERN.test(value)) {
    throw new Error('Profile state revision must be 20 lowercase hexadecimal characters.');
  }

  return value;
}

function paragraphInput(
  label: string,
  customId: string,
  values: readonly string[],
  maxLength: number,
  description = 'One item per line',
) {
  return {
    type: 18,
    label,
    description,
    component: {
      type: 4,
      custom_id: customId,
      style: 2,
      required: false,
      max_length: maxLength,
      value: values.join('\n'),
    },
  };
}

function draftOnlyNotice() {
  return {
    type: 10,
    content: 'Submitting this form updates your pending changes only. Use **Save changes** on the profile panel to publish everything together.',
  };
}

function hasPendingEdits(snapshot: ProfileSnapshot) {
  return Boolean(snapshot.draft || snapshot.pendingPhoto);
}

function editableProfile(snapshot: ProfileSnapshot) {
  return snapshot.draft?.profile ?? snapshot.profile;
}

function editableRevision(snapshot: ProfileSnapshot) {
  return assertProfileRevision(snapshot.draft?.revision ?? snapshot.stateRevision);
}

function button(label: string, customId: string, style: number, disabled = false) {
  return { type: 2, style, label, custom_id: customId, ...(disabled ? { disabled: true } : {}) };
}

function v2Edit(
  components: readonly Record<string, unknown>[],
  attachments: readonly Record<string, unknown>[],
): DiscordMessagePayload {
  return {
    flags: IS_COMPONENTS_V2_FLAG,
    content: null,
    embeds: [],
    attachments,
    allowed_mentions: { parse: [] },
    components,
  };
}

function escapeInlineCode(value: string) {
  return value.replace(/`/g, '\u02cb');
}

function escapeDiscordMarkdown(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+\-.!|>~])/g, '\\$1')
    .replace(/@/g, '@\u200b');
}
