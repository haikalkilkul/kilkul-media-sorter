import { createHmac } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

export const MEDIA_EXTENSIONS: Record<string, 'image' | 'video'> = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image',
  '.bmp': 'image', '.tif': 'image', '.tiff': 'image', '.avif': 'image', '.heic': 'image',
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.avi': 'video', '.mkv': 'video',
  '.webm': 'video', '.wmv': 'video', '.mpeg': 'video', '.mpg': 'video', '.3gp': 'video',
  '.mts': 'video', '.m2ts': 'video',
};

export type DiscoveredMedia = {
  id: string;
  filename: string;
  mediaType: 'image' | 'video';
  sizeBytes: number;
  relativePath: string;
  extension: string;
};

export type DiscoveryResult = { items: DiscoveredMedia[]; count: number; warnings: string[]; warningCount: number };
export type MediaFingerprint = { relativePath: string; sizeBytes: number; mtimeMs: number; ctimeMs: number; dev: number; ino: number; mode: number };
export type DiscoveryIndex = { result: DiscoveryResult; fingerprints: Map<string, MediaFingerprint> };

/** Walks asynchronously and only returns metadata; media contents are never opened. */
export async function discoverMediaWithIndex(root: string, idSecret: Buffer, sourceId: string): Promise<DiscoveryIndex> {
  const items: DiscoveredMedia[] = [];
  const warnings: string[] = [];
  const fingerprints = new Map<string, MediaFingerprint>();
  const pending = [''];

  while (pending.length) {
    const relativeDirectory = pending.pop()!;
    const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
    let entries;
    try {
      // Re-check the directory itself so a directory entry replaced by a symlink is skipped.
      const directoryInfo = await lstat(absoluteDirectory);
      if (!directoryInfo.isDirectory()) continue;
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (relativeDirectory === '') throw error;
      warnings.push(`Skipped inaccessible directory: ${relativeDirectory.split(path.sep).join('/')}`);
      continue;
    }

    let visited = 0;
    for (const entry of entries) {
      visited += 1;
      if (visited % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { pending.push(relativePath); continue; }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      const mediaType = MEDIA_EXTENSIONS[extension];
      if (!mediaType) continue;
      try {
        const info = await lstat(path.join(root, relativePath));
        if (!info.isFile()) continue;
        const relativePathForClient = relativePath.split(path.sep).join('/');
        const id = createHmac('sha256', idSecret).update(`${sourceId}\0${relativePathForClient}`).digest('hex').slice(0, 32);
        items.push({
          id,
          filename: entry.name,
          mediaType,
          sizeBytes: info.size,
          relativePath: relativePathForClient,
          extension,
        });
        fingerprints.set(id, { relativePath: relativePathForClient, sizeBytes: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, mode: info.mode });
      } catch {
        warnings.push(`Skipped file that became unavailable: ${relativePath.split(path.sep).join('/')}`);
      }
    }
  }

  // Explicit code-point comparison gives deterministic ordering independent of the OS locale.
  items.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  return { result: { items, count: items.length, warnings, warningCount: warnings.length }, fingerprints };
}

export async function discoverMedia(root: string, idSecret: Buffer, sourceId: string): Promise<DiscoveryResult> {
  return (await discoverMediaWithIndex(root, idSecret, sourceId)).result;
}
