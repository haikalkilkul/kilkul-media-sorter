export type QueueIdentity = { id: string };
export type QueueMoveResult = { id: string; status: 'succeeded' | 'failed' };

export function getMoveTargetIds(items: QueueIdentity[], selected: ReadonlySet<string>, activeId?: string): string[] {
  if (selected.size) return items.filter(item => selected.has(item.id)).map(item => item.id);
  return activeId && items.some(item => item.id === activeId) ? [activeId] : [];
}

export function reconcileMovedQueue<T extends QueueIdentity>(
  items: T[], selected: ReadonlySet<string>, activeId: string | undefined, activeIndex: number, results: QueueMoveResult[],
) {
  const succeeded = new Set(results.filter(result => result.status === 'succeeded').map(result => result.id));
  const remaining = items.filter(item => !succeeded.has(item.id));
  const nextSelected = new Set([...selected].filter(id => remaining.some(item => item.id === id)));
  const preservedActiveIndex = activeId ? remaining.findIndex(item => item.id === activeId) : -1;
  return {
    items: remaining,
    selected: nextSelected,
    current: preservedActiveIndex >= 0 ? preservedActiveIndex : remaining.length ? Math.min(activeIndex, remaining.length - 1) : 0,
  };
}
