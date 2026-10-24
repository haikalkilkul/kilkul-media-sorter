import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { canStartHoldSeek, HoldSeekController, isEditableKeyboardTarget, SEEK_REPEAT_INTERVAL_MS, seekVideoBy } from '../src/utils/video-seek';

function fakeVideo(currentTime: number, duration: number, readyState = 1) {
  let time = currentTime;
  const video = { readyState, duration, get currentTime() { return time; }, set currentTime(value: number) { time = value; } } as HTMLVideoElement;
  return { video, time: () => time };
}

class FakeTimers {
  private nextId = 0;
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  setInterval(callback: () => void, delay: number): unknown { const id = ++this.nextId; this.callbacks.set(id, callback); this.delays.push(delay); return id; }
  clearInterval(id: unknown): void { this.callbacks.delete(id as number); }
  tick(): void { for (const callback of [...this.callbacks.values()]) callback(); }
}

describe('active video seek helper', () => {
  it('seeks backward and forward by the requested five-second interval while paused or playing', () => {
    const { video, time } = fakeVideo(20, 100);
    assert.equal(seekVideoBy(video, -5), true);
    assert.equal(time(), 15);
    assert.equal(seekVideoBy(video, 5), true);
    assert.equal(time(), 20);
  });

  it('clamps both ends of a finite duration', () => {
    const start = fakeVideo(2, 30);
    assert.equal(seekVideoBy(start.video, -5), true);
    assert.equal(start.time(), 0);
    const end = fakeVideo(28, 30);
    assert.equal(seekVideoBy(end.video, 5), true);
    assert.equal(end.time(), 30);
  });

  it('does not issue a seek before metadata, for no active video, or with an indefinite duration', () => {
    assert.equal(seekVideoBy(null, 5), false);
    assert.equal(seekVideoBy(fakeVideo(20, 30, 0).video, 5), false);
    assert.equal(seekVideoBy(fakeVideo(20, Number.POSITIVE_INFINITY).video, 5), false);
  });

  it('seeks immediately on J/L and repeats at the configured interval until key release', () => {
    const backward = fakeVideo(30, 100); const backwardTimers = new FakeTimers();
    const j = new HoldSeekController(offset => seekVideoBy(backward.video, offset), backwardTimers);
    assert.equal(j.start('j'), true);
    assert.equal(backward.time(), 25);
    assert.deepEqual(backwardTimers.delays, [SEEK_REPEAT_INTERVAL_MS]);
    backwardTimers.tick(); backwardTimers.tick();
    assert.equal(backward.time(), 15);
    j.stop('j');
    backwardTimers.tick();
    assert.equal(backward.time(), 15);
    assert.equal(backwardTimers.callbacks.size, 0);

    const forward = fakeVideo(30, 100); const forwardTimers = new FakeTimers();
    const l = new HoldSeekController(offset => seekVideoBy(forward.video, offset), forwardTimers);
    assert.equal(l.start('l'), true);
    assert.equal(forward.time(), 35);
    forwardTimers.tick();
    assert.equal(forward.time(), 40);
    l.stop('l');
  });

  it('starts only one repeat loop, stops on lost active-video validity, and clamps held seeks', () => {
    const boundary = fakeVideo(2, 7); const timers = new FakeTimers();
    const seek = new HoldSeekController(offset => seekVideoBy(boundary.video, offset), timers);
    assert.equal(seek.start('l'), true);
    assert.equal(boundary.time(), 7);
    assert.equal(seek.start('l'), false);
    assert.equal(timers.callbacks.size, 1);
    timers.tick();
    assert.equal(boundary.time(), 7);
    seek.stop();
    assert.equal(timers.callbacks.size, 0);

    let active = true; const invalidTimers = new FakeTimers();
    const invalidated = new HoldSeekController(() => active, invalidTimers);
    assert.equal(invalidated.start('j'), true);
    active = false; invalidTimers.tick();
    assert.equal(invalidTimers.callbacks.size, 0);
  });

  it('rejects repeat events, modifiers, editable fields, and active dialogs before starting hold-seek', () => {
    const plain = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    assert.equal(canStartHoldSeek('j', false, null, plain, false), true);
    assert.equal(canStartHoldSeek('L', false, null, plain, false), true);
    assert.equal(canStartHoldSeek('j', true, null, plain, false), false);
    assert.equal(canStartHoldSeek('j', false, { tagName: 'INPUT', isContentEditable: false }, plain, false), false);
    assert.equal(canStartHoldSeek('l', false, null, { ...plain, ctrlKey: true }, false), false);
    assert.equal(canStartHoldSeek('l', false, null, plain, true), false);
    assert.equal(canStartHoldSeek('x', false, null, plain, false), false);
  });

  it('wires release, focus loss, visibility loss, and active-preview changes to timer cleanup', () => {
    const app = readFileSync(new URL('../src/MediaSorterApp.tsx', import.meta.url), 'utf8');
    assert.match(app, /window\.addEventListener\('keyup', onKeyUp\)/);
    assert.match(app, /window\.addEventListener\('blur', stopSeeking\)/);
    assert.match(app, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
    assert.match(app, /document\.addEventListener\('focusin', stopSeeking\)/);
    assert.match(app, /previewKeyRef\.current !== expectedKey/);
    assert.match(app, /return \(\) => \{\s*controller\.stop\(\)/);
  });

  it('ignores shortcuts in editable fields and allows normal application targets', () => {
    assert.equal(isEditableKeyboardTarget({ tagName: 'INPUT', isContentEditable: false }), true);
    assert.equal(isEditableKeyboardTarget({ tagName: 'TEXTAREA', isContentEditable: false }), true);
    assert.equal(isEditableKeyboardTarget({ tagName: 'SELECT', isContentEditable: false }), true);
    assert.equal(isEditableKeyboardTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isEditableKeyboardTarget({ tagName: 'BUTTON', isContentEditable: false }), false);
    assert.equal(isEditableKeyboardTarget(null), false);
  });

  it('keeps portrait and landscape previews contained inside a shrinkable frame', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.workspace,\.main-content,\.preview-stage\.media-stage\{min-height:0\}/);
    assert.match(css, /\.media-image,\.media-video\{[^}]*object-fit:contain;object-position:center/);
    assert.match(css, /\.media-player-frame\{width:100%;height:100%;min-width:0;min-height:0;max-width:none;max-height:none\}/);
  });

  it('bounds the desktop workspace to the dynamic viewport and adapts queue/sidebar sizing', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.app-shell\{height:100vh;height:100dvh;min-height:0;overflow:hidden\}/);
    assert.match(css, /body\{min-width:0;overflow:hidden\}/);
    assert.match(css, /\.workspace\{height:auto;min-height:0;flex:1 1 0\}/);
    assert.match(css, /\.sidebar\{width:clamp\(180px,18vw,228px\)/);
    assert.match(css, /\.queue-panel\{display:flex;flex-direction:column;height:auto;min-height:42px;flex:0 0 clamp\(138px,23vh,174px\);overflow:hidden\}/);
    assert.match(css, /\.queue-panel:not\(\.collapsed\)\{height:auto;flex-basis:clamp\(138px,23vh,174px\)\}/);
    assert.match(css, /\.filmstrip,\.filmstrip-virtual\{height:calc\(100% - 42px\);min-height:0;flex:1 1 0;overflow-x:auto;overflow-y:hidden\}/);
    assert.match(css, /\.queue-panel\.collapsed\{flex-basis:42px\}/);
  });

  it('keeps batch summary in the fixed queue header and detailed results in a bounded dialog', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../src/MediaSorterApp.tsx', import.meta.url), 'utf8');
    assert.match(app, /className="batch-summary" onClick=\{\(\) => setBatchDetailsOpen\(true\)\}/);
    assert.match(app, /className="help-modal batch-results-modal" role="dialog"/);
    assert.match(css, /\.batch-results-modal \.batch-result-list\{max-height:min\(48vh,48dvh,460px\);overflow:auto/);
    assert.doesNotMatch(app, /className="batch-report"/);
  });
});
