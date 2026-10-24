import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  adjacentQueueIndex, getQueueNavigationIntent, HoldNavigationController, inclusiveQueueRange,
  NAVIGATION_REPEAT_DELAY_MS, NAVIGATION_REPEAT_INTERVAL_MS, rebaseQueueAnchor,
} from '../src/utils/queue-navigation';

class FakeTimers {
  private nextId = 0;
  readonly timeouts = new Map<number, () => void>();
  readonly intervals = new Map<number, () => void>();
  readonly delays: number[] = [];
  setTimeout(callback: () => void, delay: number): unknown { const id = ++this.nextId; this.timeouts.set(id, callback); this.delays.push(delay); return id; }
  clearTimeout(id: unknown): void { this.timeouts.delete(id as number); }
  setInterval(callback: () => void, delay: number): unknown { const id = ++this.nextId; this.intervals.set(id, callback); this.delays.push(delay); return id; }
  clearInterval(id: unknown): void { this.intervals.delete(id as number); }
  elapseDelay(): void { const callbacks = [...this.timeouts.values()]; this.timeouts.clear(); callbacks.forEach(callback => callback()); }
  tick(): void { [...this.intervals.values()].forEach(callback => callback()); }
}

const plain = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
const queue = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }));

describe('keyboard queue navigation and range selection', () => {
  it('moves one step in either direction and clamps at empty, single-item, and both boundaries', () => {
    assert.equal(adjacentQueueIndex(2, 5, 'left'), 1);
    assert.equal(adjacentQueueIndex(2, 5, 'right'), 3);
    assert.equal(adjacentQueueIndex(0, 5, 'left'), 0);
    assert.equal(adjacentQueueIndex(4, 5, 'right'), 4);
    assert.equal(adjacentQueueIndex(0, 1, 'left'), 0);
    assert.equal(adjacentQueueIndex(0, 1, 'right'), 0);
    assert.equal(adjacentQueueIndex(10, 0, 'left'), 0);
  });

  it('navigates immediately, waits before repeat, repeats at a controlled rate, then stops at release or boundary', () => {
    const timers = new FakeTimers(); let active = 1;
    const controller = new HoldNavigationController(timers);
    const step = (direction: 'left' | 'right') => {
      const next = adjacentQueueIndex(active, queue.length, direction);
      if (next === active) return false;
      active = next; return true;
    };
    controller.start('right', step);
    assert.equal(active, 2);
    assert.deepEqual(timers.delays, [NAVIGATION_REPEAT_DELAY_MS]);
    timers.elapseDelay();
    assert.deepEqual(timers.delays, [NAVIGATION_REPEAT_DELAY_MS, NAVIGATION_REPEAT_INTERVAL_MS]);
    timers.tick(); timers.tick();
    assert.equal(active, 4);
    timers.tick();
    assert.equal(active, 4);
    assert.equal(timers.intervals.size, 0);

    active = 3;
    controller.start('left', step);
    assert.equal(active, 2);
    controller.stop('left');
    timers.elapseDelay(); timers.tick();
    assert.equal(active, 2);
    assert.equal(timers.timeouts.size + timers.intervals.size, 0);
  });

  it('does not create duplicate repeat loops for repeated keydown and stops both timer phases on focus loss', () => {
    const timers = new FakeTimers(); let steps = 0;
    const controller = new HoldNavigationController(timers);
    const step = () => { steps += 1; return true; };
    controller.start('left', step);
    controller.start('left', step);
    assert.equal(steps, 1);
    assert.equal(timers.timeouts.size, 1);
    controller.stop();
    timers.elapseDelay(); timers.tick();
    assert.equal(steps, 1);
    assert.equal(timers.timeouts.size + timers.intervals.size, 0);

    controller.start('right', step);
    timers.elapseDelay();
    controller.stop(); // window blur / visibility loss / unmount share the same cleanup path
    timers.tick();
    assert.equal(steps, 2);
    assert.equal(timers.intervals.size, 0);
  });

  it('extends and contracts inclusive ranges from a fixed anchor in queue order', () => {
    assert.deepEqual([...inclusiveQueueRange(queue, 'b', 'd')], ['b', 'c', 'd']);
    assert.deepEqual([...inclusiveQueueRange(queue, 'b', 'c')], ['b', 'c']);
    assert.deepEqual([...inclusiveQueueRange(queue, 'd', 'b')], ['b', 'c', 'd']);
    assert.deepEqual([...inclusiveQueueRange(queue, 'b', 'b')], ['b']);
    assert.deepEqual([...inclusiveQueueRange(queue, 'gone', 'b')], []);
    assert.equal(inclusiveQueueRange(queue, 'b', 'd').size, 3); // selected count follows the inclusive range
  });

  it('keeps the Shift anchor fixed across repeated steps and contracts back toward it', () => {
    const timers = new FakeTimers(); const controller = new HoldNavigationController(timers);
    let active = 1; let anchor: string | null = null; let selection = new Set<string>();
    const step = (direction: 'left' | 'right') => {
      const previous = active;
      const next = adjacentQueueIndex(previous, queue.length, direction);
      if (next === previous) return false;
      anchor ??= queue[previous].id;
      active = next;
      selection = inclusiveQueueRange(queue, anchor, queue[active].id);
      return true;
    };
    controller.start('right', step);
    assert.equal(anchor, 'b');
    assert.equal(queue[active].id, 'c');
    assert.deepEqual([...selection], ['b', 'c']);
    timers.elapseDelay(); timers.tick();
    assert.equal(anchor, 'b');
    assert.equal(queue[active].id, 'd');
    assert.deepEqual([...selection], ['b', 'c', 'd']);
    controller.stop('right'); // Arrow released; Shift remains held, so anchor is retained.
    controller.start('left', step);
    assert.equal(anchor, 'b');
    assert.equal(queue[active].id, 'c');
    assert.deepEqual([...selection], ['b', 'c']);
    controller.stop('left');
  });

  it('keeps anchors when possible and rebases them after queue removals', () => {
    const remaining = queue.filter(item => item.id !== 'b');
    assert.equal(rebaseQueueAnchor(remaining, 'c', 'd'), 'c');
    assert.equal(rebaseQueueAnchor(remaining, 'b', 'd'), 'd');
    assert.equal(rebaseQueueAnchor([], 'b', undefined), null);
  });

  it('handles arrows only without editable targets, dialogs, or conflicting modifiers', () => {
    assert.deepEqual(getQueueNavigationIntent('ArrowRight', false, null, plain, false), { direction: 'right', extendSelection: false });
    assert.deepEqual(getQueueNavigationIntent('ArrowLeft', false, null, { ...plain, shiftKey: true }, false), { direction: 'left', extendSelection: true });
    assert.equal(getQueueNavigationIntent('ArrowLeft', true, null, plain, false), null);
    assert.equal(getQueueNavigationIntent('ArrowRight', false, { tagName: 'TEXTAREA', isContentEditable: false }, plain, false), null);
    assert.equal(getQueueNavigationIntent('ArrowRight', false, { tagName: 'DIV', isContentEditable: true }, plain, false), null);
    assert.equal(getQueueNavigationIntent('ArrowRight', false, null, { ...plain, ctrlKey: true }, false), null);
    assert.equal(getQueueNavigationIntent('ArrowRight', false, null, { ...plain, metaKey: true }, false), null);
    assert.equal(getQueueNavigationIntent('ArrowRight', false, null, { ...plain, altKey: true }, false), null);
    assert.equal(getQueueNavigationIntent('ArrowRight', false, null, plain, true), null);
    assert.equal(getQueueNavigationIntent('x', false, null, plain, false), null);
  });

  it('wires arrow repeat cleanup to keyup, focus loss, visibility loss, and queue changes', () => {
    const app = readFileSync(new URL('../src/MediaSorterApp.tsx', import.meta.url), 'utf8');
    assert.match(app, /window\.addEventListener\('keyup', onKeyUp\)/);
    assert.match(app, /window\.addEventListener\('blur', onBlur\)/);
    assert.match(app, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
    assert.match(app, /document\.addEventListener\('focusin', onFocusIn\)/);
    assert.match(app, /navigationControllerRef\.current\?\.stop\(\)/);
    assert.match(app, /navigationControllerRef\.current = controller/);
    assert.match(app, /rangeAnchorRef\.current = rebaseQueueAnchor\(items, rangeAnchorRef\.current, items\[currentIndexRef\.current\]\?\.id\);\s*\}, \[items\]\);/);
  });
});
