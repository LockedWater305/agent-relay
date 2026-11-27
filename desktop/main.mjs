/**
 * BeeZilla desktop — Electron main process.
 *
 * There is NO second server here. The window is a view over the same local
 * runtime the CLI drives; the shell's only jobs are: start it, point a window at
 * it, put the per-launch token on every request, and shut it down cleanly.
 *
 * Auth is injected at the NETWORK layer (`onBeforeSendHeaders`), not in a
 * preload script. A preload runs in an isolated world with contextIsolation on,
 * so patching `window.fetch` there does not touch the page's fetch — a trap that
 * produces a window where every API call 401s while the preload "looks right".
 */
import { app, BrowserWindow, Menu, session, shell, dialog, safeStorage, ipcMain, systemPreferences } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RuntimeSupervisor } from "./supervisor.mjs";
import { ROOT, runtimeLib } from "./paths.mjs";
import { installLogging, logLine, logPaths } from "./logger.mjs";
import { connectAccount, cloudBaseUrl, managedAccountConnectCapability } from "./connect.mjs";
import { createDesktopCsp, loadCspManifest } from "./csp.mjs";
import { createLibraryTransition } from "./library-vault.mjs";
import { createDocumentTransition } from "./document-transition.mjs";
import { createOriginalDownloadRefusal } from "./original-download.mjs";
import {
  allowAudioPermission, connectBaseUrl, createRuntimeAuth, isAppDownload, isAppPage,
  isConnectNavigation, isTrustedSender, retargetAppPage, runtimeOrigin, safeExternalUrl, sameOrigin, webUrl,
} from "./security.mjs";

// FIRST, before anything that can throw. 0.2.0 died at module-link time and left
// no trace anywhere; every launch now writes a session block to
// %APPDATA%\BeeZilla\logs\main.log (BZ_LOG_DIR overrides), tees console output into
// it, and turns an uncaught exception into a readable dialog naming that file.
installLogging({
  version: app.getVersion(),
  onFatal: (kind, err) => {
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    const { file, dir } = logPaths();
    try {
      dialog.showErrorBox(
        `BeeZilla — ${kind}`,
        `${detail}\n\nLog file:\n${file ?? dir ?? "(logging unavailable)"}\n\n` +
          `Review this log before sharing it with support.`,
      );
    } finally {
      app.exit(1);
    }
  },
});

const supervisor = new RuntimeSupervisor({
  root: ROOT,
  onLog: (line) => console.log(line),
});

/**
 * The runtime is local: caching its HTML/JS buys nothing and guarantees a stale
 * UI after an app update (Electron's disk cache outlives the process). This was
 * found by a test that kept seeing the previous build's copy while the file on
 * disk was current.
 */
app.commandLine.appendSwitch("disable-http-cache");

// Silence is the worst failure mode in a packaged app. The logger installs the
// process handlers (uncaught exception → dialog naming the log file); here we
// only add the exit breadcrumb, so "it closed itself" is answerable from disk.
process.on("exit", (code) => console.log(`[desktop] exiting code=${code}`));

let mainWindow = null;
let mainReopenPage = null;
let settingsWindow = null;
let runtimeBase = null;
const trustedContents = () => [mainWindow, settingsWindow]
  .filter((win) => win && !win.isDestroyed()).map((win) => win.webContents);
// Only the exact bundled test page, only in an unpackaged test launch. A
// BZ_PROBE_URL is never authority to give an arbitrary page privileged IPC.
const testPageUrl = !app.isPackaged && process.env.BZ_SETTINGS_TEST
  ? pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "test-settings.html")).href
  : null;
const runtimeAuth = createRuntimeAuth({ getContents: trustedContents, testPageUrl });
const acquireLibraryHistory = createLibraryTransition({
  getContents: trustedContents, getBase: () => runtimeBase,
  getRuntime: () => supervisor.runtime, testPageUrl,
});
const pendingRuntimeRetargets = new Map();
const acquireLibraryTransition = createDocumentTransition({
  getContents: trustedContents, getBase: () => runtimeBase,
  getRuntime: () => supervisor.runtime, acquireLibrary: acquireLibraryHistory,
  onIdle: flushRuntimeRetargets, testPageUrl,
});
let runtimeBinding = null;
let runtimeBindingGeneration = 0;
const originalDownloadRefusal = createOriginalDownloadRefusal({
  getBinding: () => currentRuntimeBinding(supervisor.runtime), getContents: trustedContents,
  isTrustedSender, webUrl,
  notify: (wc, data) => wc.send("beezilla:original-download:refused", data),
});
let settingsPreviousBinding = null;
let settingsHistoryTransition = null;
let quitting = false;

function guardLibraryWindowClose(win) {
  const contents = win.webContents;
  let allowed = false, pending = false;
  win.on("close", (event) => {
    if (allowed) return;
    event.preventDefault();
    if (quitting || pending) return;
    pending = true;
    void (async () => {
      let transition, closed = false, rendererGone = false;
      try {
        transition = await acquireLibraryTransition();
        if (win.isDestroyed() || contents.isDestroyed()) return;
        const closingMain = win === mainWindow;
        const savedPage = closingMain ? transition.targets.find((item) => item.wc === contents) : null;
        // close() can be prevented by the renderer. Do not skip its lease
        // cleanup merely because close() returned or override unload security.
        closed = await new Promise((resolve) => {
          const cleanup = () => {
            win.removeListener("closed", didClose);
            contents.removeListener("will-prevent-unload", didPrevent);
            contents.removeListener("render-process-gone", didLoseRenderer);
          };
          const didClose = () => {
            // Remember only the verified local document from a completed close,
            // not a cancelled close, a request in flight, or another window.
            if (closingMain) {
              mainReopenPage = savedPage && isAppPage(savedPage.url, savedPage.base)
                ? { url: savedPage.url, base: savedPage.base } : null;
            }
            cleanup();
            resolve(true);
          };
          const didPrevent = () => { cleanup(); allowed = false; resolve(false); };
          const didLoseRenderer = () => {
            // A crashed renderer may never finish the unload handshake. End
            // this attempt without forcing the host window to close.
            rendererGone = true;
            didPrevent();
          };
          win.once("closed", didClose);
          contents.once("will-prevent-unload", didPrevent);
          contents.once("render-process-gone", didLoseRenderer);
          allowed = true;
          try { win.close(); } catch (error) { cleanup(); allowed = false; throw error; }
        });
      } catch (error) {
        allowed = false;
        if (!win.isDestroyed() && !contents.isDestroyed()) {
          dialog.showErrorBox("Changes still need to be saved", `${error.message}\n\nBeeZilla stayed open. Retry after Sketch and Library saves are available; do not force-quit to apply this change.`);
        }
      } finally {
        if (transition) await transition.release({ skip: closed || rendererGone ? [contents] : [] });
        pending = false;
      }
    })();
  });
}

function clearRuntimeAuth() {
  originalDownloadRefusal.clear();
  runtimeAuth.clear();
  runtimeBinding = null;
  runtimeBindingGeneration++;
}

function currentRuntimeBinding(rt) {
  const proof = runtimeBinding;
  return proof && proof.rt === rt && proof.base === runtimeBase && proof.generation === runtimeBindingGeneration &&
    proof.host === rt?.host && proof.port === rt?.port && proof.token === rt?.token ? proof : null;
}

function flushRuntimeRetargets() {
  if (acquireLibraryTransition.held()) return;
  for (const [wc, target] of pendingRuntimeRetargets) {
    if (wc.isDestroyed() || !trustedContents().includes(wc)) { pendingRuntimeRetargets.delete(wc); continue; }
    if (!currentRuntimeBinding(target.rt) || target.base !== runtimeBase) continue;
    // Keep this intent until an actual successful destination document commit.
    // Preload may defer replace(), and a queued transition may cancel it.
    try { wc.send("beezilla:runtime:changed", { url: target.url }); }
    catch (error) { console.warn("[desktop] restart navigation unavailable:", error.message); }
  }
}

function bindRuntime(rt, notifyWindows = false) {
  originalDownloadRefusal.clear();
  const previousBase = runtimeBase;
  const targets = trustedContents().map((wc) => ({ wc, url: wc.getURL() }));
  runtimeBase = runtimeAuth.bind(rt);
  // This proof is created only AFTER the underlying binding accepts authority.
  // It never leaves main; every clear invalidates it and advances generation.
  runtimeBinding = Object.freeze({ rt, base: runtimeBase, host: rt.host, port: rt.port, token: rt.token, generation: ++runtimeBindingGeneration });
  if (notifyWindows && previousBase && (previousBase !== runtimeBase || pendingRuntimeRetargets.size)) {
    for (const { wc, url } of targets) {
      if (wc.isDestroyed() || (testPageUrl && url === testPageUrl)) continue;
      const fallback = wc === settingsWindow?.webContents ? "/buzzy/settings" : "/buzzy/talk";
      const earlier = pendingRuntimeRetargets.get(wc);
      if (previousBase === runtimeBase && !earlier) continue;
      const ownedUrl = earlier?.base === previousBase ? earlier.url : url;
      pendingRuntimeRetargets.set(wc, { rt, base: runtimeBase, url: retargetAppPage(ownedUrl, previousBase, runtimeBase, fallback) });
    }
  }
  flushRuntimeRetargets();
  return runtimeBase;
}

function openSafeExternal(url) {
  const safe = safeExternalUrl(url);
  if (!safe || sameOrigin(safe, runtimeBase)) return;
  void shell.openExternal(safe).catch((err) => console.warn("[desktop] external link failed:", err.message));
}

function handleAppLink(wc, url) {
  if (acquireLibraryTransition.held()) return;
  if (!isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, { base: runtimeBase, contents: trustedContents(), testPageUrl })) return;
  if (isAppPage(url, runtimeBase)) {
    void wc.loadURL(url).catch((err) => console.warn("[desktop] navigation failed:", err.message));
  } else if (isAppDownload(url, runtimeBase)) {
    // Native downloads remain available, but imported HTML never becomes the
    // privileged top-level app document. The permit is single-use and URL-bound.
    try {
      const headers = runtimeAuth.prepareDownload(wc, url);
      originalDownloadRefusal.prepare(wc, url, headers);
      wc.downloadURL(url, { headers });
    }
    catch (err) { console.warn("[desktop] download unavailable:", err.message); }
  } else {
    openSafeExternal(url);
  }
}

function confineAppWindow(win) {
  const wc = win.webContents;
  acquireLibraryTransition.register(wc);
  wc.on("did-navigate", (_event, url, httpResponseCode) => {
    const target = pendingRuntimeRetargets.get(wc);
    if (target && currentRuntimeBinding(target.rt) && target.base === runtimeBase && url === target.url && httpResponseCode >= 200 && httpResponseCode < 300) pendingRuntimeRetargets.delete(wc);
  });
  wc.on("destroyed", () => { pendingRuntimeRetargets.delete(wc); originalDownloadRefusal.forgetContents(wc); });
  wc.on("did-start-navigation", (event, _url, _inPlace, isMainFrame) => {
    if ((event.isMainFrame ?? isMainFrame) === true) originalDownloadRefusal.forgetContents(wc);
  });
  const allowed = (url) => isAppPage(url, runtimeBase) || Boolean(testPageUrl && url === testPageUrl);
  wc.on("will-navigate", (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    handleAppLink(wc, url);
  });
  // Support both Electron's details-object and older positional event shapes.
  const confineFrame = (event, url, _inPlace, isMainFrame) => {
    if ((event.isMainFrame ?? isMainFrame) !== true || !allowed(event.url ?? url)) event.preventDefault();
  };
  // Main-frame navigations are handled by will-navigate (including explicit
  // download links). Blocking them earlier would swallow those links entirely.
  wc.on("will-frame-navigate", (event, _url, _inPlace, isMainFrame) => {
    if ((event.isMainFrame ?? isMainFrame) !== true) event.preventDefault();
  });
  wc.on("will-redirect", confineFrame);
  wc.on("will-attach-webview", (event) => event.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    handleAppLink(wc, url);
    return { action: "deny" };
  });
}

/**
 * Identity for the local runtime.
 *
 * Without this the window shows the synthetic local row — name "Owner",
 * `owner@beezilla.local` — even right after the user signed in with their real
 * account, which reads as "the app doesn't know me". A connected account's
 * name/email is written to `<dataDir>/identity.json` and exported into the
 * runtime's environment before it starts, so the owner row adopts it.
 */
function identityFile() {
  return join(supervisor.dataDir, "identity.json");
}

const injectedOwnerEnv = new Map();
// The credential commits first. A failed profile write must not make this
// launcher trust the previous account's sidecar on any child restart.
let unsavedOwnerIdentity = null;
function applyIdentityToEnv() {
  // Remove only this launcher's previous overrides; a missing/partial backup
  // or a new account is not permission to reuse details from the older one.
  for (const [key, { previous, value }] of injectedOwnerEnv) {
    if (process.env[key] !== value) continue;
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  injectedOwnerEnv.clear();
  try {
    const id = unsavedOwnerIdentity ?? (existsSync(identityFile())
      ? JSON.parse(readFileSync(identityFile(), "utf8"))
      : null);
    const name = typeof id?.name === "string" ? id.name.trim() : "";
    const email = typeof id?.email === "string" ? id.email.trim() : "";
    if (!email) return;
    for (const [key, value] of [["BZ_LOCAL_OWNER_NAME", name], ["BZ_LOCAL_OWNER_EMAIL", email]]) {
      if (!value) continue;
      injectedOwnerEnv.set(key, { previous: process.env[key], value });
      process.env[key] = value;
    }
    if (!unsavedOwnerIdentity) console.log("[desktop] local owner profile loaded");
  } catch (err) {
    // JSON parser errors can quote the file contents. Log only the failure type.
    const reason = err instanceof SyntaxError ? " (invalid JSON)" : "";
    console.warn(`[desktop] could not read identity.json${reason}`);
  }
}

function saveIdentity(account) {
  const email = typeof account?.email === "string" ? account.email.trim() : "";
  const name = email && typeof account?.name === "string" ? account.name.trim() : "";
  const nextIdentity = { name, email };
  try {
    mkdirSync(supervisor.dataDir, { recursive: true });
    // Called only when a new managed connection commits. An unavailable
    // profile must not leave the prior account displayed under the new key.
    writeFileSync(identityFile(), JSON.stringify({ ...nextIdentity, savedAt: new Date().toISOString() }, null, 2) + "\n");
    unsavedOwnerIdentity = null;
    console.log(email ? "[desktop] local owner profile saved" : "[desktop] connected profile unavailable; using local owner settings");
  } catch {
    // Keep even an empty replacement for the life of this launcher. Do not
    // delete the old sidecar or change the credential commit on write failure.
    unsavedOwnerIdentity = nextIdentity;
    console.warn("[desktop] could not save identity.json; check that the local data directory is writable");
  }
  applyIdentityToEnv();
}

// Only values this process injected may be withdrawn on the next Save/Remove.
// A real environment override (including one equal to a stored key at launch)
// is not a stored credential and must keep the shared resolver's precedence.
const injectedInferenceEnv = new Map();
let appliedStoredInference = null;

function injectInferenceEnv(name, value) {
  injectedInferenceEnv.set(name, { previous: process.env[name], value });
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function hasInjectedInferenceKey() {
  const injected = injectedInferenceEnv.get("BZ_CHAT_KEY");
  return Boolean(injected && process.env.BZ_CHAT_KEY === injected.value);
}

function isStoredInferenceApplied(stored) {
  if (!stored || !appliedStoredInference) return false;
  const { credential, env } = appliedStoredInference;
  return ["provider", "key", "baseUrl", "model", "encrypted", "expiresAt", "updatedAt"]
    .every((field) => stored[field] === credential[field]) &&
    Object.entries(env).every(([name, value]) => process.env[name] === value);
}

/**
 * Decrypt the stored inference key into the environment the runtime inherits.
 * safeStorage only works after `app.whenReady()`, so this cannot run at module
 * load — and it must run again after the user saves a key, before the restart.
 *
 * Async only because the inference library is loaded from the runtime tree at
 * call time (see paths.mjs); a missing file becomes a sentence, not a crash.
 */
async function applyStoredInferenceToEnv() {
  for (const [name, { previous, value }] of injectedInferenceEnv) {
    // A subsequently changed value is an override, not ours to erase.
    if (process.env[name] !== value) continue;
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  injectedInferenceEnv.clear();
  appliedStoredInference = null;
  try {
    const { loadInference, isExpired } = await runtimeLib("scripts/lib/inference.mjs");
    const inf = loadInference(supervisor.dataDir, {
      decrypt: (buf) => safeStorage.decryptString(Buffer.from(buf)),
    });
    const envKey = (process.env.BZ_CHAT_KEY ?? "").trim();
    if (!envKey && inf && inf.provider === "beezilla" && isExpired(inf)) {
      // Expiry is a session problem: refuse by name instead of spending a request
      // that comes back 401 and reads as "your key is wrong".
      injectInferenceEnv("BZ_MANAGED_EXPIRED", "1");
      injectInferenceEnv("BZ_MUSIC_VIA_GATEWAY", undefined);
      console.warn("[desktop] BeeZilla token expired — Settings will ask you to reconnect");
      return;
    }
    injectInferenceEnv("BZ_MANAGED_EXPIRED", undefined);
    if (envKey || inf?.key) {
      if (!envKey) injectInferenceEnv("BZ_CHAT_KEY", inf.key);
      // A new key's blank optional fields mean provider defaults, not the
      // previous key's gateway/model. Never send it to a retired endpoint.
      // Genuine endpoint/model overrides win; otherwise use this store's fields.
      if (!(process.env.BZ_CHAT_BASE_URL ?? "").trim() && inf?.baseUrl) injectInferenceEnv("BZ_CHAT_BASE_URL", inf.baseUrl);
      if (!(process.env.BZ_CHAT_MODEL ?? "").trim() && inf?.model) injectInferenceEnv("BZ_CHAT_MODEL", inf.model);
      // Managed music rides the same short-lived gateway token as chat: the app holds
      // no music key at all, and quota/plan are enforced on our side. BYOK installs
      // (provider "byok") keep using their own ElevenLabs key from Settings.
      injectInferenceEnv("BZ_MUSIC_VIA_GATEWAY", !envKey && inf.provider === "beezilla" && inf.baseUrl ? inf.baseUrl : undefined);
      if (!envKey) {
        // Private proof of the injection, never an env flag or renderer payload.
        // Settings must also match the current decrypted store and effective env.
        appliedStoredInference = {
          credential: { ...inf },
          env: Object.fromEntries(["BZ_CHAT_KEY", "BZ_CHAT_BASE_URL", "BZ_CHAT_MODEL"].map((name) => [name, process.env[name]])),
        };
      }
      console.log(`[desktop] inference: ${envKey ? "env" : `${inf.provider} (stored${inf.encrypted ? ", encrypted" : ""})`}`);
      return;
    }
  } catch (err) {
    // A store we cannot decrypt must not take the app down — chat refuses by name.
    console.warn("[desktop] could not read the stored inference key:", err instanceof Error ? err.message : err);
  }
}

let injectedMusicEnv = null;

/**
 * Resolve the same env-first music configuration as the CLI before spawning the
 * local runtime. A Save/Clear may withdraw a prior store injection, but must
 * never overwrite or erase a key the operator supplied in their environment.
 */
async function applyStoredMusicToEnv() {
  if (injectedMusicEnv && process.env.BZ_ELEVEN_KEY === injectedMusicEnv.value) {
    if (injectedMusicEnv.previous === undefined) delete process.env.BZ_ELEVEN_KEY;
    else process.env.BZ_ELEVEN_KEY = injectedMusicEnv.previous;
  }
  injectedMusicEnv = null;
  try {
    const { resolveMusicKey } = await runtimeLib("scripts/lib/music-keys.mjs");
    const previous = process.env.BZ_ELEVEN_KEY;
    const found = resolveMusicKey(supervisor.dataDir, {
      decrypt: (buf) => safeStorage.decryptString(Buffer.from(buf)),
    });
    if (found?.source === "env") {
      console.log("[desktop] music: env");
    } else if (found?.source === "store") {
      process.env.BZ_ELEVEN_KEY = found.key;
      injectedMusicEnv = { previous, value: process.env.BZ_ELEVEN_KEY };
      console.log(`[desktop] music: ${found.provider} (stored${found.encrypted ? ", encrypted" : ""})`);
    }
  } catch (err) {
    console.warn("[desktop] could not read the stored music key:", err instanceof Error ? err.message : err);
  }
}

/**
 * Settings IPC. `safeStorage` is only usable after `app.whenReady()`, so the
 * handlers are built there — but they are plain functions, so the contract can be
 * tested without a display (see scripts/test-desktop-settings.mjs).
 */
let settingsHandlers = null;

function registerSettingsIpc() {
  // Imported here, not at the top: settings.mjs loads the runtime's credential
  // libraries, so a broken install must fail inside this try/catch (logged, and
  // shown as a sentence) rather than at module-link time before logging exists.
  return import("./settings.mjs").then(({ createSettingsHandlers, publicSettingsResult, publicSettingsFailure }) => {
    const handlers = createSettingsHandlers({
      dataDir: () => supervisor.dataDir,
      supervisor,
      isStoredInferenceApplied,
      hasInjectedInferenceKey,
      cipher: {
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(Buffer.from(b)),
      },
      beforeRestart: async () => {
        // Freeze/drain only the current origin’s named Library stores BEFORE
        // clearing auth or stopping the database. No cross-origin storage copy.
        settingsHistoryTransition = await acquireLibraryTransition({ allowDeferred: true });
        const binding = currentRuntimeBinding(supervisor.runtime);
        clearRuntimeAuth();
        settingsPreviousBinding = binding ? { binding, clearedGeneration: runtimeBindingGeneration } : null;
        // Identity first: the runtime reads BZ_LOCAL_OWNER_* at spawn.
        applyIdentityToEnv();
        await applyStoredInferenceToEnv();
        await applyStoredMusicToEnv();
      },
      afterRestart: async (rt) => {
        // A crashed runtime may require a new server before its still-visible
        // origin can migrate. Persist before navigating away from that origin.
        await settingsHistoryTransition?.flush(rt);
        bindRuntime(rt, true);
      },
      afterRestartFinally: async () => {
        const transition = settingsHistoryTransition;
        const previous = settingsPreviousBinding;
        settingsHistoryTransition = null;
        settingsPreviousBinding = null;
        // A stop refusal may leave the actual original runtime usable. Restore
        // ONLY proof captured before this attempt's own clear, not an unbound
        // replacement retained by the supervisor after an earlier failed handoff.
        const proof = previous?.binding;
        if (proof && !runtimeBinding && runtimeBindingGeneration === previous.clearedGeneration &&
            supervisor.runtime === proof.rt && runtimeBase === proof.base &&
            proof.rt.host === proof.host && proof.rt.port === proof.port && proof.rt.token === proof.token) {
          bindRuntime(proof.rt);
        }
        await transition?.release({ keepRetiredFrozen: true });
      },
    });

    const wrap = (fn, settingsAction = null) => async (event, payload) => {
      try {
        if (!isTrustedSender(event, { base: runtimeBase, contents: trustedContents(), testPageUrl })) {
          return { ok: false, error: "This action is available only from the BeeZilla app window." };
        }
        if (settingsAction === "saveInference" && payload?.provider === "beezilla") {
          return { ok: false, error: "Use Connect BeeZilla account to set up managed inference." };
        }
        const data = await fn(payload);
        return { ok: true, data: settingsAction ? publicSettingsResult(data) : data };
      } catch (err) {
        if (settingsAction) return { ok: false, error: publicSettingsFailure(settingsAction, payload) };
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };

    ipcMain.handle("beezilla:settings:get", wrap(() => handlers.status(), "get"));
    ipcMain.handle("beezilla:settings:saveInference", wrap((cfg) => handlers.saveInference(cfg), "saveInference"));
    ipcMain.handle("beezilla:settings:saveSearch", wrap((cfg) => handlers.saveSearch(cfg), "saveSearch"));
    ipcMain.handle("beezilla:settings:saveMusic", wrap((cfg) => handlers.saveMusic(cfg), "saveMusic"));
    ipcMain.handle("beezilla:settings:clear", wrap((kind) => handlers.clear(kind), "clear"));
    ipcMain.handle("beezilla:app:version", wrap(() => ({ version: app.getVersion() })));
    // "Connect BeeZilla account" from the Settings screen: same flow as the menu item.
    ipcMain.handle("beezilla:settings:connect", wrap(() => connectManagedAccount()));
    // Diagnostics from the UI: one click to the folder that holds main.log.
    ipcMain.handle("beezilla:app:openLogs", wrap(async () => {
      const { dir } = logPaths();
      if (!dir) throw new Error("No logs folder is available for this session.");
      try {
        if (await shell.openPath(dir) === "") return { opened: true };
      } catch { /* report both native failure forms without filesystem details */ }
      throw new Error("Could not open the logs folder. Check that BeeZilla can access it.");
    }));
    ipcMain.handle("beezilla:app:logPath", wrap(async () => logPaths()));
    // The page knows things the shell cannot see: which device it got, what the
    // recorder produced, what the transcriber answered. Those lines belong in
    // main.log next to the launch breadcrumbs, not only in a DevTools console the
    // user will never open.
    ipcMain.handle("beezilla:app:log", wrap(async (message) => {
      const text = String(message ?? "").slice(0, 600);
      logLine("log", [`[ui] ${text}`]);
      return { logged: true };
    }));

    return handlers;
  });
}

let canReopenMainWindow = false;
let openingMainWindow = null;
// One install, one runtime: a second launch must focus or reopen the window,
// not open a second server against the same PGLite data directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => void focusOrReopenMainWindow());
}

function focusOrReopenMainWindow() {
  if (quitting) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (mainWindow.isVisible()) mainWindow.focus();
    else mainWindow.show(); // Showing also focuses a window hidden without minimization.
    return;
  }
  // The first window is created by startup after Electron and the local
  // handlers are ready. Later activation and launch events share a reopen.
  if (!canReopenMainWindow || acquireLibraryTransition.held()) return;
  if (!openingMainWindow) {
    openingMainWindow = createWindow().catch((err) => {
      if (!quitting) dialog.showErrorBox("BeeZilla could not reopen", String(err?.message ?? err));
    }).finally(() => { openingMainWindow = null; });
  }
}

function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "BeeZilla",
        submenu: [
          {
            label: "Settings…",
            accelerator: "CmdOrCtrl+,",
            click: () => void openSettings(),
          },
          {
            label: "Connect BeeZilla account…",
            // UI affordance only. The command checks the same capability for
            // every entry path, including Settings IPC and the native test hook.
            enabled: managedAccountConnectCapability().enabled,
            click: () => void connectManagedAccount(),
          },
          { type: "separator" },
          {
            label: "Open Logs Folder",
            click: () => {
              const { dir, file } = logPaths();
              console.log(`[desktop] opening logs folder ${dir}`);
              if (dir) void shell.openPath(dir);
              else dialog.showErrorBox("BeeZilla", `Logging is unavailable.\n${file ?? ""}`);
            },
          },
          { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => {
            if (quitting || acquireLibraryTransition.held()) return;
            const wc = BrowserWindow.getFocusedWindow()?.webContents;
            if (!trustedContents().includes(wc)) return;
            if (!currentRuntimeBinding(supervisor.runtime)) {
              dialog.showErrorBox("BeeZilla is not connected", "This window is still open. Open Settings from the BeeZilla menu to reconnect before reloading.");
              return;
            }
            wc.reload();
          } },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    ]),
  );
}

/**
 * Settings window — a second window over the SAME runtime, not a second server.
 * It shares the default session, so the auth header injected for `base` already
 * applies and the page can reach the preload bridge.
 */
const settingsPagesLoaded = new WeakSet();
const settingsPagesToRetry = new WeakSet();

function reportSettingsLoadProblem(win, slow = false) {
  // Closing, quitting, or a successful restart navigation can cancel the
  // original load. Only ask to retry an open window with no usable page.
  if (quitting || settingsWindow !== win || win.isDestroyed() || settingsPagesLoaded.has(win)) return;
  settingsPagesToRetry.add(win);
  dialog.showErrorBox(slow ? "Settings is still loading" : "BeeZilla could not load Settings", slow
    ? "Settings is taking longer than expected. Open Settings from the BeeZilla menu to try again."
    : "The local Settings page did not load. Open Settings from the BeeZilla menu to try again.");
}

async function loadSettingsPage(win, url) {
  settingsPagesToRetry.delete(win);
  let timer, onClose, result;
  try {
    const closed = new Promise((resolve) => {
      onClose = () => resolve("closed");
      win.once("closed", onClose);
    });
    const slow = new Promise((resolve) => {
      timer = setTimeout(() => resolve("waiting"), 30_000);
      timer.unref?.();
    });
    result = await Promise.race([
      win.loadURL(url).then(() => "loaded"),
      slow,
      closed,
    ]);
  } catch {
    result = "failed";
  } finally {
    clearTimeout(timer);
    if (onClose) win.removeListener("closed", onClose);
  }
  if (result === "loaded") console.log(`[desktop] settings window opened ${url}`);
  if (result === "failed" || result === "waiting") reportSettingsLoadProblem(win, result === "waiting");
}

function settingsWindowFor(url) {
  if (acquireLibraryTransition.held()) return null;
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 820,
    minWidth: 560,
    title: "BeeZilla — Settings",
    parent: mainWindow ?? undefined,
    modal: false,
    show: true,
    backgroundColor: "#f7f8fa",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
    },
  });
  const win = settingsWindow;
  win.on("closed", () => {
    if (settingsWindow === win) settingsWindow = null;
  });
  confineAppWindow(settingsWindow);
  guardLibraryWindowClose(settingsWindow);
  // Electron 35+ passes one event object; the positional level/message/line
  // arguments are deprecated (see the 35.0 breaking changes).
  win.webContents.on("console-message", ({ message }) =>
    console.log(`[settings] ${message}`),
  );
  win.webContents.on("did-navigate", (_event, destination, status) => {
    if (status >= 200 && status < 300 && isAppPage(destination, runtimeBase)) {
      settingsPagesLoaded.add(win);
      settingsPagesToRetry.delete(win);
    }
  });
  void loadSettingsPage(win, url);
  return win;
}

/**
 * Connect a BeeZilla account so the app can use OUR inference.
 *
 * The token is minted inside our own page (session cookie stays there) and handed
 * straight to the credential store; the store restart then puts it in the runtime's
 * environment. Nothing about the account itself is copied locally.
 */
let connecting = null;
function connectManagedAccount() {
  // Authoritative boundary: check before joining an in-flight request, creating
  // a session/window, resolving a cloud URL, minting tokens or writing stores.
  // Renderer payloads and the menu's enabled state cannot grant this capability.
  const capability = managedAccountConnectCapability();
  if (!capability.enabled) {
    return Promise.resolve({ ok: false, code: "connect_disabled", error: capability.reason });
  }
  if (connecting) return connecting;
  connecting = performConnect().catch((error) => {
    console.warn("[desktop] connect failed:", error.message);
    return { ok: false, error: error.message };
  }).finally(() => { connecting = null; });
  return connecting;
}

async function performConnect() {
  const baseUrl = connectBaseUrl(cloudBaseUrl());
  const connectSession = session.fromPartition("persist:beezilla-connect");
  connectSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  connectSession.setPermissionCheckHandler(() => false);
  connectSession.setDevicePermissionHandler(() => false);
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: "Connect BeeZilla",
    autoHideMenuBar: true,
    webPreferences: { session: connectSession, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  const limitConnectNavigation = (event, url) => {
    if (!isConnectNavigation(event.url ?? url, baseUrl)) event.preventDefault();
  };
  win.webContents.on("will-navigate", limitConnectNavigation);
  win.webContents.on("will-redirect", limitConnectNavigation);
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isConnectNavigation(url, baseUrl)) void win.loadURL(url).catch(() => {});
    return { action: "deny" };
  });

  const outcome = await connectAccount({
    baseUrl,
    open: (url) => win.loadURL(url),
    evaluate: (script) => {
      // OAuth may temporarily navigate elsewhere. Never ask that origin to mint
      // or supply a BeeZilla credential; wait for the same-origin callback.
      if (!sameOrigin(win.webContents.getURL(), baseUrl)) return Promise.resolve(JSON.stringify({ status: 401, body: { code: "unauthenticated" } }));
      return win.webContents.executeJavaScript(`location.origin === ${JSON.stringify(baseUrl)} ? (${script}) : JSON.stringify({status:401,body:{code:"unauthenticated"}})`, true);
    },
    isOpen: () => !win.isDestroyed(),
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
    signInDeadlineMs: Number(process.env.BZ_CONNECT_DEADLINE_MS ?? 180_000),
  });

  if (!outcome.ok) {
    console.warn(`[desktop] connect: ${outcome.error}`);
    // Never leave a blank BeeZilla window behind after a failed load.
    if (!win.isDestroyed()) win.destroy();
    if (!process.env.BZ_CONNECT_TEST && mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "BeeZilla inference",
        message: outcome.unreachable
          ? "BeeZilla is not reachable."
          : outcome.needsSignIn
            ? "Sign-in did not complete."
            : "Could not connect.",
        detail: `${outcome.error}\n\nYou can still use your own key: BeeZilla → Settings.`,
      });
    }
    return outcome;
  }

  const saved = await settingsHandlers.saveInference({
    provider: "beezilla",
    key: outcome.token,
    baseUrl: outcome.baseUrl,
    model: outcome.model,
    expiresAt: outcome.expiresAt,
  }, {
    onCommitted: () => saveIdentity(outcome.account),
    search: outcome.search?.ok ? {
      token: outcome.search.token, gateway: outcome.search.endpoint, expiresAt: outcome.search.expiresAt,
    } : null,
  });
  console.log(`[desktop] connect: BeeZilla inference connected (expires ${outcome.expiresAt ?? "unknown"}), runtime ${saved.reason ? "restart failed" : saved.started ? "started" : "restarted"}`);

  // Search is a second capability and is allowed to be missing. Saying so once, at
  // connect time, is better than a user discovering it later in a chat turn.
  const searchSaved = saved.searchSaved ?? null;
  const restartFailure = saved.reason || null;
  if (searchSaved) {
    console.log(`[desktop] connect: BeeZilla search connected (expires ${outcome.search.expiresAt ?? "unknown"})`);
  } else if (saved.searchError) {
    console.warn(`[desktop] connect: ${saved.searchError}`);
  } else if (outcome.search?.notDeployed) {
    console.log("[desktop] connect: BeeZilla search is not enabled on this deployment — BYOK search only");
  } else if (outcome.search?.error) {
    console.warn(`[desktop] connect: search token unavailable — ${outcome.search.error}`);
  }

  if (restartFailure) {
    return { ok: false, error: "Account credentials were saved, but BeeZilla did not restart. Retry from Settings without force-quitting." };
  }
  return { ...outcome, token: undefined, search: { ...outcome.search, ...(saved.searchError ? { ok: false, error: saved.searchError } : {}), token: undefined, saved: searchSaved }, savedTo: saved.saved?.key };
}

let openingSettings = null;
let pendingSettingsRuntime = null;
function pendingSettingsRuntimeMatches(rt) {
  return rt && pendingSettingsRuntime?.rt === rt && pendingSettingsRuntime.host === rt.host &&
    pendingSettingsRuntime.port === rt.port && pendingSettingsRuntime.token === rt.token &&
    pendingSettingsRuntime.generation === runtimeBindingGeneration;
}

async function recoverRuntimeForSettings() {
  const existing = supervisor.runtime;
  // Retry only a replacement started by this menu action. Another failed
  // handoff can leave a live but unbound runtime and must keep its own guards.
  if (existing && !pendingSettingsRuntimeMatches(existing)) {
    throw new Error("The local connection is not ready in this window. Keep BeeZilla open if you have unsaved work.");
  }
  const rt = existing ?? await supervisor.start();
  if (currentRuntimeBinding(supervisor.runtime) && supervisor.runtime === rt) return true;
  pendingSettingsRuntime = { rt, host: rt.host, port: rt.port, token: rt.token, generation: runtimeBindingGeneration };
  if (quitting || acquireLibraryTransition.held()) return false;
  if (!pendingSettingsRuntimeMatches(supervisor.runtime)) throw new Error("The local connection changed. Open Settings to try again.");

  // Same-origin recovery restores access without discarding any open document.
  if (!runtimeBase || runtimeOrigin(rt) === runtimeBase) {
    bindRuntime(rt, true);
    pendingSettingsRuntime = null;
    return true;
  }
  let transition, rebound = false;
  try {
    // A port change replaces documents. Use the existing Sketch/Library save
    // barrier before sending any replacement navigation, not afterwards.
    transition = await acquireLibraryTransition();
    if (quitting) return false;
    if (!pendingSettingsRuntimeMatches(supervisor.runtime)) throw new Error("The local connection changed.");
    bindRuntime(rt, true);
    rebound = true;
    pendingSettingsRuntime = null;
    return true;
  } catch {
    throw new Error("BeeZilla kept your window open because it could not finish saving before reconnecting. Keep it open if you have unsaved work. In Sketch, Export PNG can keep a copy of your drawing.");
  } finally {
    await transition?.release({ keepRetiredFrozen: rebound });
  }
}

function openSettings() {
  if (quitting || acquireLibraryTransition.held()) return;
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    if (settingsWindow.isVisible()) settingsWindow.focus();
    else settingsWindow.show();
    if (!settingsPagesToRetry.has(settingsWindow) && currentRuntimeBinding(supervisor.runtime)) return;
  }
  // The supervisor shares startup, but each awaiting menu click would still
  // create its own window. Share the entire open, not just the child process.
  if (!openingSettings) {
    openingSettings = openSettingsWindow().catch((err) => {
      if (!quitting) dialog.showErrorBox("BeeZilla could not open Settings", String(err?.message ?? err));
    }).finally(() => { openingSettings = null; });
  }
  return openingSettings;
}

async function openSettingsWindow() {
  if (!currentRuntimeBinding(supervisor.runtime)) {
    if (!await recoverRuntimeForSettings()) return;
    if (quitting || acquireLibraryTransition.held()) return;
  }
  if (settingsWindow) {
    if (settingsPagesToRetry.has(settingsWindow)) void loadSettingsPage(settingsWindow, `${runtimeBase}/buzzy/settings`);
  } else {
    settingsWindowFor(`${runtimeBase}/buzzy/settings`);
  }
}

async function createWindow() {
  if (quitting || acquireLibraryTransition.held()) return;
  console.log("[desktop] createWindow: starting runtime");
  const rt = await supervisor.start();
  if (quitting || acquireLibraryTransition.held()) return;
  console.log(`[desktop] runtime ready on ${rt.host}:${rt.port}`);
  const base = bindRuntime(rt);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#ffffff",
    title: "BeeZilla",
    show: Boolean(process.env.BZ_SMOKE),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // .cjs: a sandboxed renderer cannot load an ESM preload, and it fails
      // silently — window.beezilla just does not exist.
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  confineAppWindow(mainWindow);
  guardLibraryWindowClose(mainWindow);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) =>
    console.log(`[desktop] load failed ${code} ${desc} ${url}`),
  );
  mainWindow.webContents.on("console-message", ({ message }) => {
    console.log(`[renderer] ${message}`);
    // Probe mode ends the moment the renderer reports — no fixed timeout to wait out.
    if (process.env.BZ_SETTINGS_TEST && message.startsWith("SETTINGS_RESULT:")) {
      setTimeout(() => app.quit(), 250);
    }
  });

  // Test hook: load a probe page instead of the product UI, so the privileged
// bridge can be exercised in a real sandboxed renderer.
  const probe = process.env.BZ_SETTINGS_TEST;
  // The connect probe drives its own window; it must not be mistaken for the
  // settings probe (which loads test-settings.html and waits for a result line).
  const quiet = Boolean(probe || process.env.BZ_CONNECT_TEST);
  // BZ_PROBE_URL lets a test load a real product page (e.g. the settings screen)
  // and drive it, instead of a synthetic probe document.
  const probePath = process.env.BZ_PROBE_PATH;
  const reopenTarget = mainReopenPage
    ? retargetAppPage(mainReopenPage.url, mainReopenPage.base, base)
    : `${base}/buzzy/talk`;
  const target =
    process.env.BZ_PROBE_URL ||
    (probePath ? `${base}${probePath}` : null) ||
    (probe && testPageUrl ? testPageUrl : reopenTarget);
  if (typeof target !== "string" || (!isAppPage(target, base) && target !== testPageUrl)) throw new Error("The desktop entry point must be a local BeeZilla app page.");
  const loaded = await Promise.race([
    mainWindow.loadURL(target).then(() => true),
    new Promise((r) => setTimeout(() => r(false), 30_000)),
  ]);
  console.log(`[desktop] loadURL ${loaded ? "resolved" : "TIMED OUT"} ${target}`);

  // Headless smoke hook: render, capture what the user would see, exit. Lets CI
  // prove the window actually paints instead of only proving the process boots.
  // Capture AFTER loadURL resolves — registering a `did-finish-load` listener
  // here would never fire, because the event has already been emitted by then.
  if (process.env.BZ_CONNECT_TEST) {
    // Drive the real flow (window -> mint inside the page -> credential store) and
    // report it in one parseable line for scripts/test-desktop-connect.mjs.
    const outcome = await connectManagedAccount();
    console.log(
      `CONNECT_RESULT:${JSON.stringify({
        ok: outcome.ok,
        error: outcome.error ?? null,
        needsSignIn: outcome.needsSignIn ?? false,
        // The search half is reported too: a connect that silently drops it looks
        // identical to one that never asked.
        search: outcome.search
          ? { ok: outcome.search.ok === true, notDeployed: outcome.search.notDeployed === true, error: outcome.search.error ?? null }
          : null,
      })}`,
    );
    setTimeout(() => app.quit(), 500);
    return;
  }

  if (probe && process.env.BZ_SETTINGS_DRIVE) {
    // Drive the real settings form: pick "my own key", paste, save, read the
    // result out of the DOM. A UI that renders but cannot save is not a feature.
    const driver = `(async () => {
      const out = {};
      out.hasBridge = Boolean(window.beezilla && window.beezilla.settings);
      out.formPresent = Boolean(document.getElementById("save-inference") && document.getElementById("provider-byok"));
      out.buttonsEnabled = !document.getElementById("save-inference").disabled;
      const radio = document.getElementById("provider-byok");
      if (radio) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
      out.byokFieldsShown = !document.getElementById("byok-fields").hidden;
      // The unconfigured copy must match the radio just picked: "nothing to
      // configure" beside "answers will refuse" reads like a broken app.
      out.emptyNote = document.getElementById("inference-current").textContent.trim();
      out.clearDisabledWhenEmpty = document.getElementById("clear-inference").disabled;
      document.getElementById("key").value = "sk-drive-probe-1234567890";
      document.getElementById("save-inference").click();
      await new Promise((resolve) => {
        const started = Date.now();
        const tick = setInterval(() => {
          const text = document.getElementById("inference-status").textContent || "";
          if (/Saved|Could not|required|error/i.test(text) || Date.now() - started > 40000) { clearInterval(tick); resolve(); }
        }, 250);
      });
      out.statusText = document.getElementById("inference-status").textContent;
      out.currentText = document.getElementById("inference-current").textContent.trim();
      return JSON.stringify(out);
    })()`;
    const result = await mainWindow.webContents.executeJavaScript(driver).catch((err) => JSON.stringify({ ok: false, error: String(err) }));
    console.log(`SETTINGS_DRIVE_RESULT:${result}`);
    app.quit();
    return;
  }

  if (probe) {
    // Safety net only: the renderer normally quits the app as soon as it reports.
    setTimeout(() => {
      console.log("[desktop] probe timed out — no SETTINGS_RESULT");
      app.quit();
    }, 40_000);
    return;
  }

  // First run with nothing configured: chat can only refuse, so open the thing
  // that makes it usable instead of handing a new user a dead window.
  if (!quiet && !process.env.BZ_CHAT_KEY) {
    console.log("[desktop] onboarding: no inference configured — opening Settings");
    void openSettings();
  }
  if (!quiet && process.env.BZ_FIRSTRUN_TEST) {
    // Bounded test launch: a configured install has nothing to prove and no other
    // reason to exit, so without this the suite waits out its own timeout.
    setTimeout(() => app.quit(), 4000);
    return;
  }

  if (process.env.BZ_SMOKE) {
    await new Promise((r) => setTimeout(r, Number(process.env.BZ_SMOKE_DELAY_MS ?? 2500)));
    // A capture that never resolves would hang CI forever; race it.
    // Capture what the user actually sees: on a first run that is the Settings
    // window, not the chat window behind it.
    const shotWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1) ?? mainWindow;
    const image = await Promise.race([
      shotWindow.webContents.capturePage(),
      new Promise((r) => setTimeout(() => r(null), 15_000)),
    ]);
    const { writeFileSync } = await import("node:fs");
    if (image) {
      writeFileSync(process.env.BZ_SMOKE_OUT || "beezilla-smoke.png", image.toPNG());
      console.log("[smoke] captured window");
    } else {
      console.log("[smoke] capture timed out — window did not paint");
    }
    app.quit();
  }
}

/**
 * Media permission, decided here instead of by a default.
 *
 * "It didn't hear me" has one silent cause above all others: getUserMedia rejects
 * and nothing records why. Electron answers permission requests from a handler or
 * from a default that has moved between versions; either way the renderer only
 * sees a rejected promise. Decide explicitly, log the decision with the requesting
 * origin, and the log then answers the question before the user has to describe it.
 */
function installMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const allowed = allowAudioPermission({
      contents: trustedContents(), webContents: wc, base: runtimeBase,
      permission, origin: details?.requestingUrl, details, request: true,
    });
    // A permission diagnostic needs the requester’s origin, not a private document URL.
    // Never query a retired WebContents just to log a denial.
    logLine("log", [`[perm] request ${permission} ← ${webUrl(details?.requestingUrl)?.origin ?? "unknown"} → ${allowed ? "allow" : "deny"}`]);
    callback(allowed);
  });
  // Device permission is for USB/HID/serial, not microphones. No such device
  // capability is exposed by this app. Microphones use the media handlers.
  ses.setDevicePermissionHandler((details) => {
    logLine("log", [`[perm] device ${details?.deviceType ?? "?"} → deny`]);
    return false;
  });
  // Windows/macOS can refuse microphone access to the executable itself, and that
  // refusal shows up as a live stream delivering silence — no error anywhere.
  setTimeout(() => {
    try {
      const status = systemPreferences.getMediaAccessStatus?.("microphone");
      logLine("log", [`[perm] OS microphone access=${status ?? "unknown"}`]);
    } catch (err) {
      logLine("log", [`[perm] OS microphone access query failed: ${err?.message ?? err}`]);
    }
  }, 1500);

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const allowed = allowAudioPermission({
      contents: trustedContents(), webContents: wc, base: runtimeBase,
      permission, origin: requestingOrigin, details,
    });
    logLine("log", [
      `[perm] check ${permission}${details?.mediaType ? `(${details.mediaType})` : ""} ← ${webUrl(requestingOrigin)?.origin ?? "unknown"} → ${allowed ? "allow" : "deny"}`,
    ]);
    return allowed;
  });
}

app.whenReady().then(async () => {
  installMenu();
  installMediaPermissions();
  try {
    // A stale/missing build manifest must stop startup, never silently remove
    // the policy. This hook is exclusive to local application main frames;
    // cloud sign-in lives in a separate session and hosted HTTP is unchanged.
    const desktopCsp = createDesktopCsp({
      manifest: loadCspManifest(ROOT),
      getRuntime: () => supervisor.runtime,
      getContents: trustedContents,
    });
    // Bind CSP to the same actual request authorization, before the runtime
    // can stop/restart while a main-document response is still in flight.
    // The cloud sign-in window has a different session and never uses this.
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
      try {
        if (!supervisor.runtime) clearRuntimeAuth();
        if (acquireLibraryTransition.blocksRequest(details)) { callback({ cancel: true }); return; }
        callback(originalDownloadRefusal.authorizeRequest(details, desktopCsp.authorizeRequest(details, runtimeAuth.headers(details))));
      } catch {
        callback({ cancel: true });
      }
    });
    session.defaultSession.webRequest.onHeadersReceived({ urls: ["http://127.0.0.1:*/*"] }, (details, callback) => {
      try {
        const policy = desktopCsp.headers(details);
        callback(policy.cancel ? policy : { ...policy, ...originalDownloadRefusal.headers(details) });
      }
      catch (err) {
        console.error("[desktop] could not enforce the script policy:", err.message);
        callback({ cancel: true });
      }
    });
    // Include redirected/error endpoints for cleanup; these listeners only
    // discard request records and never modify responses or grant authority.
    session.defaultSession.webRequest.onCompleted((details) => { desktopCsp.finished(details); originalDownloadRefusal.finished(details); });
    session.defaultSession.webRequest.onErrorOccurred((details) => { desktopCsp.finished(details); originalDownloadRefusal.finished(details); });
    applyIdentityToEnv();
    await applyStoredInferenceToEnv();
    await applyStoredMusicToEnv();
    settingsHandlers = await registerSettingsIpc();
    await createWindow();
  } catch (err) {
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    console.error("[desktop] failed to start:", detail);
    const { file } = logPaths();
    dialog.showErrorBox(
      "BeeZilla could not start",
      `${err instanceof Error ? err.message : String(err)}\n\nLog file:\n${file ?? "(logging unavailable)"}\n\n` +
        `Run \`beezilla doctor\` from a terminal for details.`,
    );
    app.quit();
    return;
  }

  canReopenMainWindow = true;
  app.on("activate", (_event, hasVisibleWindows) => {
    // An existing window can be hidden or minimized; an empty window list is
    // not the only time an explicit activation needs to surface BeeZilla.
    if (hasVisibleWindows === false || BrowserWindow.getAllWindows().length === 0) focusOrReopenMainWindow();
  });
});

// The runtime holds an embedded Postgres. Killing it abruptly loses the WAL
// flush, so quitting waits for a graceful stop.
app.on("before-quit", async (event) => {
  // A second Quit must not bypass a pending save/stop barrier. app.exit below
  // intentionally bypasses before-quit only after both steps have succeeded.
  if (quitting) { event.preventDefault(); return; }
  quitting = true;
  event.preventDefault();
  let transition, stoppingDatabase = false;
  try {
    transition = await acquireLibraryTransition();
    stoppingDatabase = true;
    await supervisor.stop();
    stoppingDatabase = false;
    clearRuntimeAuth();
    app.exit(0);
  } catch (error) {
    quitting = false;
    dialog.showErrorBox("BeeZilla stayed open", stoppingDatabase
      ? "Sketch and Library finished saving. BeeZilla could not confirm the local database stopped. Wait a moment, then choose Quit again."
      : `${error.message}\n\nRetry when Sketch and Library changes can be saved and the local database can stop safely.`);
  } finally {
    await transition?.release();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
