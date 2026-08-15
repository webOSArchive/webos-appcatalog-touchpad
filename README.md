# webOS App Catalog

The webOS Archive's restoration of the TouchPad App Catalog client (`com.palm.app.enyo-findapps`) — HP's original Enyo source, patched and maintained independently of HP's dead backend.

## Cloning

This repo has a **git submodule** for the built-in magazine content (see below). A plain `git clone` will leave that submodule's folder empty, which breaks the app (the magazine engine reads its content from a symlink into that folder). Clone with submodules included:

```sh
git clone --recurse-submodules git@github.com:webOSArchive/webos-appcatalog-touchpad.git
```

If you already have a plain clone, populate the submodule after the fact:

```sh
git submodule update --init --recursive
```

## Magazine content (Pivot)

The built-in magazine's default/fallback content — branded **Pivot** — lives in its own repo, [webOSArchive/PivotMagazine-WOSA](https://github.com/webOSArchive/PivotMagazine-WOSA), checked in here as a submodule at `main/source/magazine/PivotMagazine-WOSA`. This keeps the (large, binary-heavy) magazine content versioned independently of the app's own JS source.

`main/source/magazine/defaultEdition` is a git-tracked **symlink** to `PivotMagazine-WOSA/Issues/Current` — that's the literal path the magazine engine (`Magazine.js`) fetches from at runtime (`source/magazine/defaultEdition/{lang}/manifest.json`, relative to the app's `index.html`), so the symlink means zero app-code changes were needed to externalize the content.

**Device gotcha:** `/media/cryptofs/apps` — where third-party apps actually live on a webOS device — does **not support symlinks**, even as root (confirmed live: `ln -s` fails there with "Operation not permitted" while the identical command works fine in `/tmp` on the same device). Any on-device deploy or future IPK build must **physically copy** `PivotMagazine-WOSA/Issues/Current/*` into `defaultEdition/` rather than symlink it — e.g. `cp -rL` / `rsync -L` / `tar --dereference` when assembling a package payload. The symlink itself is only for the repo/local-dev-machine story.

## Self-update

The app checks `http://appcatalog.webosarchive.org/appcatalog-touchpad.json` (a static manifest at the domain root, served over plain HTTP so it works on a freshly-Doctored device before Preware/the community OTA are installed) a few seconds after launch, compares `version` against its own `appinfo.json` version, and prompts to install via Preware if the manifest is newer. See `main/source/archive-patch.js`.
