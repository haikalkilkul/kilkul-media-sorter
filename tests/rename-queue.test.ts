import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MediaItem } from '../src/services/api';
import { createRenameQueueSync, reconcileRenameQueue } from '../src/utils/rename-queue';

const items: MediaItem[] = [
  { id: 'old', filename: 'photo.jpg', mediaType: 'image', sizeBytes: 1, relativePath: 'trip/photo.jpg', extension: '.jpg' },
  { id: 'other', filename: 'clip.mp4', mediaType: 'video', sizeBytes: 2, relativePath: 'clip.mp4', extension: '.mp4' },
];

describe('rename queue reconciliation', () => {
  it('keeps the active file and selection on their new IDs while preserving other selected files', () => {
    const sync = createRenameQueueSync(items, new Set(['old', 'other']), 'old', 'old', 'trip/holiday.jpg');
    const result = reconcileRenameQueue([
      { ...items[0], id: 'renamed', filename: 'holiday.jpg', relativePath: 'trip/holiday.jpg' },
      { ...items[1], id: 'other-new-scan' },
    ], sync);
    assert.equal(result.current, 0);
    assert.deepEqual([...result.selected], ['renamed', 'other-new-scan']);
    assert.equal(result.anchorId, 'renamed');
  });

  it('uses either old or new relative path after an uncertain response, without keeping stale IDs', () => {
    const sync = createRenameQueueSync(items, new Set(['old']), 'old', null, 'trip/holiday.jpg', true);
    const oldName = reconcileRenameQueue([{ ...items[0], id: 'rescanned-old' }], sync);
    const newName = reconcileRenameQueue([{ ...items[0], id: 'rescanned-new', filename: 'holiday.jpg', relativePath: 'trip/holiday.jpg' }], sync);
    assert.deepEqual([...oldName.selected], ['rescanned-old']);
    assert.deepEqual([...newName.selected], ['rescanned-new']);
    assert.equal(oldName.current, 0);
    assert.equal(newName.current, 0);
  });
});
