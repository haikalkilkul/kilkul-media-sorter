import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placeholderItems } from '../src/data/placeholders';
import { validateRenamedFilename } from '../src/utils/filename';

describe('validateRenamedFilename', () => {
  const current = placeholderItems[0];

  it('preserves the current extension when given a stem or a full filename', () => {
    assert.deepEqual(validateRenamedFilename('holiday', current.filename, current.id, placeholderItems), { filename: 'holiday.jpg' });
    assert.deepEqual(validateRenamedFilename('holiday.jpg', current.filename, current.id, placeholderItems), { filename: 'holiday.jpg' });
  });

  it('does not append a duplicate extension accidentally', () => {
    assert.deepEqual(validateRenamedFilename('holiday.jpg.jpg', current.filename, current.id, placeholderItems), { filename: 'holiday.jpg' });
    assert.match(validateRenamedFilename('holiday.png', current.filename, current.id, placeholderItems).error ?? '', /Keep the existing/);
  });

  it('rejects empty, invalid, reserved, trailing-dot and duplicate names', () => {
    assert.ok(validateRenamedFilename('  ', current.filename, current.id, placeholderItems).error);
    assert.ok(validateRenamedFilename('bad/name', current.filename, current.id, placeholderItems).error);
    assert.ok(validateRenamedFilename('CON', current.filename, current.id, placeholderItems).error);
    assert.ok(validateRenamedFilename('trailing.', current.filename, current.id, placeholderItems).error);
    assert.ok(validateRenamedFilename('coastline.mov', current.filename, current.id, placeholderItems).error);
  });
});
