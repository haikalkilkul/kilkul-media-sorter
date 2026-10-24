import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMoveTargetIds, reconcileMovedQueue } from '../src/utils/move-queue';

describe('batch queue selection and reconciliation', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('uses the active item with no selection and queue-ordered selected IDs otherwise', () => {
    assert.deepEqual(getMoveTargetIds(items, new Set(), 'c'), ['c']);
    assert.deepEqual(getMoveTargetIds(items, new Set(['d']), 'b'), ['d']);
    assert.deepEqual(getMoveTargetIds(items, new Set(['c', 'a']), 'b'), ['a', 'c']);
    assert.deepEqual(getMoveTargetIds(items, new Set(), undefined), []);
  });

  it('removes confirmed successes, retains failed selection, and preserves an active item still queued', () => {
    const result = reconcileMovedQueue(items, new Set(['a', 'b', 'c']), 'c', 2, [
      { id: 'a', status: 'succeeded' }, { id: 'b', status: 'failed' },
    ]);
    assert.deepEqual(result.items, [{ id: 'b' }, { id: 'c' }, { id: 'd' }]);
    assert.deepEqual([...result.selected], ['b', 'c']);
    assert.equal(result.current, 1);
  });

  it('chooses the next remaining item after the active one moves, otherwise the previous item', () => {
    const movedActive = reconcileMovedQueue(items, new Set(), 'b', 1, [{ id: 'b', status: 'succeeded' }]);
    assert.equal(movedActive.items[movedActive.current].id, 'c');
    const movedLast = reconcileMovedQueue(items, new Set(), 'd', 3, [{ id: 'd', status: 'succeeded' }]);
    assert.equal(movedLast.items[movedLast.current].id, 'c');
    const emptied = reconcileMovedQueue([{ id: 'only' }], new Set(['only']), 'only', 0, [{ id: 'only', status: 'succeeded' }]);
    assert.deepEqual(emptied.items, []);
    assert.deepEqual([...emptied.selected], []);
    assert.equal(emptied.current, 0);
  });
});
