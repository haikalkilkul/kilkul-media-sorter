import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../server/app';

const headers = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kilkul-rename-'));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'nested'), { recursive: true });
  await writeFile(path.join(source, 'nested', 'photo.jpg'), 'original-bytes');
  const app = await createApp({ logger: false, configPath: null });
  await app.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: source } });
  const scan = (await app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} })).json();
  return { app, root, source, scan, item: scan.items[0] as { id: string; filename: string; relativePath: string; extension: string } };
}

describe('secure physical media rename', () => {
  it('renames in the same nested directory, retains bytes and invalidates the old scan identity', async () => {
    const f = await setup();
    try {
      const renamed = await f.app.inject({ method: 'PATCH', url: `/api/media/${f.item.id}/rename`, headers, payload: { scanId: f.scan.scanId, basename: 'holiday' } });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.deepEqual(renamed.json(), { filename: 'holiday.jpg', unchanged: false });
      assert.equal(await readFile(path.join(f.source, 'nested', 'holiday.jpg'), 'utf8'), 'original-bytes');
      assert.deepEqual(await readdir(path.join(f.source, 'nested')), ['holiday.jpg']);
      assert.equal((await f.app.inject({ method: 'GET', url: `/api/media/${f.item.id}/preview?scan=${f.scan.scanId}`, headers })).statusCode, 404);
      const refreshed = (await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} })).json();
      assert.equal(refreshed.items[0].filename, 'holiday.jpg');
      assert.equal(refreshed.items[0].relativePath, 'nested/holiday.jpg');
      assert.notEqual(refreshed.items[0].id, f.item.id);
    } finally { await f.app.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it('rejects existing names case-insensitively without changing either file', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.source, 'nested', 'HOLIDAY.jpg'), 'keep-existing');
      const conflict = await f.app.inject({ method: 'PATCH', url: `/api/media/${f.item.id}/rename`, headers, payload: { scanId: f.scan.scanId, basename: 'holiday' } });
      assert.equal(conflict.statusCode, 409);
      assert.equal(await readFile(path.join(f.source, 'nested', 'photo.jpg'), 'utf8'), 'original-bytes');
      assert.equal(await readFile(path.join(f.source, 'nested', 'HOLIDAY.jpg'), 'utf8'), 'keep-existing');
    } finally { await f.app.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it('rejects invalid basenames and retains the source file', async () => {
    const f = await setup();
    try {
      for (const basename of ['', '   ', '.', '..', '../escape', 'bad/name', 'bad:name', 'CON', 'trailing.', 'trailing ', 'tab\tname']) {
        const response = await f.app.inject({ method: 'PATCH', url: `/api/media/${f.item.id}/rename`, headers, payload: { scanId: f.scan.scanId, basename } });
        assert.equal(response.statusCode, 400, `${JSON.stringify(basename)}: ${response.body}`);
      }
      assert.equal(await readFile(path.join(f.source, 'nested', 'photo.jpg'), 'utf8'), 'original-bytes');
    } finally { await f.app.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it('rejects unknown media IDs, stale scans and client-supplied paths', async () => {
    const f = await setup();
    try {
      const unknown = await f.app.inject({ method: 'PATCH', url: `/api/media/${'a'.repeat(32)}/rename`, headers, payload: { scanId: f.scan.scanId, basename: 'new-name' } });
      assert.equal(unknown.statusCode, 404);
      const newerScan = await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const stale = await f.app.inject({ method: 'PATCH', url: `/api/media/${f.item.id}/rename`, headers, payload: { scanId: f.scan.scanId, basename: 'new-name' } });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().rescanRequired, true);
      const arbitraryPath = await f.app.inject({ method: 'PATCH', url: `/api/media/${newerScan.json().items[0].id}/rename`, headers, payload: { scanId: newerScan.json().scanId, basename: 'new-name', sourcePath: f.root } });
      assert.equal(arbitraryPath.statusCode, 400);
      assert.equal(await readFile(path.join(f.source, 'nested', 'photo.jpg'), 'utf8'), 'original-bytes');
    } finally { await f.app.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it('handles case-only changes through the guarded temporary-link path', async () => {
    const f = await setup();
    try {
      const response = await f.app.inject({ method: 'PATCH', url: `/api/media/${f.item.id}/rename`, headers, payload: { scanId: f.scan.scanId, basename: 'PHOTO' } });
      assert.equal(response.statusCode, 200, response.body);
      const refreshed = (await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} })).json();
      assert.equal(refreshed.items[0].filename, 'PHOTO.jpg');
      assert.deepEqual(await readdir(path.join(f.source, 'nested')), ['PHOTO.jpg']);
      assert.equal(await readFile(path.join(f.source, 'nested', 'PHOTO.jpg'), 'utf8'), 'original-bytes');
    } finally { await f.app.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it('serializes simultaneous rename attempts for one media ID', async () => {
    const f = await setup();
    try {
      const send = (basename: string) => f.app.inject({ method: 'PATCH', url: `/api/media/${f.item.id}/rename`, headers, payload: { scanId: f.scan.scanId, basename } });
      const results = await Promise.all([send('first'), send('second')]);
      assert.equal(results.filter(result => result.statusCode === 200).length, 1);
      assert.ok(results.every(result => result.statusCode === 200 || result.statusCode === 409));
      const names = await readdir(path.join(f.source, 'nested'));
      assert.equal(names.length, 1);
      assert.ok(['first.jpg', 'second.jpg'].includes(names[0]));
      assert.equal(await readFile(path.join(f.source, 'nested', names[0]), 'utf8'), 'original-bytes');
    } finally { await f.app.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it('uses the exclusive filesystem commit when two different files race for one destination name', async () => {
    const f = await setup();
    try {
      await writeFile(path.join(f.source, 'nested', 'other.jpg'), 'other-bytes');
      const scan = (await f.app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} })).json();
      const requests = scan.items.map((item: { id: string }) => f.app.inject({ method: 'PATCH', url: `/api/media/${item.id}/rename`, headers, payload: { scanId: scan.scanId, basename: 'shared' } }));
      const results = await Promise.all(requests);
      assert.equal(results.filter(result => result.statusCode === 200).length, 1);
      assert.equal(results.filter(result => result.statusCode === 409).length, 1);
      const remaining = await readdir(path.join(f.source, 'nested'));
      assert.equal(remaining.length, 2);
      assert.ok(remaining.includes('shared.jpg'));
      assert.ok(remaining.includes('photo.jpg') || remaining.includes('other.jpg'));
      assert.ok(['original-bytes', 'other-bytes'].includes(await readFile(path.join(f.source, 'nested', 'shared.jpg'), 'utf8')));
    } finally { await f.app.close(); await rm(f.root, { recursive: true, force: true }); }
  });
});
