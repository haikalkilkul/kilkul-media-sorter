import type { FastifyInstance } from 'fastify';
import type { FolderRegistry } from '../services/folder-registry.js';

const pathBody = {
  type: 'object', additionalProperties: false, required: ['path'],
  properties: { path: { type: 'string', minLength: 1, maxLength: 32760 } },
} as const;

export function registerFolderRoutes(app: FastifyInstance, registry: FolderRegistry): void {
  app.get('/api/folders', async () => registry.getConfiguration());

  app.put<{ Body: { path: string } }>('/api/folders/source', { schema: { body: pathBody } }, async (request, reply) => {
    await registry.setSource(request.body.path);
    return reply.send(await registry.getConfiguration());
  });

  app.post<{ Body: { path: string } }>('/api/folders/destinations', { schema: { body: pathBody } }, async (request, reply) => {
    const destination = await registry.addDestination(request.body.path);
    return reply.code(201).send(destination);
  });

  app.delete<{ Params: { id: string } }>('/api/folders/destinations/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (request, reply) => {
    if (!await registry.removeDestination(request.params.id)) return reply.code(404).send({ error: 'Destination not found.' });
    return reply.code(204).send();
  });

  app.post<{ Body: { confirm: true } }>('/api/folders/recover', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['confirm'], properties: { confirm: { const: true } } } },
  }, async (_request, reply) => {
    await registry.recoverConfiguration();
    return reply.send(await registry.getConfiguration());
  });

  // Client paths are intentionally forbidden here: scan always uses server-held source configuration.
  app.post('/api/scan', { schema: { body: { type: 'object', maxProperties: 0, additionalProperties: false } } }, async (_request, reply) => {
    const { sourceId, scanId, result } = await registry.scan();
    return reply.send({ sourceId, scanId, ...result });
  });
}
