import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FolderError, type FolderRegistry } from '../services/folder-registry.js';

const contentTypes: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.3gp': 'video/3gpp',
  '.mts': 'video/mp2t', '.m2ts': 'video/mp2t',
};

type RangeResult = { start: number; end: number };

function parseSingleRange(header: string | undefined, size: number): RangeResult | 'invalid' {
  if (header === undefined) return { start: 0, end: Math.max(0, size - 1) };
  if (size === 0 || !/^bytes=\d*-\d*$/.test(header) || header === 'bytes=-') return 'invalid';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return 'invalid';
  const [, startText, endText] = match;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || start > requestedEnd) return 'invalid';
  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function sendPreview(request: FastifyRequest<{ Params: { id: string }; Querystring: { scan: string } }>, reply: FastifyReply, registry: FolderRegistry) {
  const media = await registry.openMedia(request.params.id, request.query.scan);
  const type = contentTypes[media.extension];
  if (!type) {
    await media.handle.close();
    throw new FolderError('Media type is not supported for preview.', 415);
  }

  const previewHeaders = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (request.method === 'HEAD') {
    await media.handle.close();
    reply.hijack();
    reply.raw.writeHead(200, { ...previewHeaders, 'Content-Length': String(media.sizeBytes) });
    reply.raw.end();
    return reply;
  }
  for (const [name, value] of Object.entries(previewHeaders)) reply.header(name, value);

  const range = parseSingleRange(request.headers.range, media.sizeBytes);
  if (range === 'invalid') {
    await media.handle.close();
    return reply.code(416)
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Range', `bytes */${media.sizeBytes}`)
      .send({ error: 'Requested byte range is not satisfiable.' });
  }

  if (media.sizeBytes === 0) {
    await media.handle.close();
    return reply.code(200).header('Content-Length', '0').send();
  }

  const start = range.start;
  const end = range.end;
  const status = request.headers.range ? 206 : 200;
  const length = end - start + 1;
  if (status === 206) reply.header('Content-Range', `bytes ${start}-${end}/${media.sizeBytes}`);
  reply.code(status).header('Content-Length', String(length));

  const stream = media.handle.createReadStream({ start, end, autoClose: true });
  const abortStream = () => stream.destroy();
  if (media.signal.aborted) abortStream();
  else media.signal.addEventListener('abort', abortStream, { once: true });
  stream.once('close', () => media.signal.removeEventListener('abort', abortStream));
  request.raw.once('aborted', () => stream.destroy());
  reply.raw.once('close', () => { if (!reply.raw.writableEnded) stream.destroy(); });
  return reply.send(stream);
}

export function registerMediaRoutes(app: FastifyInstance, registry: FolderRegistry): void {
  const route = {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9]{32}$' } } },
      querystring: { type: 'object', required: ['scan'], additionalProperties: false, properties: { scan: { type: 'string', format: 'uuid' } } },
    },
  } as const;
  app.get<{ Params: { id: string }; Querystring: { scan: string } }>('/api/media/:id/preview', route, (request, reply) => sendPreview(request, reply, registry));
  app.post<{ Params: { id: string }; Body: { scanId: string; destinationId: string } }>('/api/media/:id/move', {
    // Fastify's default AJV configuration may remove unknown properties before
    // schema validation. Reject them here so callers cannot submit filesystem paths.
    preValidation: async request => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'scanId' && key !== 'destinationId')) {
        throw new FolderError('Invalid request.', 400);
      }
    },
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9]{32}$' } } },
      body: {
        type: 'object', additionalProperties: false, required: ['scanId', 'destinationId'],
        properties: { scanId: { type: 'string', format: 'uuid' }, destinationId: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => reply.send(await registry.moveMedia(request.params.id, request.body.scanId, request.body.destinationId)));
  app.post<{ Body: { ids: string[]; scanId: string; destinationId: string } }>('/api/media/batch-move', {
    preValidation: async request => {
      const body = request.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['ids', 'scanId', 'destinationId'].includes(key))) {
        throw new FolderError('Invalid request.', 400);
      }
    },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['ids', 'scanId', 'destinationId'],
        properties: {
          ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', pattern: '^[a-f0-9]{32}$' } },
          scanId: { type: 'string', format: 'uuid' }, destinationId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => reply.send(await registry.moveBatch(request.body.ids, request.body.scanId, request.body.destinationId)));
}
