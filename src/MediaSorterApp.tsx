import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Aperture, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Film, FolderOpen, Image as ImageIcon, Keyboard, Moon, Plus, ScanLine, Sun, X } from 'lucide-react';
import type { FormEvent } from 'react';
import { api, ApiError, type BatchMoveItemResult, type ConfiguredFolder, type FolderConfiguration, type MediaItem, type ScanResult } from './services/api';
import { MediaDetails } from './components/MediaDetails';
import { canStartHoldSeek, HoldSeekController, isEditableKeyboardTarget, seekVideoBy } from './utils/video-seek';
import { getMoveTargetIds, reconcileMovedQueue } from './utils/move-queue';
import { adjacentQueueIndex, getQueueNavigationIntent, HoldNavigationController, inclusiveQueueRange, rebaseQueueAnchor, type QueueDirection } from './utils/queue-navigation';

type Theme = 'dark' | 'light';
type VideoPreviewState = { key: string; status: 'loading' | 'buffering' | 'ready' | 'error'; currentTime: number; duration: number | null; message?: string };
type DisplayMoveResult = BatchMoveItemResult & { originalFilename: string; relativePath: string };
type BatchReport = { destinationId: string; destinationName: string; total: number; pending: boolean; submitted: Array<{ id: string; originalFilename: string; relativePath: string }>; results: DisplayMoveResult[]; requestUncertain?: string; requestUncertainItems?: Array<{ id: string; originalFilename: string; relativePath: string }>; requestError?: string };
const themeKey = 'kilkul-media-sorter-theme';
function initialTheme(): Theme {
  try { return localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}
function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function folderName(folderPath: string): string {
  return folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || folderPath;
}

export default function MediaSorterApp() {
  const [folders, setFolders] = useState<FolderConfiguration>({ source: null, destinations: [] });
  const [sourceInput, setSourceInput] = useState('');
  const [destinationInput, setDestinationInput] = useState('');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [current, setCurrent] = useState(0);
  const currentIndexRef = useRef(current);
  currentIndexRef.current = current;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const rangeAnchorRef = useRef<string | null>(null);
  const navigationControllerRef = useRef<HoldNavigationController | null>(null);
  const rangeNavigationActiveRef = useRef(false);
  const navigationStepRef = useRef<(direction: QueueDirection, extendSelection: boolean) => boolean>(() => false);
  const [queueOpen, setQueueOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [batchDetailsOpen, setBatchDetailsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [loadingFolders, setLoadingFolders] = useState(true);
  const [configuring, setConfiguring] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('Ready · no source folder selected');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [activeDestination, setActiveDestination] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const movingRef = useRef<string | null>(null);
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null);
  const [filmWindow, setFilmWindow] = useState({ start: 0, end: 24 });
  const [imagePreview, setImagePreview] = useState<{ key: string; status: 'loading' | 'ready' | 'error' }>({ key: '', status: 'loading' });
  const [videoPreview, setVideoPreview] = useState<VideoPreviewState>({ key: '', status: 'loading', currentTime: 0, duration: null });
  const currentItem = items[current];
  const currentItemId = useRef<string | undefined>(currentItem?.id);
  currentItemId.current = currentItem?.id;
  const videoRef = useRef<HTMLVideoElement>(null);
  const filmstripRef = useRef<HTMLDivElement>(null);
  const previewKey = currentItem && scanResult ? `${scanResult.scanId}:${currentItem.id}` : '';
  const previewKeyRef = useRef(previewKey);
  previewKeyRef.current = previewKey;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101110' : '#f3f4f0');
    try { localStorage.setItem(themeKey, theme); } catch { /* Current-session theme still applies. */ }
  }, [theme]);

  useEffect(() => {
    let mounted = true;
    api.getFolders().then(config => {
      if (!mounted) return;
      setFolders(config);
      setSourceInput(config.source?.path ?? '');
      setLoadingFolders(false);
    }).catch(reason => {
      if (!mounted) return;
      setError(reason instanceof Error ? reason.message : 'Could not connect to the local service.');
      setLoadingFolders(false);
    });
    return () => { mounted = false; };
  }, []);

  const setSource = async (event: FormEvent<HTMLFormElement>) => {
    if (movingRef.current) return;
    event.preventDefault();
    setConfiguring(true); setError(''); setItems([]); setSelected(new Set()); currentIndexRef.current = 0; setCurrent(0); setScanResult(null); setScanned(false); setActiveDestination(null);
    try {
      const config = await api.setSource(sourceInput);
      setFolders(config);
      setSourceInput(config.source?.path ?? '');
      setFeedback('Source folder saved. Scan it to load media.');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not configure that source folder.';
      setError(message); setFeedback(message);
    } finally { setConfiguring(false); }
  };

  const addDestination = async (event: FormEvent<HTMLFormElement>) => {
    if (movingRef.current) return;
    event.preventDefault(); setConfiguring(true); setError('');
    try {
      const destination = await api.addDestination(destinationInput);
      setFolders(previous => ({ ...previous, destinations: [...previous.destinations, destination] }));
      setDestinationInput(''); setFeedback(`Destination added: ${destination.path}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not add that destination folder.';
      setError(message); setFeedback(message);
    } finally { setConfiguring(false); }
  };

  const removeDestination = async (destination: ConfiguredFolder) => {
    if (movingRef.current) return;
    setError('');
    try {
      await api.removeDestination(destination.id);
      setFolders(previous => ({ ...previous, destinations: previous.destinations.filter(entry => entry.id !== destination.id) }));
      if (activeDestination === destination.id) setActiveDestination(null);
      setFeedback(`Destination removed: ${destination.path}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not remove that destination.';
      setError(message); setFeedback(message);
    }
  };

  const scan = useCallback(async () => {
    if (!folders.source || scanning) return;
    setScanning(true); setError(''); setFeedback('Scanning source folder…');
    try {
      const result = await api.scan();
      if (result.sourceId !== folders.source.id) {
        setItems([]); setSelected(new Set()); currentIndexRef.current = 0; setCurrent(0); setScanResult(null); setScanned(false); setActiveDestination(null);
        try {
          const latest = await api.getFolders();
          setFolders(latest); setSourceInput(latest.source?.path ?? '');
        } catch { /* The cleared queue is safer than showing results for an outdated source. */ }
        const message = 'The source folder changed in another window. The old queue was cleared; review the current source and scan again.';
        setError(message); setFeedback(message);
        return;
      }
      const priorId = currentItemId.current;
      const newIndex = priorId ? result.items.findIndex(item => item.id === priorId) : -1;
      const stillValid = new Set(result.items.map(item => item.id));
      setItems(result.items);
      setSelected(old => new Set([...old].filter(id => stillValid.has(id))));
      const nextCurrent = newIndex >= 0 ? newIndex : 0;
      currentIndexRef.current = nextCurrent;
      setCurrent(nextCurrent);
      setFilmWindow({ start: 0, end: Math.min(24, result.items.length) });
      const rescannedIds = new Set(result.items.map(item => item.id));
      setBatchReport(previous => {
        if (!previous || (!previous.requestUncertain && !previous.results.some(item => item.status === 'failed' && (item.uncertain || item.code === 'MOVE_404' || item.code === 'MOVE_409')))) return previous;
        const reconcile = (entry: DisplayMoveResult): DisplayMoveResult => {
          if (entry.status !== 'failed') return entry;
          if (rescannedIds.has(entry.id) && (entry.uncertain || entry.code === 'MOVE_404' || entry.code === 'MOVE_409')) {
            return { ...entry, code: 'MOVE_RESCANNED', uncertain: false, message: 'Rescan confirms the item remains in the source. It is safe to retry.' };
          }
          if (entry.uncertain && !rescannedIds.has(entry.id)) return { ...entry, message: 'Rescan no longer finds this item in the source. Check the destination before taking further action.' };
          return entry;
        };
        const results = previous.results.map(reconcile);
        for (const entry of previous.requestUncertainItems ?? []) {
          results.push(rescannedIds.has(entry.id)
            ? { ...entry, status: 'failed', code: 'MOVE_OUTCOME_CHECKED', uncertain: false, message: 'Rescan confirms the item remains in the source. It is safe to retry.' }
            : { ...entry, status: 'failed', code: 'MOVE_OUTCOME_UNKNOWN', uncertain: true, message: 'Rescan no longer finds this item in the source. Check the destination before taking further action.' });
        }
        return { ...previous, requestUncertain: undefined, requestUncertainItems: undefined, results };
      });
      setScanResult(result); setScanned(true);
      setFeedback(result.warningCount ? `Scan complete with ${result.warningCount} warning${result.warningCount === 1 ? '' : 's'}.` : `Scan complete · ${result.count} media file${result.count === 1 ? '' : 's'} found.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The source folder could not be scanned.';
      const displayMessage = items.length ? `Rescan failed. Previous results remain displayed. ${message}` : message;
      setError(displayMessage); setFeedback(displayMessage);
    } finally { setScanning(false); }
  }, [folders.source, scanning]);

  const toggleSelected = (id: string) => {
    rangeAnchorRef.current = id;
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  };
  const navigate = (offset: number) => {
    const next = items.length ? Math.max(0, Math.min(items.length - 1, current + offset)) : 0;
    if (next === current) return;
    rangeAnchorRef.current = null;
    currentIndexRef.current = next;
    setCurrent(next);
    if (next < filmWindow.start || next >= filmWindow.end) setFilmWindow({ start: Math.max(0, next - 4), end: Math.min(items.length, next + 20) });
  };
  navigationStepRef.current = (direction, extendSelection) => {
    const queue = itemsRef.current;
    if (!queue.length) return false;
    const previous = currentIndexRef.current;
    const next = adjacentQueueIndex(previous, queue.length, direction);
    if (next === previous) return false;
    if (extendSelection) {
      const existingAnchor = rangeAnchorRef.current;
      const anchor = existingAnchor && queue.some(item => item.id === existingAnchor) ? existingAnchor : queue[previous].id;
      rangeAnchorRef.current = anchor;
      setSelected(inclusiveQueueRange(queue, anchor, queue[next].id));
    } else {
      rangeAnchorRef.current = null;
    }
    currentIndexRef.current = next;
    setCurrent(next);
    if (next < filmWindow.start || next >= filmWindow.end) setFilmWindow({ start: Math.max(0, next - 4), end: Math.min(queue.length, next + 20) });
    return true;
  };
  const chooseDestination = (destination: ConfiguredFolder) => {
    setActiveDestination(destination.id);
    setError('');
    setFeedback(`Destination selected: ${folderName(destination.path)}. Move applies to selected items, or the active item when none are selected.`);
  };

  const moveToDestination = useCallback(async (destination: ConfiguredFolder, requestedIds?: string[]) => {
    if (movingRef.current) { setFeedback('A move is already in progress.'); return; }
    if (!scanResult) { setFeedback('Scan the source folder before moving files.'); return; }
    const chosen = requestedIds ?? getMoveTargetIds(items, selected, currentItem?.id);
    if (!chosen.length) { setFeedback('Select a scanned media item before moving files.'); return; }
    if (chosen.length > 100) { setFeedback('A batch can contain at most 100 files. Select fewer items.'); return; }
    navigationControllerRef.current?.stop();
    rangeNavigationActiveRef.current = false;
    const byId = new Map(items.map(item => [item.id, item]));
    const labels = new Map(chosen.map(id => [id, byId.get(id)]));
    const operationKey = chosen.length === 1 && !requestedIds && selected.size === 0 ? chosen[0] : 'batch';
    movingRef.current = operationKey;
    setMovingId(operationKey); setError(''); setActiveDestination(destination.id);
    const submitted = chosen.map(id => ({ id, originalFilename: labels.get(id)?.filename ?? 'Media item', relativePath: labels.get(id)?.relativePath ?? '' }));
    setBatchReport({ destinationId: destination.id, destinationName: folderName(destination.path), total: chosen.length, pending: true, submitted, results: [] });
    setFeedback(`Moving ${chosen.length} file${chosen.length === 1 ? '' : 's'} to ${folderName(destination.path)}…`);
    const activeId = currentItem?.id;
    try {
      let results: BatchMoveItemResult[];
      if (chosen.length === 1 && !requestedIds && selected.size === 0) {
        const result = await api.moveMedia(chosen[0], scanResult.scanId, destination.id);
        results = [{ id: result.id, status: 'succeeded', filename: result.filename, strategy: result.strategy }];
      } else {
        results = (await api.moveBatch(chosen, scanResult.scanId, destination.id)).results;
      }
      const displayResults: DisplayMoveResult[] = results.map(result => ({
        ...result,
        originalFilename: labels.get(result.id)?.filename ?? 'Media item',
        relativePath: labels.get(result.id)?.relativePath ?? '',
      }));
      const failed = displayResults.filter((result): result is DisplayMoveResult & { status: 'failed' } => result.status === 'failed');
      const reconciled = reconcileMovedQueue(items, selected, activeId, current, displayResults);
      setItems(reconciled.items);
      setSelected(reconciled.selected);
      currentIndexRef.current = reconciled.current;
      setCurrent(reconciled.current);
      setFilmWindow({ start: 0, end: Math.min(24, reconciled.items.length) });
      setBatchReport({ destinationId: destination.id, destinationName: folderName(destination.path), total: chosen.length, pending: false, submitted, results: displayResults });
      const uncertain = failed.filter(result => result.uncertain);
      if (uncertain.length) {
        setFeedback(`${displayResults.length - failed.length} moved · ${failed.length - uncertain.length} failed · ${uncertain.length} outcome${uncertain.length === 1 ? '' : 's'} uncertain. Rescan before retrying.`);
      } else {
      setFeedback(`${displayResults.length - failed.length} moved · ${failed.length} failed to ${folderName(destination.path)}.`);
      }
      setError(failed.length ? `${failed.length} file${failed.length === 1 ? '' : 's'} need review.` : '');
      setScanned(true);
    } catch (reason) {
      const message = reason instanceof ApiError && reason.uncertain
        ? `${reason.message} Rescan before retrying.`
        : reason instanceof Error ? reason.message : 'The move request failed. The queue was kept.';
      const uncertain = reason instanceof ApiError && reason.uncertain;
      setBatchReport({ destinationId: destination.id, destinationName: folderName(destination.path), total: chosen.length, pending: false, submitted, results: [], ...(uncertain ? { requestUncertain: message, requestUncertainItems: submitted } : { requestError: message }) });
      setError(message); setFeedback(message);
    } finally {
      movingRef.current = null;
      setMovingId(null);
    }
  }, [currentItem, scanResult, selected, items, current]);

  const moveCurrentTo = useCallback((destination: ConfiguredFolder) => moveToDestination(destination), [moveToDestination]);

  const updateVideoForKey = (key: string, changes: Partial<VideoPreviewState>) => {
    if (previewKeyRef.current !== key) return;
    setVideoPreview(previous => ({
      key,
      status: previous.key === key ? previous.status : 'loading',
      currentTime: previous.key === key ? previous.currentTime : 0,
      duration: previous.key === key ? previous.duration : null,
      ...changes,
    }));
  };

  useEffect(() => {
    const previousVideo = videoRef.current;
    return () => {
      if (previousVideo) {
        previousVideo.pause();
        previousVideo.removeAttribute('src');
        previousVideo.load();
      }
    };
  }, [previewKey]);

  useEffect(() => {
    if (!previewKey || currentItem?.mediaType !== 'video') return;
    const expectedKey = previewKey;
    const controller = new HoldSeekController(offset => {
      const player = videoRef.current;
      if (!player || previewKeyRef.current !== expectedKey || player.dataset.previewKey !== expectedKey) return false;
      return seekVideoBy(player, offset);
    });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!canStartHoldSeek(event.key, event.repeat, target, event, helpOpen || batchDetailsOpen)) return;
      const key = event.key.toLowerCase();
      if ((key === 'j' || key === 'l') && controller.start(key)) event.preventDefault();
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'j' || key === 'l') controller.stop(key);
    };
    const stopSeeking = () => controller.stop();
    const onVisibilityChange = () => { if (document.hidden) stopSeeking(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stopSeeking);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('focusin', stopSeeking);
    return () => {
      controller.stop();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopSeeking);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('focusin', stopSeeking);
    };
  }, [previewKey, currentItem?.mediaType, helpOpen, batchDetailsOpen]);

  useEffect(() => {
    const controller = new HoldNavigationController();
    navigationControllerRef.current = controller;
    const stopNavigation = (clearAnchor = true) => {
      controller.stop();
      rangeNavigationActiveRef.current = false;
      if (clearAnchor) rangeAnchorRef.current = null;
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Shift') { controller.stop(); rangeNavigationActiveRef.current = false; return; }
      const target = event.target instanceof HTMLElement ? event.target : null;
      const intent = getQueueNavigationIntent(event.key, event.repeat, target, event, helpOpen || batchDetailsOpen);
      if (!intent || movingRef.current || target?.closest('video') || !itemsRef.current.length) return;
      event.preventDefault();
      rangeNavigationActiveRef.current = intent.extendSelection;
      controller.start(intent.direction, direction => navigationStepRef.current(direction, intent.extendSelection));
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'ArrowLeft') { controller.stop('left'); rangeNavigationActiveRef.current = false; }
      else if (event.key === 'ArrowRight') { controller.stop('right'); rangeNavigationActiveRef.current = false; }
      else if (event.key === 'Shift') {
        if (rangeNavigationActiveRef.current) controller.stop();
        rangeNavigationActiveRef.current = false;
        rangeAnchorRef.current = null;
      }
    };
    const onBlur = () => stopNavigation();
    const onVisibilityChange = () => { if (document.hidden) stopNavigation(); };
    const onFocusIn = () => stopNavigation();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      stopNavigation();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('focusin', onFocusIn);
      if (navigationControllerRef.current === controller) navigationControllerRef.current = null;
    };
  }, [helpOpen, batchDetailsOpen]);

  useEffect(() => {
    navigationControllerRef.current?.stop();
    rangeNavigationActiveRef.current = false;
    rangeAnchorRef.current = rebaseQueueAnchor(items, rangeAnchorRef.current, items[currentIndexRef.current]?.id);
  }, [items]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (helpOpen || batchDetailsOpen) { if (event.key === 'Escape') { setHelpOpen(false); setBatchDetailsOpen(false); } return; }
      if (isEditableKeyboardTarget(target)) return;
      if (movingRef.current) return;
      const videoHasNativeFocus = Boolean(target?.closest('video'));
      if (event.repeat) return;
      if (videoHasNativeFocus && ['k', 'K', ' ', 'Spacebar', 'Escape'].includes(event.key)) return;
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      const selectAllShortcut = !event.altKey && !event.shiftKey && (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
      if (selectAllShortcut && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        rangeAnchorRef.current = null;
        if (!items.length) { setSelected(new Set()); setFeedback('The queue is empty.'); return; }
        setSelected(previous => previous.size === items.length ? new Set() : new Set(items.map(item => item.id)));
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== '?')) return;
      if (event.key === 'Escape') { setHelpOpen(false); return; }
      if (event.key === '?') { setHelpOpen(open => !open); return; }
      if (event.key.toLowerCase() === 's' && currentItem) { toggleSelected(currentItem.id); return; }
      if (event.key.toLowerCase() === 'q') { setQueueOpen(open => !open); return; }
      if (currentItem?.mediaType === 'video' && (event.key.toLowerCase() === 'k' || event.key === ' ' || event.key === 'Spacebar')) {
        if (target?.closest('button,a,[role="button"]')) return;
        const player = videoRef.current;
        if (player) {
          event.preventDefault();
          if (player.paused) {
            const requestedPreviewKey = previewKeyRef.current;
            void player.play().catch(() => updateVideoForKey(requestedPreviewKey, { status: 'error', message: 'Playback could not start. This codec may not be supported.' }));
          }
          else player.pause();
        }
        return;
      }
      if (/^[1-9]$/.test(event.key) && !movingRef.current && !scanning && !configuring) {
        const destination = folders.destinations[Number(event.key) - 1];
        if (destination) void moveCurrentTo(destination);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [items, currentItem, folders.destinations, selected.size, helpOpen, batchDetailsOpen, previewKey, moveCurrentTo, scanning, configuring]);

  useEffect(() => {
    const strip = filmstripRef.current;
    if (!strip || !items.length) return;
    const left = current * 123;
    if (left < strip.scrollLeft || left + 112 > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: Math.max(0, left - 60) });
  }, [current, items.length]);

  const selectAll = () => {
    rangeAnchorRef.current = null;
    setSelected(previous => previous.size === items.length && items.length ? new Set() : new Set(items.map(item => item.id)));
  };
  const sourceLabel = folders.source?.path ?? 'No source folder configured';
  const selectedDestination = folders.destinations.find(destination => destination.id === activeDestination) ?? null;
  const duplicateCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of items) counts.set(entry.filename.toLocaleLowerCase(), (counts.get(entry.filename.toLocaleLowerCase()) ?? 0) + 1);
    return counts;
  }, [items]);
  const visibleItems = items.slice(filmWindow.start, Math.min(filmWindow.end, items.length));
  const previewUrl = currentItem && scanResult ? api.previewUrl(currentItem.id, scanResult.scanId) : '';
  const imageStatus = imagePreview.key === previewKey ? imagePreview.status : 'loading';
  const activeVideoState = videoPreview.key === previewKey ? videoPreview : { key: previewKey, status: 'loading' as const, currentTime: 0, duration: null };

  return <main className="app-shell" data-theme={theme}>
    <header className="topbar">
      <a className="brand" href="#" aria-label="kilkul-media-sorter home"><span className="brand-mark"><Aperture size={17}/></span><span>kilkul-media-sorter</span></a>
      <form className="source-config" onSubmit={setSource}>
        <label htmlFor="source-path">SOURCE</label><input id="source-path" value={sourceInput} onChange={event => setSourceInput(event.target.value)} placeholder="Absolute folder path, e.g. C:\\Photos or /Users/name/Photos" title={sourceLabel} autoComplete="off" spellCheck={false} disabled={configuring || loadingFolders || scanning || Boolean(movingId)}/>
        <button className="text-button source-save" type="submit" disabled={configuring || loadingFolders || scanning || Boolean(movingId)}><FolderOpen size={14}/>{folders.source ? 'Change source' : 'Set source'}</button>
      </form>
      <div className="top-actions"><span className="progress">{items.length ? String(current + 1).padStart(2, '0') : '—'} <span className="muted">/ {items.length || '—'}</span></span><button className="scan-button" onClick={() => void scan()} disabled={!folders.source || scanning || configuring || Boolean(movingId)}><ScanLine size={14}/>{scanning ? 'Scanning…' : scanned ? 'Rescan' : 'Scan'}</button><span className="divider"/><button className="icon-button theme-toggle" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={17}/> : <Moon size={17}/>}</button><button className="icon-button" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts"><CircleHelp size={17}/></button></div>
    </header>
    <div className="workspace">
      <aside className="sidebar">
        <div className="section-heading"><span>DESTINATIONS</span><span className="shortcut-caption">1–9</span></div>
        <p className="aside-caption">Click to select · number keys move selected files</p>
        <nav className="destination-list" aria-label="Configured destinations">
          {folders.destinations.map((destination, index) => <div key={destination.id} className={`destination-row ${activeDestination === destination.id ? 'active' : ''}`}><button className="destination" onClick={() => chooseDestination(destination)} title={destination.path} disabled={Boolean(movingId)}><span className={`folder-icon tone-${index % 4}`}><FolderOpen size={15}/></span><span className="destination-label"><b>{folderName(destination.path)}</b><small>{destination.path}</small></span><kbd>{index < 9 ? index + 1 : '—'}</kbd></button><button className="remove-destination" onClick={() => void removeDestination(destination)} aria-label={`Remove destination ${destination.path}`} title="Remove destination" disabled={Boolean(movingId)}><X size={14}/></button></div>)}
          {!folders.destinations.length && <p className="empty-destinations">Add a destination path below.</p>}
        </nav>
        <form className="destination-form" onSubmit={addDestination}><label htmlFor="destination-path">Add destination folder</label><input id="destination-path" value={destinationInput} onChange={event => setDestinationInput(event.target.value)} placeholder="Absolute folder path" autoComplete="off" spellCheck={false} disabled={Boolean(movingId)}/><button className="add-destination" type="submit" disabled={!destinationInput.trim() || configuring || Boolean(movingId)}><Plus size={14}/> Add destination</button></form>
        <div className="sidebar-bottom"><div className="key-hint"><span>Move selection or active file</span><kbd>1–9</kbd></div><p>Selected files move into the destination root. With no selection, the active file moves. Name conflicts receive a new filename.</p></div>
      </aside>
      <section className="main-content" aria-label="Media queue">
        <div className="preview-toolbar"><div className="breadcrumb"><span>{folders.source ? 'Source' : 'Get started'}</span><ChevronRight size={14}/><span className="muted" title={sourceLabel}>{folders.source ? folderName(folders.source.path) : sourceLabel}</span></div><span className="preview-count">{items.length ? String(current + 1).padStart(2, '0') : '—'} <span>/ {items.length || '—'}</span></span></div>
        {currentItem ? <div className="preview-stage media-stage">
          <div className={`media-player-frame ${currentItem.mediaType}`}>
            {currentItem.mediaType === 'image' ? <>
              {imageStatus === 'error' ? <div className="preview-failure" role="status"><ImageIcon size={27}/><strong>Image preview unavailable</strong><span>The file could not be loaded or decoded. Rescan the source if it changed.</span></div> : <><img className="media-image" src={previewUrl} alt={currentItem.filename} onLoad={() => { if (previewKeyRef.current === previewKey) setImagePreview({ key: previewKey, status: 'ready' }); }} onError={() => { if (previewKeyRef.current === previewKey) setImagePreview({ key: previewKey, status: 'error' }); }}/>{imageStatus === 'loading' && <div className="preview-loading" role="status"><span className="loading-mark"><ImageIcon size={22}/></span>Loading image preview…</div>}</>}
            </> : <>
              {activeVideoState.status === 'error' ? <div className="preview-failure" role="status"><Film size={27}/><strong>Video preview unavailable</strong><span>{activeVideoState.message ?? 'The file could not be loaded or decoded. Its codec may not be supported.'}</span></div> : <><video key={previewKey} ref={videoRef} data-preview-key={previewKey} className="media-video" src={previewUrl} controls preload="metadata" playsInline onLoadStart={() => updateVideoForKey(previewKey, { status: 'loading' })} onLoadedMetadata={event => { const duration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null; updateVideoForKey(previewKey, { duration, currentTime: event.currentTarget.currentTime }); }} onCanPlay={() => updateVideoForKey(previewKey, { status: 'ready' })} onWaiting={() => updateVideoForKey(previewKey, { status: 'buffering' })} onPlaying={() => updateVideoForKey(previewKey, { status: 'ready' })} onTimeUpdate={event => updateVideoForKey(previewKey, { currentTime: event.currentTarget.currentTime, duration: Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : null })} onError={event => { const code = event.currentTarget.error?.code; const message = code === MediaError.MEDIA_ERR_DECODE ? 'The browser could not decode this video. Its codec may not be supported.' : code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'The video source is unavailable or its format/codec is unsupported.' : 'The file could not be loaded. It may have changed or become unavailable.'; updateVideoForKey(previewKey, { status: 'error', message }); }}/>{(activeVideoState.status === 'loading' || activeVideoState.status === 'buffering') && <div className="video-loading" role="status">{activeVideoState.status === 'buffering' ? 'Buffering…' : 'Loading video…'}</div>}<div className="video-time" aria-live="off">{formatDuration(activeVideoState.currentTime)} / {formatDuration(activeVideoState.duration)}</div></>}
            </>}
          </div>
          <div className="preview-bottom"><MediaDetails item={currentItem}/><div className="item-actions">{selectedDestination && <button className="move-button" onClick={() => void moveCurrentTo(selectedDestination)} disabled={Boolean(movingId)}>{movingId ? 'Moving…' : `Move ${selected.size ? `${selected.size} selected` : 'active'} to ${folderName(selectedDestination.path)}`}</button>}<button className={`select-button ${selected.has(currentItem.id) ? 'selected' : ''}`} onClick={() => toggleSelected(currentItem.id)} disabled={Boolean(movingId)}>{selected.has(currentItem.id) ? <Check size={15}/> : <Plus size={15}/>} {selected.has(currentItem.id) ? 'Selected' : 'Select'} <kbd>S</kbd></button></div></div>
          <button className="nav-arrow previous" onClick={() => navigate(-1)} aria-label="Previous item" disabled={items.length < 2 || Boolean(movingId)}><ChevronLeft size={20}/></button><button className="nav-arrow next" onClick={() => navigate(1)} aria-label="Next item" disabled={items.length < 2 || Boolean(movingId)}><ChevronRight size={20}/></button>
        </div> : <div className="empty-queue">{scanning ? <><span className="loading-mark"><ScanLine size={22}/></span><strong>Scanning source folder…</strong><span>Reading folder entries and supported-file metadata.</span></> : error && !folders.source ? <><strong>Local service unavailable</strong><span>{error}</span></> : !folders.source ? <><span className="empty-folder-icon"><FolderOpen size={28}/></span><strong>Select a source folder to get started</strong><span>Enter an absolute path above, then choose Scan.</span><small>Images and videos preview when supported by the browser. Files move only after you choose a destination action.</small></> : scanned && items.length === 0 ? <><span className="empty-folder-icon"><ImageIcon size={28}/></span><strong>No supported media found</strong><span>The source folder contains no supported image or video files.</span><button className="modal-done retry-scan" onClick={() => void scan()}><ScanLine size={14}/> Rescan</button></> : <><span className="empty-folder-icon"><ScanLine size={28}/></span><strong>Source folder is ready</strong><span>Scan to find supported media in this folder and its subfolders.</span></>}</div>}
        <div className="preview-footer"><div className={`status-message ${error ? 'error-status' : ''}`} role={error ? 'alert' : 'status'}><span className={`status-dot ${error ? 'error-dot' : 'subdued'}`}/>{error || feedback}</div><div className="shortcut-strip"><span><kbd>←</kbd><kbd>→</kbd> Navigate</span><span><kbd>S</kbd> Select</span><span><kbd>?</kbd> Shortcuts</span></div></div>
        {!scanning && scanResult?.warningCount ? <details className="scan-warning"><summary>Scan found {scanResult.count} items with {scanResult.warningCount} warning{scanResult.warningCount === 1 ? '' : 's'}.</summary><ul>{scanResult.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></details> : null}
      </section>
    </div>
    <section className={`queue-panel ${queueOpen ? '' : 'collapsed'}`} aria-label="Discovered media queue">
      <div className="queue-header"><button className="queue-title" onClick={() => setQueueOpen(open => !open)} aria-expanded={queueOpen}><ChevronDown size={15} className={queueOpen ? '' : 'rotated'}/><span>Queue</span><span className="queue-tag">{scanned ? `${items.length} ITEMS` : 'NOT SCANNED'}</span></button><div className="queue-actions">{batchReport && <button className="batch-summary" onClick={() => setBatchDetailsOpen(true)} aria-label="Open batch move results">{batchReport.pending ? `Moving ${batchReport.total}…` : `${batchReport.results.filter(result => result.status === 'succeeded').length} moved · ${batchReport.results.filter(result => result.status === 'failed' && !result.uncertain).length} failed · ${batchReport.results.filter(result => result.status === 'failed' && result.uncertain).length} uncertain`}<small>Results</small></button>}{selectedDestination && selected.size > 0 && <button className="move-button queue-move-button" onClick={() => void moveToDestination(selectedDestination)} disabled={Boolean(movingId)}>Move {selected.size} to {folderName(selectedDestination.path)}</button>}<button className="select-all-button" onClick={selectAll} disabled={!items.length || Boolean(movingId)}>{selected.size === items.length && items.length ? 'Clear all' : 'Select all'}</button><span className="selection-count"><b>{selected.size}</b> selected</span><span className="divider"/><button className="icon-button small" onClick={() => setQueueOpen(open => !open)} aria-label={queueOpen ? 'Collapse queue' : 'Expand queue'}>{queueOpen ? <ChevronDown size={16}/> : <ChevronDown size={16} className="rotated"/>}</button></div></div>
      {queueOpen && <div className="filmstrip filmstrip-virtual" ref={filmstripRef} onScroll={event => {
        const element = event.currentTarget;
        const start = Math.max(0, Math.floor(element.scrollLeft / 123) - 4);
        const end = Math.min(items.length, Math.ceil((element.scrollLeft + element.clientWidth) / 123) + 4);
        setFilmWindow(previous => previous.start === start && previous.end === end ? previous : { start, end });
      }}><div className="filmstrip-canvas" style={{ width: `${Math.max(1, items.length * 123)}px` }}>{visibleItems.map((queueItem, offset) => { const index = filmWindow.start + offset; return <button key={queueItem.id} className={`film-item ${index === current ? 'current' : ''} ${selected.has(queueItem.id) ? 'is-selected' : ''}`} style={{ left: `${index * 123}px` }} onClick={event => { currentIndexRef.current = index; setCurrent(index); if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelected(queueItem.id); else rangeAnchorRef.current = queueItem.id; }} aria-label={`${queueItem.filename}, ${queueItem.relativePath}, ${queueItem.mediaType}${selected.has(queueItem.id) ? ', selected' : ''}`} aria-current={index === current ? 'true' : undefined} aria-pressed={selected.has(queueItem.id)} title={queueItem.relativePath}><span className="film-thumb real-media-thumb">{queueItem.mediaType === 'video' ? <Film size={19}/> : <ImageIcon size={19}/>}<small>{queueItem.extension}</small>{selected.has(queueItem.id) && <span className="thumb-check"><Check size={12}/></span>}</span><span className="film-name">{queueItem.filename}{(duplicateCounts.get(queueItem.filename.toLocaleLowerCase()) ?? 0) > 1 && <small>{queueItem.relativePath}</small>}</span></button>; })}</div>{scanned && !items.length && <span className="queue-empty-note">No media items</span>}{!scanned && !items.length && <span className="queue-empty-note">Configure a source folder and scan to populate the queue.</span>}</div>}
    </section>
    <footer className="bottom-bar"><span><span className={`status-dot ${scanning || movingId ? '' : 'subdued'}`}/>{movingId ? movingId === 'batch' ? 'Moving batch' : 'Moving file' : scanning ? 'Scanning' : scanned ? `Ready · ${items.length} media items` : loadingFolders ? 'Connecting to local service' : 'Ready · UI connected to local service'}</span><span>Preview locally · Move sends files to the selected destination</span></footer>
    {batchDetailsOpen && batchReport && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setBatchDetailsOpen(false); }}><section className="help-modal batch-results-modal" role="dialog" aria-modal="true" aria-labelledby="batch-results-title"><div className="modal-heading"><div><span className="eyebrow">MOVE SUMMARY · {batchReport.destinationName}</span><h2 id="batch-results-title">{batchReport.pending ? 'Move in progress' : 'Batch move results'}</h2></div><button className="icon-button" onClick={() => setBatchDetailsOpen(false)} aria-label="Close batch results"><X size={18}/></button></div>
      <div className="batch-counts"><span><b>{batchReport.pending ? '—' : batchReport.results.filter(result => result.status === 'succeeded').length}</b> succeeded</span><span><b>{batchReport.results.filter(result => result.status === 'failed' && !result.uncertain).length}</b> failed</span><span><b>{batchReport.results.filter(result => result.status === 'failed' && result.uncertain).length}</b> uncertain</span></div>
      {batchReport.pending && <><p className="batch-detail-note">Processing {batchReport.total} submitted files. Per-file results will appear when the request completes.</p><span className="batch-indeterminate" aria-hidden="true"/><ul className="batch-result-list">{batchReport.submitted.map(item => <li key={item.id}><span><b title={item.relativePath}>{item.originalFilename}</b><small>Processing in this batch</small></span></li>)}</ul></>}
      {batchReport.requestError && <p className="batch-detail-note error-status">{batchReport.requestError}</p>}
      {batchReport.requestUncertain && <p className="batch-detail-note error-status">{batchReport.requestUncertain}</p>}
      {!batchReport.pending && batchReport.results.length > 0 && <ul className="batch-result-list">{batchReport.results.map(result => <li key={result.id} className={result.status === 'failed' ? result.uncertain ? 'uncertain' : 'failed' : 'succeeded'}><span><b title={result.relativePath}>{result.originalFilename}</b>{result.status === 'succeeded' ? <small>→ {result.filename}</small> : <small>{result.message}</small>}</span>{result.status === 'failed' && !result.uncertain && result.code !== 'MOVE_404' && result.code !== 'MOVE_409' && items.some(item => item.id === result.id) && <button className="select-all-button" onClick={() => { const destination = folders.destinations.find(folder => folder.id === batchReport.destinationId); if (destination) void moveToDestination(destination, [result.id]); }} disabled={Boolean(movingId)}>Retry</button>}</li>)}</ul>}
      {(batchReport.requestUncertain || batchReport.results.some(result => result.status === 'failed' && result.uncertain)) && <button className="modal-done batch-recover" onClick={() => void scan()} disabled={scanning}><ScanLine size={14}/>{scanning ? 'Rescanning…' : 'Rescan source to recover'}</button>}
      <button className="modal-done" onClick={() => setBatchDetailsOpen(false)}>Close</button>
    </section></div>}
    {helpOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setHelpOpen(false); }}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-heading"><div><span className="eyebrow">QUICK REFERENCE</span><h2 id="help-title">Keyboard shortcuts</h2></div><button className="icon-button" onClick={() => setHelpOpen(false)} aria-label="Close shortcuts"><X size={18}/></button></div><div className="shortcut-list"><div><span>Navigate · hold to repeat</span><span><kbd>←</kbd><kbd>→</kbd></span></div><div><span>Select current item</span><kbd>S</kbd></div><div><span>Select all / clear all</span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} + A</kbd></div><div><span>Video seek; hold to continue</span><span><kbd>J</kbd><kbd>L</kbd> · 5 sec</span></div><div><span>Video play / pause</span><span><kbd>K</kbd> / <kbd>Space</kbd></span></div><div><span>Move selection or active item</span><span className="destination-shortcuts">{folders.destinations.slice(0, 9).map((destination, index) => <span key={destination.id}>{folderName(destination.path)} <kbd>{index + 1}</kbd></span>)}</span></div><div><span>Toggle queue panel</span><kbd>Q</kbd></div><div><span>Open shortcut help</span><kbd>?</kbd></div><div><span>Close dialog</span><kbd>Esc</kbd></div></div><p className="modal-note"><Keyboard size={14}/> Hold J/L to keep seeking in five-second steps. Hold Shift with an arrow to extend or contract a queue-order range. Range selection replaces the previous selection. If one or more files are selected, Move and destination number keys move the selection. With no selection, they move the active item. Ctrl+A / ⌘A selects or clears the queue; shortcuts are inactive in editable fields or while a dialog is open. Batch moves return per-file results and may partially succeed.</p><button className="modal-done" onClick={() => setHelpOpen(false)}>Done <ChevronRight size={15}/></button></section></div>}
  </main>;
}
