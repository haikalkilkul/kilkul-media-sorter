# kilkul-media-sorter

A local-first desktop media organizer with explicit folder configuration, recursive discovery, real image previews, native browser video playback and safe single or batch moves into configured destinations.

## Prerequisites and startup

- Node.js 22 LTS (Node 20.19+ supports the selected Vite release)
- npm 10+
- Google Chrome or another modern browser

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The Vite server proxies `/api` requests to Fastify on `127.0.0.1:3001`. Health check: `curl http://127.0.0.1:3001/api/health` returns `{"status":"ok"}`.

Enter an absolute source folder path in the top bar and choose **Set source**. Enter destination paths in the sidebar. Paths must exist and be accessible; source folders need read access and destination folders need read and write access. Scan the source to find supported media recursively. Folder configuration lives in server memory and must be entered again after restarting the backend.

The browser File System Access API does not provide a dependable absolute path that this Node service can scan across both Windows and macOS. This milestone therefore uses explicit absolute path inputs, which work on both operating systems and avoid a native-picker dependency.

## Interactions

- Left/right arrows navigate discovered files without wrapping; hold an arrow to repeat after a 300 ms delay at 100 ms intervals. `Shift` + Left/Right extends or contracts a contiguous queue-order selection.
- `J` and `L` seek the current video backward/forward by five seconds; hold either key to continue seeking. `K` or Space toggles video playback when focus is outside the native player. Left/right keep navigating queue items.
- `Ctrl+A` (or `⌘+A` on macOS) selects or clears all discovered items. The filmstrip also supports Shift/Ctrl/Command-click multi-selection.
- `Q` toggles the queue panel. `?` opens shortcut help; Escape closes it.
- `F2` or the visible **Rename** action renames the active media file in its current folder. Enter only the name before the extension; the existing extension is shown separately and retained automatically. If another item is selected, clear the selection or select only the active item first.
- `1`–`9` move selected items into the matching configured destination, or the active item when nothing is selected. The visible **Move** action follows the same selection rule. If a destination name already exists, a numbered suffix is added; existing files are never overwritten.
- The sun/moon control switches themes. Dark is the default and the preference persists in local storage.
- The filmstrip virtualizes its rendered entries while retaining horizontal navigation for large queues.

Batch move counts stay in the queue header, which does not change the filmstrip height. Open **Results** to inspect per-file outcomes, retry known failures, or rescan after uncertain results. The result dialog uses a bounded list; the queue and preview retain their workspace space.

Keyboard shortcuts are ignored in editable fields. Native video controls provide play/pause, timeline seeking, volume/mute and fullscreen. The central preview shows the actual source-relative path beneath each filename and its media type and size. Paths are displayed with `/` separators; long paths truncate with the full path in a tooltip.

Keyboard range selection keeps its anchor fixed while Shift is held and replaces the prior selection with the inclusive anchor-to-active range. Releasing Shift ends range extension; a plain arrow move clears the range anchor. If a queue update removes the anchor item, the anchor rebases to the active item when available.

## API

- `GET /api/health` — local service health.
- `GET /api/folders` — configured source and destinations, including opaque IDs and their user-configured paths.
- `PUT /api/folders/source` — validate and configure one source folder; clears the prior scan context.
- `POST /api/folders/destinations` — validate and add a destination.
- `DELETE /api/folders/destinations/:id` — remove a destination by configured ID.
- `POST /api/scan` — recursively scan the configured source. The request body must be `{}`; source paths are never accepted in scan requests.
- `GET`/`HEAD /api/media/:id/preview?scan=<scanId>` — stream a currently registered media item by opaque ID and current scan revision. It does not accept filesystem paths; video and image responses support byte ranges.
- `POST /api/media/:id/move` — move one current-scan media ID to one configured destination ID. The body is `{ "scanId": "…", "destinationId": "…" }`; paths are never accepted.
- `PATCH /api/media/:id/rename` — rename a current-scan media ID in its existing folder. The body is `{ "scanId": "…", "basename": "…" }`; the server retains the existing extension and does not accept filesystem paths. A response marked `rescanRequired` means the current queue IDs are no longer safe to use until a fresh scan succeeds.
- `POST /api/media/batch-move` — move 1–100 current-scan IDs to one configured destination. The body is `{ "ids": ["…"], "scanId": "…", "destinationId": "…" }`; paths are never accepted. The response contains one ordered result for each submitted ID. A successful result includes its destination filename and move strategy; a failure includes a safe code, message and `uncertain` flag. Malformed, duplicate, unknown and oversized requests are rejected before any item moves. Known per-file failures do not stop the remaining items.

Supported extensions (case-insensitive): images `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.tif`, `.tiff`, `.avif`, `.heic`; video `.mp4`, `.mov`, `.m4v`, `.avi`, `.mkv`, `.webm`, `.wmv`, `.mpeg`, `.mpg`, `.3gp`, `.mts`, `.m2ts`.

Results sort by relative path and include an opaque per-source ID, filename, media type, byte size, relative path and extension. Duplicate basenames remain distinct. Discovery does not read media contents. Inaccessible nested folders and files that disappear during scanning are skipped with warnings; no supported files is a valid empty result.

The image allowlist is served with image MIME types; browser decoding still depends on Chrome's support for that format. Video extensions do not guarantee that the embedded audio/video codecs can play. Chrome support depends on both container and codec, the Chrome build and OS/hardware decoders. In particular, H.264/AAC availability differs between branded Chrome and Chromium builds, while HEVC playback requires compatible Chrome/platform support. Containers such as AVI and Matroska can hold codecs Chrome cannot decode. The app reports a decode/source error without changing the file. See [Chromium's codec and container support notes](https://www.chromium.org/audio-video/).

Video uses Chrome's native `<video controls>` UI. The preview endpoint implements single byte ranges (`206 Partial Content`, suffix and open-ended ranges), ordinary full-file `GET`, and `HEAD`. It streams from a file handle; it does not buffer full media files in memory. A scan revision is required on preview URLs so requests from prior scans are rejected after the queue refreshes.

## Security and limitations

Fastify binds only to `127.0.0.1`, checks the expected Host and Vite Origin, does not enable CORS or trust proxy headers, validates request schemas, and keeps configured roots in server memory. Folder paths are canonicalized and checked for existence, accessibility, directory type and source/destination overlap. The scan endpoint takes no client-supplied path; it uses only the configured source. Preview IDs resolve only through the latest server-held discovery index, then the path is checked against the configured root and file identity before opening. Symbolic links are skipped during discovery and rejected during preview validation. Media responses use `nosniff`, safe error messages and no absolute path headers.

The app has no authentication layer; loopback binding and browser-origin checks are the current local-service boundary. Configuration resets when the server exits. A single scan returns the complete metadata queue. Rename requests resolve only through the current server-side media index, keep the file in its existing directory, retain its extension, reject reserved or invalid basenames, and use exclusive no-overwrite link commits. Case-only changes use a temporary same-directory link and attempt a no-overwrite rollback if the final name cannot be committed. A failed rename that touched filesystem links invalidates the server scan; refresh the queue before further media actions. A process or system failure during the brief case-only transition can leave a `.kilkul-rename-*.tmp` link, so inspect the source folder if the operation outcome cannot be confirmed. Moves flatten files into the selected destination root and preserve the original filename where available. A numbered suffix resolves name collisions. Same-volume moves use an atomic no-overwrite hard-link commit before removing the source. Cross-volume moves copy into a temporary file, flush and verify size and SHA-256, commit without overwriting, then remove the source. Batch moves are independent operations, not an all-or-nothing transaction: the server runs at most three file moves concurrently and continues after a known per-file failure. The UI removes only confirmed successes, retains failed selections for review, and allows retry for known failures whose items remain in the queue. An uncertain result is never automatically retried; rescan the source and inspect the destination first. If a client disconnects before receiving the response, some files may already have moved; use a fresh scan to reconcile the queue. If source removal fails after destination commit, the API marks the result uncertain so the UI can ask for a rescan. Portable path-based symlink checks cannot fully prevent a local process from racing a filesystem entry during a scan/open/move; avoid scanning folders actively modified by untrusted local processes. Thumbnail generation is not implemented.

## Development checks

```sh
npm run typecheck
npm test
npm run build
```
