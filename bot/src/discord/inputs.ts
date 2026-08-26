import { isMemberOrder, type MemberOrder } from '../domain/member-profile.js';
import type {
  DiscordAttachment,
  DiscordCommandOption,
  DiscordInteraction,
  DiscordModalChild,
} from './types.js';

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export const PROFILE_EDIT_CONFIRMATION_CUSTOM_ID = 'profile_edit_confirmation';
export const PROFILE_EDIT_CONFIRMATION_VALUE = 'save_and_publish';

export class DiscordInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordInputError';
  }
}

export function parseDiscordInteraction(value: unknown): DiscordInteraction {
  if (!isRecord(value)) {
    throw new DiscordInputError('Interaction body must be an object.');
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.application_id !== 'string' ||
    typeof value.token !== 'string' ||
    typeof value.type !== 'number'
  ) {
    throw new DiscordInputError('Interaction is missing required fields.');
  }

  return value as DiscordInteraction;
}

export function getGuildUserId(interaction: DiscordInteraction) {
  const userId = interaction.member?.user?.id;

  if (!userId || !SNOWFLAKE_PATTERN.test(userId)) {
    throw new DiscordInputError('This interaction must have a valid guild member.');
  }

  return userId;
}

export function assertExpectedGuild(interaction: DiscordInteraction, guildId: string) {
  if (interaction.guild_id !== guildId) {
    throw new DiscordInputError('This command is only available in the configured Discord server.');
  }
}

export function getCommandOption(
  options: readonly DiscordCommandOption[] | undefined,
  name: string,
) {
  return options?.find((option) => option.name === name);
}

export function getRequiredMemberOrderOption(
  options: readonly DiscordCommandOption[] | undefined,
  name = 'category',
): MemberOrder {
  const value = getCommandOption(options, name)?.value;

  if (typeof value !== 'number' || !isMemberOrder(value)) {
    throw new DiscordInputError('Member category must be one of the configured choices.');
  }

  return value;
}

export function findModalChild(interaction: DiscordInteraction, customId: string) {
  for (const top of interaction.data?.components ?? []) {
    if (top.type === 18 && 'component' in top && top.component.custom_id === customId) {
      return top.component;
    }
  }

  return undefined;
}

export function getRequiredModalText(interaction: DiscordInteraction, customId: string) {
  const child = findModalChild(interaction, customId);

  if (!child || child.type !== 4 || typeof child.value !== 'string' || !child.value.trim()) {
    throw new DiscordInputError(`${customId} is required.`);
  }

  return child.value;
}

export function getOptionalModalText(interaction: DiscordInteraction, customId: string) {
  const child = findModalChild(interaction, customId);

  if (!child) {
    return '';
  }

  if (child.type !== 4 || typeof child.value !== 'string') {
    throw new DiscordInputError(`${customId} must be text.`);
  }

  return child.value;
}

export function getSingleModalValue(interaction: DiscordInteraction, customId: string) {
  const child = findModalChild(interaction, customId);

  if (!child || !hasValues(child) || child.values.length !== 1 || !child.values[0]) {
    throw new DiscordInputError(`${customId} requires exactly one selection.`);
  }

  return child.values[0];
}

export function assertRegistrationConsent(interaction: DiscordInteraction) {
  if (getSingleModalValue(interaction, 'consent') !== 'accepted') {
    throw new DiscordInputError('Public information confirmation is required.');
  }
}

export function assertProfileEditConfirmation(interaction: DiscordInteraction) {
  const child = findModalChild(interaction, PROFILE_EDIT_CONFIRMATION_CUSTOM_ID);

  if (
    !child
    || !hasValues(child)
    || child.values.length !== 1
    || child.values[0] !== PROFILE_EDIT_CONFIRMATION_VALUE
  ) {
    throw new DiscordInputError(
      'Select the confirmation that saves and publishes this profile edit immediately.',
    );
  }
}

export function getModalMemberOrder(interaction: DiscordInteraction): MemberOrder {
  const raw = getSingleModalValue(interaction, 'category');
  const order = Number(raw);

  if (!Number.isInteger(order) || !isMemberOrder(order)) {
    throw new DiscordInputError('Member category must be one of the configured choices.');
  }

  return order;
}

export function getUploadedAttachment(
  interaction: DiscordInteraction,
  customId = 'photo',
): DiscordAttachment {
  const attachmentId = getSingleModalValue(interaction, customId);
  const attachment = interaction.data?.resolved?.attachments?.[attachmentId];

  if (!attachment || attachment.id !== attachmentId) {
    throw new DiscordInputError('The uploaded file is missing from resolved.attachments.');
  }

  if (
    typeof attachment.filename !== 'string' ||
    typeof attachment.url !== 'string' ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size < 0
  ) {
    throw new DiscordInputError('The uploaded file metadata is invalid.');
  }

  return attachment;
}

export function splitModalLines(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function hasValues(
  child: DiscordModalChild,
): child is Extract<DiscordModalChild, { values: string[] }> {
  return 'values' in child && Array.isArray(child.values);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
