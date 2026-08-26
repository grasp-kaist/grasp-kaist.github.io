import { DiscordInputError } from './inputs.js';
import { ephemeralTextResponse, pongResponse } from './payloads.js';
import type { DiscordInteraction, InteractionRouteResult } from './types.js';

type InteractionRouter = {
  route(interaction: DiscordInteraction): Promise<InteractionRouteResult>;
};

const DISCORD_GUILD_ID_PATTERN = /^\d{17,20}$/;

/** Routes each guild interaction to a cached, guild-bound inner router. */
export class DiscordGuildRouter {
  readonly #applicationId: string;
  readonly #createRouter: (guildId: string) => InteractionRouter;
  readonly #reportError: (error: unknown) => void;
  readonly #routers = new Map<string, InteractionRouter>();

  constructor(options: {
    applicationId: string;
    createRouter(guildId: string): InteractionRouter;
    reportError?: (error: unknown) => void;
  }) {
    this.#applicationId = options.applicationId;
    this.#createRouter = options.createRouter;
    this.#reportError = options.reportError ?? (() => undefined);
  }

  async route(interaction: DiscordInteraction): Promise<InteractionRouteResult> {
    try {
      if (interaction.application_id !== this.#applicationId) {
        throw new DiscordInputError('Interaction application ID does not match this service.');
      }

      if (interaction.type === 1) {
        return { response: pongResponse() };
      }

      const guildId = interaction.guild_id;

      if (!guildId || !DISCORD_GUILD_ID_PATTERN.test(guildId)) {
        throw new DiscordInputError('This command must be used in a Discord server.');
      }

      let router = this.#routers.get(guildId);

      if (!router) {
        router = this.#createRouter(guildId);
        this.#routers.set(guildId, router);
      }

      return await router.route(interaction);
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
}
