import { Hono } from 'hono';

export type BotHealthSnapshot = {
  ready: boolean;
  gateway: 'starting' | 'ready' | 'reconnecting' | 'disconnected' | 'stopping';
  profileRecovery: 'running' | 'ready';
  publicationMode: 'sandbox' | 'production';
  publicationQueue: 'disabled' | 'recovering' | 'ready' | 'degraded';
  queuedPublications: number;
  storage: 'ready';
};

export function createHealthApp(getSnapshot: () => BotHealthSnapshot) {
  const app = new Hono();

  app.get('/healthz', (context) => {
    const snapshot = getSnapshot();
    return context.json(
      {
        status: snapshot.ready ? 'ok' : 'starting',
        gateway: snapshot.gateway,
        profileRecovery: snapshot.profileRecovery,
        publicationMode: snapshot.publicationMode,
        publicationQueue: snapshot.publicationQueue,
        queuedPublications: snapshot.queuedPublications,
        storage: snapshot.storage,
      },
      snapshot.ready ? 200 : 503,
    );
  });

  app.notFound((context) => context.json({ error: 'not found' }, 404));
  return app;
}
