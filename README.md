# webOS App Catalog

The webOS Archive's restoration of the TouchPad App Catalog client (`com.palm.app.enyo-findapps`) — HP's original Enyo source, patched and maintained independently of HP's dead backend.

## Magazine content (Pivot)

The magazine feature — branded **Pivot** — ships a tiny placeholder edition baked directly into this repo at `main/source/magazine/defaultEdition/{lang}/` (a single "Fetching your first issue of Pivot..." page, a few KB, no submodule involved). The real ~14MB/300-file edition is too large to preload onto a system image, so it's hydrated from `https://appcatalog.webosarchive.org/pivot/{lang}/` after install instead, cached on-device at `/media/internal/.pivot`.

`main/source/pivot-hydration.js` (loaded after `build.js`, alongside `archive-patch.js`) does the work in two independent halves:
- **Write path:** ~3s after every launch, best-effort checks the server's `version.json` against whatever `magazineVersion` is (or isn't — e.g. the folder was deleted) cached on disk, and if the server is ahead, downloads the full edition into `/media/internal/.pivot/{lang}/` via `palm://com.palm.downloadmanager/download`, finishing with the manifest itself — its presence on disk doubles as the completion marker.
- **Read path:** the magazine engine's existing default-edition fallback now tries the hydrated cache first, and only falls back to the bundled placeholder if it's missing or stale-format.

The magazine **engine** (`Magazine`, `MagazinePage`, `BindableLayout`, etc., under `main/source/magazine/app/` and `main/source/magazine/services/`) needed zero changes for any of this — every file reference resolves through a `physicalPath` string taken verbatim from whichever manifest was loaded, with no path-joining logic anywhere, so pointing it at `/media/internal/.pivot/...` instead of `source/magazine/defaultEdition/...` is purely a manifest-URL choice.

Full editions are authored independently in [webOSArchive/PivotMagazine-WOSA](https://github.com/webOSArchive/PivotMagazine-WOSA) (no longer a submodule of this repo) and published as static files to `catalog-service`'s `pivot/{lang}/` via `PivotMagazine-WOSA/Tools/gen-device-manifest.py`.

## Self-update

The app checks `http://appcatalog.webosarchive.org/appcatalog-touchpad.json` (a static manifest at the domain root, served over plain HTTP so it works on a freshly-Doctored device before Preware/the community OTA are installed) a few seconds after launch, compares `version` against its own `appinfo.json` version, and prompts to install via Preware if the manifest is newer. See `main/source/archive-patch.js`.
