/* Folders BeeZilla can read: the Settings section that drives window.beezillaFolders.
 * Desktop only. A browser tab has no bridge, so the section stays hidden there.
 * Every value from the main process is written with textContent. Nothing here parses HTML. */
(function () {
  "use strict";
  const api = window.beezillaFolders;
  const section = document.getElementById("folders");
  if (!api || !section) return;
  section.hidden = false;

  const SHOWN = 50; // newest activity entries kept on the page
  const ADD_LABEL = "Add a folder…"; // the label the button returns to after a pick
  const GRANT_OPS = ["grant", "activate", "pause", "resume", "revoke"];
  const ACTION = {
    grant: "Added folder", activate: "Turned on", pause: "Paused", resume: "Resumed",
    revoke: "Removed", listDir: "Listed folder", readFile: "Read file", search: "Searched",
  };
  const STOPPED = { limit: "stopped at the match limit", maxFiles: "stopped at the file limit" };

  const addButton = document.getElementById("folders-add");
  const status = document.getElementById("folders-status");
  const list = document.getElementById("folders-list");
  const emptyList = document.getElementById("folders-empty");
  const feed = document.getElementById("folders-activity");
  const emptyFeed = document.getElementById("folders-activity-empty");

  let grants = []; // broker summaries, in the order the broker lists them
  let activity = []; // newest first, at most SHOWN entries
  let asking = null; // id of the grant whose Remove is waiting for confirmation
  let focusRequest = null; // { id, target } applied once, after the next draw

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === "text") node.textContent = value;
      else if (key === "className") node.className = value;
      else node.setAttribute(key, value);
    }
    if (children) node.append(...children);
    return node;
  }

  function say(text, kind) {
    status.textContent = text;
    status.className = `status ${kind || ""}`.trim();
  }

  function stateOf(grant) {
    if (grant.revoked) return { word: "Removed", kind: "removed" };
    if (grant.paused) return { word: "Paused", kind: "paused" };
    return grant.active ? { word: "On", kind: "on" } : { word: "Off", kind: "off" };
  }

  function button(label, grant, onClick, secondary) {
    const node = el("button", {
      type: "button",
      className: secondary ? "secondary" : "",
      text: label,
      "aria-label": `${label}: ${grant.label}`,
    });
    node.addEventListener("click", onClick);
    return node;
  }

  // nodes collects the focusable buttons of each row, so a request can name one after the draw.
  function grantRow(grant, nodes) {
    const state = stateOf(grant);
    const row = el("li", { className: "folder" }, [
      el("div", { className: "folder-head" }, [
        el("strong", { text: grant.label }),
        el("span", { className: `pill ${state.kind}`, text: state.word }),
      ]),
      el("code", { className: "folder-path", text: grant.root }),
    ]);
    if (grant.revoked) return row; // a removed folder keeps its line for this session, with no actions

    if (asking === grant.id) {
      const keep = button("Keep folder", grant, () => {
        asking = null;
        focusRequest = { id: grant.id, target: "remove" };
        draw();
      }, true);
      const remove = button("Remove folder", grant, () => {
        asking = null;
        void act(() => api.revoke(grant.id), `Removed “${grant.label}”. Add it again to read it.`);
      }, false);
      remove.className = "danger";
      nodes[grant.id] = { keep };
      row.append(
        el("p", {
          className: "folder-confirm",
          text: `Remove “${grant.label}”? This is final: BeeZilla forgets the folder and cannot read it until you add it again. Nothing in the folder is changed.`,
        }),
        el("div", { className: "folder-actions" }, [keep, remove]),
      );
      return row;
    }

    const actions = el("div", { className: "folder-actions" });
    if (grant.paused) {
      actions.append(button("Resume", grant, () => act(() => api.resume(grant.id), `“${grant.label}” resumed.`)));
    } else if (grant.active) {
      actions.append(button("Pause", grant, () => act(() => api.pause(grant.id), `“${grant.label}” is paused. BeeZilla cannot read it until you resume.`)));
    } else {
      actions.append(button("Turn on", grant, () => act(() => api.activate(grant.id), `“${grant.label}” is on. BeeZilla can read it until you pause it or quit.`)));
    }
    const remove = button("Remove", grant, () => {
      asking = grant.id;
      focusRequest = { id: grant.id, target: "keep" };
      draw();
    }, true);
    actions.append(remove);
    nodes[grant.id] = { remove };
    row.append(actions);
    return row;
  }

  function draw() {
    const nodes = {};
    list.replaceChildren(...grants.map((grant) => grantRow(grant, nodes)));
    emptyList.hidden = grants.length > 0;
    if (focusRequest) {
      const target = nodes[focusRequest.id]?.[focusRequest.target];
      focusRequest = null;
      target?.focus();
    }
  }

  // Runs one broker call, says what happened, then redraws from the broker's own list.
  async function act(call, okText) {
    try {
      const res = await call();
      if (res && res.ok) say(okText, "ok");
      else say((res && res.message) || "That did not work.", "err");
    } catch {
      say("That did not work.", "err");
    }
    await refresh();
  }

  async function refresh() {
    try {
      const res = await api.list();
      if (!res || !res.ok) return say((res && res.message) || "Could not read the folder list.", "err");
      grants = res.data;
      draw();
    } catch {
      say("Could not read the folder list.", "err");
    }
  }

  function folderName(grantId) {
    if (!grantId) return "—";
    const grant = grants.find((g) => g.id === grantId);
    return grant ? grant.label : "a folder";
  }

  // The broker never records search text, so a search row shows no file and no query.
  function activityRow(entry) {
    const when = Number.isFinite(entry.at) ? new Date(entry.at).toLocaleTimeString() : "—";
    const file = entry.op === "listDir" && entry.path === "" ? "(top folder)" : (entry.path ?? "—");
    const cells = [
      el("time", { text: when }),
      el("span", { text: ACTION[entry.op] || "Action" }),
      el("span", { text: folderName(entry.grantId) }),
      el("span", { text: file }),
    ];
    const result = !entry.ok ? `refused (${entry.reason})` : entry.reason ? (STOPPED[entry.reason] || entry.reason) : "";
    if (result) cells.push(el("span", { className: "why", text: result }));
    return el("li", {}, cells);
  }

  function drawActivity() {
    feed.replaceChildren(...activity.map((entry) => activityRow(entry)));
    emptyFeed.hidden = activity.length > 0;
  }

  async function loadActivity() {
    try {
      const res = await api.activity();
      if (res && res.ok) {
        activity = res.data.slice(-SHOWN).reverse(); // the broker keeps the oldest first
        drawActivity();
      }
    } catch {
      // The list stays empty. Entries from now on still appear.
    }
  }

  const stopActivity = api.onActivity((entry) => {
    activity.unshift(entry);
    if (activity.length > SHOWN) activity.length = SHOWN;
    drawActivity();
    if (GRANT_OPS.includes(entry.op)) refresh();
  });
  window.addEventListener("pagehide", () => stopActivity());

  addButton.addEventListener("click", async () => {
    addButton.disabled = true;
    addButton.textContent = "Choosing…";
    try {
      const res = await api.pick();
      if (!res || !res.ok) say((res && res.message) || "No folder was added.", "err");
      else if (res.data && res.data.granted) say(`Added “${res.data.grant.label}”. It is off until you turn it on.`, "ok");
      else say("No folder was added.", "");
    } catch {
      say("No folder was added.", "err");
    } finally {
      addButton.disabled = false;
      addButton.textContent = ADD_LABEL;
      await refresh();
    }
  });

  void refresh();
  void loadActivity();
})();
