import { createElement } from 'react';
import { normalizeRelativePath } from '../utils/media-display';
import type { MediaItem } from '../services/api';

export function MediaDetails({ item }: { item: MediaItem }) {
  const relativePath = normalizeRelativePath(item.relativePath);
  return createElement('div', { className: 'file-info' },
    createElement('span', { className: 'file-name', title: item.filename }, item.filename),
    createElement('span', { className: 'file-meta' }, item.mediaType.toUpperCase(), ' ', createElement('span', null, '·'), ' ', formatBytes(item.sizeBytes)),
    createElement('span', { className: 'source-file-path', title: relativePath }, `Source: ${relativePath}`),
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}
