import { randomBytes, randomUUID } from 'node:crypto';
import { access, lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { discoverMediaWithIndex, type DiscoveryResult, type MediaFingerprint } from './media-discovery.js';
import { FileMoveError, moveFileNoOverwrite, type LinkOperation } from './file-mover.js';

export type ConfiguredFolder = { id: string; path: string };
export type FolderConfiguration = { source: ConfiguredFolder | null; destinations: ConfiguredFolder[] };
export type OpenMedia = { handle: FileHandle; sizeBytes: number; mediaType: 'image' | 'video'; extension: string; signal: AbortSignal };
export type MoveResult = { id: string; destinationId: string; filename: string; strategy: 'hard-link' | 'verified-copy' };
export type BatchMoveResult =
  | { id: string; status: 'succeeded'; filename: string; strategy: 'hard-link' | 'verified-copy' }
  | { id: string; status: 'failed'; code: string; message: string; uncertain: boolean };
const maxBatchSize = 100;
const batchConcurrency = 3;

export class FolderError extends Error {
  constructor(message: string, readonly statusCode: number, readonly uncertain = false) { super(message); }
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

async function validateDirectory(input: string, role: 'source' | 'destination'): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 32760 || /[\u0000-\u001f]/.test(trimmed) || !path.isAbsolute(trimmed)) {
    throw new FolderError('Enter an absolute folder path for this computer.', 400);
  }
  try {
    const originalInfo = await lstat(trimmed);
    if (originalInfo.isSymbolicLink()) throw new FolderError('Folder paths that are symbolic links are not supported.', 400);
    const canonicalPath = await realpath(trimmed);
    const info = await stat(canonicalPath);
    if (!info.isDirectory()) throw new FolderError('The selected path is not a folder.', 400);
    // Windows does not implement X_OK as a directory traversal check; ACL-backed read access is the useful probe there.
    const traverse = process.platform === 'win32' ? 0 : constants.X_OK;
    const permissions = role === 'source'
      ? constants.R_OK | traverse
      : constants.R_OK | constants.W_OK | traverse;
    await access(canonicalPath, permissions);
    return canonicalPath;
  } catch (error) {
    if (error instanceof FolderError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new FolderError('That folder does not exist. Check the path and try again.', 404);
    if (code === 'EACCES' || code === 'EPERM') throw new FolderError(`The ${role} folder is not accessible with the current permissions.`, 403);
    throw new FolderError(`Could not validate the ${role} folder.`, 400);
  }
}

export class FolderRegistry {
  private source: ConfiguredFolder | null = null;
  private destinations: ConfiguredFolder[] = [];
  private readonly idSecret = randomBytes(32);
  private fingerprints = new Map<string, MediaFingerprint>();
  private media = new Map<string, DiscoveryResult['items'][number]>();
  private currentScanId: string | null = null;
  private scanVersion = 0;
  private previewController = new AbortController();
  private movingMedia = new Set<string>();
  private movingDestinations = new Map<string, number>();
  private movingBatches = new Set<string>();
  private readonly linkFile?: LinkOperation;

  constructor(options: { linkFile?: LinkOperation } = {}) { this.linkFile = options.linkFile; }

  getConfiguration(): FolderConfiguration {
    return { source: this.source ? { ...this.source } : null, destinations: this.destinations.map(folder => ({ ...folder })) };
  }

  async setSource(input: string): Promise<ConfiguredFolder> {
    if (this.movingMedia.size) throw new FolderError('A file move is in progress. Wait for it to finish before changing the source folder.', 409);
    const folderPath = await validateDirectory(input, 'source');
    for (const destination of this.destinations) {
      if (pathsOverlap(folderPath, destination.path)) {
        throw new FolderError('The source folder cannot be the same as, inside, or contain a destination folder.', 400);
      }
    }
    this.scanVersion += 1;
    this.previewController.abort();
    this.previewController = new AbortController();
    this.source = { id: randomUUID(), path: folderPath };
    this.fingerprints.clear();
    this.media.clear();
    this.currentScanId = null;
    return { ...this.source };
  }

  async addDestination(input: string): Promise<ConfiguredFolder> {
    const folderPath = await validateDirectory(input, 'destination');
    if (this.source && pathsOverlap(this.source.path, folderPath)) {
      throw new FolderError('A destination cannot be the same as, inside, or contain the source folder.', 400);
    }
    if (this.destinations.some(folder => folder.path === folderPath)) throw new FolderError('That destination is already configured.', 409);
    const folder = { id: randomUUID(), path: folderPath };
    this.destinations.push(folder);
    return { ...folder };
  }

  removeDestination(id: string): boolean {
    if (this.movingDestinations.has(id)) throw new FolderError('A file is being moved to that destination. Try again when it finishes.', 409);
    const remaining = this.destinations.filter(folder => folder.id !== id);
    if (remaining.length === this.destinations.length) return false;
    this.destinations = remaining;
    return true;
  }

  async scan(): Promise<{ sourceId: string; scanId: string; result: DiscoveryResult }> {
    if (this.movingMedia.size) throw new FolderError('A file move is in progress. Wait for it to finish before scanning again.', 409);
    const source = this.source;
    if (!source) throw new FolderError('Configure a source folder before scanning.', 409);
    const scanVersion = ++this.scanVersion;
    try {
      const discovered = await discoverMediaWithIndex(source.path, this.idSecret, source.id);
      if (this.source?.id !== source.id) throw new FolderError('The source folder changed while scanning. Scan again.', 409);
      if (scanVersion !== this.scanVersion) throw new FolderError('A newer scan replaced these results. Use the latest queue.', 409);
      const scanId = randomUUID();
      this.previewController.abort();
      this.previewController = new AbortController();
      this.fingerprints = discovered.fingerprints;
      this.media = new Map(discovered.result.items.map(item => [item.id, item]));
      this.currentScanId = scanId;
      return { sourceId: source.id, scanId, result: discovered.result };
    } catch (error) {
      if (error instanceof FolderError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') throw new FolderError('The source folder cannot be read with the current permissions.', 403);
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new FolderError('The source folder is no longer available. Configure it again.', 404);
      throw new FolderError('The source folder could not be scanned.', 500);
    }
  }

  async openMedia(id: string, scanId: string): Promise<OpenMedia> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new FolderError('Media item not found. Scan the source again.', 404);
    const source = this.source;
    if (!this.currentScanId || scanId !== this.currentScanId) throw new FolderError('This preview is from an older scan. Refresh the queue.', 404);
    const item = this.media.get(id);
    const fingerprint = this.fingerprints.get(id);
    if (!source || !item || !fingerprint) throw new FolderError('Media item is no longer in the current scan. Scan the source again.', 404);

    const absolutePath = path.resolve(source.path, ...fingerprint.relativePath.split('/'));
    if (!containsPath(source.path, absolutePath) || absolutePath === source.path) {
      throw new FolderError('Media item is outside the configured source folder.', 404);
    }

    let handle: FileHandle | undefined;
    try {
      const canonicalPath = await realpath(absolutePath);
      if (canonicalPath !== absolutePath || !containsPath(source.path, canonicalPath)) {
        throw new FolderError('Media item is no longer available in the configured source folder.', 404);
      }
      const pathInfo = await lstat(absolutePath);
      if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new FolderError('Media item is no longer a regular file.', 404);
      if (pathInfo.size !== fingerprint.sizeBytes || pathInfo.mtimeMs !== fingerprint.mtimeMs || pathInfo.ctimeMs !== fingerprint.ctimeMs || pathInfo.dev !== fingerprint.dev || pathInfo.ino !== fingerprint.ino) {
        throw new FolderError('Media item changed since scanning. Rescan the source folder.', 409);
      }
      if (this.source?.id !== source.id || this.currentScanId !== scanId) throw new FolderError('This preview is no longer part of the current source scan.', 404);

      const noFollow = constants.O_NOFOLLOW ?? 0;
      handle = await open(absolutePath, constants.O_RDONLY | noFollow);
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.size !== fingerprint.sizeBytes || openedInfo.mtimeMs !== fingerprint.mtimeMs || openedInfo.ctimeMs !== fingerprint.ctimeMs || openedInfo.dev !== fingerprint.dev || openedInfo.ino !== fingerprint.ino) {
        throw new FolderError('Media item changed while opening. Rescan the source folder.', 409);
      }
      if (this.source?.id !== source.id || this.currentScanId !== scanId) throw new FolderError('This preview is no longer part of the current source scan.', 404);
      return { handle, sizeBytes: openedInfo.size, mediaType: item.mediaType, extension: item.extension, signal: this.previewController.signal };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (error instanceof FolderError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw new FolderError('Media item is no longer available. Rescan the source folder.', 404);
      if (code === 'EACCES' || code === 'EPERM') throw new FolderError('Media item cannot be read with the current permissions.', 403);
      throw new FolderError('Media item could not be opened.', 500);
    }
  }

  async moveMedia(id: string, scanId: string, destinationId: string): Promise<MoveResult> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new FolderError('Media item not found. Scan the source again.', 404);
    if (this.movingMedia.has(id)) throw new FolderError('This file is already being moved.', 409);
    this.assertMoveContext([id], scanId, destinationId);
    this.movingMedia.add(id);
    this.adjustDestinationMove(destinationId, 1);
    try { return await this.performMove(id, scanId, destinationId); }
    finally { this.movingMedia.delete(id); this.adjustDestinationMove(destinationId, -1); }
  }

  async moveBatch(ids: string[], scanId: string, destinationId: string): Promise<{ results: BatchMoveResult[] }> {
    if (ids.length < 1 || ids.length > maxBatchSize || ids.some(id => !/^[a-f0-9]{32}$/.test(id))) {
      throw new FolderError(`Submit between 1 and ${maxBatchSize} valid media IDs.`, 400);
    }
    if (new Set(ids).size !== ids.length) throw new FolderError('Duplicate media IDs are not allowed in a batch.', 400);
    this.assertMoveContext(ids, scanId, destinationId);
    if (ids.some(id => this.movingMedia.has(id))) throw new FolderError('One or more files are already being moved. Wait for those moves to finish.', 409);
    const batchKey = `${destinationId}:${[...ids].sort().join(',')}`;
    if (this.movingBatches.has(batchKey)) throw new FolderError('This batch is already in progress.', 409);
    for (const id of ids) this.movingMedia.add(id);
    this.movingBatches.add(batchKey);
    this.adjustDestinationMove(destinationId, 1);

    const results: BatchMoveResult[] = new Array(ids.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= ids.length) return;
        const id = ids[index];
        try {
          const result = await this.performMove(id, scanId, destinationId);
          results[index] = { id, status: 'succeeded', filename: result.filename, strategy: result.strategy };
        } catch (error) {
          const failure = error instanceof FolderError ? error : new FolderError('The file could not be moved safely.', 500);
          results[index] = {
            id, status: 'failed', code: `MOVE_${failure.statusCode}`, message: failure.message, uncertain: failure.uncertain,
          };
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(batchConcurrency, ids.length) }, () => worker()));
      return { results };
    } finally {
      for (const id of ids) this.movingMedia.delete(id);
      this.movingBatches.delete(batchKey);
      this.adjustDestinationMove(destinationId, -1);
    }
  }

  private assertMoveContext(ids: string[], scanId: string, destinationId: string): void {
    if (!this.source || scanId !== this.currentScanId) throw new FolderError('This media is from an older scan. Refresh the queue.', 409);
    if (!this.destinations.some(folder => folder.id === destinationId)) throw new FolderError('Configured destination not found.', 404);
    if (ids.some(id => !this.media.has(id) || !this.fingerprints.has(id))) throw new FolderError('One or more media IDs are not in the current scan. Refresh the queue.', 404);
  }

  private adjustDestinationMove(destinationId: string, change: 1 | -1): void {
    const count = (this.movingDestinations.get(destinationId) ?? 0) + change;
    if (count > 0) this.movingDestinations.set(destinationId, count);
    else this.movingDestinations.delete(destinationId);
  }

  private async performMove(id: string, scanId: string, destinationId: string): Promise<MoveResult> {
    const source = this.source;
    if (!source || scanId !== this.currentScanId) throw new FolderError('This media item is from an older scan. Refresh the queue.', 409);
    const destination = this.destinations.find(folder => folder.id === destinationId);
    if (!destination) throw new FolderError('Configured destination not found.', 404);
    const fingerprint = this.fingerprints.get(id);
    const item = this.media.get(id);
    if (!item || !fingerprint) throw new FolderError('Media item is no longer in the current scan. Scan the source again.', 404);
    let sourceHandle: FileHandle | undefined;
    try {
      const opened = await this.openMedia(id, scanId);
      sourceHandle = opened.handle;
      const sourcePath = path.resolve(source.path, ...fingerprint.relativePath.split('/'));
      const validate = async (afterCommit = false, expectedSourceCtimeMs = fingerprint.ctimeMs) => {
        if (this.source?.id !== source.id || this.currentScanId !== scanId || !this.media.has(id) || !this.fingerprints.has(id)) {
          throw new FolderError('The source scan changed during the move. Rescan before continuing.', 409);
        }
        const configuredDestination = this.destinations.find(folder => folder.id === destination.id);
        if (!configuredDestination || configuredDestination.path !== destination.path) throw new FolderError('The configured destination changed during the move.', 409);
        const sourceRootInfo = await lstat(source.path);
        const destinationRootInfo = await lstat(destination.path);
        if (sourceRootInfo.isSymbolicLink() || !sourceRootInfo.isDirectory() || destinationRootInfo.isSymbolicLink() || !destinationRootInfo.isDirectory()) {
          throw new FolderError('The source or destination folder is no longer a valid directory.', 409);
        }
        if (await realpath(source.path) !== source.path || await realpath(destination.path) !== destination.path) {
          throw new FolderError('The source or destination folder changed. Configure it again before moving files.', 409);
        }
        if (pathsOverlap(source.path, destination.path)) throw new FolderError('Source and destination folders overlap; this move is not allowed.', 400);
        const permissions = constants.R_OK | constants.W_OK | (process.platform === 'win32' ? 0 : constants.X_OK);
        await access(destination.path, permissions);
        const canonicalFile = await realpath(sourcePath);
        if (canonicalFile !== sourcePath || !containsPath(source.path, canonicalFile)) throw new FolderError('The media item is outside the configured source folder.', 409);
        const sourceInfo = await lstat(sourcePath);
        const handleInfo = await sourceHandle!.stat();
        const matches = (info: typeof sourceInfo) => info.isFile() && !info.isSymbolicLink() && info.size === fingerprint.sizeBytes && info.mtimeMs === fingerprint.mtimeMs && info.ctimeMs === (afterCommit ? expectedSourceCtimeMs : fingerprint.ctimeMs) && info.dev === fingerprint.dev && info.ino === fingerprint.ino;
        if (!matches(sourceInfo) || !matches(handleInfo)) throw new FolderError('The source file changed since scanning. Rescan before moving it.', 409);
      };

      const result = await moveFileNoOverwrite({
        sourcePath,
        destinationRoot: destination.path,
        filename: item.filename,
        fingerprint,
        sourceHandle,
        validate,
        linkFile: this.linkFile,
      });
      if (this.source?.id === source.id && this.currentScanId === scanId) {
        this.media.delete(id);
        this.fingerprints.delete(id);
        this.previewController.abort();
        this.previewController = new AbortController();
      }
      return { id, destinationId: destination.id, filename: result.filename, strategy: result.strategy };
    } catch (error) {
      if (error instanceof FolderError) throw error;
      if (error instanceof FileMoveError) throw new FolderError(error.message, error.statusCode, error.uncertain);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw new FolderError('The source or destination is no longer available. Rescan and try again.', 409);
      if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') throw new FolderError('The source file or destination folder is locked or inaccessible.', 403);
      throw new FolderError('The file could not be moved safely.', 500);
    } finally {
      await sourceHandle?.close().catch(() => undefined);
    }
  }
}
