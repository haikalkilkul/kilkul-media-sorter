export type ConfiguredFolder = { id: string; path: string };
export type FolderConfiguration = { source: ConfiguredFolder | null; destinations: ConfiguredFolder[] };
export type MediaItem = {
  id: string;
  filename: string;
  mediaType: 'image' | 'video';
  sizeBytes: number;
  relativePath: string;
  extension: string;
};
export type ScanResult = { sourceId: string; scanId: string; items: MediaItem[]; count: number; warnings: string[]; warningCount: number };
export type MoveResult = { id: string; destinationId: string; filename: string; strategy: 'hard-link' | 'verified-copy' };
export type BatchMoveItemResult =
  | { id: string; status: 'succeeded'; filename: string; strategy: 'hard-link' | 'verified-copy' }
  | { id: string; status: 'failed'; code: string; message: string; uncertain: boolean };
export type BatchMoveResponse = { results: BatchMoveItemResult[] };

export class ApiError extends Error {
  constructor(message: string, readonly uncertain = false, readonly rescanRequired = false) { super(message); }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error : `Local API request failed (${response.status}).`;
    throw new ApiError(message, Boolean(payload && typeof payload === 'object' && 'uncertain' in payload && payload.uncertain === true), Boolean(payload && typeof payload === 'object' && 'rescanRequired' in payload && payload.rescanRequired === true));
  }
  return payload as T;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export const api = {
  getFolders: () => request<FolderConfiguration>('/api/folders'),
  setSource: (path: string) => request<FolderConfiguration>('/api/folders/source', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ path }) }),
  addDestination: (path: string) => request<ConfiguredFolder>('/api/folders/destinations', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ path }) }),
  removeDestination: (id: string) => request<void>(`/api/folders/destinations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  scan: () => request<ScanResult>('/api/scan', { method: 'POST', headers: jsonHeaders, body: '{}' }),
  renameMedia: async (id: string, scanId: string, basename: string) => {
    try { return await request<{ filename: string; unchanged: boolean }>(`/api/media/${encodeURIComponent(id)}/rename`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ scanId, basename }) }); }
    catch (reason) { if (reason instanceof ApiError) throw reason; throw new ApiError('The rename result could not be confirmed. Rescan the source and check the filename before retrying.', true, true); }
  },
  previewUrl: (id: string, scanId: string) => `/api/media/${encodeURIComponent(id)}/preview?scan=${encodeURIComponent(scanId)}`,
  moveMedia: async (id: string, scanId: string, destinationId: string) => {
    try {
      return await request<MoveResult>(`/api/media/${encodeURIComponent(id)}/move`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ scanId, destinationId }),
      });
    } catch (reason) {
      if (reason instanceof ApiError) throw reason;
      throw new ApiError('The move request did not return a confirmed result. Rescan the source and check the destination before retrying.', true);
    }
  },
  moveBatch: async (ids: string[], scanId: string, destinationId: string) => {
    try {
      return await request<BatchMoveResponse>('/api/media/batch-move', {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ids, scanId, destinationId }),
      });
    } catch (reason) {
      if (reason instanceof ApiError) throw reason;
      throw new ApiError('The batch request did not return confirmed per-file results. Rescan the source and check the destination before retrying.', true);
    }
  },
};
