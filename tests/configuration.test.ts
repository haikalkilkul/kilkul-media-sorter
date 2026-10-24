import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../server/app';
import { ConfigurationStore, ConfigurationStoreError, defaultConfigurationPath } from '../server/services/config-store';

const headers = { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kilkul-config-'));
  const source = path.join(root, 'source');
  const firstDestination = path.join(root, 'destination-one');
  const secondDestination = path.join(root, 'destination-two');
  await mkdir(source); await mkdir(firstDestination); await mkdir(secondDestination);
  const configPath = path.join(root, 'user-data', 'config.json');
  await mkdir(path.dirname(configPath));
  return { root, source, firstDestination, secondDestination, configPath };
}

async function appFor(configPath: string) { return createApp({ logger: false, configPath }); }

describe('persistent folder configuration', () => {
  it('selects user configuration locations by platform without relying on the project directory', () => {
    assert.equal(defaultConfigurationPath({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\Users\\me'), path.join('C:\\Users\\me\\AppData\\Local', 'kilkul-media-sorter', 'config.json'));
    assert.equal(defaultConfigurationPath({}, 'darwin', '/Users/me'), path.join('/Users/me', 'Library', 'Application Support', 'kilkul-media-sorter', 'config.json'));
    assert.equal(defaultConfigurationPath({ XDG_CONFIG_HOME: '/tmp/user-config' }, 'linux', '/home/me'), path.join('/tmp/user-config', 'kilkul-media-sorter', 'config.json'));
    assert.equal(defaultConfigurationPath({ XDG_CONFIG_HOME: 'relative' }, 'linux', '/home/me'), path.join('/home/me', '.config', 'kilkul-media-sorter', 'config.json'));
  });

  it('persists empty configuration and only path values in the versioned JSON format', async () => {
    const f = await fixture();
    try {
      const store = new ConfigurationStore(f.configPath);
      await store.save({ version: 1, sourcePath: null, destinationPaths: [] });
      const data = JSON.parse(await readFile(f.configPath, 'utf8'));
      assert.deepEqual(data, { version: 1, sourcePath: null, destinationPaths: [] });
      assert.equal('id' in data, false);
      const app = await appFor(f.configPath);
      try { assert.deepEqual(await (await app.inject({ method: 'GET', url: '/api/folders', headers })).json(), { source: null, destinations: [], recoveryRequired: false }); }
      finally { await app.close(); }
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('restores source and multiple destinations after a backend restart with fresh runtime identities', async () => {
    const f = await fixture();
    await writeFile(path.join(f.source, 'photo.jpg'), 'media');
    const first = await appFor(f.configPath);
    try {
      const sourceResponse = await first.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: f.source } });
      const sourceId = sourceResponse.json().source.id;
      const storedSourcePath = sourceResponse.json().source.path;
      const firstDest = await first.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: f.firstDestination } });
      const secondDest = await first.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: f.secondDestination } });
      assert.equal(sourceResponse.statusCode, 200, sourceResponse.body);
      assert.equal(firstDest.statusCode, 201, firstDest.body);
      assert.equal(secondDest.statusCode, 201, secondDest.body);
      const scan = await first.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
      const oldScanId = scan.json().scanId;
      const oldMediaId = scan.json().items[0].id;
      assert.equal(sourceResponse.statusCode, 200);
      assert.equal(firstDest.statusCode, 201); assert.equal(secondDest.statusCode, 201);
      const diskConfig = JSON.parse(await readFile(f.configPath, 'utf8'));
      assert.deepEqual(Object.keys(diskConfig).sort(), ['destinationPaths', 'sourcePath', 'version']);
      assert.deepEqual(diskConfig.destinationPaths, [firstDest.json().path, secondDest.json().path]);
      assert.equal(diskConfig.sourcePath, storedSourcePath);
      assert.equal('id' in diskConfig, false);
      const oldDestinationId = firstDest.json().id;
      await first.close();

      const restarted = await appFor(f.configPath);
      try {
        const loaded = (await restarted.inject({ method: 'GET', url: '/api/folders', headers })).json();
        assert.equal(loaded.source.path, storedSourcePath); assert.equal(loaded.source.id === sourceId, false);
        assert.deepEqual(loaded.destinations.map((entry: { path: string }) => entry.path), [firstDest.json().path, secondDest.json().path]);
        assert.ok(loaded.destinations.every((entry: { id: string; available: boolean }) => entry.id !== oldDestinationId && entry.available));
        assert.equal(loaded.recoveryRequired, false);
        const oldPreview = await restarted.inject({ method: 'GET', url: `/api/media/${oldMediaId}/preview?scan=${oldScanId}`, headers });
        assert.equal(oldPreview.statusCode, 404);
        const freshScan = await restarted.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
        assert.notEqual(freshScan.json().scanId, oldScanId);
        assert.notEqual(freshScan.json().items[0].id, oldMediaId);
        const staleMove = await restarted.inject({ method: 'POST', url: `/api/media/${oldMediaId}/move`, headers, payload: { scanId: oldScanId, destinationId: oldDestinationId } });
        assert.equal(staleMove.statusCode, 409);
      } finally { await restarted.close(); }
    } finally { await first.close().catch(() => undefined); await rm(f.root, { recursive: true, force: true }); }
  });

  it('keeps unavailable source and destination paths visible and removable after restart', async () => {
    const f = await fixture();
    const first = await appFor(f.configPath);
    try {
      const sourceResponse = await first.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: f.source } });
      assert.equal(sourceResponse.statusCode, 200, sourceResponse.body);
      const storedSourcePath = sourceResponse.json().source.path;
      const destination = await first.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: f.firstDestination } });
      assert.equal(destination.statusCode, 201, destination.body);
      const storedDestinationPath = destination.json().path;
      await first.close();
      await rm(f.source, { recursive: true }); await rm(f.firstDestination, { recursive: true });
      const restarted = await appFor(f.configPath);
      try {
        const loaded = (await restarted.inject({ method: 'GET', url: '/api/folders', headers })).json();
        assert.equal(loaded.source.path, storedSourcePath); assert.equal(loaded.source.available, false); assert.ok(loaded.source.warning);
        assert.equal(loaded.destinations[0].path, storedDestinationPath); assert.equal(loaded.destinations[0].available, false);
        const removed = await restarted.inject({ method: 'DELETE', url: `/api/folders/destinations/${loaded.destinations[0].id}`, headers: { host: headers.host, origin: headers.origin } });
        assert.equal(removed.statusCode, 204, removed.body);
        const afterRemoval = (await restarted.inject({ method: 'GET', url: '/api/folders', headers })).json();
        assert.deepEqual(afterRemoval.destinations, []); assert.equal(afterRemoval.source.path, storedSourcePath);
      } finally { await restarted.close(); }
    } finally { await first.close().catch(() => undefined); await rm(f.root, { recursive: true, force: true }); }
  });

  it('preserves malformed, structurally invalid, and unknown-version files until explicit recovery', async t => {
    const examples = [
      ['malformed', '{ this is not json'],
      ['invalid structure', JSON.stringify({ version: 1, sourcePath: null, destinationPaths: [], mediaIds: ['secret'] })],
      ['unknown version', JSON.stringify({ version: 2, sourcePath: null, destinationPaths: [] })],
    ];
    for (const [name, contents] of examples) await t.test(name, async () => {
      const f = await fixture();
      await writeFile(f.configPath, contents);
      const app = await appFor(f.configPath);
      try {
        const initial = await app.inject({ method: 'GET', url: '/api/folders', headers });
        assert.equal(initial.json().recoveryRequired, true); assert.match(initial.json().warning, /preserved/i);
        const before = await readFile(f.configPath, 'utf8');
        const normalChange = await app.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: f.source } });
        assert.equal(normalChange.statusCode, 409); assert.equal(await readFile(f.configPath, 'utf8'), before);
        const recovered = await app.inject({ method: 'POST', url: '/api/folders/recover', headers, payload: { confirm: true } });
        assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(recovered.json().recoveryRequired, false);
        const backups = (await (await import('node:fs/promises')).readdir(path.dirname(f.configPath))).filter(file => file.includes('.invalid-') && file.endsWith('.bak'));
        assert.equal(backups.length, 1); assert.equal(await readFile(path.join(path.dirname(f.configPath), backups[0]), 'utf8'), before);
        assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), { version: 1, sourcePath: null, destinationPaths: [] });
      } finally { await app.close(); await rm(f.root, { recursive: true, force: true }); }
    });
  });

  it('leaves runtime source and destination configuration unchanged when persistence fails', async () => {
    const f = await fixture();
    const initialStore = new ConfigurationStore(f.configPath);
    await initialStore.save({ version: 1, sourcePath: f.source, destinationPaths: [f.firstDestination] });
    class FailingStore extends ConfigurationStore {
      override async save(_configuration: { version: 1; sourcePath: string | null; destinationPaths: string[] }): Promise<void> {
        throw new ConfigurationStoreError('Simulated storage failure.');
      }
    }
    const app = await createApp({ logger: false, configurationStore: new FailingStore(f.configPath) });
    try {
      const before = (await app.inject({ method: 'GET', url: '/api/folders', headers })).json();
      const diskBefore = await readFile(f.configPath, 'utf8');
      const sourceChange = await app.inject({ method: 'PUT', url: '/api/folders/source', headers, payload: { path: f.secondDestination } });
      assert.equal(sourceChange.statusCode, 500);
      const add = await app.inject({ method: 'POST', url: '/api/folders/destinations', headers, payload: { path: f.secondDestination } });
      assert.equal(add.statusCode, 500);
      const remove = await app.inject({ method: 'DELETE', url: `/api/folders/destinations/${before.destinations[0].id}`, headers });
      assert.equal(remove.statusCode, 500);
      const after = (await app.inject({ method: 'GET', url: '/api/folders', headers })).json();
      assert.equal(after.source.path, f.source); assert.equal(after.source.id, before.source.id);
      assert.deepEqual(after.destinations.map((entry: { path: string; id: string }) => entry), before.destinations);
      assert.equal(await readFile(f.configPath, 'utf8'), diskBefore);
    } finally { await app.close(); await rm(f.root, { recursive: true, force: true }); }
  });
});
