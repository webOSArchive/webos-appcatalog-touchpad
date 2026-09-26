/*
 * archive-install.js -- how App Catalog installs a package, on each system it runs on.
 *
 * HP's catalog installed through com.palm.appInstallService and followed the install through
 * its "status" subscription: the catalog's own progress pill ("Downloading", "Installing",
 * "Open"). That service still exists on webOS, but checks every package against HP's signing
 * servers, gone since 2015, so every install ends "install failed", FAILED_VERIFY.
 *
 *   Lunacy  -- its com.palm.appInstallService installs packages as Preware did (running their
 *              scripts), so the catalog uses its own install path as HP wrote it.
 *   webOS   -- the catalog installs a package itself: the download manager fetches it, and
 *              com.palm.appinstaller/installNoVerify (open to a com.palm.* app) installs it,
 *              reporting to the same progress pill as the appInstallService would have. The
 *              stock installer runs no install scripts, so a package that has any
 *              (IpkInspect) is handed to the .ipk handler instead - Preware, Preware 2.
 *              The catalog never registers as an .ipk handler itself.
 *   other   -- LuneOS, or anywhere the above aren't there: the .ipk handler.
 *
 * The .ipk handler: whichever apps the system lists for application/vnd.webos.ipk, the active
 * one first, then the original Preware by id; each is opened with {type: "install", file,
 * target} until one opens. From a patch by a Preware 2 developer, with its LuneOS route.
 *
 * Loaded after archive-patch.js; replaces its Preware-only install.
 */
(function () {
    "use strict";

    var IPK_MIME = "application/vnd.webos.ipk";
    var FALLBACK_IPK_HANDLER = "org.webosinternals.preware";
    // Legacy webOS user agents say "webOS/1.x-2.x" or "hpwOS/3.x"; LuneOS doesn't.
    var IS_LEGACY_WEBOS = /hpwOS\/|webOS\/[1-3]\./.test(navigator.userAgent);

    // ---- the bus ----

    // An unreferenced PalmServiceBridge can be collected before it answers.
    var pending = [];

    function lunaCall(url, params, callback, keepOpen) {
        var bridge = new PalmServiceBridge();
        pending.push(bridge);
        function done() {
            var i = pending.indexOf(bridge);
            if (i >= 0) { pending.splice(i, 1); }
        }
        bridge.onservicecallback = function (msg) {
            if (!keepOpen) { done(); }
            var response;
            try { response = JSON.parse(msg); } catch (e) { response = {returnValue: false, errorText: String(msg)}; }
            callback(response, function () { done(); try { bridge.cancel(); } catch (e) {} });
        };
        bridge.call(url, JSON.stringify(params || {}));
        return bridge;
    }

    // ---- where are we? ----

    // "lunacy", "webos" or "other"; decided at load, long before anyone taps Install.
    var platform = IS_LEGACY_WEBOS ? "webos" : "other";
    if (window.PalmServiceBridge) {
        lunaCall("palm://com.palm.bus/signal/registerServerStatus", {serviceName: "org.webosarchive.lunacy"}, function (r) {
            if (r && r.connected) { platform = "lunacy"; }
            console.log("ARCHIVE-INSTALL platform: " + platform);
        });
    } else {
        platform = "other";
    }

    // ---- the .ipk handler ----

    function launchApp(id, params, callback) {
        if (IS_LEGACY_WEBOS) {
            lunaCall("palm://com.palm.applicationManager/open", {id: id, params: params}, callback);
        } else {
            // LuneOS: LunaAppManager passes launches on to SAM and then answers '"<id>" was
            // not found' even for an app it launched, so ask SAM itself.
            lunaCall("luna://com.webos.service.applicationmanager/launch", {id: id, params: params}, callback);
        }
    }

    // callback(appIds): the active handler, the alternates, then the original Preware.
    function ipkHandlerCandidates(callback) {
        lunaCall("palm://com.palm.applicationManager/listAllHandlersForMime", {mime: IPK_MIME}, function (r) {
            var ids = [], h = r && r.returnValue && r.resourceHandlers, i;
            function add(id) { if (id && ids.indexOf(id) < 0) { ids.push(id); } }
            if (h) {
                add(h.activeHandler && h.activeHandler.appId);
                for (i = 0; h.alternates && i < h.alternates.length; i++) { add(h.alternates[i].appId); }
            }
            add(FALLBACK_IPK_HANDLER);
            callback(ids);
        });
    }

    // Opens the package in the first handler that launches. onSuccess(appId), onFailure(lastResponse).
    // A handler removed since it registered fails to launch, and the next is tried.
    function openIpkWithHandler(ipkUrl, onSuccess, onFailure) {
        ipkHandlerCandidates(function (ids) {
            var n = 0;
            function next(last) {
                if (n >= ids.length) { onFailure(last); return; }
                var id = ids[n++];
                launchApp(id, {type: "install", file: ipkUrl, target: ipkUrl}, function (r) {
                    if (r && r.returnValue) {
                        console.log("ARCHIVE-INSTALL package handed to " + id);
                        onSuccess(id);
                    } else {
                        console.log("ARCHIVE-INSTALL handler " + id + " not available: " + JSON.stringify(r));
                        next(r);
                    }
                });
            }
            next({returnValue: false, errorText: "No application for .ipk files"});
        });
    }

    // The install handed to a handler app: the button resets when the catalog comes back
    // to the front (the handler's card closing), or reports failure if none would open.
    function installWithHandler(app, ipkUrl) {
        openIpkWithHandler(ipkUrl, function (handlerId) {
            console.log("ARCHIVE-INSTALL " + handlerId + " opened; waiting for onWindowActivated");
            window._archivePatchOnActivated = function () {
                var numId = app._archiveNumericId ||
                            (/^\d+$/.test(String(app.id || "")) ? String(app.id) : null);
                var palmId = app.publicApplicationId;
                // _myApps is keyed by the numeric catalog id; see archive-patch.js.
                if (numId && palmId !== numId) { app.publicApplicationId = numId; }
                app.setState("findApps.AppState.Download");
            };
        }, function (r) {
            console.log("ARCHIVE-INSTALL no .ipk handler could be opened: " + JSON.stringify(r));
            app.errorCode = "PREWARE_NOT_FOUND";
            app.setState("findApps.AppState.InstallFailed");
        });
    }

    // ---- the parameters HP's service takes ----

    // The appInstallService refuses an install with any empty string among its parameters
    // ("Bad parameter", measured on the TouchPad), so empty and missing ones are left out.
    function installParams(app) {
        // The catalog's session is archive-patch.js's DummyConfig; the service wants its token.
        var dummy = (AppCatalog.Config && AppCatalog.Config.DummyConfig) || {};
        var p = {
            catalogId: app._archiveNumericId || app.id,
            id: app.publicApplicationId,
            title: app.title,
            version: app.serverVersion,
            vendor: app.vendor,
            vendorUrl: app.vendorUrl,
            iconUrl: app.iconUrl || app.icon,
            ipkUrl: app.packageUrl,
            authToken: findApps.UserSession._token || dummy._token,
            deviceId: findApps.UserSession._deviceId || dummy._deviceId,
            email: findApps.UserSession._email || dummy._email,
            noApp: app.appType === "app" ? false : true,
            services: app.services,
            accounts: app.accounts,
            dockMode: app.dockMode,
            universalSearch: app.universalSearch,
            loc_name: app.title,
            transactionId: "" + new Date().getTime()
        };
        for (var k in p) {
            if (p.hasOwnProperty(k) && (p[k] === undefined || p[k] === null || p[k] === "")) { delete p[k]; }
        }
        if (typeof p.catalogId === "number") { p.catalogId = String(p.catalogId); }
        return p;
    }

    // ---- webOS: the catalog installs it itself ----

    // Reports to the catalog as appInstallService's status subscription would:
    // {id, details: {…, state, progress}}, through the download manager's own callback.
    function reporter(adm, params) {
        var details = {};
        for (var k in params) { if (params.hasOwnProperty(k)) { details[k] = params[k]; } }
        details.icon = params.iconUrl;
        return function (state, progress, extra) {
            details.state = state;
            details.progress = progress;
            if (extra) { for (var e in extra) { if (extra.hasOwnProperty(e)) { details[e] = extra[e]; } } }
            var copy = {};
            for (var c in details) { if (details.hasOwnProperty(c)) { copy[c] = details[c]; } }
            adm._appInstallServiceStatusCB(null, {id: params.id, details: copy});
        };
    }

    function installDirectly(adm, app) {
        var params = installParams(app);
        DirectInstall.run(params, reporter(adm, params), function (scripts) {
            // Only Preware's root helper runs install scripts.
            console.log("ARCHIVE-INSTALL " + params.id + " has install scripts (" + scripts + "): handing it to the .ipk handler");
            installWithHandler(app, params.ipkUrl);
        });
    }

    // ---- the catalog's install ----

    // Every caller installs through AppInstallService.install: DownloadStateManager._install
    // (the normal Get flow) and AppState.InstallFailed's retry.
    findApps.AppInstallService.prototype.install = function (app, successCb, failureCb) {
        var ipkUrl = app.packageUrl;
        console.log("ARCHIVE-INSTALL install " + app.publicApplicationId + " on " + platform + ": " + ipkUrl);
        if (!ipkUrl) { return; }
        if (platform === "lunacy") {
            this.subscribe = false;
            this.call(installParams(app), {method: "install", onSuccess: successCb, onFailure: failureCb});
        } else if (platform === "webos") {
            installDirectly(this.owner, app);
        } else {
            installWithHandler(app, ipkUrl);
        }
    };

    // A list row is found by its app's id to redraw it as an install moves. The row was
    // listed under the catalog's numeric id ("130"), and fetching the app's details turns the
    // same AppDownload's id into the package's ("com.example.app") before the install starts,
    // so the row was never found and stayed at "Downloading..." after the app had installed.
    // The row keeps that AppDownload, so it is matched by it as well.
    var _origSerialSearch = findApps.AppList.prototype.serialSearch;
    findApps.AppList.prototype.serialSearch = function (arr, appPublicApplicationId) {
        var i = _origSerialSearch.call(this, arr, appPublicApplicationId);
        if (i >= 0 || !arr) { return i; }
        for (i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i]._appDownload && arr[i]._appDownload.publicApplicationId === appPublicApplicationId) { return i; }
        }
        return -1;
    };

    // For the catalog's own self-update prompt (archive-patch.js).
    window.archiveInstallWithHandler = function (ipkUrl) {
        openIpkWithHandler(ipkUrl, function (id) {
            console.log("ARCHIVE-INSTALL update handed to " + id);
        }, function (r) {
            console.log("ARCHIVE-INSTALL update: no .ipk handler could be opened: " + JSON.stringify(r));
        });
    };
    window.archiveInstallPlatform = function () { return platform; };
}());
