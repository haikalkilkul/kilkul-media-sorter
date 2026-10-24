import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../server/app';
import { discoverMedia } from '../server/services/media-discovery';

const headers = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173' };

async function temporaryDirectory(): Promise<string> {
  const fixtureRoot = path.join(process.cwd(), 'tests', '.tmp');
  await mkdir(fixtureRoot, { recursive: true });
  return mkdtemp(path.join(fixtureRoot, 'kilkul-discovery-'));
}

describe('media discovery', () => {
  it('discovers recursively, matches extensions without case, excludes unsupported files, and distinguishes duplicate names', async () => {
    const root = await temporaryDirectory();
    try {
      await mkdir(path.join(root, 'a'), { recursive: true });
      await mkdir(path.join(root, 'b'), { recursive: true });
      await writeFile(path.join(root, 'a', 'photo.JPG'), 'a');
      await writeFile(path.join(root, 'b', 'photo.JPG'), 'different');
      await writeFile(path.join(root, 'clip.Mp4'), 'video');
      await writeFile(path.join(root, 'notes.txt'), 'not media');
      const result = await discoverMedia(root, Buffer.alloc(32, 7), 'test-source');
      assert.equal(result.count, 3);
      assert.deepEqual(result.items.map(item => item.relativePath), ['a/photo.JPG', 'b/photo.JPG', 'clip.Mp4']);
      assert.equal(result.items[0].mediaType, 'image');
      assert.equal(result.items[0].sizeBytes, 1);
      assert.notEqual(result.items[0].id, result.items[1].id);
      assert.equal(result.warningCount, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns a valid empty result and reports a missing root clearly', async () => {
    const root = await temporaryDirectory();
    try {
      assert.deepEqual(await discoverMedia(root, Buffer.alloc(32), 'test-source'), { items: [], count: 0, warnings: [], warningCount: 0 });
      await assert.rejects(discoverMedia(path.join(root, 'missing'), Buffer.alloc(32), 'test-source'), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not follow directory symlinks', async t => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    try {
      await mkdir(path.join(root, 'real'));
      await writeFile(path.join(root, 'real', 'kept.png'), 'x');
      await writeFile(path.join(outside, 'secret.jpg'), 'outside root');
      try { await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory symlink creation is not permitted on this Windows host.'); return; }
        throw error;
      }
      const result = await discoverMedia(root, Buffer.alloc(32), 'test-source');
      assert.deepEqual(result.items.map(item => item.relativePath), ['real/kept.png']);
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});

describe('folder and scan API', () => {
  it('keeps scan paths server-side, validates roots/roles, and preserves the health endpoint', async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    const app = await createApp({ logger: false, configPath: null });
    try {
      await mkdir(source);
      await mkdir(path.join(source, 'trip'), { recursive: true });
      await mkdir(destination);
      await writeFile(path.join(source, 'trip', 'sample.webp'), 'image');
      await writeFile(path.join(source, 'clip.mp4'), '0123456789');

      assert.deepEqual((await app.inject({ method: 'GET', url: '/api/health', headers })).json(), { status: 'ok' });
      const missing = await app.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: path.join(root, 'missing') } });
      assert.equal(missing.statusCode, 404);

      const savedSource = await app.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: source } });
      assert.equal(savedSource.statusCode, 200, savedSource.body);
      const overlap = await app.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: path.join(source, 'trip') } });
      assert.equal(overlap.statusCode, 400);
      const savedDestination = await app.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: destination } });
      assert.equal(savedDestination.statusCode, 201);
      const destinationId = savedDestination.json().id as string;
      assert.match(destinationId, /^[0-9a-f-]{36}$/i);

      const arbitraryPath = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: { path: root } });
      assert.equal(arbitraryPath.statusCode, 400);
      const scan = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      assert.equal(scan.statusCode, 200);
      assert.equal(scan.json().count, 2);
      const image = scan.json().items.find((item: { filename: string }) => item.filename === 'sample.webp');
      const video = scan.json().items.find((item: { filename: string }) => item.filename === 'clip.mp4');
      assert.equal(image.relativePath, 'trip/sample.webp');
      assert.equal(JSON.stringify(scan.json()).includes(source), false);

      const imageResponse = await app.inject({ method: 'GET', url: `/api/media/${image.id}/preview?scan=${scan.json().scanId}`, headers });
      assert.equal(imageResponse.statusCode, 200, imageResponse.body);
      assert.equal(imageResponse.body, 'image');
      assert.equal(imageResponse.headers['content-type'], 'image/webp');
      assert.equal(imageResponse.headers['x-content-type-options'], 'nosniff');
      assert.equal(imageResponse.headers['accept-ranges'], 'bytes');
      const imageHead = await app.inject({ method: 'HEAD', url: `/api/media/${image.id}/preview?scan=${scan.json().scanId}`, headers });
      assert.equal(imageHead.statusCode, 200);
      assert.equal(imageHead.headers['content-length'], '5');
      assert.equal(imageHead.body, '');

      const videoFull = await app.inject({ method: 'GET', url: `/api/media/${video.id}/preview?scan=${scan.json().scanId}`, headers });
      assert.equal(videoFull.statusCode, 200);
      assert.equal(videoFull.body, '0123456789');
      assert.equal(videoFull.headers['content-length'], '10');
      const videoRange = await app.inject({ method: 'GET', url: `/api/media/${video.id}/preview?scan=${scan.json().scanId}`, headers: { ...headers, range: 'bytes=2-5' } });
      assert.equal(videoRange.statusCode, 206);
      assert.equal(videoRange.body, '2345');
      assert.equal(videoRange.headers['content-range'], 'bytes 2-5/10');
      assert.equal(videoRange.headers['content-length'], '4');
      const suffixRange = await app.inject({ method: 'GET', url: `/api/media/${video.id}/preview?scan=${scan.json().scanId}`, headers: { ...headers, range: 'bytes=-3' } });
      assert.equal(suffixRange.statusCode, 206);
      assert.equal(suffixRange.body, '789');
      const malformedRange = await app.inject({ method: 'GET', url: `/api/media/${video.id}/preview?scan=${scan.json().scanId}`, headers: { ...headers, range: 'bytes=0-1,4-5' } });
      assert.equal(malformedRange.statusCode, 416, malformedRange.body);
      assert.equal(malformedRange.headers['content-range'], 'bytes */10');
      const unsatisfiableRange = await app.inject({ method: 'GET', url: `/api/media/${video.id}/preview?scan=${scan.json().scanId}`, headers: { ...headers, range: 'bytes=10-' } });
      assert.equal(unsatisfiableRange.statusCode, 416);
      const unknownMedia = await app.inject({ method: 'GET', url: `/api/media/${'a'.repeat(32)}/preview?scan=${scan.json().scanId}`, headers });
      assert.equal(unknownMedia.statusCode, 404);
      const arbitraryMediaPath = await app.inject({ method: 'GET', url: `/api/media/${encodeURIComponent(root)}/preview?scan=${scan.json().scanId}`, headers });
      assert.equal(arbitraryMediaPath.statusCode, 400);

      const stableScan = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      assert.equal(stableScan.json().items[0].id, scan.json().items[0].id);
      const stalePreview = await app.inject({ method: 'GET', url: `/api/media/${image.id}/preview?scan=${scan.json().scanId}`, headers });
      assert.equal(stalePreview.statusCode, 404);
      await writeFile(path.join(source, 'clip.mp4'), 'changed-size');
      const changedPreview = await app.inject({ method: 'GET', url: `/api/media/${video.id}/preview?scan=${stableScan.json().scanId}`, headers });
      assert.equal(changedPreview.statusCode, 409);
      await app.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: source } });
      const newSourceScan = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      assert.notEqual(newSourceScan.json().items[0].id, scan.json().items[0].id);
      const removed = await app.inject({ method: 'DELETE', url: `/api/folders/destinations/${destinationId}`, headers });
      assert.equal(removed.statusCode, 204);

      const badOrigin = await app.inject({ method: 'POST', url: '/api/scan', headers: { ...headers, origin: 'https://attacker.example' }, payload: {} });
      assert.equal(badOrigin.statusCode, 403);
      const badHost = await app.inject({ method: 'GET', url: '/api/folders', headers: { ...headers, host: '127.0.0.1:9999' } });
      assert.equal(badHost.statusCode, 400);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
