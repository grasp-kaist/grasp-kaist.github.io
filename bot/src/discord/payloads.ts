import { memberCategories, type MemberOrder } from '../domain/member-profile.js';
import {
  PROFILE_EDIT_CONFIRMATION_CUSTOM_ID,
  PROFILE_EDIT_CONFIRMATION_VALUE,
} from './inputs.js';
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
          description: 'Your role or affiliation as shown on the website',
          component: {
            type: 4,
            custom_id: 'position',
            style: 1,
            min_length: 1,
            max_length: 160,
            required: true,
            placeholder: 'Undergraduate Student, KAIST',
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
  const revision = assertProfileRevision(snapshot.stateRevision);
  return {
    type: 9,
    data: {
      custom_id: `profile-basic:v1:${revision}`,
      title: 'Edit name and position',
      components: [
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
            value: snapshot.profile.name,
          },
        },
        {
          type: 18,
          label: 'Position',
          component: {
            type: 4,
            custom_id: 'position',
            style: 1,
            min_length: 1,
            max_length: 160,
            required: true,
            value: snapshot.profile.position,
          },
        },
        profileEditConfirmation(),
      ],
    },
  };
}

export function editTextModalResponse(snapshot: ProfileSnapshot): DiscordInteractionResponse {
  const revision = assertProfileRevision(snapshot.stateRevision);
  return {
    type: 9,
    data: {
      custom_id: `profile-text:v1:${revision}`,
      title: 'Edit profile information',
      components: [
        paragraphInput('Details', 'details', snapshot.profile.details, 2_000),
        paragraphInput(
          'Research interests',
          'research_interests',
          snapshot.profile.researchInterests,
          2_000,
        ),
        paragraphInput(
          'Contact',
          'contact',
          snapshot.profile.contact,
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
            value: snapshot.profile.website,
          },
        },
        profileEditConfirmation(),
      ],
    },
  };
}

export function categoryModalResponse(snapshot: ProfileSnapshot): DiscordInteractionResponse {
  const revision = assertProfileRevision(snapshot.stateRevision);
  return {
    type: 9,
    data: {
      custom_id: `profile-category:v1:${revision}`,
      title: 'Member category',
      components: [
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
              default: order === snapshot.profile.order,
            })),
          },
        },
        profileEditConfirmation(),
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
): DiscordInteractionResponse {
  return {
    type: 4,
    data: {
      flags: EPHEMERAL_FLAG | IS_COMPONENTS_V2_FLAG,
      allowed_mentions: { parse: [] },
      components: profilePanelComponents(snapshot, undefined, publicationMode),
    },
  };
}

export function profilePanelEdit(
  snapshot: ProfileSnapshot,
  notice?: string,
  publicationMode: 'sandbox' | 'production' = 'production',
): DiscordMessagePayload {
  return v2Edit(profilePanelComponents(snapshot, notice, publicationMode), []);
}

function profilePanelComponents(
  snapshot: ProfileSnapshot,
  notice: string | undefined,
  publicationMode: 'sandbox' | 'production',
) {
  const revision = assertProfileRevision(snapshot.stateRevision);
  const category = memberCategories.find(({ order }) => order === snapshot.profile.order)?.label;
  const profile = snapshot.profile;
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
  ]
    .filter(Boolean)
    .join('\n');

  const containerChildren: Record<string, unknown>[] = [{ type: 10, content: summary }];

  if (snapshot.bindingStatus === 'active') {
    containerChildren.push(
      {
        type: 1,
        components: [
          button('Name & position', 'profile:edit-basic', 1),
          button('Profile details', 'profile:edit-text', 2),
          button('Category', 'profile:edit-category', 2),
          button('Change photo', 'profile:replace-photo', 2),
        ],
      },
      {
        type: 1,
        components: [
          button('Remove photo', `profile:remove-photo:${revision}`, 4),
          button(
            publicationMode === 'sandbox'
              ? (profile.listed ? 'Mark hidden (sandbox)' : 'Mark listed (sandbox)')
              : (profile.listed ? 'Hide from website' : 'Show on website'),
            `profile:set-listed:${profile.listed ? '0' : '1'}:${revision}`,
            profile.listed ? 2 : 3,
          ),
        ],
      },
    );
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
): DiscordMessagePayload {
  if (result?.queued) {
    return v2Edit(
      [
        {
          type: 10,
          content:
            'The profile update was accepted and is safely queued. '
            + 'Run `/profile` again shortly to see the published result.',
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

export function operationPendingEdit(): DiscordMessagePayload {
  return v2Edit(
    [
      {
        type: 10,
        content:
          'Your profile registration or previous update is being published and may take a few minutes. '
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
        `${prepared.width}×${prepared.height} WebP. Save this result?`,
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
        button('Save photo', `profile:photo-confirm:${stagedPhotoId}`, 3),
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

function profileEditConfirmation() {
  return {
    type: 18,
    label: 'Confirm save and publish',
    description: 'Required. Submitting saves now and publishes immediately in production.',
    component: {
      type: 22,
      custom_id: PROFILE_EDIT_CONFIRMATION_CUSTOM_ID,
      min_values: 1,
      max_values: 1,
      required: true,
      options: [
        {
          label: 'Save and publish this edit now',
          value: PROFILE_EDIT_CONFIRMATION_VALUE,
        },
      ],
    },
  };
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
