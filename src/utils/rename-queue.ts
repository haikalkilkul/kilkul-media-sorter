import type { MediaItem } from '../services/api';

export type RenameQueueSync = { activePaths: Set<string>; selectedPaths: Set<string>; anchorPaths: Set<string> };

export function createRenameQueueSync(
  items: MediaItem[], selectedIds: ReadonlySet<string>, activeId: string, anchorId: string | null, newRelativePath: string, includeOriginalPath = false,
): RenameQueueSync {
  const active = items.find(item => item.id === activeId);
  if (!active) return { activePaths: new Set([newRelativePath]), selectedPaths: new Set(), anchorPaths: new Set() };
  const alternatives = includeOriginalPath ? [active.relativePath, newRelativePath] : [newRelativePath];
  const selectedPaths = new Set(items.filter(item => selectedIds.has(item.id) && item.id !== activeId).map(item => item.relativePath));
  if (selectedIds.has(activeId)) alternatives.forEach(relativePath => selectedPaths.add(relativePath));
  const anchor = items.find(item => item.id === anchorId);
  const anchorPaths = new Set(anchor ? (anchor.id === activeId ? alternatives : [anchor.relativePath]) : []);
  return { activePaths: new Set(alternatives), selectedPaths, anchorPaths };
}

export function reconcileRenameQueue(items: MediaItem[], sync: RenameQueueSync) {
  const activeIndex = items.findIndex(item => sync.activePaths.has(item.relativePath));
  return {
    current: activeIndex >= 0 ? activeIndex : 0,
    selected: new Set(items.filter(item => sync.selectedPaths.has(item.relativePath)).map(item => item.id)),
    anchorId: items.find(item => sync.anchorPaths.has(item.relativePath))?.id ?? null,
  };
}
