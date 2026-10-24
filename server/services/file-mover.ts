import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export type MoveFingerprint = { sizeBytes: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; mode?: number };
export type MoveFileResult = { filename: string; strategy: 'hard-link' | 'verified-copy' };
export type LinkOperation = (existingPath: string, newPath: string) => Promise<void>;
export type MoveFileOptions = {
  sourcePath: string;
  destinationRoot: string;
  filename: string;
  fingerprint: MoveFingerprint;
  sourceHandle: FileHandle;
  validate: (afterCommit?: boolean, expectedSourceCtimeMs?: number) => Promise<void>;
  linkFile?: LinkOperation;
};

export class FileMoveError extends Error {
  constructor(message: string, readonly statusCode: number, readonly uncertain = false) { super(message); }
}

const destinationTails = new Map<string, Promise<void>>();
const maxCandidates = 1000;
const copyBufferBytes = 1024 * 1024;

function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

function normalizedFilename(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function candidateName(filename: string, sequence: number): string {
  if (!sequence) return filename;
  const parsed = path.parse(filename);
  return `${parsed.name} (${sequence})${parsed.ext}`;
}

function sameFingerprint(actual: { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; isFile(): boolean }, expected: MoveFingerprint): boolean {
  return actual.isFile() && actual.size === expected.sizeBytes && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs && actual.dev === expected.dev && actual.ino === expected.ino;
}

function sameIdentity(actual: { size: number; mtimeMs: number; dev: number; ino: number; isFile(): boolean }, expected: MoveFingerprint): boolean {
  return actual.isFile() && actual.size === expected.sizeBytes && actual.mtimeMs === expected.mtimeMs && actual.dev === expected.dev && actual.ino === expected.ino;
}

async function withDestinationLock<T>(destinationRoot: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(destinationRoot).normalize('NFC').toLowerCase();
  const previous = destinationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  destinationTails.set(key, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (destinationTails.get(key) === current) destinationTails.delete(key);
  }
}

async function existingCaseFoldedName(root: string, candidate: string): Promise<boolean> {
  const names = await readdir(root);
  const wanted = normalizedFilename(candidate);
  return names.some(name => normalizedFilename(name) === wanted);
}

async function commitUnique(root: string, filename: string, sourcePath: string, linkFile: LinkOperation, validate: () => Promise<void>) {
  return withDestinationLock(root, async () => {
    for (let sequence = 0; sequence < maxCandidates; sequence += 1) {
      const candidate = candidateName(filename, sequence);
      if (await existingCaseFoldedName(root, candidate)) continue;
      await validate();
      const targetPath = path.join(root, candidate);
      try {
        await linkFile(sourcePath, targetPath);
        return { filename: candidate, path: targetPath };
      } catch (error) {
        if (errno(error) === 'EEXIST') continue;
        throw error;
      }
    }
    throw new FileMoveError('Could not find an unused destination filename after 1000 attempts.', 409);
  });
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new FileMoveError('The destination copy could not be completed.', 500);
    offset += bytesWritten;
  }
}

async function copyAndVerify(source: FileHandle, tempPath: string, expected: MoveFingerprint): Promise<void> {
  const before = await source.stat();
  if (!sameFingerprint(before, expected)) throw new FileMoveError('The source file changed. Rescan before moving it.', 409);
  let temporary: FileHandle | undefined;
  try {
    temporary = await open(tempPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, expected.mode ? expected.mode & 0o777 : 0o600);
    const sourceHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(copyBufferBytes);
    let position = 0;
    while (position < expected.sizeBytes) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expected.sizeBytes - position), position);
      if (!bytesRead) throw new FileMoveError('The source file ended before the copy completed.', 409);
      const chunk = buffer.subarray(0, bytesRead);
      sourceHash.update(chunk);
      await writeAll(temporary, chunk, position);
      position += bytesRead;
    }
    await temporary.sync();
    const afterSource = await source.stat();
    const afterCopy = await temporary.stat();
    if (!sameFingerprint(afterSource, expected) || !afterCopy.isFile() || afterCopy.size !== expected.sizeBytes) {
      throw new FileMoveError('The source changed while it was being copied. Rescan before moving it.', 409);
    }

    const destinationHash = createHash('sha256');
    const verifyBuffer = Buffer.allocUnsafe(copyBufferBytes);
    position = 0;
    while (position < expected.sizeBytes) {
      const { bytesRead } = await temporary.read(verifyBuffer, 0, Math.min(verifyBuffer.length, expected.sizeBytes - position), position);
      if (!bytesRead) throw new FileMoveError('The destination copy could not be verified.', 500);
      destinationHash.update(verifyBuffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (sourceHash.digest('hex') !== destinationHash.digest('hex')) throw new FileMoveError('The destination copy did not match the source.', 500);
  } finally {
    await temporary?.close();
  }
}

async function cleanupCommittedPath(pathToRemove: string, expected: MoveFingerprint): Promise<boolean> {
  try {
    const info = await lstat(pathToRemove);
    if (!sameFingerprint(info, expected)) return false;
    await unlink(pathToRemove);
    return true;
  } catch (error) { return errno(error) === 'ENOENT'; }
}

function fingerprintFromInfo(info: { size: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; mode: number }): MoveFingerprint {
  return { sizeBytes: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, mode: info.mode };
}

export async function moveFileNoOverwrite(options: MoveFileOptions): Promise<MoveFileResult> {
  const linkFile = options.linkFile ?? link;
  let temporaryPath: string | undefined;
  let committedPath: string | undefined;
  let committedName = options.filename;
  let strategy: MoveFileResult['strategy'] = 'hard-link';
  try {
    try {
      const committed = await commitUnique(options.destinationRoot, options.filename, options.sourcePath, linkFile, () => options.validate());
      committedPath = committed.path;
      committedName = committed.filename;
      const committedInfo = await lstat(committedPath);
      if (!sameIdentity(committedInfo, options.fingerprint)) {
        const rolledBack = await cleanupCommittedPath(committedPath, fingerprintFromInfo(committedInfo));
        committedPath = undefined;
        if (!rolledBack) throw new FileMoveError('The source changed during the move and a destination entry may remain; rescan and check the destination.', 500, true);
        throw new FileMoveError('The source changed during the move; the original was preserved.', 409);
      }
    } catch (error) {
      if (errno(error) !== 'EXDEV') throw error;
      strategy = 'verified-copy';
      temporaryPath = path.join(options.destinationRoot, `.kilkul-move-${randomUUID()}.tmp`);
      await copyAndVerify(options.sourceHandle, temporaryPath, options.fingerprint);
      const committed = await commitUnique(options.destinationRoot, options.filename, temporaryPath, linkFile, () => options.validate());
      committedPath = committed.path;
      committedName = committed.filename;
      const tempInfo = await lstat(temporaryPath);
      const committedInfo = await lstat(committedPath);
      if (tempInfo.dev !== committedInfo.dev || tempInfo.ino !== committedInfo.ino || committedInfo.size !== options.fingerprint.sizeBytes) {
        throw new FileMoveError('The committed destination could not be verified; the source was preserved.', 500, true);
      }
      await unlink(temporaryPath);
      temporaryPath = undefined;
    }
    return await finishMove(options, committedPath, committedName, strategy);
  } catch (error) {
    if (temporaryPath) {
      try { await unlink(temporaryPath); }
      catch (cleanupError) {
        if (errno(cleanupError) !== 'ENOENT') throw new FileMoveError('The move did not complete and a temporary destination file may remain; the source was preserved.', 500, true);
      }
    }
    if (error instanceof FileMoveError) throw error;
    const code = errno(error);
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EBUSY') throw new FileMoveError('The source file or destination folder is locked or inaccessible.', 403);
    if (code === 'ENOSPC' || code === 'EDQUOT') throw new FileMoveError('The destination does not have enough free space.', 507);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw new FileMoveError('The source or destination is no longer available. Rescan and try again.', 409);
    throw new FileMoveError('The file could not be moved safely.', 500);
  }
}

async function finishMove(options: MoveFileOptions, committedPath: string, filename: string, strategy: MoveFileResult['strategy']): Promise<MoveFileResult> {
  try {
    const committedInfo = await lstat(committedPath);
    if (!committedInfo.isFile() || committedInfo.size !== options.fingerprint.sizeBytes) {
      throw new FileMoveError('The committed destination could not be verified; the source was preserved.', 500, true);
    }
    const committedFingerprint = fingerprintFromInfo(committedInfo);
    const sourceAfterCommit = await lstat(options.sourcePath);
    const handleAfterCommit = await options.sourceHandle.stat();
    if (!sameIdentity(sourceAfterCommit, options.fingerprint) || !sameIdentity(handleAfterCommit, options.fingerprint)) {
      const rolledBack = await cleanupCommittedPath(committedPath, committedFingerprint);
      if (!rolledBack) throw new FileMoveError('The source changed and the destination could not be rolled back. Rescan and check both locations.', 500, true);
      throw new FileMoveError('The source changed before it could be removed. The destination was rolled back where possible.', 409);
    }
    // Creating a hard link can update ctime on the shared inode. Capture that expected
    // filesystem change after confirming the source identity is otherwise unchanged.
    const sourceCtimeAfterCommit = sourceAfterCommit.ctimeMs;
    await options.validate(true, sourceCtimeAfterCommit);
    const sourcePathInfo = await lstat(options.sourcePath);
    const sourceHandleInfo = await options.sourceHandle.stat();
    if (!sameIdentity(sourcePathInfo, options.fingerprint) || !sameIdentity(sourceHandleInfo, options.fingerprint)) {
      const rolledBack = await cleanupCommittedPath(committedPath, committedFingerprint);
      if (!rolledBack) throw new FileMoveError('The source changed and the destination could not be rolled back. Rescan and check both locations.', 500, true);
      throw new FileMoveError('The source changed before it could be removed. The destination was rolled back where possible.', 409);
    }
    await unlink(options.sourcePath);
    return { filename, strategy };
  } catch (error) {
    if (error instanceof FileMoveError && error.uncertain) throw error;
    if (error instanceof FileMoveError) throw error;
    throw new FileMoveError('The destination was committed, but the source could not be removed. Both copies may exist; rescan and check the destination.', 500, true);
  }
}
