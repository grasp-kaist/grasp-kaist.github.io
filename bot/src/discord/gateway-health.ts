import { Events, type Client, type CloseEvent } from 'discord.js';

export type DiscordGatewayHealthState = {
  ready: boolean;
  gateway: 'starting' | 'ready' | 'reconnecting' | 'disconnected' | 'stopping';
};

export type DiscordGatewayHealthOptions = {
  client: Client;
  health: DiscordGatewayHealthState;
  isStartupComplete: () => boolean;
  isShuttingDown: () => boolean;
  onUnrecoverableDisconnect?: (event: CloseEvent, shardId: number) => void | Promise<void>;
};

/** Keep Railway readiness aligned with discord.js shard connection events. */
export function attachDiscordGatewayHealthEvents(
  options: DiscordGatewayHealthOptions,
): () => void {
  let unrecoverableDisconnectHandled = false;
  const markReconnecting = () => {
    if (!options.isShuttingDown()) {
      options.health.ready = false;
      options.health.gateway = 'reconnecting';
    }
  };
  const markDisconnected = (event: CloseEvent, shardId: number) => {
    if (!options.isShuttingDown()) {
      options.health.ready = false;
      options.health.gateway = 'disconnected';

      if (!unrecoverableDisconnectHandled && options.onUnrecoverableDisconnect) {
        unrecoverableDisconnectHandled = true;

        try {
          void Promise.resolve(options.onUnrecoverableDisconnect(event, shardId)).catch(
            () => undefined,
          );
        } catch {
          // Discord event handlers must not leak shutdown callback failures.
        }
      }
    }
  };
  const markReady = () => {
    if (options.isStartupComplete() && !options.isShuttingDown()) {
      options.health.ready = true;
      options.health.gateway = 'ready';
    }
  };

  options.client.on(Events.ShardReconnecting, markReconnecting);
  options.client.on(Events.ShardDisconnect, markDisconnected);
  options.client.on(Events.ShardReady, markReady);
  options.client.on(Events.ShardResume, markReady);

  return () => {
    options.client.off(Events.ShardReconnecting, markReconnecting);
    options.client.off(Events.ShardDisconnect, markDisconnected);
    options.client.off(Events.ShardReady, markReady);
    options.client.off(Events.ShardResume, markReady);
  };
}
