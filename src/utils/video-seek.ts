/** Seek a ready video by a relative offset. Returns true only when the browser accepts the seek request. */
export function seekVideoBy(video: HTMLVideoElement | null, offsetSeconds: number): boolean {
  // HAVE_METADATA is 1 per the HTMLMediaElement readyState constants.
  if (!video || video.readyState < 1 || !Number.isFinite(video.duration) || video.duration < 0 || !Number.isFinite(video.currentTime)) return false;
  const nextTime = Math.max(0, Math.min(video.duration, video.currentTime + offsetSeconds));
  try {
    video.currentTime = nextTime;
    return true;
  } catch {
    return false;
  }
}

export const SEEK_STEP_SECONDS = 5;
export const SEEK_REPEAT_INTERVAL_MS = 250;
export type SeekDirection = 'j' | 'l';
export type SeekTimerScheduler = { setInterval(callback: () => void, delayMs: number): unknown; clearInterval(timer: unknown): void };
export function canStartHoldSeek(key: string, repeated: boolean, target: Pick<HTMLElement, 'tagName' | 'isContentEditable'> | null, modifiers: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, blockedByDialog: boolean): boolean {
  const normalized = key.toLowerCase();
  return (normalized === 'j' || normalized === 'l') && !repeated && !blockedByDialog && !isEditableKeyboardTarget(target)
    && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.altKey && !modifiers.shiftKey;
}

const browserTimers: SeekTimerScheduler = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: timer => globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
};

/** Owns one key-hold loop. The initial seek is immediate; repeated seeks use only this timer. */
export class HoldSeekController {
  private direction: SeekDirection | null = null;
  private timer: unknown = null;

  constructor(private readonly seek: (offsetSeconds: number) => boolean, private readonly timers = browserTimers) {}

  start(direction: SeekDirection): boolean {
    if (this.direction === direction) return false;
    this.stop();
    this.direction = direction;
    if (!this.seek(this.offset(direction))) { this.direction = null; return false; }
    this.timer = this.timers.setInterval(() => {
      if (this.direction !== direction) return;
      if (!this.seek(this.offset(direction))) this.stop(direction);
    }, SEEK_REPEAT_INTERVAL_MS);
    return true;
  }

  stop(direction?: SeekDirection): void {
    if (direction && this.direction !== direction) return;
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.direction = null;
  }

  private offset(direction: SeekDirection): number {
    return direction === 'j' ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
  }
}

export function isEditableKeyboardTarget(target: Pick<HTMLElement, 'tagName' | 'isContentEditable'> | null): boolean {
  return Boolean(target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)));
}
