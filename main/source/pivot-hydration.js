// pivot-hydration.js
// Hydrates the Pivot magazine's full content from appcatalog.webosarchive.org into
// /media/internal/.pivot after install, so only a tiny placeholder edition needs to
// ship inside the IPK (main/source/magazine/defaultEdition/{lang}/).
// Must load AFTER build.js (listed last in main/depends.js), since it extends the
// compiled Magazine kind at runtime rather than editing main/build.js by hand --
// see main/source/magazine/app/Magazine.js for the original source it builds on.

(function () {
    "use strict";

    var PIVOT_BASE_URL = "https://appcatalog.webosarchive.org/pivot";
    var PIVOT_CACHE_ROOT = "/media/internal/.pivot";
    var SUPPORTED_LANGS = ["de", "en", "es", "fr", "it"];

    function resolveLang() {
        var lang = (enyo.g11n.currentLocale().toISOString()).substring(0, 2);
        if (SUPPORTED_LANGS.indexOf(lang) === -1) {
            lang = "en";
        }
        return lang;
    }

    // -----------------------------------------------------------------------
    // downloadFile -- wraps the platform's download manager via a raw
    // PalmServiceBridge (same low-level primitive archive-patch.js already
    // uses for the Preware-install call), not Enyo's PalmService kind.
    // Confirmed on-device (2026-08-19): Enyo's PalmService kind only ever
    // delivers the FIRST response of a subscribed call to onSuccess, silently
    // dropping the later push that actually carries completed:true -- the
    // download itself succeeds (visible in /var/log/messages and on disk),
    // but the queue never advances. PalmServiceBridge's onservicecallback
    // fires once per bus message, which is what a progress+completion
    // subscription actually needs.
    //
    // Actual response shapes seen on-device for palm://com.palm.downloadmanager/download:
    //   ack:      {"returnValue":true,"ticket":N,"url":...,"target":...,"subscribed":true}
    //   progress: {"ticket":N,"amountReceived":X,"amountTotal":Y,...}            (no "completed" key)
    //   final:    {"ticket":N,...,"httpStatus":200,"completed":true,"aborted":false,"target":"..."}
    // -----------------------------------------------------------------------
    function downloadFile(sourceUrl, targetDir, targetFilename, onDone) {
        var done = false;
        var bridge = new PalmServiceBridge();
        function finish(ok) {
            if (done) { return; }
            done = true;
            // Drop the reference so nothing keeps this bridge (and its closure)
            // alive after we're done with it -- unclear whether the platform
            // caps concurrent/total PalmServiceBridge handles per app, but this
            // is cheap insurance either way.
            bridge.onservicecallback = null;
            onDone(ok);
        }
        try {
            bridge.onservicecallback = function (msg) {
                var response;
                try { response = JSON.parse(msg); } catch (e) { return; }
                if (!response) { return; }
                if (response.completed) {
                    finish(!response.aborted && (!response.httpStatus || response.httpStatus === 200));
                } else if (response.returnValue === false) {
                    finish(false);
                }
                // else: an ack or progress update -- keep waiting.
            };
            bridge.call("palm://com.palm.downloadmanager/download", JSON.stringify({
                target: sourceUrl,
                targetDir: targetDir,
                targetFilename: targetFilename,
                subscribe: true
            }));
        } catch (e) {
            finish(false);
        }
    }

    // -----------------------------------------------------------------------
    // Wake lock -- confirmed on-device (2026-08-19) that this is genuinely
    // needed, not just theoretical: with no lock held, the download queue
    // repeatedly went completely silent (zero new download requests, download
    // manager CPU usage near zero) for minutes at a stretch whenever the
    // device was left alone, then resumed exactly where it left off once
    // woken/foregrounded again -- consistent with webOS suspending this
    // page's JS execution on system sleep.
    //
    // Two prior attempts via com.palm.power's activityStart/activityEnd left
    // zero trace in powerd's log despite matching reference implementations.
    // A guessed `PalmSystem.setWindowProperties(...)` attempt after that was
    // never even tested against a real proven caller. This is: matches a
    // genuinely working implementation in webos-papyrus-ereader (another app
    // on this same platform that needs the screen to stay on/awake during a
    // long operation -- app/app/Main.js's disableDim/enableDim), which uses
    // `palm://com.palm.display/control/` via a plain PalmService with NO
    // static method and a single-argument `.call({blockScreenTimeout: ...})`
    // -- notably a different service than com.palm.power entirely.
    // -----------------------------------------------------------------------
    enyo.kind({
        name: "enyo.FindApps.Magazine.PivotDimService",
        kind: "PalmService",
        service: "palm://com.palm.display/control/"
    });

    var pivotDimService = new enyo.FindApps.Magazine.PivotDimService();

    function acquireWakeLock() {
        try {
            if (typeof window !== "undefined" && window.PalmSystem) {
                pivotDimService.call({blockScreenTimeout: true});
            } else if (typeof enyo !== "undefined" && enyo.windows && enyo.windows.setWindowProperties) {
                enyo.windows.setWindowProperties(window, {blockScreenTimeout: true});
            }
        } catch (e) {}
    }

    function releaseWakeLock() {
        try {
            if (typeof window !== "undefined" && window.PalmSystem) {
                pivotDimService.call({blockScreenTimeout: false});
            } else if (typeof enyo !== "undefined" && enyo.windows && enyo.windows.setWindowProperties) {
                enyo.windows.setWindowProperties(window, {blockScreenTimeout: false});
            }
        } catch (e) {}
    }

    // -----------------------------------------------------------------------
    // checkAndHydrate -- checks the server's magazine version against whatever
    // is (or isn't -- e.g. the user deleted the folder) cached on disk, and
    // if the server is ahead, downloads the full edition into place. Runs
    // standalone, independent of whether the Magazine tab is ever opened.
    // -----------------------------------------------------------------------
    function checkAndHydrate(lang) {
        if (isHydratingElsewhere()) {
            return;
        }
        readLocalVersion(lang, function (localVersion) {
            fetchJson(PIVOT_BASE_URL + "/" + lang + "/version.json", function (remote) {
                var remoteVersion = (remote && remote.magazineVersion) || 0;
                if (remoteVersion <= localVersion) {
                    return; // already current -- nothing to do
                }
                markHydrating();
                fetchJson(PIVOT_BASE_URL + "/" + lang + "/manifest.device.json", function (devManifest) {
                    if (!devManifest || !devManifest.assets || !devManifest.self) {
                        return;
                    }
                    acquireWakeLock();
                    downloadQueue(lang, devManifest.assets.slice(), devManifest.self, releaseWakeLock);
                });
            });
        });
    }

    // onDone fires exactly once, on every exit path (full completion or an
    // early abort on a failed download), so the wake lock is always released.
    function downloadQueue(lang, remainingAssets, selfEntry, onDone) {
        var targetDir = PIVOT_CACHE_ROOT + "/" + lang;
        if (remainingAssets.length === 0) {
            // All page assets are down -- write the local manifest last, so its
            // presence on disk is itself the "hydration complete" signal.
            downloadFile(selfEntry.sourceUrl, targetDir, selfEntry.targetFilename, function (ok) {
                // best-effort either way -- a failure here just means we retry
                // (and re-download everything) on the next version check.
                onDone();
            });
            return;
        }
        var asset = remainingAssets.shift();
        downloadFile(asset.sourceUrl, targetDir, asset.targetFilename, function (ok) {
            if (!ok) {
                onDone(); // abort the queue; next launch's version check retries from scratch
                return;
            }
            // Paced rather than chained straight through, for two independent reasons
            // both confirmed on-device: (1) rapid-fire calls silently stopped producing
            // responses after a couple dozen in a row, with no error anywhere -- looks
            // like a hidden rate limit or handle cap on PalmServiceBridge/downloadmanager;
            // (2) even below that ceiling, this JS thread is the SAME thread the app's
            // own UI renders on -- back-to-back native bridge calls visibly stalled the
            // app's splash/launch rendering. Nothing is waiting on this to finish quickly,
            // so pace it gently rather than racing the UI for the thread.
            setTimeout(function () {
                downloadQueue(lang, remainingAssets, selfEntry, onDone);
            }, 1000);
        });
    }

    function readLocalVersion(lang, callback) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", PIVOT_CACHE_ROOT + "/" + lang + "/manifest.json", true);
        xhr.onload = function () {
            if (xhr.status !== 200) { callback(0); return; }
            try {
                var manifest = JSON.parse(xhr.responseText);
                callback((manifest && manifest.magazineVersion) || 0);
            } catch (e) {
                callback(0);
            }
        };
        xhr.onerror = function () { callback(0); };
        try { xhr.send(); } catch (e) { callback(0); }
    }

    function fetchJson(url, callback) {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.onload = function () {
            if (xhr.status !== 200) { callback(null); return; }
            try { callback(JSON.parse(xhr.responseText)); } catch (e) { callback(null); }
        };
        xhr.onerror = function () { callback(null); };
        try { xhr.send(); } catch (e) { callback(null); }
    }

    function isHydratingElsewhere() {
        try {
            var raw = localStorage.getItem("com.palm.app.findapps.pivotHydrating");
            if (!raw) { return false; }
            return (Date.now() - parseInt(raw, 10)) < (2 * 60 * 1000);
        } catch (e) {
            return false;
        }
    }
    function markHydrating() {
        try { localStorage.setItem("com.palm.app.findapps.pivotHydrating", "" + Date.now()); } catch (e) {}
    }

    // -----------------------------------------------------------------------
    // Read path: prefer the hydrated cache over the bundled placeholder.
    // Only touches Magazine's fallback tier -- the live/db8 edition attempt in
    // create() is untouched. Full-body override (not saving/calling the
    // original) so the pre-existing usingDefaultEdition re-entrancy guard
    // still behaves exactly as before.
    // -----------------------------------------------------------------------
    var MagazineProto = enyo.FindApps.Magazine.Magazine.prototype;

    MagazineProto.loadDefaultEdition = function () {
        if (this.usingDefaultEdition) {
            return this.unableToInitMagazine();
        }
        this.usingDefaultEdition = true;
        this._pivotLang = resolveLang();
        this._pivotTryHydratedCache(true);
    };

    // Shared by every check site (initial load, background poll, and the
    // tab-return check) so there's exactly one success/failure path to reason
    // about. isInitial controls what happens on failure: the very first check
    // falls back to the bundled placeholder (nothing has rendered yet); every
    // later check just leaves whatever's already on screen alone and waits for
    // the next attempt.
    MagazineProto._pivotTryHydratedCache = function (isInitial) {
        this.$.webService.call(null, {
            url: PIVOT_CACHE_ROOT + "/" + this._pivotLang + "/manifest.json",
            handleAs: "json",
            onSuccess: "_pivotHydratedCacheFound",
            onFailure: isInitial ? "_loadBundledPlaceholderEdition" : "_pivotHydratedCacheStillPending"
        });
    };

    MagazineProto._pivotHydratedCacheFound = function (inSender, inResponse, inRequest) {
        this._pivotShowingPlaceholder = false;
        if (this._pivotRecheckTimer) {
            clearInterval(this._pivotRecheckTimer);
            this._pivotRecheckTimer = null;
        }
        // Rebuilds the file set and re-renders the current page -- when this fires
        // from a background/tab-return recheck rather than the initial load, this is
        // what actually swaps the still-showing placeholder for the real content.
        this.gotDefaultEditionFileSet(inSender, inResponse, inRequest);
    };

    MagazineProto._pivotHydratedCacheStillPending = function () {
        // Not ready yet -- the interval (or the next tab visit) just tries again.
    };

    MagazineProto._loadBundledPlaceholderEdition = function () {
        this.warn(MagazineErrors.getErrorString(MagazineErrors.LOADING_DEFAULT_EDITION));
        this._pivotShowingPlaceholder = true;
        var lang = this._pivotLang;
        this.$.webService.call(null, {
            url: "source/magazine/defaultEdition/" + lang + "/manifest.json",
            handleAs: "json",
            onSuccess: "gotDefaultEditionFileSet",
            onFailure: "unableToInitMagazine"
        });
        // The placeholder just rendered because hydration hadn't finished (or hadn't
        // even started) at the moment this Magazine instance was created. Hydration
        // itself runs independently in the background and has no way to reach back
        // into an already-rendered view to say "done now" -- without this, a user who
        // opens the Magazine tab before hydration finishes and just leaves it open
        // (never switching away and back, which is the other trigger -- see
        // findApps.MagazineView.prototype.reset below) would sit on the placeholder
        // forever, even after the real edition is fully cached on disk. So: poll for
        // it in the background too. Confirmed on-device that hydration can genuinely
        // take 6-7 minutes end to end (not just the ~3-4min happy-path estimate --
        // per-call round-trip latency adds up over ~200 calls), so this is capped
        // generously above that rather than the 5min this first shipped with, which
        // was observed expiring before a real run actually finished.
        this._startPivotRecheck();
    };

    MagazineProto._startPivotRecheck = function () {
        if (this._pivotRecheckTimer) {
            return;
        }
        var self = this;
        var attemptsLeft = 60; // 15min at 15s apart
        this._pivotRecheckTimer = setInterval(function () {
            attemptsLeft -= 1;
            if (attemptsLeft <= 0) {
                clearInterval(self._pivotRecheckTimer);
                self._pivotRecheckTimer = null;
                return;
            }
            self._pivotTryHydratedCache(false);
        }, 15000);
    };

    // -----------------------------------------------------------------------
    // "View Recent Apps" button on the placeholder page: while the real
    // edition hydrates, the placeholder (main/source/magazine/defaultEdition)
    // offers a way out to the rest of the app instead of just sitting there.
    // Wires a new "recentapps" magazine target to the Categories/Browser view,
    // pre-selecting the "New" stored query (RadioGroup index 1 -- see
    // main/source/main/AppCatalog.js, "Top"/"New"; "Paid"/"Free" were trimmed).
    // -----------------------------------------------------------------------
    if (enyo.FindApps && enyo.FindApps.Magazine && enyo.FindApps.Magazine.Magazine) {
        enyo.FindApps.Magazine.Magazine.prototype.magazineDefinedTarget.recentapps = {type: "external"};
    }

    if (typeof findApps !== "undefined" && findApps.AppCatalog && findApps.BrowserView && findApps.MagazineView) {
        findApps.AppCatalog.prototype.showNewest = function () {
            this.$.stored_queries.setValue(1);
            this.storedQuerySelected();
        };
        findApps.BrowserView.prototype.showNewest = function () {
            this.$.browseCategories.showNewest();
        };

        var _origGoToTarget = findApps.MagazineView.prototype.goToTarget;
        findApps.MagazineView.prototype.goToTarget = function (inSender, targetName, params) {
            if (targetName === "recentapps") {
                var browserView = findApps.ViewLibrary.getView("BROWSER");
                browserView.reset();
                browserView.showNewest();
                return;
            }
            return _origGoToTarget.apply(this, arguments);
        };

        // Confirmed on-device: switching to another tab and back does NOT recreate
        // the underlying Magazine component (create()/loadDefaultEdition() only run
        // once, on the view's first construction) -- it just calls reset() on the
        // already-alive instance. Without this, a user who switches away and back
        // after hydration finished kept seeing the placeholder indefinitely; only a
        // full app close+relaunch actually picked up the real content, which is a
        // broken experience. This makes tab-return the primary, instant way hydration
        // gets noticed -- the interval in _startPivotRecheck above is just the backup
        // for someone who leaves the Magazine tab open and never switches away at all.
        var _origMagazineViewReset = findApps.MagazineView.prototype.reset;
        findApps.MagazineView.prototype.reset = function () {
            var result = _origMagazineViewReset.apply(this, arguments);
            var magazine = this.$.magazine;
            if (magazine && magazine._pivotShowingPlaceholder) {
                magazine._pivotTryHydratedCache(false);
            }
            return result;
        };
    }

    // -----------------------------------------------------------------------
    // Write-path: best-effort background hydration on every launch, whether or
    // not the user ever opens the Magazine tab. A no-op once the on-device
    // manifest's magazineVersion is already current with the server.
    //
    // Delayed well past launch (confirmed on-device: starting this at the same
    // 3s mark archive-patch.js uses for its lightweight one-shot update check
    // was too early for a ~200-call download sequence on this single-threaded
    // JS environment -- it visibly stalled the app's own splash/launch
    // rendering, since native bridge calls and UI paint share one thread).
    // 20s gives the app room to fully launch and settle first.
    // -----------------------------------------------------------------------
    setTimeout(function () {
        try {
            checkAndHydrate(resolveLang());
        } catch (e) {}
    }, 20000);
}());
