import { isMemberOrder, type MemberOrder } from '../domain/member-profile.js';
import {
  assertExpectedGuild,
  assertRegistrationConsent,
  DiscordInputError,
  getGuildUserId,
  getModalMemberOrder,
  getOptionalModalText,
  getRequiredMemberOrderOption,
  getRequiredModalText,
  getRequiredStringOption,
  getSingleModalValue,
  getSubcommand,
  getUploadedAttachment,
  splitModalLines,
} from './inputs.js';
import {
  assertPhotoToken,
  categoryModalResponse,
  deferEphemeralResponse,
  deferUpdateResponse,
  editBasicModalResponse,
  editTextModalResponse,
  ephemeralTextResponse,
  operationCompleteEdit,
  operationFailedEdit,
  photoFlowFinishedEdit,
  photoUploadModalResponse,
  pongResponse,
  preparedPhotoPreviewEdit,
  profilePanelResponse,
  profilePanelEdit,
  registerModalResponse,
} from './payloads.js';
import type {
  AttachmentDownloader,
  DiscordActor,
  DiscordInteraction,
  InteractionRouteResult,
  InteractionWebhookClient,
  ProfileOperationResult,
  ProfileService,
  ProfileSnapshot,
} from './types.js';

type InteractionRouterConfig = {
  applicationId: string;
  guildId: string;
  ownerUserId: string;
};

type InteractionRouterDependencies = {
  config: InteractionRouterConfig;
  service: ProfileService;
  webhook: InteractionWebhookClient;
  attachmentDownloader: AttachmentDownloader;
  formatError?: (error: unknown) => string;
  reportError?: (error: unknown) => void;
};

export class DiscordInteractionRouter {
  readonly #config: InteractionRouterConfig;
  readonly #service: ProfileService;
  readonly #webhook: InteractionWebhookClient;
  readonly #attachmentDownloader: AttachmentDownloader;
  readonly #formatError: (error: unknown) => string;
  readonly #reportError: (error: unknown) => void;

  constructor(dependencies: InteractionRouterDependencies) {
    this.#config = dependencies.config;
    this.#service = dependencies.service;
    this.#webhook = dependencies.webhook;
    this.#attachmentDownloader = dependencies.attachmentDownloader;
    this.#formatError =
      dependencies.formatError ?? (() => 'No website changes were published. Please try again.');
    this.#reportError = dependencies.reportError ?? (() => undefined);
  }

  async route(interaction: DiscordInteraction): Promise<InteractionRouteResult> {
    try {
      if (interaction.application_id !== this.#config.applicationId) {
        throw new DiscordInputError('Interaction application ID does not match this service.');
      }

      if (interaction.type === 1) {
        return { response: pongResponse() };
      }

      assertExpectedGuild(interaction, this.#config.guildId);
      const userId = getGuildUserId(interaction);

      switch (interaction.type) {
        case 2:
          return await this.#routeCommand(interaction, userId);
        case 3:
          return await this.#routeMessageComponent(interaction, userId);
        case 4:
          return { response: { type: 8, data: { choices: [] } } };
        case 5:
          return this.#routeModalSubmit(interaction, userId);
        default:
          throw new DiscordInputError('Unsupported interaction type.');
      }
    } catch (error) {
      if (!(error instanceof DiscordInputError)) {
        this.#reportError(error);
      }

      return {
        response: ephemeralTextResponse(
          error instanceof DiscordInputError
            ? error.message
            : 'Unable to open the profile interface. Please try again.',
        ),
      };
    }
  }

  async #routeCommand(interaction: DiscordInteraction, userId: string) {
    const commandName = interaction.data?.name;

    switch (commandName) {
      case 'register': {
        const order = getRequiredMemberOrderOption(interaction.data?.options);
        const local = this.#service.getOwnProfileLocal(this.#config.guildId, userId);

        if (local.snapshot) {
          return { response: profilePanelResponse(local.snapshot) };
        }

        if (local.hasBinding) {
          return {
            response: ephemeralTextResponse(
              'This Discord account already has a registration that is being recovered. Run `/profile` again shortly.',
            ),
          };
        }

        return { response: registerModalResponse(order) };
      }
      case 'profile':
        return {
          response: deferEphemeralResponse(),
          afterResponse: async () => {
            try {
              const snapshot = await this.#service.getOwnProfile(
                this.#config.guildId,
                userId,
              );
              await this.#webhook.editOriginal(
                interaction.token,
                snapshot
                  ? profilePanelEdit(snapshot)
                  : photoFlowFinishedEdit(
                      'You do not have a GRASP profile yet. Run `/register` to create one.',
                    ),
              );
            } catch (error) {
              await this.#editDeferredFailure(interaction.token, error);
            }
          },
        };
      case 'profile-admin':
        this.#assertOwner(userId);
        return this.#routeAdminCommand(interaction, userId);
      default:
        throw new DiscordInputError('Unknown application command.');
    }
  }

  #routeAdminCommand(interaction: DiscordInteraction, userId: string): InteractionRouteResult {
    const actor = this.#actor(interaction, userId);
    const subcommand = getSubcommand(interaction.data?.options);

    switch (subcommand.name) {
      case 'hide': {
        const target = getRequiredStringOption(subcommand.options, 'member');
        return this.#deferredMutation(
          interaction,
          () => this.#service.ownerHide(actor, target),
          'The profile was hidden from the website.',
        );
      }
      case 'revoke': {
        const target = getRequiredStringOption(subcommand.options, 'member');
        return this.#deferredMutation(
          interaction,
          () => this.#service.ownerRevoke(actor, target),
          'The profile binding was suspended.',
        );
      }
      case 'restore': {
        const target = getRequiredStringOption(subcommand.options, 'member');
        return this.#deferredMutation(
          interaction,
          () => this.#service.ownerRestore(actor, target),
          'The profile binding was restored.',
        );
      }
      case 'transfer': {
        const from = getRequiredStringOption(subcommand.options, 'from');
        const to = getRequiredStringOption(subcommand.options, 'to');

        if (from === to) {
          throw new DiscordInputError('The current and new Discord accounts must differ.');
        }

        return this.#deferredMutation(
          interaction,
          () => this.#service.ownerTransfer(actor, from, to),
          'The profile binding was transferred.',
        );
      }
      case 'set-category': {
        const target = getRequiredStringOption(subcommand.options, 'member');
        const order = getRequiredMemberOrderOption(subcommand.options);
        return this.#deferredMutation(
          interaction,
          () => this.#service.ownerSetCategory(actor, target, order),
          'The member category was corrected.',
        );
      }
      default:
        throw new DiscordInputError('Unknown profile-admin subcommand.');
    }
  }

  async #routeMessageComponent(interaction: DiscordInteraction, userId: string) {
    const customId = interaction.data?.custom_id;

    if (!customId || interaction.data?.component_type !== 2) {
      throw new DiscordInputError('Unsupported profile component.');
    }

    if (customId === 'profile:edit-basic') {
      return { response: editBasicModalResponse(this.#requireActiveProfileLocal(userId)) };
    }

    if (customId === 'profile:edit-text') {
      return { response: editTextModalResponse(this.#requireActiveProfileLocal(userId)) };
    }

    if (customId === 'profile:edit-category') {
      return { response: categoryModalResponse(this.#requireActiveProfileLocal(userId)) };
    }

    if (customId === 'profile:replace-photo') {
      this.#requireActiveProfileLocal(userId);
      return { response: photoUploadModalResponse() };
    }

    const actor = this.#actor(interaction, userId);

    if (customId === 'profile:remove-photo') {
      return this.#deferredMutation(
        interaction,
        () => this.#service.removeOwnPhoto(actor),
        'Your profile photo was removed.',
        true,
      );
    }

    if (customId === 'profile:set-listed:0' || customId === 'profile:set-listed:1') {
      const listed = customId.endsWith(':1');
      return this.#deferredMutation(
        interaction,
        () => this.#service.setOwnListed(actor, listed),
        listed
          ? 'Your profile is now shown on the Members page.'
          : 'Your profile is now hidden from the Members page.',
        true,
      );
    }

    const confirmToken = getPhotoActionToken(customId, 'profile:photo-confirm:');

    if (confirmToken) {
      return this.#deferredMutation(
        interaction,
        () => this.#service.confirmOwnPhoto(actor, confirmToken),
        'Your profile photo was published.',
        true,
      );
    }

    const cancelToken = getPhotoActionToken(customId, 'profile:photo-cancel:');

    if (cancelToken) {
      return {
        response: deferUpdateResponse(),
        afterResponse: async () => {
          try {
            await this.#service.discardOwnPhoto(actor, cancelToken);
            const snapshot = await this.#service.getOwnProfile(
              this.#config.guildId,
              userId,
            );
            await this.#webhook.editOriginal(
              interaction.token,
              snapshot
                ? profilePanelEdit(snapshot, 'Profile photo change cancelled.')
                : photoFlowFinishedEdit('Profile photo change cancelled.'),
            );
          } catch (error) {
            await this.#editDeferredFailure(interaction.token, error);
          }
        },
      };
    }

    throw new DiscordInputError('Unknown profile button.');
  }

  #routeModalSubmit(interaction: DiscordInteraction, userId: string): InteractionRouteResult {
    const customId = interaction.data?.custom_id;
    const actor = this.#actor(interaction, userId);
    const registrationMatch = customId?.match(/^register:v1:([0-5])$/);

    if (registrationMatch) {
      const order = Number(registrationMatch[1]);

      if (!isMemberOrder(order)) {
        throw new DiscordInputError('Member category is invalid.');
      }

      const name = limitedRequiredText(interaction, 'name', 80);
      const position = limitedRequiredText(interaction, 'position', 160);
      assertRegistrationConsent(interaction);

      return this.#deferredMutation(
        interaction,
        () => this.#service.register(actor, { name, position, order }),
        'Your hidden GRASP profile was created. Run `/profile` to continue editing it.',
      );
    }

    if (customId === 'profile-basic:v1') {
      const name = limitedRequiredText(interaction, 'name', 80);
      const position = limitedRequiredText(interaction, 'position', 160);
      return this.#deferredMutation(
        interaction,
        () => this.#service.updateOwnProfile(actor, { name, position }),
        'Your name and position were updated.',
        true,
      );
    }

    if (customId === 'profile-text:v1') {
      const details = limitedOptionalText(interaction, 'details', 2_000);
      const researchInterests = limitedOptionalText(
        interaction,
        'research_interests',
        2_000,
      );
      const contact = limitedOptionalText(interaction, 'contact', 1_000);
      const website = limitedOptionalText(interaction, 'website', 500);
      return this.#deferredMutation(
        interaction,
        () =>
          this.#service.updateOwnProfile(actor, {
            details: splitModalLines(details),
            researchInterests: splitModalLines(researchInterests),
            contact: splitModalLines(contact),
            website,
          }),
        'Your profile information was updated.',
        true,
      );
    }

    if (customId === 'profile-category:v1') {
      const order = getModalMemberOrder(interaction);
      return this.#deferredMutation(
        interaction,
        () => this.#service.updateOwnProfile(actor, { order }),
        'Your member category was updated.',
        true,
      );
    }

    if (customId === 'profile-photo:v1') {
      const attachment = getUploadedAttachment(interaction);
      return {
        response: deferUpdateResponse(),
        afterResponse: async () => {
          try {
            const bytes = await this.#attachmentDownloader.download(attachment);
            const prepared = await this.#service.prepareOwnPhoto(actor, {
              bytes,
              filename: attachment.filename,
              ...(attachment.content_type ? { contentType: attachment.content_type } : {}),
            });
            const preview = preparedPhotoPreviewEdit(prepared);
            await this.#webhook.editOriginal(
              interaction.token,
              preview.payload,
              preview.files,
            );
          } catch (error) {
            await this.#editDeferredFailure(interaction.token, error);
          }
        },
      };
    }

    throw new DiscordInputError('Unknown profile form.');
  }

  #deferredMutation(
    interaction: DiscordInteraction,
    operation: () => Promise<ProfileOperationResult>,
    successMessage: string,
    updateOriginal = false,
  ): InteractionRouteResult {
    return {
      response: updateOriginal ? deferUpdateResponse() : deferEphemeralResponse(),
      afterResponse: async () => {
        try {
          const result = await operation();
          await this.#webhook.editOriginal(
            interaction.token,
            operationCompleteEdit(successMessage, result),
          );
        } catch (error) {
          await this.#editDeferredFailure(interaction.token, error);
        }
      },
    };
  }

  async #editDeferredFailure(interactionToken: string, error: unknown) {
    this.#reportError(error);
    await this.#webhook.editOriginal(
      interactionToken,
      operationFailedEdit(this.#formatError(error)),
    );
  }

  #requireActiveProfileLocal(userId: string): ProfileSnapshot {
    const local = this.#service.getOwnProfileLocal(this.#config.guildId, userId);
    const snapshot = local.snapshot;

    if (!snapshot) {
      throw new DiscordInputError(
        local.hasBinding
          ? 'This profile is still being recovered. Run `/profile` again shortly.'
          : 'Run `/register` before editing a profile.',
      );
    }

    if (snapshot.bindingStatus !== 'active') {
      throw new DiscordInputError('This profile is not currently active.');
    }

    return snapshot;
  }

  #assertOwner(userId: string) {
    if (userId !== this.#config.ownerUserId) {
      throw new DiscordInputError('Only the configured site owner can use this command.');
    }
  }

  #actor(interaction: DiscordInteraction, userId: string): DiscordActor {
    return {
      interactionId: interaction.id,
      guildId: this.#config.guildId,
      userId,
    };
  }
}

function limitedRequiredText(
  interaction: DiscordInteraction,
  customId: string,
  maxLength: number,
) {
  const value = getRequiredModalText(interaction, customId);

  if (value.length > maxLength) {
    throw new DiscordInputError(`${customId} is too long.`);
  }

  return value;
}

function limitedOptionalText(
  interaction: DiscordInteraction,
  customId: string,
  maxLength: number,
) {
  const value = getOptionalModalText(interaction, customId);

  if (value.length > maxLength) {
    throw new DiscordInputError(`${customId} is too long.`);
  }

  return value;
}

function getPhotoActionToken(customId: string, prefix: string) {
  if (!customId.startsWith(prefix)) {
    return undefined;
  }

  const token = customId.slice(prefix.length);

  try {
    return assertPhotoToken(token);
  } catch {
    throw new DiscordInputError('Prepared photo token is invalid.');
  }
}
