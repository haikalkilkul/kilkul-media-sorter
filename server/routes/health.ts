import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', {
    schema: { response: { 200: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['ok'] } } } } },
  }, async () => ({ status: 'ok' as const }));
}
