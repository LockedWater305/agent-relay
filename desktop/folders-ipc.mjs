/**
 * IPC for the folder-access broker (desktop/capability-broker.mjs).
 *
 * These channels are the only way a page reaches the broker. The trust rules, each covered by
 * scripts/test-folders-ipc.mjs:
 *   - every channel answers only a sender that isTrustedSender() accepts; any other sender gets
 *     { ok: false, code: "untrusted_sender" } and nothing runs;
 *   - no channel grants a folder that the caller names. The only grant path is pick(): it opens
 *     the native folder dialog and grants the folder the person chose there. Its payload is ignored;
 *   - a cancelled dialog grants nothing;
 *   - every answer is { ok: true, data } or { ok: false, code, message }. A raw exception never
 *     reaches the page.
 *
 * Dependencies are parameters, so this module loads without Electron.
 */
import { ERROR_CODES } from "./capability-broker.mjs";

/** Channels the page reaches through window.beezillaFolders (preload.cjs). */
export const FOLDER_CHANNELS = Object.freeze({
  pick: "bz-folders:pick",
  list: "bz-folders:list",
  activate: "bz-folders:activate",
  pause: "bz-folders:pause",
  resume: "bz-folders:resume",
  revoke: "bz-folders:revoke",
  listDir: "bz-folders:listDir",
  readFile: "bz-folders:readFile",
  search: "bz-folders:search",
  activity: "bz-folders:activity",
  /** Synchronous, preload only: the runtime origin this window may use for the bridge. */
  origin: "bz-folders:origin",
});

/** Main -> window: one push per broker activity entry. */
export const FOLDER_ACTIVITY_EVENT = "bz-folders:activity-event";

// Codes this layer adds. Broker codes pass through unchanged (see ERROR_CODES).
const UNAVAILABLE_MESSAGE = "BeeZilla could not finish that folder action.";
const UNTRUSTED_MESSAGE = "Folder access is available only from the BeeZilla app window.";

class FolderIpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FolderIpcError";
    this.code = code;
  }
}

function failure(err) {
  if (err instanceof FolderIpcError || ERROR_CODES.includes(err?.code)) {
    return { ok: false, code: err.code, message: err.message };
  }
  // Not a broker error: keep the detail (which may name a path) out of the page.
  return { ok: false, code: "unavailable", message: UNAVAILABLE_MESSAGE };
}

function requireObject(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new FolderIpcError("bad_argument", "the request must be an object");
  }
  return payload;
}

function trusted(isTrustedSender, event) {
  try {
    return isTrustedSender(event) === true;
  } catch {
    return false;
  }
}

/**
 * Registers every folder channel.
 *
 * @param {object} deps
 * @param {{ handle: Function, on: Function }} deps.ipcMain
 * @param {{ showOpenDialog: Function }} deps.dialog
 * @param {object} deps.broker            the object createBroker() returns
 * @param {(event: object) => boolean} deps.isTrustedSender
 * @param {(event: object) => object|null} deps.getWindow  the window that sent the call (dialog parent)
 * @param {() => string|null} deps.runtimeOrigin           the origin trusted windows may use now
 */
export function registerFolderIpc({ ipcMain, dialog, broker, isTrustedSender, getWindow, runtimeOrigin }) {
  let picking = false;

  async function pick(event) {
    if (picking) throw new FolderIpcError("busy", "The folder picker is already open.");
    picking = true;
    try {
      const owner = getWindow(event) ?? null;
      // Built from constants only. Nothing the page sent reaches the dialog.
      const options = {
        title: "Choose a folder for BeeZilla to read",
        buttonLabel: "Choose folder",
        properties: ["openDirectory"],
      };
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      const chosen = result?.canceled ? null : result?.filePaths?.[0];
      if (typeof chosen !== "string" || chosen === "") return { granted: false };
      const grant = await broker.grantFolder(chosen);
      return { granted: true, grant };
    } finally {
      picking = false;
    }
  }

  const handlers = {
    [FOLDER_CHANNELS.pick]: (event) => pick(event),
    [FOLDER_CHANNELS.list]: () => broker.list(),
    [FOLDER_CHANNELS.activate]: (_event, payload) => broker.activate(requireObject(payload).id),
    [FOLDER_CHANNELS.pause]: (_event, payload) => broker.pause(requireObject(payload).id),
    [FOLDER_CHANNELS.resume]: (_event, payload) => broker.resume(requireObject(payload).id),
    [FOLDER_CHANNELS.revoke]: (_event, payload) => broker.revoke(requireObject(payload).id),
    [FOLDER_CHANNELS.listDir]: (_event, payload) => {
      const { id, path } = requireObject(payload);
      return broker.listDir(id, path);
    },
    [FOLDER_CHANNELS.readFile]: (_event, payload) => {
      const { id, path, options } = requireObject(payload);
      return broker.readFile(id, path, options);
    },
    [FOLDER_CHANNELS.search]: (_event, payload) => {
      const { id, query, options } = requireObject(payload);
      return broker.search(id, query, options);
    },
    [FOLDER_CHANNELS.activity]: () => broker.activity(),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!trusted(isTrustedSender, event)) return { ok: false, code: "untrusted_sender", message: UNTRUSTED_MESSAGE };
      try {
        return { ok: true, data: await handler(event, payload) };
      } catch (err) {
        return failure(err);
      }
    });
  }

  // Synchronous on purpose: the preload asks while it runs, before the page's scripts do. Any
  // other sender, or any failure, gets null and the bridge is not exposed.
  ipcMain.on(FOLDER_CHANNELS.origin, (event) => {
    // Always answer: a synchronous call that gets no reply blocks the page.
    let origin = null;
    try {
      const value = trusted(isTrustedSender, event) ? runtimeOrigin() : null;
      origin = typeof value === "string" ? value : null;
    } catch {
      origin = null;
    }
    event.returnValue = origin;
  });
}

/**
 * The onActivity callback for createBroker(): sends each entry to every live app window. Only the
 * windows the caller lists receive it, and a window that is closing never changes the broker.
 */
export function folderActivityForwarder(contents) {
  return (entry) => {
    for (const wc of contents()) {
      try {
        if (!wc.isDestroyed()) wc.send(FOLDER_ACTIVITY_EVENT, entry);
      } catch {
        // A window closing mid-send must not change what the broker did.
      }
    }
  };
}
