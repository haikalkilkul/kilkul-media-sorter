import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../server/app';
import { FolderRegistry } from '../server/services/folder-registry';
import { moveFileNoOverwrite } from '../server/services/file-mover';
import { open, stat } from 'node:fs/promises';

const headers = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };

async function setup(options: { registry?: FolderRegistry; sourceName?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kilkul-move-'));
  const source = path.join(root, options.sourceName ?? 'source');
  const destination = path.join(root, 'destination');
  await mkdir(source, { recursive: true });
  await mkdir(destination);
  const app = await createApp({ logger: false, configPath: null, ...(options.registry ? { registry: options.registry } : {}) });
  await app.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: source } });
  const configuredDestination = await app.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: destination } });
  const scan = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
  return { app, root, source, destination, destinationId: configuredDestination.json().id as string, scan: scan.json() as { scanId: string; items: Array<{ id: string; filename: string; relativePath: string }> } };
}

async function closeAndRemove(fixture: Awaited<ReturnType<typeof setup>>) {
  await fixture.app.close();
  await rm(fixture.root, { recursive: true, force: true });
}

function move(fixture: Awaited<ReturnType<typeof setup>>, id: string, payload: Record<string, unknown> = {}, scanId = fixture.scan.scanId) {
  return fixture.app.inject({ method: 'POST', url: `/api/media/${id}/move`, headers, payload: { scanId, destinationId: fixture.destinationId, ...payload } });
}

describe('secure single-file moves', () => {
  it('moves a scanned file to the destination root, removes it from the active registry, and invalidates its preview id', async () => {
    const f = await setup();
    try {
      await mkdir(path.join(f.source, 'nested'));
      await writeFile(path.join(f.source, 'nested', 'photo.jpg'), 'original-bytes');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const item = scan.json().items[0];
      const response = await f.app.inject({ method: 'POST', url: `/api/media/${item.id}/move`, headers, payload: { scanId: scan.json().scanId, destinationId: f.destinationId } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().filename, 'photo.jpg');
      assert.equal(await readFile(path.join(f.destination, 'photo.jpg'), 'utf8'), 'original-bytes');
      assert.deepEqual(await readdir(path.join(f.source, 'nested')), []);
      assert.equal((await f.app.inject({ method: 'GET', url: `/api/media/${item.id}/preview?scan=${scan.json().scanId}`, headers })).statusCode, 404);
      assert.equal((await f.app.inject({ method: 'POST', url: `/api/media/${item.id}/move`, headers, payload: { scanId: scan.json().scanId, destinationId: f.destinationId } })).statusCode, 404);
    } finally { await closeAndRemove(f); }
  });

  it('creates unique flat names for multiple conflicts and preserves multiple-dot and extensionless names', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.source, 'photo.tar.jpg'), 'source-photo');
      await writeFile(path.join(f.destination, 'photo.tar.jpg'), 'keep-0');
      await writeFile(path.join(f.destination, 'photo.tar (1).jpg'), 'keep-1');
      await writeFile(path.join(f.source, 'README'), 'source-readme');
      await writeFile(path.join(f.destination, 'README'), 'keep-readme');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const scanData = scan.json();
      const photo = scanData.items.find((item: { filename: string }) => item.filename === 'photo.tar.jpg');
      const photoMove = await f.app.inject({ method: 'POST', url: `/api/media/${photo.id}/move`, headers, payload: { scanId: scanData.scanId, destinationId: f.destinationId } });
      assert.equal(photoMove.json().filename, 'photo.tar (2).jpg');
      assert.equal(await readFile(path.join(f.destination, 'photo.tar.jpg'), 'utf8'), 'keep-0');
      assert.equal(await readFile(path.join(f.destination, 'photo.tar (1).jpg'), 'utf8'), 'keep-1');
      assert.equal(await readFile(path.join(f.destination, 'photo.tar (2).jpg'), 'utf8'), 'source-photo');
    } finally { await closeAndRemove(f); }
  });

  it('handles case-insensitive collisions conservatively and serializes concurrent destination allocations', async () => {
    const f = await setup();
    try {
      await mkdir(path.join(f.source, 'a')); await mkdir(path.join(f.source, 'b'));
      await writeFile(path.join(f.source, 'a', 'Same.JPG'), 'a');
      await writeFile(path.join(f.source, 'b', 'same.jpg'), 'b');
      await writeFile(path.join(f.destination, 'SAME.jpg'), 'keep');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const data = scan.json();
      const results = await Promise.all(data.items.map((item: { id: string }) => f.app.inject({ method: 'POST', url: `/api/media/${item.id}/move`, headers, payload: { scanId: data.scanId, destinationId: f.destinationId } })));
      assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 200]);
      const names = (await readdir(f.destination)).map(name => name.toLowerCase());
      assert.equal(new Set(names).size, 3);
      assert.ok(names.includes('same (1).jpg'));
      assert.ok(names.includes('same (2).jpg'));
      assert.equal(await readFile(path.join(f.destination, 'SAME.jpg'), 'utf8'), 'keep');
    } finally { await closeAndRemove(f); }
  });

  it('rejects invalid ids, stale scans, unknown destinations, and arbitrary path fields', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.source, 'photo.png'), 'x');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const id = scan.json().items[0].id;
      assert.equal((await move(f, 'bad')).statusCode, 400);
      assert.equal((await move(f, id, { destinationId: '00000000-0000-4000-8000-000000000000' }, scan.json().scanId)).statusCode, 404);
      assert.equal((await move(f, id, { sourcePath: f.source, destinationPath: f.destination }, scan.json().scanId)).statusCode, 400);
      await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const stale = await f.app.inject({ method: 'POST', url: `/api/media/${id}/move`, headers, payload: { scanId: scan.json().scanId, destinationId: f.destinationId } });
      assert.equal(stale.statusCode, 409);
      assert.equal(await readFile(path.join(f.source, 'photo.png'), 'utf8'), 'x');
    } finally { await closeAndRemove(f); }
  });

  it('keeps the source and queue identity on disappearance or changed file identity', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.source, 'photo.png'), 'before');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const item = scan.json().items[0];
      await writeFile(path.join(f.source, 'photo.png'), 'changed-content');
      const changed = await f.app.inject({ method: 'POST', url: `/api/media/${item.id}/move`, headers, payload: { scanId: scan.json().scanId, destinationId: f.destinationId } });
      assert.equal(changed.statusCode, 409);
      assert.equal(await readFile(path.join(f.source, 'photo.png'), 'utf8'), 'changed-content');
      const newer = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const currentItem = newer.json().items[0];
      await rm(path.join(f.source, 'photo.png'));
      const missing = await f.app.inject({ method: 'POST', url: `/api/media/${currentItem.id}/move`, headers, payload: { scanId: newer.json().scanId, destinationId: f.destinationId } });
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(await readdir(f.destination), []);
    } finally { await closeAndRemove(f); }
  });

  it('rejects overlapping roots and symbolic-link source or destination entries', async t => {
    const f = await setup();
    try {
      const nested = path.join(f.source, 'inside'); await mkdir(nested);
      const overlap = await f.app.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: nested } });
      assert.equal(overlap.statusCode, 400);
      await writeFile(path.join(f.source, 'real.png'), 'safe');
      try { await import('node:fs/promises').then(fs => fs.symlink(path.join(f.source, 'real.png'), path.join(f.source, 'linked.png'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows symlink creation is disabled for this test account.'); return; } throw error; }
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      assert.equal(scan.json().items.some((item: { filename: string }) => item.filename === 'linked.png'), false);
      const realItem = scan.json().items.find((item: { filename: string }) => item.filename === 'real.png');
      await rm(path.join(f.source, 'real.png'));
      await import('node:fs/promises').then(fs => fs.symlink(path.join(f.source, 'linked.png'), path.join(f.source, 'real.png')));
      const substituted = await f.app.inject({ method: 'POST', url: `/api/media/${realItem.id}/move`, headers, payload: { scanId: scan.json().scanId, destinationId: f.destinationId } });
      assert.ok(substituted.statusCode === 404 || substituted.statusCode === 409);
      const outside = path.join(f.root, 'outside-destination'); await mkdir(outside);
      const destinationLink = path.join(f.root, 'destination-link');
      await import('node:fs/promises').then(fs => fs.symlink(outside, destinationLink, 'dir'));
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: destinationLink } })).statusCode, 400);
    } finally { await closeAndRemove(f); }
  });

  it('uses the cross-volume verified-copy fallback when linking reports EXDEV', async () => {
    let sourcePath = '';
    let rejectedSourceLink = false;
    const registry = new FolderRegistry({ linkFile: async (oldPath, newPath) => {
      if (oldPath.endsWith('large.mp4') && !rejectedSourceLink) { rejectedSourceLink = true; throw Object.assign(new Error('simulated volume boundary'), { code: 'EXDEV' }); }
      await link(oldPath, newPath);
    } });
    const f = await setup({ registry, sourceName: 'source' });
    try {
      sourcePath = path.join(f.source, 'large.mp4');
      const content = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
      await writeFile(sourcePath, content);
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const item = scan.json().items[0];
      const result = await f.app.inject({ method: 'POST', url: `/api/media/${item.id}/move`, headers, payload: { scanId: scan.json().scanId, destinationId: f.destinationId } });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().strategy, 'verified-copy');
      assert.deepEqual(await readFile(path.join(f.destination, 'large.mp4')), content);
      assert.deepEqual(await readdir(f.source), []);
      assert.equal((await readdir(f.destination)).some(name => name.startsWith('.kilkul-move-')), false);
    } finally { await closeAndRemove(f); }
  });

  it('allocates a unique extensionless filename while preserving the source', async () => {
    const f = await setup();
    try {
      const sourcePath = path.join(f.source, 'README');
      await writeFile(sourcePath, 'new'); await writeFile(path.join(f.destination, 'README'), 'existing');
      const info = await stat(sourcePath); const handle = await open(sourcePath, 'r');
      try {
        const moved = await moveFileNoOverwrite({
          sourcePath, destinationRoot: f.destination, filename: 'README', sourceHandle: handle,
          fingerprint: { sizeBytes: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, mode: info.mode },
          validate: async () => undefined,
        });
        assert.equal(moved.filename, 'README (1)');
        assert.equal(await readFile(path.join(f.destination, 'README'), 'utf8'), 'existing');
        assert.equal(await readFile(path.join(f.destination, 'README (1)'), 'utf8'), 'new');
      } finally { await handle.close(); }
    } finally { await closeAndRemove(f); }
  });

  it('preserves the source and cleans the temporary copy if the final commit fails', async () => {
    let sourcePath = '';
    const registry = new FolderRegistry({ linkFile: async (oldPath, newPath) => {
      if (oldPath === sourcePath) throw Object.assign(new Error('simulated volume boundary'), { code: 'EXDEV' });
      throw Object.assign(new Error('simulated commit failure'), { code: 'EIO' });
    } });
    const f = await setup({ registry, sourceName: 'source' });
    try {
      sourcePath = path.join(f.source, 'photo.jpg');
      await writeFile(sourcePath, 'preserve-me');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const item = scan.json().items[0];
      const failed = await f.app.inject({ method: 'POST', url: `/api/media/${item.id}/move`, headers, payload: { scanId: scan.json().scanId, destinationId: f.destinationId } });
      assert.equal(failed.statusCode, 500);
      assert.equal(await readFile(sourcePath, 'utf8'), 'preserve-me');
      assert.deepEqual(await readdir(f.destination), []);
    } finally { await closeAndRemove(f); }
  });

  it('batch moves independent files and reports a partial failure per item', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.source, 'one.jpg'), 'one');
      await writeFile(path.join(f.source, 'two.mp4'), 'two');
      await writeFile(path.join(f.destination, 'one.jpg'), 'preserve-existing');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const data = scan.json();
      const missingItem = data.items.find((item: { filename: string }) => item.filename === 'two.mp4');
      await rm(path.join(f.source, 'two.mp4'));
      const result = await f.app.inject({ method: 'POST', url: '/api/media/batch-move', headers, payload: { ids: data.items.map((item: { id: string }) => item.id), scanId: data.scanId, destinationId: f.destinationId } });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json().results.map((entry: { status: string }) => entry.status), ['succeeded', 'failed']);
      assert.equal(result.json().results[1].id, missingItem.id);
      assert.equal(result.json().results[1].uncertain, false);
      assert.equal(result.json().results[0].filename, 'one (1).jpg');
      assert.equal(await readFile(path.join(f.destination, 'one.jpg'), 'utf8'), 'preserve-existing');
      assert.equal(await readFile(path.join(f.destination, 'one (1).jpg'), 'utf8'), 'one');
      assert.deepEqual(await readdir(f.source), []);
      assert.equal((await f.app.inject({ method: 'GET', url: `/api/media/${data.items[0].id}/preview?scan=${data.scanId}`, headers })).statusCode, 404);
    } finally { await closeAndRemove(f); }
  });

  it('rejects malformed, duplicate, empty, oversized, unknown, and path-bearing batch requests before moving files', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.source, 'file.jpg'), 'keep');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const item = scan.json().items[0];
      const send = (payload: unknown) => f.app.inject({ method: 'POST', url: '/api/media/batch-move', headers, payload });
      const base = { scanId: scan.json().scanId, destinationId: f.destinationId };
      assert.equal((await send({ ...base, ids: [] })).statusCode, 400);
      assert.equal((await send({ ...base, ids: [item.id, item.id] })).statusCode, 400);
      assert.equal((await send({ ...base, ids: Array.from({ length: 101 }, () => item.id) })).statusCode, 400);
      assert.equal((await send({ ...base, ids: ['invalid'] })).statusCode, 400);
      assert.equal((await send({ ...base, ids: ['a'.repeat(32)] })).statusCode, 404);
      assert.equal((await send({ ...base, ids: [item.id], sourcePath: f.source })).statusCode, 400);
      assert.equal((await send({ ...base, destinationId: '00000000-0000-4000-8000-000000000000', ids: [item.id] })).statusCode, 404);
      assert.equal(await readFile(path.join(f.source, 'file.jpg'), 'utf8'), 'keep');
      assert.deepEqual(await readdir(f.destination), []);
    } finally { await closeAndRemove(f); }
  });

  it('revalidates changed item identities per item and continues processing the batch', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.source, 'changed.jpg'), 'before');
      await writeFile(path.join(f.source, 'valid.jpg'), 'valid');
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const data = scan.json();
      await writeFile(path.join(f.source, 'changed.jpg'), 'changed-after-scan');
      const result = await f.app.inject({ method: 'POST', url: '/api/media/batch-move', headers, payload: { ids: data.items.map((item: { id: string }) => item.id), scanId: data.scanId, destinationId: f.destinationId } });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json().results.map((entry: { status: string }) => entry.status), ['failed', 'succeeded']);
      assert.equal(result.json().results[0].code, 'MOVE_409');
      assert.equal(await readFile(path.join(f.source, 'changed.jpg'), 'utf8'), 'changed-after-scan');
      assert.equal(await readFile(path.join(f.destination, 'valid.jpg'), 'utf8'), 'valid');
    } finally { await closeAndRemove(f); }
  });

  it('limits batch workers to three and rejects a concurrent single move of a reserved batch item', async () => {
    let simultaneousOpens = 0;
    let maximumOpens = 0;
    let releaseLink!: () => void;
    const linkGate = new Promise<void>(resolve => { releaseLink = resolve; });
    let holdFirstLink = true;
    const registry = new FolderRegistry({ linkFile: async (oldPath, newPath) => {
      if (holdFirstLink) { holdFirstLink = false; await linkGate; }
      await link(oldPath, newPath);
    } });
    const originalOpen = registry.openMedia.bind(registry);
    registry.openMedia = async (...args) => {
      simultaneousOpens += 1; maximumOpens = Math.max(maximumOpens, simultaneousOpens);
      await new Promise(resolve => setTimeout(resolve, 10));
      try { return await originalOpen(...args); }
      finally { simultaneousOpens -= 1; }
    };
    const f = await setup({ registry });
    try {
      for (let index = 0; index < 7; index += 1) await writeFile(path.join(f.source, `file-${index}.jpg`), String(index));
      const scan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const data = scan.json();
      const firstBatchRequest = f.app.inject({ method: 'POST', url: '/api/media/batch-move', headers, payload: { ids: data.items.map((item: { id: string }) => item.id), scanId: data.scanId, destinationId: f.destinationId } });
      await new Promise(resolve => setTimeout(resolve, 25));
      const duplicateBatch = await f.app.inject({ method: 'POST', url: '/api/media/batch-move', headers, payload: { ids: data.items.map((item: { id: string }) => item.id), scanId: data.scanId, destinationId: f.destinationId } });
      assert.equal(duplicateBatch.statusCode, 409);
      const competingSingle = await f.app.inject({ method: 'POST', url: `/api/media/${data.items[0].id}/move`, headers, payload: { scanId: data.scanId, destinationId: f.destinationId } });
      assert.equal(competingSingle.statusCode, 409);
      assert.ok(maximumOpens > 1 && maximumOpens <= 3, `observed ${maximumOpens} concurrent item opens`);
      releaseLink();
      const result = await firstBatchRequest;
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().results.filter((entry: { status: string }) => entry.status === 'succeeded').length, 7);
      assert.equal(new Set(await readdir(f.destination)).size, 7);
    } finally { releaseLink(); await closeAndRemove(f); }
  });
});
