import { parsePdf } from "./pdfparse.js";
import { suggestName, DEFAULT_SETTINGS } from "./rename.js";

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };

// Each picked file gets an entry we can re-render when the template changes,
// without re-parsing the PDF.
let seq = 0;
const entries = new Map(); // id -> { file, parsed, name, el, done }

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.sync.get({ settings: DEFAULT_SETTINGS });
  settings = { ...DEFAULT_SETTINGS, ...stored.settings };
  $("template").value = settings.template;
  $("separator").value = settings.separator;
  $("illegal").value = settings.illegalReplacement;
  $("lowercase").checked = !!settings.lowercase;
}

async function saveSettings() {
  settings = {
    ...settings,
    template: $("template").value.trim() || DEFAULT_SETTINGS.template,
    separator: $("separator").value,
    illegalReplacement: $("illegal").value || "-",
    lowercase: $("lowercase").checked,
  };
  await chrome.storage.sync.set({ settings });
  // Re-suggest names for everything already parsed.
  for (const e of entries.values()) {
    if (e.parsed) {
      e.name = suggestName(e.parsed, settings).name;
      const input = e.el.querySelector(".name");
      if (input && !e.edited) input.value = e.name;
    }
  }
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

function addFiles(fileList) {
  const files = [...fileList].filter(
    (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)
  );
  if (!files.length) return;
  $("list").hidden = false;
  $("bulk").hidden = false;
  for (const file of files) processFile(file);
}

async function processFile(file) {
  const id = ++seq;
  const el = renderRow(id, file.name);
  const entry = { file, parsed: null, name: "", el, done: false, edited: false };
  entries.set(id, entry);
  el.classList.add("busy");
  try {
    const parsed = await parsePdf(file);
    const { name, parsed: fields } = suggestName(parsed, settings);
    entry.parsed = parsed;
    entry.name = name;
    fillRow(el, { name, parsed: fields });
  } catch (err) {
    el.classList.add("err");
    el.querySelector(".orig").textContent = file.name + " — could not read this PDF";
    // Fall back to a date-stamped name so the row is still usable.
    entry.name = suggestName({ originalName: file.name }, settings).name;
    fillRow(el, { name: entry.name, parsed: { type: "document", titleSource: "none" } });
  } finally {
    el.classList.remove("busy");
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderRow(id, origName) {
  const el = document.createElement("div");
  el.className = "row";
  el.dataset.id = String(id);
  el.innerHTML = `
    <div class="orig"></div>
    <div class="arrow">↓ renamed to</div>
    <div class="name-line">
      <input class="name" spellcheck="false" />
      <button class="apply">Save</button>
    </div>
    <div class="badges"></div>`;
  el.querySelector(".orig").textContent = origName;
  el.querySelector(".apply").addEventListener("click", () => applyOne(id));
  el.querySelector(".name").addEventListener("input", () => {
    entries.get(id).edited = true;
    entries.get(id).name = el.querySelector(".name").value;
  });
  $("list").appendChild(el);
  return el;
}

function fillRow(el, { name, parsed }) {
  el.querySelector(".name").value = name;
  const badges = el.querySelector(".badges");
  badges.innerHTML = "";
  if (parsed) {
    add(badges, parsed.type || "document", "type");
    const src = parsed.titleSource;
    if (src === "metadata") add(badges, "from metadata");
    else if (src === "firstpage") add(badges, "from page title");
    if (parsed.id) add(badges, parsed.id.split("-")[0]);
    if (parsed.year) add(badges, parsed.year);
  }
}

function add(container, text, cls) {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? " " + cls : "");
  b.textContent = text;
  container.appendChild(b);
}

// ---------------------------------------------------------------------------
// Applying (save a renamed copy via the downloads API)
// ---------------------------------------------------------------------------

function download(file, filename) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        // Revoke once the download has been handed off.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (chrome.runtime.lastError || downloadId == null) {
          reject(new Error(chrome.runtime.lastError?.message || "download failed"));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

async function applyOne(id) {
  const e = entries.get(id);
  if (!e || e.done) return;
  const name = e.el.querySelector(".name").value.trim() || e.name;
  const safe = /\.pdf$/i.test(name) ? name : name + ".pdf";
  try {
    await download(e.file, safe);
    e.done = true;
    e.el.classList.add("done");
    e.el.querySelector(".apply").textContent = "Saved ✓";
  } catch (err) {
    e.el.querySelector(".apply").textContent = "Retry";
  }
}

async function applyAll() {
  for (const id of entries.keys()) {
    // Small stagger keeps Chrome from collapsing rapid-fire downloads.
    await applyOne(id);
    await new Promise((r) => setTimeout(r, 120));
  }
}

function clearAll() {
  entries.clear();
  $("list").innerHTML = "";
  $("list").hidden = true;
  $("bulk").hidden = true;
  $("file").value = "";
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireDrop() {
  const drop = $("drop");
  drop.addEventListener("click", () => $("file").click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); }
  });
  $("file").addEventListener("change", (e) => addFiles(e.target.files));
  ["dragenter", "dragover"].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("dragging"); })
  );
  ["dragleave", "drop"].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("dragging"); })
  );
  drop.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
}

function wireSettings() {
  for (const id of ["template", "separator", "illegal", "lowercase"]) {
    const ev = id === "template" || id === "illegal" ? "input" : "change";
    $(id).addEventListener(ev, saveSettings);
  }
}

function initTabContext() {
  const inTab = new URLSearchParams(location.search).get("tab") === "1";
  if (inTab) {
    document.body.classList.add("in-tab");
    $("openTab").hidden = true;
  } else {
    $("openTab").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?tab=1") });
      window.close();
    });
  }
}

async function init() {
  initTabContext();
  await loadSettings();
  wireDrop();
  wireSettings();
  $("applyAll").addEventListener("click", applyAll);
  $("clear").addEventListener("click", clearAll);
}

init();
