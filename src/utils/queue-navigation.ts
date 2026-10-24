import { isEditableKeyboardTarget } from './video-seek.js';

export type QueueDirection = 'left' | 'right';
export type QueueNavigationIntent = { direction: QueueDirection; extendSelection: boolean };
export const NAVIGATION_REPEAT_DELAY_MS = 300;
export const NAVIGATION_REPEAT_INTERVAL_MS = 100;

export type NavigationTimerScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(timer: unknown): void;
};

const browserTimers: NavigationTimerScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: timer => globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
};

export function getQueueNavigationIntent(
  key: string,
  repeated: boolean,
  target: Pick<HTMLElement, 'tagName' | 'isContentEditable'> | null,
  modifiers: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  blockedByDialog: boolean,
): QueueNavigationIntent | null {
  if ((key !== 'ArrowLeft' && key !== 'ArrowRight') || repeated || blockedByDialog || isEditableKeyboardTarget(target)
    || modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return null;
  return { direction: key === 'ArrowLeft' ? 'left' : 'right', extendSelection: modifiers.shiftKey };
}

export function adjacentQueueIndex(index: number, itemCount: number, direction: QueueDirection): number {
  if (itemCount < 1) return 0;
  const validIndex = Math.max(0, Math.min(itemCount - 1, index));
  return Math.max(0, Math.min(itemCount - 1, validIndex + (direction === 'right' ? 1 : -1)));
}

export function inclusiveQueueRange<T extends { id: string }>(items: T[], anchorId: string, endpointId: string): Set<string> {
  const anchor = items.findIndex(item => item.id === anchorId);
  const endpoint = items.findIndex(item => item.id === endpointId);
  if (anchor < 0 || endpoint < 0) return new Set();
  return new Set(items.slice(Math.min(anchor, endpoint), Math.max(anchor, endpoint) + 1).map(item => item.id));
}

export function rebaseQueueAnchor<T extends { id: string }>(items: T[], anchorId: string | null, activeId: string | undefined): string | null {
  if (anchorId && items.some(item => item.id === anchorId)) return anchorId;
  return activeId && items.some(item => item.id === activeId) ? activeId : null;
}

/** Immediate first step, then a delay and a bounded repeat loop until released or clamped. */
export class HoldNavigationController {
  private direction: QueueDirection | null = null;
  private delayTimer: unknown = null;
  private repeatTimer: unknown = null;

  constructor(private readonly timers = browserTimers) {}

  start(direction: QueueDirection, step: (direction: QueueDirection) => boolean): void {
    if (this.direction === direction) return;
    this.stop();
    this.direction = direction;
    if (!step(direction)) { this.direction = null; return; }
    this.delayTimer = this.timers.setTimeout(() => {
      this.delayTimer = null;
      if (this.direction !== direction) return;
      this.repeatTimer = this.timers.setInterval(() => {
        if (this.direction === direction && !step(direction)) this.stop(direction);
      }, NAVIGATION_REPEAT_INTERVAL_MS);
    }, NAVIGATION_REPEAT_DELAY_MS);
  }

  stop(direction?: QueueDirection): void {
    if (direction && this.direction !== direction) return;
    if (this.delayTimer !== null) this.timers.clearTimeout(this.delayTimer);
    if (this.repeatTimer !== null) this.timers.clearInterval(this.repeatTimer);
    this.delayTimer = null;
    this.repeatTimer = null;
    this.direction = null;
  }
}
