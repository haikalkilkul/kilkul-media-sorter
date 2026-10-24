import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { registerFolderRoutes } from './routes/folders.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMediaRoutes } from './routes/media.js';
import { FolderError, FolderRegistry } from './services/folder-registry.js';
import { ConfigurationStore, ConfigurationStoreError } from './services/config-store.js';

export async function createApp(options: { logger?: boolean; registry?: FolderRegistry; configPath?: string | null; configurationStore?: ConfigurationStore } = {}) {
  const app = Fastify({ logger: options.logger ?? true, trustProxy: false, bodyLimit: 140_000 });
  const allowedOrigin = 'http://127.0.0.1:5173';
  const configurationStore = options.configurationStore ?? (!options.registry && options.configPath !== null ? new ConfigurationStore(options.configPath) : undefined);
  const registry = options.registry ?? new FolderRegistry({ ...(configurationStore ? { configurationStore } : {}) });
  await registry.loadConfiguration();

  await app.register(helmet, { contentSecurityPolicy: false });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== '127.0.0.1:3001') return reply.code(400).send({ error: 'Invalid host' });
    const origin = request.headers.origin;
    if (origin && origin !== allowedOrigin) return reply.code(403).send({ error: 'Origin not allowed' });
    if (request.method !== 'GET' && !origin && request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'Cross-site requests are not allowed' });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof FolderError) return reply.code(error.statusCode).send({ error: error.message, ...(error.uncertain ? { uncertain: true } : {}), ...(error.rescanRequired ? { rescanRequired: true } : {}) });
    if (error instanceof ConfigurationStoreError) return reply.code(error.statusCode).send({ error: error.message });
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      return reply.code(400).send({ error: 'Invalid request.' });
    }
    app.log.error(error);
    return reply.code(500).send({ error: 'The local service could not complete the request.' });
  });

  registerHealthRoutes(app);
  registerFolderRoutes(app, registry);
  registerMediaRoutes(app, registry);
  return app;
}
