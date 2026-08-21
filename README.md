# webOS App Catalog

The webOS Archive's restoration of the TouchPad App Catalog client (`com.palm.app.enyo-findapps`) — HP's original Enyo source, patched and maintained independently of HP's dead backend.

## Magazine content (Pivot)

The magazine feature — branded **Pivot** — ships a tiny placeholder edition baked directly into this repo at `main/source/magazine/defaultEdition/{lang}/` (a single page: spinner + progress bar + "Fetching your first issue of Pivot..." + a "View Recent Apps" escape hatch, a few KB, no submodule involved). The real edition (currently ~4MB/88 files for `en`; other locales are placeholder-only for now) is too large to preload onto a system image, so it's hydrated from `https://appcatalog.webosarchive.org/pivot/{lang}/` after install instead, cached on-device at `/media/internal/.pivot`.

`main/source/pivot-hydration.js` (loaded after `build.js`, alongside `archive-patch.js`) does the work in two independent halves:
- **Write path:** 20s after every launch (tuned empirically — starting this earlier visibly stalled the app's own splash/launch rendering, since native download-manager bridge calls and UI paint share one JS thread), best-effort checks the server's `version.json` against whatever `magazineVersion` is (or isn't — e.g. the folder was deleted) cached on disk, and if the server is ahead, downloads the full edition into `/media/internal/.pivot/{lang}/` via `palm://com.palm.downloadmanager/download`, one file per second, finishing with the manifest itself — its presence on disk doubles as the completion marker. Progress is reported into the placeholder's `enyo.ProgressBar` via direct DOM writes (not Enyo's component API — see the comment on `updateProgress()`), blending byte-weighted and file-count-weighted progress so the bar doesn't sit near 0% through the ~40 tiny JSON files that precede the edition's few large images.
- **Read path:** the magazine engine's existing default-edition fallback now tries the hydrated cache first, and only falls back to the bundled placeholder if it's missing or stale-format. A 15s recheck loop (and an immediate check on tab-return) picks up hydration finishing while the placeholder is already on screen, so the magazine swaps over live without needing an app restart.

Two things in `pivot-hydration.js` look removable but aren't:
- The `?_=Date.now()` cache-busting suffix on the hydrated-cache manifest fetch. Without it, WebKit's XHR cache can keep serving the *first* (necessarily-failed, since hydration hasn't run yet) response to every later poll of the same URL, even long after the real file exists on disk — the magazine then never recovers without a full app restart.
- `markHydrating()`'s heartbeat call after every file (not just once at the start). A one-shot lock stays "fresh" for its whole window regardless of whether the app is still running, so killing the app mid-download used to leave the next launch seeing a stale-but-unexpired lock and silently skipping hydration entirely, with no retry until a *third* launch.

The magazine **engine** (`Magazine`, `MagazinePage`, `BindableLayout`, etc., under `main/source/magazine/app/` and `main/source/magazine/services/`) needed zero changes for any of this — every file reference resolves through a `physicalPath` string taken verbatim from whichever manifest was loaded, with no path-joining logic anywhere, so pointing it at `/media/internal/.pivot/...` instead of `source/magazine/defaultEdition/...` is purely a manifest-URL choice.

Full editions are authored independently in [webOSArchive/PivotMagazine-WOSA](https://github.com/webOSArchive/PivotMagazine-WOSA) (no longer a submodule of this repo, sibling directory to this one) and published as static files to `catalog-service`'s `pivot/{lang}/` via `PivotMagazine-WOSA/Tools/gen-device-manifest.py` — see that repo's `CLAUDE.md` for the full publish workflow, including a couple of non-obvious gotchas (the generator never deletes stale files, and `--version` must be bumped every time or devices silently never see the update).

## Self-update

The app checks `http://appcatalog.webosarchive.org/appcatalog-touchpad.json` (a static manifest at the domain root, served over plain HTTP so it works on a freshly-Doctored device before Preware/the community OTA are installed) a few seconds after launch, compares `version` against its own `appinfo.json` version, and prompts to install via Preware if the manifest is newer. See `main/source/archive-patch.js`.
