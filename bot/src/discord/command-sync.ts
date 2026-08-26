import {
  ApplicationIntegrationType,
  InteractionContextType,
  REST,
  Routes,
  type RESTPutAPIApplicationCommandsJSONBody,
} from 'discord.js';

import { guildCommands } from './commands.js';

export type DiscordCommandRest = {
  get(route: string): Promise<unknown>;
  put(route: string, options: { body: RESTPutAPIApplicationCommandsJSONBody }): Promise<unknown>;
};

export type GlobalCommandSyncResult = {
  changed: boolean;
  commandCount: number;
};

/**
 * The profile bot is intentionally server-installable and server-only even
 * though its commands are registered globally. Registering them globally
 * makes them available as soon as the application is installed in a guild.
 */
export const globalGuildCommands = guildCommands.map((command) => ({
  ...command,
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild],
})) as RESTPutAPIApplicationCommandsJSONBody;

/**
 * Compare the deployed schema before bulk-overwriting it. Discord command
 * objects contain generated IDs, versions, and default-valued fields, so the
 * comparison projects each remote command onto the desired schema rather than
 * comparing the complete API response.
 */
export async function syncGlobalCommandsIfChanged(input: {
  applicationId: string;
  botToken: string;
  rest?: DiscordCommandRest;
}): Promise<GlobalCommandSyncResult> {
  const rest =
    input.rest ??
    (new REST({ version: '10' }).setToken(input.botToken) as DiscordCommandRest);
  const route = Routes.applicationCommands(input.applicationId);
  const current = await rest.get(route);

  if (commandSchemasEqual(current, globalGuildCommands)) {
    return { changed: false, commandCount: globalGuildCommands.length };
  }

  await rest.put(route, { body: globalGuildCommands });
  return { changed: true, commandCount: globalGuildCommands.length };
}

export function commandSchemasEqual(
  current: unknown,
  desired: RESTPutAPIApplicationCommandsJSONBody = globalGuildCommands,
) {
  if (!Array.isArray(current) || current.length !== desired.length) {
    return false;
  }

  const currentByKey = new Map<string, Record<string, unknown>>();

  for (const command of current) {
    if (!isRecord(command)) {
      return false;
    }

    const key = commandKey(command);

    if (!key || currentByKey.has(key)) {
      return false;
    }

    currentByKey.set(key, command);
  }

  return desired.every((command) => {
    const key = commandKey(command);
    const deployed = key ? currentByKey.get(key) : undefined;
    return deployed !== undefined && matchesDesiredShape(deployed, command);
  });
}

function commandKey(command: unknown) {
  if (!isRecord(command)) {
    return undefined;
  }

  if (typeof command.name !== 'string') {
    return undefined;
  }

  const type = typeof command.type === 'number' ? command.type : 1;
  return `${type}:${command.name}`;
}

function matchesDesiredShape(actual: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((item, index) => matchesDesiredShape(actual[index], item))
    );
  }

  if (isRecord(desired)) {
    if (!isRecord(actual)) {
      return false;
    }

    return Object.entries(desired).every(([key, value]) =>
      matchesDesiredShape(actual[key], value),
    );
  }

  return Object.is(actual, desired);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
