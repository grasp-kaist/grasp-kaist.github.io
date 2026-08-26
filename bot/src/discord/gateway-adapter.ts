import {
  ComponentType,
  type APIMessageTopLevelComponent,
  type APIModalInteractionResponseCallbackData,
  type ApplicationCommandOptionChoiceData,
  type BaseInteractionResolvedData,
  type CommandInteractionOption,
  type Interaction,
  type InteractionReplyOptions,
  type MessageMentionOptions,
  type ModalData,
  type ModalSubmitInteraction,
} from 'discord.js';

import type { DiscordInteractionRouter } from './router.js';
import type {
  DiscordAttachment,
  DiscordCommandOption,
  DiscordInteraction,
  DiscordInteractionResponse,
  DiscordModalChild,
  DiscordModalComponent,
  DiscordResolvedData,
  InteractionRouteResult,
} from './types.js';

type GatewayRouter = Pick<DiscordInteractionRouter, 'route'>;

export class DiscordGatewayAckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscordGatewayAckError';
  }
}

/** Convert discord.js' interaction classes back to the narrow API shape used by the existing router. */
export function toRouterInteraction(interaction: Interaction): DiscordInteraction {
  const converted: DiscordInteraction = {
    id: interaction.id,
    application_id: interaction.applicationId,
    type: interaction.type,
    token: interaction.token,
    version: interaction.version,
    user: { id: interaction.user.id },
  };

  if (interaction.guildId) {
    converted.guild_id = interaction.guildId;
    converted.member = { user: { id: interaction.user.id } };
  }

  if (interaction.isChatInputCommand()) {
    const resolved = toRouterResolvedData(interaction.options.resolved);
    converted.data = {
      name: interaction.commandName,
      type: interaction.commandType,
      options: interaction.options.data.map(toRouterCommandOption),
      ...(resolved ? { resolved } : {}),
    };
    return converted;
  }

  if (interaction.isAutocomplete()) {
    converted.data = {
      name: interaction.commandName,
      type: interaction.commandType,
      options: interaction.options.data.map(toRouterCommandOption),
    };
    return converted;
  }

  if (interaction.isMessageComponent()) {
    converted.data = {
      custom_id: interaction.customId,
      component_type: interaction.componentType,
      ...('values' in interaction && Array.isArray(interaction.values)
        ? { values: [...interaction.values] }
        : {}),
    };
    return converted;
  }

  if (interaction.isModalSubmit()) {
    const resolved = toRouterResolvedData(interaction.fields.resolved);
    converted.data = {
      custom_id: interaction.customId,
      components: toRouterModalComponents(interaction),
      ...(resolved ? { resolved } : {}),
    };
  }

  return converted;
}

/**
 * Send the router's initial callback through discord.js. Only after Discord
 * accepts that acknowledgement may the router's slow follow-up work begin.
 */
export async function dispatchGatewayInteraction(
  interaction: Interaction,
  router: GatewayRouter,
  reportError: (error: unknown) => void = console.error,
): Promise<InteractionRouteResult> {
  const result = await router.route(toRouterInteraction(interaction));
  await acknowledgeGatewayInteraction(interaction, result.response);

  if (result.afterResponse) {
    try {
      await result.afterResponse();
    } catch (error) {
      reportError(error);
    }
  }

  return result;
}

export async function acknowledgeGatewayInteraction(
  interaction: Interaction,
  response: DiscordInteractionResponse,
) {
  switch (response.type) {
    case 4: {
      if (!interaction.isRepliable()) {
        throw new DiscordGatewayAckError('This interaction cannot receive a message response.');
      }

      await interaction.reply(toInteractionReplyOptions(response.data));
      return;
    }
    case 5: {
      if (!interaction.isRepliable()) {
        throw new DiscordGatewayAckError('This interaction cannot be deferred.');
      }

      const flags = response.data?.flags;
      await interaction.deferReply({
        ...(typeof flags === 'number'
          ? { flags: flags as NonNullable<Parameters<typeof interaction.deferReply>[0]>['flags'] }
          : {}),
      });
      return;
    }
    case 6: {
      if (
        !('deferUpdate' in interaction) ||
        typeof interaction.deferUpdate !== 'function'
      ) {
        throw new DiscordGatewayAckError('This interaction cannot defer a message update.');
      }

      await interaction.deferUpdate();
      return;
    }
    case 8: {
      if (!interaction.isAutocomplete()) {
        throw new DiscordGatewayAckError('Only autocomplete interactions accept choices.');
      }

      await interaction.respond(toAutocompleteChoices(response.data?.choices));
      return;
    }
    case 9: {
      if (!('showModal' in interaction) || typeof interaction.showModal !== 'function') {
        throw new DiscordGatewayAckError('This interaction cannot open a modal.');
      }

      if (!response.data) {
        throw new DiscordGatewayAckError('The modal response has no data.');
      }

      await interaction.showModal(
        response.data as unknown as APIModalInteractionResponseCallbackData,
      );
      return;
    }
    default:
      throw new DiscordGatewayAckError(
        `Unsupported Gateway interaction response type: ${response.type}.`,
      );
  }
}

function toRouterCommandOption(option: CommandInteractionOption): DiscordCommandOption {
  return {
    name: option.name,
    type: option.type,
    ...('value' in option && option.value !== undefined ? { value: option.value } : {}),
    ...(option.options ? { options: option.options.map(toRouterCommandOption) } : {}),
  };
}

function toRouterModalComponents(
  interaction: ModalSubmitInteraction,
): DiscordModalComponent[] {
  const converted: DiscordModalComponent[] = [];

  for (const top of interaction.fields.components) {
    if ('component' in top) {
      converted.push({
        type: 18,
        id: top.id,
        component: toRouterModalChild(top.component),
      });
      continue;
    }

    if ('components' in top) {
      for (const component of top.components) {
        converted.push({
          type: 18,
          id: top.id,
          component: toRouterModalChild(component),
        });
      }
      continue;
    }

    converted.push({ type: 10, id: top.id });

  }

  return converted;
}

function toRouterModalChild(component: ModalData): DiscordModalChild {
  switch (component.type) {
    case ComponentType.TextInput:
      return {
        type: 4,
        id: component.id,
        custom_id: component.customId,
        value: component.value,
      };
    case ComponentType.StringSelect:
    case ComponentType.FileUpload:
    case ComponentType.CheckboxGroup:
      return {
        type: component.type,
        id: component.id,
        custom_id: component.customId,
        values: [...component.values],
      };
    case ComponentType.RadioGroup:
      return {
        type: 21,
        id: component.id,
        custom_id: component.customId,
        value: component.value,
      };
    case ComponentType.Checkbox:
      return {
        type: 23,
        id: component.id,
        custom_id: component.customId,
        value: component.value,
      };
    default:
      throw new TypeError(`Unsupported modal component type: ${component.type}.`);
  }
}

function toRouterResolvedData(
  resolved: Readonly<BaseInteractionResolvedData> | null,
): DiscordResolvedData | undefined {
  if (!resolved) {
    return undefined;
  }

  const converted: DiscordResolvedData = {};

  if (resolved.users) {
    converted.users = Object.fromEntries(
      resolved.users.map((user, id) => [id, { id: user.id, username: user.username }]),
    );
  }

  if (resolved.members) {
    converted.members = Object.fromEntries(resolved.members.map((_member, id) => [id, {}]));
  }

  if (resolved.attachments) {
    converted.attachments = Object.fromEntries(
      resolved.attachments.map((attachment, id) => [id, toRouterAttachment(attachment)]),
    );
  }

  return Object.keys(converted).length > 0 ? converted : undefined;
}

function toRouterAttachment(
  attachment: NonNullable<BaseInteractionResolvedData['attachments']> extends ReadonlyMap<
    string,
    infer Value
  >
    ? Value
    : never,
): DiscordAttachment {
  return {
    id: attachment.id,
    filename: attachment.name,
    size: attachment.size,
    url: attachment.url,
    proxy_url: attachment.proxyURL,
    ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
    width: attachment.width,
    height: attachment.height,
    ephemeral: attachment.ephemeral,
  };
}

function toInteractionReplyOptions(
  data: Record<string, unknown> | undefined,
): InteractionReplyOptions {
  const options: InteractionReplyOptions = {};

  if (!data) {
    return options;
  }

  if (typeof data.content === 'string') {
    options.content = data.content;
  }

  if (Array.isArray(data.embeds)) {
    options.embeds = data.embeds as NonNullable<InteractionReplyOptions['embeds']>;
  }

  if (Array.isArray(data.components)) {
    options.components = data.components as APIMessageTopLevelComponent[];
  }

  if (typeof data.flags === 'number') {
    options.flags = data.flags as InteractionReplyOptions['flags'];
  }

  if (typeof data.tts === 'boolean') {
    options.tts = data.tts;
  }

  const allowedMentions = toAllowedMentions(data.allowed_mentions);

  if (allowedMentions) {
    options.allowedMentions = allowedMentions;
  }

  if (Array.isArray(data.attachments) && data.attachments.length > 0) {
    throw new DiscordGatewayAckError(
      'Initial Gateway responses with attachment metadata require file data.',
    );
  }

  return options;
}

function toAllowedMentions(value: unknown): MessageMentionOptions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const options: MessageMentionOptions = {};

  if (Array.isArray(value.parse)) {
    options.parse = value.parse.filter(
      (entry): entry is 'users' | 'roles' | 'everyone' =>
        entry === 'users' || entry === 'roles' || entry === 'everyone',
    );
  }

  if (Array.isArray(value.users) && value.users.every((entry) => typeof entry === 'string')) {
    options.users = value.users;
  }

  if (Array.isArray(value.roles) && value.roles.every((entry) => typeof entry === 'string')) {
    options.roles = value.roles;
  }

  if (typeof value.replied_user === 'boolean') {
    options.repliedUser = value.replied_user;
  }

  return options;
}

function toAutocompleteChoices(value: unknown): ApplicationCommandOptionChoiceData[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((choice) => {
    if (
      !isRecord(choice) ||
      typeof choice.name !== 'string' ||
      (typeof choice.value !== 'string' && typeof choice.value !== 'number')
    ) {
      return [];
    }

    return [
      {
        name: choice.name,
        value: choice.value,
        ...(isRecord(choice.name_localizations)
          ? { nameLocalizations: choice.name_localizations as Record<string, string> }
          : {}),
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
