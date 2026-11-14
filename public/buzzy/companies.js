/* Company tabs shared by Jobs, Chat, Library, and Memory.
   The active company is kept in localStorage so a switch moves the whole workspace.
   Adding from a website shows a card. A line is a company fact only after Confirm or Change. */
(function () {
  // One document-wide store: soft pages share the header and live Talk listeners.
  if (window.BZCompanies) return;
  var KEY = "bz_active_company";
  var state = { companies: [], activeId: null, ready: false, started: false, signedOut: false, loadError: false };
  var listeners = [];
  var mounts = [];
  var adding = false;
  var addMode = "website";
  var busy = false;
  var err = "";
  var draftUrl = "";
  var draftName = "";
  var editingId = "";
  var editDraft = "";
  var cardMode = "hidden"; // hidden | view | edit
  var creator = null;
  var selectionRevision = 0;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function injectStyle() {
    if (document.getElementById("bz-co-style")) return;
    var style = document.createElement("style");
    style.id = "bz-co-style";
    style.textContent =
      "#companyTabs{background:#141414;border-bottom:1px solid #222}" +
      ".bz-co-bar{max-width:1120px;margin:0 auto;padding:0.55rem 1.5rem 0.7rem;display:flex;flex-wrap:wrap;gap:0.45rem;align-items:center}" +
      ".bz-co-empty{color:#9a9a9a;font-size:0.85rem;margin-right:0.25rem}" +
      ".bz-co-tab{font:inherit;font-size:0.85rem;padding:0.38rem 0.8rem;border-radius:999px;border:1px solid #3a3a3a;background:transparent;color:#C9CDD2;cursor:pointer;font-weight:600}" +
      ".bz-co-tab.is-on{background:#FFC107;color:#0A0A0A;border-color:#FFC107;font-weight:800;box-shadow:0 0 0 2px #FFC107}" +
      ".bz-co-add{font:inherit;font-size:0.85rem;padding:0.38rem 0.8rem;border-radius:999px;border:1px dashed #B8860B;background:transparent;color:#FFC107;cursor:pointer;font-weight:700}" +
      ".bz-co-form,.bz-co-wait{max-width:1120px;margin:0 auto;padding:0 1.5rem 0.75rem;display:flex;flex-wrap:wrap;gap:0.45rem;align-items:center}" +
      ".bz-co-form input{font:inherit;padding:0.45rem 0.6rem;border-radius:6px;border:1px solid #333;background:#0A0A0A;color:#fff;min-width:16rem}" +
      ".bz-co-form button,.bz-co-line button,.bz-co-edit button{font:inherit;font-size:0.85rem;padding:0.42rem 0.75rem;border-radius:6px;border:1px solid #FFC107;background:#FFC107;color:#0A0A0A;font-weight:800;cursor:pointer}" +
      ".bz-co-form button.bz-co-cancel,.bz-co-form button.bz-co-byname,.bz-co-line button.bz-co-quiet,.bz-co-edit button.bz-co-quiet{background:transparent;color:#FFC107}" +
      ".bz-co-line button.bz-co-drop{background:transparent;color:#e7b1b1;border-color:#5a3030}" +
      ".bz-co-err{color:#C45B5B;font-size:0.8rem}" +
      ".bz-co-wait{color:#C9CDD2;font-size:0.9rem}" +
      ".bz-co-card{max-width:1120px;margin:0 auto;padding:0 1.5rem 1rem}" +
      ".bz-co-card-inner{background:#0A0A0A;border:1px solid #2A2A2A;border-radius:10px;padding:0.9rem 1rem 0.4rem}" +
      ".bz-co-card h2{font-size:1.05rem;margin:0 0 0.35rem;color:#fff}" +
      ".bz-co-card .bz-co-lead{margin:0 0 0.35rem;color:#C9CDD2;font-size:0.9rem}" +
      ".bz-co-line{border-top:1px solid #222;padding:0.7rem 0}" +
      ".bz-co-k{color:#9a9a9a;font-size:0.72rem;font-weight:700;letter-spacing:0.03em;text-transform:uppercase}" +
      ".bz-co-val{display:block;color:#fff;font-size:0.98rem;margin:0.15rem 0}" +
      ".bz-co-src{color:#9a9a9a;font-size:0.78rem;margin:0.15rem 0 0.45rem}" +
      ".bz-co-src a{color:#FFC107}" +
      ".bz-co-confirmed{color:#8FCB9B;font-size:0.78rem;font-weight:700}" +
      ".bz-co-edit input{font:inherit;padding:0.4rem 0.55rem;border-radius:6px;border:1px solid #333;background:#141414;color:#fff;width:min(36rem,100%);display:block;margin:0.35rem 0}" +
      ".bz-co-tools{margin-left:auto;display:inline-flex;gap:0.4rem;align-items:center}" +
      ".bz-co-view,.bz-co-edit-btn{font:inherit;font-size:0.8rem;padding:0.32rem 0.6rem;border-radius:6px;border:1px solid #3a3a3a;background:transparent;color:#C9CDD2;cursor:pointer;font-weight:600}" +
      ".bz-co-view.is-on,.bz-co-edit-btn.is-on{background:#2A2A2A;color:#FFC107;border-color:#FFC107}" +
      ".bz-co-details{margin:0.4rem 0 0.8rem}" +
      ".bz-co-details input{font:inherit;padding:0.4rem 0.55rem;border-radius:6px;border:1px solid #333;background:#141414;color:#fff;width:min(36rem,100%);display:block;margin:0.2rem 0 0.5rem}" +
      ".bz-co-save-details{font:inherit;font-size:0.85rem;padding:0.42rem 0.75rem;border-radius:6px;border:1px solid #FFC107;background:#FFC107;color:#0A0A0A;font-weight:800;cursor:pointer}";
    document.head.appendChild(style);
  }

  function active() {
    for (var i = 0; i < state.companies.length; i++) {
      if (state.companies[i].id === state.activeId) return state.companies[i];
    }
    return null;
  }

  function emit() {
    var current = active();
    // Non-keepalive pages must not keep reading/writing through a detached
    // callback. Talk stays connected inside the shell cache and still follows
    // company changes; old Memory/Library roots and replaced headers do not.
    listeners = listeners.filter(function (listener) { return !listener.owner || listener.owner.isConnected; });
    listeners.slice().forEach(function (listener) {
      if ((listener.owner && !listener.owner.isConnected) || listeners.indexOf(listener) < 0) return;
      try { listener.fn(current); } catch (e) { /* a page refresh must not break the tabs */ }
    });
  }

  function replaceCompany(company) {
    if (!company || !company.id) return;
    var found = false;
    state.companies = state.companies.map(function (c) {
      if (c.id !== company.id) return c;
      found = true;
      return company;
    });
    if (!found) state.companies.push(company);
  }

  function pageHref(page) {
    return /^https?:\/\//i.test(page || "") ? page : "";
  }

  function sourceHtml(line) {
    var page = pageHref(line.page);
    var link = page ? '<a href="' + esc(page) + '" target="_blank" rel="noopener">' + esc(page) + "</a>" : esc(line.page || "");
    var lead = line.edited ? "You changed this. Started from the website" : "from the website";
    return lead + (link ? " · " + link : "");
  }

  function cardHtml(company, readOnly) {
    var lines = (company && company.lines) || [];
    var html = '<section class="bz-co-card"><div class="bz-co-card-inner">';
    if (readOnly) {
      html += "<h2>About " + esc(company.name) + "</h2>";
      if (company.oneLiner) html += '<p class="bz-co-lead">' + esc(company.oneLiner) + "</p>";
    } else {
      html += '<div class="bz-co-details">' +
        '<label class="bz-co-k">Company name</label>' +
        '<input data-name value="' + esc(company.name) + '" maxlength="80">' +
        '<label class="bz-co-k">What they do — one line</label>' +
        '<input data-oneliner value="' + esc(company.oneLiner || "") + '" maxlength="280">' +
        '<button type="button" class="bz-co-save-details" data-act="save-details">Save details</button>' +
        "</div>";
    }
    lines.forEach(function (line) {
      var confirmed = line.status === "confirmed";
      html += '<div class="bz-co-line" data-line="' + esc(line.id) + '">';
      html += '<div class="bz-co-k">' + esc(line.label || line.key) + "</div>";
      if (!readOnly && editingId === line.id) {
        html += '<div class="bz-co-edit">' +
          '<input data-edit value="' + esc(editDraft) + '" maxlength="280">' +
          '<button type="button" data-act="save">Save</button>' +
          '<button type="button" class="bz-co-quiet" data-act="cancel-edit">Cancel</button>' +
          "</div>";
      } else {
        html += '<b class="bz-co-val">' + esc(line.value) + "</b>";
        html += '<div class="bz-co-src">' +
          (confirmed ? '<span class="bz-co-confirmed">Confirmed</span> · ' : "") +
          sourceHtml(line) + "</div>";
        if (!readOnly) {
          if (!confirmed) html += '<button type="button" data-act="confirm">Confirm</button>';
          html += '<button type="button" class="bz-co-quiet" data-act="change">Change</button>';
          html += '<button type="button" class="bz-co-drop" data-act="drop">Drop</button>';
        }
      }
      html += "</div>";
    });
    if (err) html += '<p class="bz-co-err">' + esc(err) + "</p>";
    html += "</div></section>";
    return html;
  }

  function renderInto(el) {
    var current = active();
    var html = '<div class="bz-co-bar" role="tablist" aria-label="Companies">';
    if (!state.companies.length) html += '<span class="bz-co-empty">No company yet</span>';
    state.companies.forEach(function (c) {
      var on = c.id === state.activeId;
      html += '<button type="button" class="bz-co-tab' + (on ? " is-on" : "") + '" role="tab" aria-selected="' +
        (on ? "true" : "false") + '" data-co="' + esc(c.id) + '"' +
        (on ? ' title="Current company"' : "") + ">" + esc(c.name) + "</button>";
    });
    html += '<button type="button" class="bz-co-add">Add company</button>';
    if (current) {
      html += '<span class="bz-co-tools">' +
        '<button type="button" class="bz-co-view' + (cardMode === "view" ? " is-on" : "") + '" data-tool="view">View</button>' +
        '<button type="button" class="bz-co-edit-btn' + (cardMode === "edit" ? " is-on" : "") + '" data-tool="edit">Edit</button>' +
        "</span>";
    }
    html += "</div>";
    if (adding && busy) {
      html += '<p class="bz-co-wait">' +
        (addMode === "name" ? "Adding this company…" : "Reading the public website…") +
        "</p>";
    } else if (adding && addMode === "name") {
      html += '<form class="bz-co-form">' +
        '<label>Company name <input name="name" maxlength="80" required placeholder="The name you use for this business" value="' + esc(draftName) + '"></label>' +
        '<button type="submit">Add company</button>' +
        '<button type="button" class="bz-co-cancel">Cancel</button>' +
        '<button type="button" class="bz-co-byname" data-mode="website">Use a website instead</button>' +
        (err ? '<span class="bz-co-err">' + esc(err) + "</span>" : "") +
        "</form>";
    } else if (adding) {
      html += '<form class="bz-co-form">' +
        '<label>Website <input name="url" maxlength="300" required placeholder="yourbusiness.com" value="' + esc(draftUrl) + '"></label>' +
        '<button type="submit">Read the website</button>' +
        '<button type="button" class="bz-co-cancel">Cancel</button>' +
        '<button type="button" class="bz-co-byname" data-mode="name">No website — use a name</button>' +
        (err ? '<span class="bz-co-err">' + esc(err) + "</span>" : "") +
        "</form>";
    }
    if (current && !adding && cardMode !== "hidden") html += cardHtml(current, cardMode === "view");
    el.innerHTML = html;
    el.querySelectorAll(".bz-co-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        editingId = "";
        err = "";
        var id = btn.getAttribute("data-co");
        if (id === state.activeId) { renderAll(); return; }
        select(id);
      });
    });
    el.querySelectorAll("[data-tool]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var t = btn.getAttribute("data-tool");
        cardMode = cardMode === t ? "hidden" : t;
        err = "";
        editingId = "";
        renderAll();
      });
    });
    var add = el.querySelector(".bz-co-add");
    if (add) add.addEventListener("click", function () {
      adding = true;
      addMode = "website";
      err = "";
      editingId = "";
      cardMode = "hidden";
      renderAll();
    });
    var form = el.querySelector(".bz-co-form");
    if (form) {
      var input = form.querySelector("input");
      if (input) input.focus();
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (busy) return;
        if (addMode === "name") {
          draftName = input ? input.value.trim() : "";
          if (!draftName) { err = "Type the company name."; renderAll(); return; }
          create(draftName);
          return;
        }
        draftUrl = input ? input.value.trim() : "";
        if (!draftUrl) { err = "Paste the website, like yourbusiness.com."; renderAll(); return; }
        createFromWebsite(draftUrl);
      });
      form.querySelector(".bz-co-cancel").addEventListener("click", function () {
        adding = false;
        err = "";
        renderAll();
      });
      var modeBtn = form.querySelector("[data-mode]");
      if (modeBtn) modeBtn.addEventListener("click", function () {
        addMode = modeBtn.getAttribute("data-mode") === "name" ? "name" : "website";
        err = "";
        renderAll();
      });
    }
    el.querySelectorAll(".bz-co-line").forEach(function (block) {
      var lineId = block.getAttribute("data-line");
      block.querySelectorAll("[data-act]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var act = btn.getAttribute("data-act");
          if (act === "cancel-edit") { editingId = ""; err = ""; renderAll(); return; }
          if (act === "change") {
            var line = ((current && current.lines) || []).filter(function (l) { return l.id === lineId; })[0];
            editingId = lineId;
            editDraft = line ? line.value : "";
            err = "";
            renderAll();
            return;
          }
          if (act === "save") {
            var field = block.querySelector("[data-edit]");
            editDraft = field ? field.value.trim() : "";
            if (!editDraft) { err = "Type what this line should say."; renderAll(); return; }
            actLine(current.id, lineId, "edit", editDraft);
            return;
          }
          if (act === "confirm") actLine(current.id, lineId, "confirm");
          if (act === "drop") actLine(current.id, lineId, "drop");
        });
      });
    });
    var saveDetails = el.querySelector("[data-act='save-details']");
    if (saveDetails) saveDetails.addEventListener("click", function () {
      var nameEl = el.querySelector("[data-name]");
      var oneEl = el.querySelector("[data-oneliner]");
      var name = nameEl ? nameEl.value.trim() : "";
      if (!name) { err = "Type the company name."; renderAll(); return; }
      saveCompanyDetails(current.id, name, oneEl ? oneEl.value.trim() : "");
    });
  }

  function renderAll() {
    injectStyle();
    mounts.forEach(renderInto);
  }

  function select(id) {
    if (!id || state.activeId === id) return;
    var known = state.companies.some(function (c) { return c.id === id; });
    if (!known) return;
    selectionRevision++;
    closeCreate(false);
    state.activeId = id;
    cardMode = "hidden";
    try { localStorage.setItem(KEY, id); } catch (e) { /* private mode */ }
    renderAll();
    emit();
  }

  function rememberActive() {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    var known = state.companies.some(function (c) { return c.id === saved; });
    state.activeId = known ? saved : (state.companies[0] ? state.companies[0].id : null);
    if (state.activeId) {
      try { localStorage.setItem(KEY, state.activeId); } catch (e) { /* private mode */ }
    }
  }

  function load() {
    return fetch("/api/buzzy/companies", { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) {
        state.signedOut = r.status === 401;
        state.loadError = !r.ok;
        return r.ok ? r.json() : { companies: [] };
      })
      .then(function (d) {
        state.loadError = state.loadError || !(d && Array.isArray(d.companies));
        state.companies = d && Array.isArray(d.companies) ? d.companies : [];
        rememberActive();
        state.ready = true;
        renderAll();
        emit();
      })
      .catch(function () {
        state.loadError = true;
        state.ready = true;
        renderAll();
        emit();
      });
  }

  function applyCreated(company) {
    replaceCompany(company);
    state.activeId = company.id;
    try { localStorage.setItem(KEY, company.id); } catch (e) { /* private mode */ }
    adding = false;
    busy = false;
    err = "";
    draftUrl = "";
    draftName = "";
    editingId = "";
    cardMode = company && company.lines && company.lines.length ? "edit" : "hidden";
    renderAll();
    emit();
  }

  function readJson(r) {
    return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; })
      .catch(function () { return { ok: false, status: r.status, data: {} }; });
  }

  function create(name) {
    err = "";
    busy = true;
    renderAll();
    fetch("/api/buzzy/companies", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: name }),
    }).then(readJson).then(function (res) {
      busy = false;
      if (res.status === 401) { err = "Sign in to add a company."; renderAll(); return; }
      var company = res.data && res.data.company;
      if (!res.ok || !company) { err = (res.data && res.data.error) || "Couldn't add that company."; renderAll(); return; }
      applyCreated(company);
    }).catch(function () {
      busy = false;
      err = "Couldn't add that company. Try again.";
      renderAll();
    });
  }

  function createFromWebsite(url) {
    err = "";
    busy = true;
    renderAll();
    fetch("/api/buzzy/companies/from-website", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url: url }),
    }).then(readJson).then(function (res) {
      busy = false;
      if (res.status === 401) { err = "Sign in to add a company."; adding = true; renderAll(); return; }
      var company = res.data && res.data.company;
      if (!res.ok || !company) {
        err = (res.data && res.data.error) || "BeeZilla couldn't read that website.";
        adding = true;
        renderAll();
        return;
      }
      applyCreated(company);
    }).catch(function () {
      busy = false;
      adding = true;
      err = "BeeZilla couldn't read that website. Try again.";
      renderAll();
    });
  }

  function actLine(companyId, lineId, action, value) {
    if (!companyId || !lineId || busy) return;
    err = "";
    busy = true;
    fetch("/api/buzzy/companies/" + encodeURIComponent(companyId) + "/lines", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ lineId: lineId, action: action, value: value }),
    }).then(readJson).then(function (res) {
      busy = false;
      if (res.status === 401) { err = "Sign in to keep this line."; renderAll(); return; }
      var company = res.data && res.data.company;
      if (!res.ok || !company) { err = (res.data && res.data.error) || "Couldn't update that line."; renderAll(); return; }
      editingId = "";
      replaceCompany(company);
      renderAll();
      emit();
    }).catch(function () {
      busy = false;
      err = "Couldn't update that line. Try again.";
      renderAll();
    });
  }

  function saveCompanyDetails(companyId, name, oneLiner) {
    if (!companyId || busy) return;
    err = "";
    busy = true;
    fetch("/api/buzzy/companies/" + encodeURIComponent(companyId), {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: name, one_liner: oneLiner }),
    }).then(readJson).then(function (res) {
      busy = false;
      if (res.status === 401) { err = "Sign in to edit this company."; renderAll(); return; }
      var company = res.data && res.data.company;
      if (!res.ok || !company) { err = (res.data && res.data.error) || "Couldn't save the company."; renderAll(); return; }
      replaceCompany(company);
      renderAll();
      emit();
    }).catch(function () {
      busy = false;
      err = "Couldn't save the company. Try again.";
      renderAll();
    });
  }

  // The header's Add action is a small, name-only flow. It does not navigate
  // away from a live conversation or expose website import as a side effect.
  function closeCreate(restoreFocus) {
    var current = creator;
    if (!current) return;
    creator = null; // late POST/JSON completion cannot choose a company
    if (current.dialog.open) current.dialog.close();
    current.dialog.remove();
    if (restoreFocus !== false && current.opener && current.opener.isConnected) current.opener.focus();
  }

  function createCurrent(current) {
    return creator === current && current.dialog.isConnected && current.dialog.open &&
      window.BZCompanies === api && current.revision === selectionRevision &&
      current.activeId === state.activeId && current.href === window.location.href &&
      !(window.BeeZillaShell && window.BeeZillaShell.busy);
  }

  function openCreate(opener) {
    if (!state.ready || (window.BeeZillaShell && window.BeeZillaShell.busy)) return;
    if (creator && createCurrent(creator)) {
      if (!creator.pending) creator.input.focus();
      return;
    }
    closeCreate(false);
    var dialog = document.createElement("dialog");
    dialog.id = "bzCompanyCreate";
    dialog.setAttribute("aria-labelledby", "bzCompanyCreateTitle");
    var style = document.createElement("style");
    // Keep these styles with the dialog, not in a page-owned head stylesheet
    // which the shell disables while another page is active.
    style.textContent =
      "#bzCompanyCreate{width:min(28rem,calc(100vw - 2rem));box-sizing:border-box;padding:1.4rem;border:1px solid #444;border-radius:12px;background:#141414;color:#f2f2f2;font:16px/1.5 system-ui,sans-serif}" +
      "#bzCompanyCreate::backdrop{background:rgba(0,0,0,.65)}" +
      "#bzCompanyCreate h2{font-size:1.25rem;margin:0 0 .5rem}#bzCompanyCreate p{font-size:.9rem;margin:.6rem 0}" +
      "#bzCompanyCreate label{display:block}#bzCompanyCreate input{box-sizing:border-box;width:100%;margin:.4rem 0 .8rem;padding:.6rem;border:1px solid #777;border-radius:6px;background:#0a0a0a;color:#fff;font:inherit}" +
      "#bzCompanyCreate button{font:inherit;margin:.3rem .5rem 0 0;padding:.45rem .8rem;border:1px solid #ffc107;border-radius:6px;background:#ffc107;color:#111;cursor:pointer}" +
      "#bzCompanyCreate button[data-company-cancel]{background:transparent;color:#ffc107}#bzCompanyCreate button:disabled{opacity:.55;cursor:wait}" +
      "#bzCompanyCreateStatus{min-height:1.5em}#bzCompanyCreate :focus-visible{outline:2px solid #ffc107;outline-offset:3px}";
    dialog.appendChild(style);
    var title = document.createElement("h2");
    title.id = "bzCompanyCreateTitle"; title.textContent = "Add a company"; dialog.appendChild(title);
    var intro = document.createElement("p");
    intro.textContent = "Use the name you use for this business. It will become your active company after it is saved.";
    dialog.appendChild(intro);
    var form = document.createElement("form");
    var label = document.createElement("label");
    label.textContent = "Company name";
    var input = document.createElement("input");
    input.id = "bzCompanyCreateName"; input.name = "name"; input.type = "text";
    input.maxLength = 80; input.required = true; input.autocomplete = "organization";
    label.appendChild(input); form.appendChild(label);
    var submit = document.createElement("button");
    submit.type = "submit"; submit.textContent = "Add company"; form.appendChild(submit);
    var cancel = document.createElement("button");
    cancel.type = "button"; cancel.textContent = "Cancel"; cancel.setAttribute("data-company-cancel", ""); form.appendChild(cancel);
    var status = document.createElement("p");
    status.id = "bzCompanyCreateStatus"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    form.appendChild(status); dialog.appendChild(form);
    var current = { dialog: dialog, input: input, opener: opener, pending: false,
      revision: selectionRevision, activeId: state.activeId, href: window.location.href };
    creator = current;
    function fail(message, uncertain) {
      if (!createCurrent(current)) return;
      current.pending = false;
      input.disabled = false;
      submit.disabled = !!uncertain;
      cancel.textContent = "Close";
      status.textContent = message;
      input.focus();
    }
    var uncertain = "Couldn't confirm whether the company was added. Close this form and reload the page to check before trying again.";
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!createCurrent(current) || current.pending || submit.disabled) return;
      var name = input.value.trim().replace(/\s+/g, " ");
      if (!name || name.length > 80) { status.textContent = "Enter a company name of 1 to 80 characters."; input.focus(); return; }
      current.pending = true;
      input.disabled = true; submit.disabled = true; cancel.textContent = "Close";
      status.textContent = "Adding company… Closing won't undo a request already sent.";
      fetch("/api/buzzy/companies", { method: "POST", credentials: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ name: name }), signal: AbortSignal.timeout(15000),
      }).then(function (response) {
        if (!createCurrent(current)) return null;
        return readJson(response);
      }).then(function (res) {
        if (!createCurrent(current) || !res) return;
        if (res.status === 401) { fail("Sign in to add a company.", false); return; }
        if (res.status === 403) { fail("You don't have permission to add this company.", false); return; }
        if (res.status === 400) { fail("Couldn't add that company. Check the name and try again.", false); return; }
        var company = res.data && res.data.company;
        if (!res.ok || !company || typeof company.id !== "string" || !/^co_[a-z0-9]{8,32}$/.test(company.id) ||
            typeof company.name !== "string" || !company.name.trim() || company.name.length > 80) {
          fail(uncertain, true); return;
        }
        // This exact owner-authenticated response is the authority. Never
        // select an optimistic ID or let a retired form replace a newer choice.
        closeCreate();
        replaceCompany(company);
        select(company.id);
      }).catch(function () { fail(uncertain, true); });
    });
    cancel.addEventListener("click", function () { if (creator === current) closeCreate(); });
    dialog.addEventListener("cancel", function (event) { event.preventDefault(); if (creator === current) closeCreate(); });
    dialog.addEventListener("close", function () { if (creator === current) closeCreate(); });
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
  }

  if (window.addEventListener) {
    window.addEventListener("popstate", function () { closeCreate(false); });
    window.addEventListener("pagehide", function () { closeCreate(false); });
  }

  var api = {
    ready: function () { return state.ready; },
    // Memory must distinguish a verified empty account from a failed lookup.
    loadError: function () { return state.loadError; },
    list: function () { return state.companies.slice(); },
    active: active,
    activeId: function () { return state.activeId; },
    // The chrome's dropdown needs to switch companies without rendering tabs.
    select: select,
    openCreate: openCreate,
    closeCreate: closeCreate,
    onChange: function (fn, ownerElement) {
      // Registration runs in the live page's bootstrap. A hard load has no
      // #bzPage wrapper yet; its main/app node moves with that page later.
      var page = document.getElementById("bzPage");
      var owner = ownerElement || (page && (page.querySelector("main") || page)) ||
        document.querySelector("main") || document.getElementById("app");
      var listener = { fn: fn, owner: owner };
      if (!owner || owner.isConnected) {
        listeners.push(listener);
        if (state.ready) {
          try { fn(active()); } catch (e) { /* page owns its error */ }
        }
      }
      return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
    },
    mount: function (el) {
      if (!el || mounts.indexOf(el) >= 0) return;
      mounts.push(el);
      if (state.ready) renderInto(el);
    },
  };
  window.BZCompanies = api;

  function boot() {
    injectStyle();
    // BZ-23: this used to be an unscoped getElementById("companyTabs"), which can
    // hand back a copy sitting inside #bzPageCache (soft nav keeps the previous
    // page alive there) instead of the live page's own node — the mount then
    // renders into a display:none subtree and the visible control is empty.
    // Only ever mount into the live page.
    var el = document.querySelector("#bzPage #companyTabs") ||
             (function () {
               var cand = document.getElementById("companyTabs");
               if (cand && (cand.closest("#bzPageCache") || cand.closest("#bzChrome"))) return null;
               return cand;
             })();
    if (el) api.mount(el);
    if (!state.started) { state.started = true; load(); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
