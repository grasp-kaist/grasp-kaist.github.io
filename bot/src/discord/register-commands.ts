import { registerGuildCommands } from './commands.js';

const applicationId = requireEnvironmentVariable('DISCORD_APPLICATION_ID');
const guildId = requireEnvironmentVariable('DISCORD_GUILD_ID');
const botToken = requireEnvironmentVariable('DISCORD_BOT_TOKEN');

await registerGuildCommands({ applicationId, guildId, botToken });
process.stdout.write('Registered GRASP profile commands for the configured Discord server.\n');

function requireEnvironmentVariable(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}
