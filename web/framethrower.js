/**
 * The FrameThrower Reference node's body.
 *
 * One DOM widget for the whole node, and every native widget hidden behind it.
 * Comfy laid out its widgets and we laid out ours, and the seam between the two
 * is where the dead space and clipped fields lived. The native widgets stay —
 * they are what serialises into the workflow and what Python reads on execute —
 * but nothing draws them. The controls here write straight into their values.
 *
 * One surface. Earlier versions gave each row its own fill, which read as a
 * stack of black boxes bolted to the node rather than part of it. Everything is
 * now the same background separated by hairlines, and the references field is
 * the only framed element — it is a viewport into someone else's pictures, and
 * the white rule says so at any theme or zoom.
 *
 * Colour comes from Comfy's own variables so the node follows the user's theme.
 * Every one has a fallback, because a custom theme can leave any of them unset.
 *
 * CSS is injected from here rather than shipped as a sibling .css file because
 * the URL a custom node's assets are served from depends on the folder name on
 * disk, which we do not control — a renamed directory would give an unstyled
 * node and no error to explain it.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "FrameThrowerReference";
const PAGE_SIZE = 30;

/** One /status request per page load, shared by every node on the canvas. */
let statusPromise = null;

/** Every native widget, so they can all be hidden in one pass. */
const NATIVE = ["query", "mode", "index", "pinned"];

const MODES = [
    { key: "hybrid", label: "Hybrid" },
    { key: "semantic", label: "Semantic" },
    { key: "description", label: "Text" },
];

/**
 * Outfit — the face the FrameThrower landing page and app are set in, so a
 * frame arriving in a graph looks like it came from the same place it did.
 *
 * Bundled as a 14 KB latin subset rather than pulled from Google: a custom node
 * has no business making a request to a third party on every canvas load, and
 * plenty of ComfyUI installs are offline or behind a firewall, where a webfont
 * import is a silent stall followed by a fallback nobody chose.
 *
 * The URL is resolved at injection time from this file's own location, because
 * the path a node's assets are served from depends on the folder name on disk.
 */
const FONT_CSS = (url) => `
@font-face { font-family:'Outfit FT'; src:url('${url}') format('woff2');
  font-weight:300 600; font-style:normal; font-display:swap; }
`;

const CSS = `
.ft { --ft-line:var(--border-color,#3a3a3a);
  --ft-on:var(--p-primary-color,#2563eb);
  --ft-dim:var(--descrip-text,#9a9a9a);
  --ft-fg:var(--input-text,#e8e8e8);
  display:flex; flex-direction:column; height:100%; min-height:130px; overflow:hidden;
  color:var(--ft-fg); font-size:11px; font-weight:400;
  font-family:'Outfit FT','Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }

/* one row: search box and the mode it searches in */
.ft-search { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:0 2px 6px; }
.ft-search > svg { width:12px; height:12px; color:var(--ft-dim); flex:0 0 auto; }
.ft-search input { flex:1 1 auto; min-width:0; border:none; outline:none; background:transparent;
  color:var(--ft-fg); font:inherit; font-size:11.5px; padding:2px 0; }
.ft-search input::placeholder { color:var(--ft-dim); opacity:.6; }
.ft-search input:disabled { color:var(--ft-dim); font-style:italic; }
.ft-mode { flex:0 0 auto; padding:2px 2px; border:none; background:transparent;
  color:var(--ft-dim); font:inherit; font-size:10px; outline:none; cursor:pointer;
  -webkit-appearance:none; appearance:none; text-align:right; }
.ft-mode:hover { color:var(--ft-fg); }
.ft-mode option { background:var(--comfy-menu-bg,#252525); color:var(--ft-fg); }

/* the references field — the only framed element, and the only one that grows */
.ft-scroll { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; padding:3px;
  border:1px solid rgba(255,255,255,.85); border-radius:3px; }
.ft-scroll::-webkit-scrollbar { width:5px; }
.ft-scroll::-webkit-scrollbar-thumb { background:var(--ft-line); border-radius:3px; }
/* --ft-thumb is the minimum cell width; auto-fill turns that into a column
   count, so one slider changes thumbnail size and columns per row together. */
.ft-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(var(--ft-thumb,84px),1fr)); gap:2px; }
.ft-cell { position:relative; aspect-ratio:16/9; overflow:hidden; cursor:pointer;
  border-radius:2px; box-shadow:inset 0 0 0 .5px rgba(255,255,255,.2); }
.ft-cell:hover { box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.6); }
.ft-cell.on { box-shadow:inset 0 0 0 2px var(--ft-on); }
.ft-cell img { width:100%; height:100%; object-fit:cover; display:block; }
/* A frame whose picture will not load. The browser's broken-image glyph is
   worse than useless inside a grid of pictures — it reads as a bug in the node
   rather than one unreachable file — so the cell keeps the title instead. */
.ft-bad { display:none; }
.ft-cell.bad { background:var(--comfy-input-bg,#1a1a1a); }
.ft-cell.bad .ft-bad { display:flex; align-items:center; justify-content:center;
  height:100%; padding:3px; text-align:center; font-size:7.5px; line-height:1.2;
  color:var(--ft-dim); opacity:.7; overflow:hidden; }
.ft-cell.bad .ft-cap { display:none; }
.ft-cap { position:absolute; left:0; right:0; bottom:0; padding:2px 4px; opacity:0;
  transition:opacity .12s; pointer-events:none;
  background:linear-gradient(to top,rgba(0,0,0,.88),transparent); }
.ft-cell:hover .ft-cap, .ft-cell.on .ft-cap { opacity:1; }
.ft-cap b { display:block; font-size:8px; font-weight:500; color:#fff; line-height:1.25;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-cap i { display:block; font-size:7px; font-style:normal; color:rgba(255,255,255,.6);
  line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-msg { display:flex; align-items:center; justify-content:center; height:100%; min-height:60px;
  padding:14px; text-align:center; font-size:10.5px; color:var(--ft-dim); line-height:1.5; }
.ft-msg.err { color:var(--error-text,#f87171); }

/* the connect panel, shown in place of results until there is a token */
.ft-conn { display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:7px; height:100%; min-height:90px; padding:14px; text-align:center; }
.ft-conn p { margin:0; font-size:10.5px; color:var(--ft-dim); line-height:1.5; max-width:230px; }
.ft-conn .ft-go { padding:5px 12px; border:none; border-radius:3px; background:var(--ft-on);
  color:var(--p-primary-contrast-color,#fff); font:inherit; font-size:11px; cursor:pointer; }
.ft-conn .ft-go:hover { filter:brightness(1.1); }
/* A rule with OR sitting in it, so the two routes read as alternatives rather
   than as a step followed by a smaller step. */
.ft-or { display:flex; align-items:center; gap:8px; width:100%; max-width:250px;
  font-size:8.5px; letter-spacing:.14em; color:var(--ft-dim); opacity:.6; }
.ft-or::before, .ft-or::after { content:""; flex:1 1 auto; height:1px; background:var(--ft-line); }
.ft-paste { display:flex; gap:4px; width:100%; max-width:250px; }
.ft-paste input { flex:1 1 auto; min-width:0; padding:4px 6px; border:1px solid var(--ft-line);
  border-radius:3px; background:transparent; color:var(--ft-fg); font:inherit; font-size:10px;
  outline:none; }
.ft-paste button { padding:4px 9px; border:1px solid var(--ft-line); border-radius:3px;
  background:transparent; color:var(--ft-fg); font:inherit; font-size:10px; cursor:pointer; }
.ft-paste button:hover { border-color:var(--ft-on); }
.ft-more { padding:5px 0; text-align:center; font-size:9px; color:var(--ft-dim); opacity:.7; }

/* one row: what is selected, and what you can do about it */
.ft-foot { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between;
  gap:6px; padding-top:4px; }
.ft-left { display:flex; align-items:center; gap:6px; min-width:0; }
/* Connection state, bottom left. A dot and a word: you should be able to tell
   whether this node can reach your account without clicking anything. */
.ft-link { display:flex; align-items:center; gap:4px; flex:0 0 auto; padding:2px 5px;
  border:none; border-radius:3px; background:transparent; font:inherit; font-size:9.5px;
  cursor:default; color:var(--ft-dim); }
.ft-link i { width:6px; height:6px; border-radius:50%; background:currentColor; }
.ft-link.up { color:#3fb950; }
.ft-link.down { color:#f85149; cursor:pointer; }
.ft-link.down:hover { background:rgba(248,81,73,.12); }
.ft-stat { min-width:0; font-size:9.5px; color:var(--ft-dim);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-stat b { color:var(--ft-fg); font-weight:500; }
.ft-acts { display:flex; align-items:center; gap:3px; flex:0 0 auto; }
.ft-size { width:52px; height:12px; margin-right:2px; cursor:ew-resize;
  -webkit-appearance:none; appearance:none; background:transparent; }
.ft-size::-webkit-slider-runnable-track { height:2px; border-radius:2px; background:var(--ft-line); }
.ft-size::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; margin-top:-3px;
  width:8px; height:8px; border-radius:50%; background:var(--ft-dim); }
.ft-size:hover::-webkit-slider-thumb { background:var(--ft-fg); }
.ft-acts button { display:flex; padding:3px; border:none; border-radius:3px; background:transparent;
  color:var(--ft-dim); cursor:pointer; }
.ft-acts button:hover:not(:disabled) { color:var(--ft-fg); }
.ft-acts button:disabled { opacity:.2; cursor:default; }
.ft-acts svg { width:11px; height:11px; }

/* progress: a hairline under the search row, gone when idle */
.ft-bar { flex:0 0 auto; height:1px; margin-bottom:4px; background:var(--ft-line); }
.ft-bar > i { display:block; height:100%; width:0; background:var(--ft-on);
  transition:width .1s linear; }
`;

const SVG = (d) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICON = {
    search: SVG('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    refresh: SVG('<path d="M21 12a9 9 0 0 0-9-9 9.8 9.8 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.8 9.8 0 0 0 6.7-2.7L21 16"/><path d="M16 16h5v5"/>'),
    x: SVG('<path d="M18 6 6 18M6 6l12 12"/>'),
};

const esc = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function injectCss() {
    if (document.getElementById("ft-node-css")) return;
    const el = document.createElement("style");
    el.id = "ft-node-css";
    // import.meta.url is this file's served path, whatever the folder is called.
    const font = new URL("./Outfit.woff2", import.meta.url).href;
    el.textContent = FONT_CSS(font) + CSS;
    document.head.appendChild(el);
}

class ReferenceBody {
    constructor(node) {
        this.node = node;
        this.rows = [];
        this.pinnedId = null;
        this.loading = false;
        this.more = false;
        this.done = false;
        this.error = null;
        this.progress = 0;
        this.lastKey = "";
        this.timer = null;
        this.debounce = null;
        this.status_ = null;      // null until /status answers; then {configured,…}
        this.connError = null;

        this.root = document.createElement("div");
        this.root.className = "ft";
        // Comfy pans and zooms the graph on wheel and drag. Without this,
        // scrolling the grid zooms the whole canvas and typing moves the node.
        for (const ev of ["wheel", "pointerdown", "mousedown", "contextmenu", "keydown"]) {
            this.root.addEventListener(ev, (e) => e.stopPropagation());
        }
        this.render();
        this.checkStatus();
    }

    // ── native widgets are the source of truth; these are the only accessors ──
    w(name) {
        return this.node.widgets?.find((x) => x.name === name);
    }
    get(name) {
        return this.w(name)?.value;
    }
    set(name, value) {
        const w = this.w(name);
        if (!w) return;
        w.value = value;
        this.node.setDirtyCanvas(true, true);
    }

    /** Thumbnail size, kept in node properties so it saves with the workflow —
     *  it is a view preference, not an input, and has no business in a socket. */
    get thumb() {
        return Number(this.node.properties?.ftThumb) || 84;
    }
    set thumb(px) {
        this.node.properties = this.node.properties || {};
        this.node.properties.ftThumb = px;
        this.root.style.setProperty("--ft-thumb", `${px}px`);
    }

    /** True when something is wired into query_in, which overrides the box. */
    get driven() {
        return Boolean(this.node.inputs?.find((i) => i.name === "query_in")?.link != null);
    }

    /** Asked once per node, and again after a successful connect. Shared across
     *  nodes via a module-level promise so ten nodes on a canvas do not make
     *  ten identical requests on load. */
    async checkStatus({ fresh = false } = {}) {
        if (fresh) statusPromise = null;
        statusPromise = statusPromise || api.fetchApi("/framethrower/status").then((r) => r.json());
        try {
            this.status_ = await statusPromise;
        } catch {
            this.status_ = { configured: false };
        }
        this.render();
    }

    async connect(token) {
        this.connError = null;
        try {
            const res = await api.fetchApi("/framethrower/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Could not save (${res.status})`);
            await this.checkStatus({ fresh: true });
            if (this.get("query")) this.search();
        } catch (e) {
            this.connError = e.message;
            this.render();
        }
    }

    // ── search ───────────────────────────────────────────────────────────────
    tick(ms) {
        this.progress = 0;
        clearInterval(this.timer);
        const inc = 95 / (ms / 50);
        this.timer = setInterval(() => {
            this.progress = Math.min(95, this.progress + inc);
            const bar = this.root.querySelector(".ft-bar > i");
            if (bar) bar.style.width = `${this.progress}%`;
        }, 50);
    }

    async post(body) {
        const res = await api.fetchApi("/framethrower/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
        return data;
    }

    async search({ append = false } = {}) {
        const q = String(this.get("query") || "").trim();
        const mode = this.get("mode") || "hybrid";
        if (!q) {
            this.rows = [];
            this.render();
            return;
        }
        const key = `${q}::${mode}`;
        if (!append && key === this.lastKey && this.rows.length) return;

        if (append) this.more = true;
        else {
            this.lastKey = key;
            this.loading = true;
            this.error = null;
            this.done = false;
            this.tick(3000);
        }
        this.render();

        try {
            const data = await this.post({
                query: q, limit: PAGE_SIZE, mode,
                offset: append ? this.rows.length : 0,
            });
            const rows = data.results || [];
            if (append) {
                // The vector index returns the same frame in overlapping
                // windows, and a duplicate id would break the grid's diff too.
                const seen = new Set(this.rows.map((r) => r.id));
                const fresh = rows.filter((r) => !seen.has(r.id));
                if (!fresh.length) this.done = true;
                this.rows = this.rows.concat(fresh);
            } else {
                this.rows = rows;
            }
            if (rows.length < PAGE_SIZE) this.done = true;
        } catch (e) {
            if (append) this.done = true;   // don't hammer a failing endpoint
            else this.error = e.message;
        } finally {
            this.loading = false;
            this.more = false;
            clearInterval(this.timer);
            this.progress = 0;
            this.render();
        }
    }

    /** Clicking the selected frame again deselects it — one click to undo a
     *  mis-click, rather than hunting for a button. */
    pick(row) {
        const same = this.pinnedId === row.id;
        this.pinnedId = same ? null : row.id;
        this.set("pinned", same ? "" : JSON.stringify(row));
        this.render();
    }

    clear() {
        this.rows = [];
        this.pinnedId = null;
        this.error = null;
        this.done = false;
        this.lastKey = "";
        this.set("pinned", "");
        this.render();
    }

    // ── view ─────────────────────────────────────────────────────────────────
    /** Shown instead of results until the server has a token. Two doors: open
     *  the tokens page, or paste one straight in. The paste field is not a
     *  fallback — on a ComfyUI running anywhere but this machine, opening a
     *  browser tab from the node is meaningless, and pasting is the only way. */
    connectPanel() {
        return `<div class="ft-conn">
      <p>Sign in to FrameThrower to search the library.</p>
      <button class="ft-go" data-act="open">Connect to account</button>
      <span class="ft-or">OR</span>
      <div class="ft-paste">
        <input type="password" placeholder="or paste a token: ft_…" spellcheck="false"/>
        <button data-act="save">Save</button>
      </div>
      ${this.connError ? `<p style="color:var(--error-text,#f87171)">${esc(this.connError)}</p>` : ""}
    </div>`;
    }

    body() {
        if (this.status_ && !this.status_.configured) return this.connectPanel();
        if (this.error) return `<div class="ft-msg err">${esc(this.error)}</div>`;
        if (this.loading && !this.rows.length) return `<div class="ft-msg">Searching…</div>`;
        if (!this.rows.length) {
            return `<div class="ft-msg">${this.driven
                ? "Driven by query_in — runs on execute"
                : "Search the library, then click a frame to use it"}</div>`;
        }
        const cells = this.rows
            .map(
                (r, i) => `<div class="ft-cell${r.id === this.pinnedId ? " on" : ""}" data-i="${i}">
        <img src="${esc(r.src)}" alt="" loading="lazy" draggable="false"
             referrerpolicy="no-referrer"
             onerror="this.closest('.ft-cell').classList.add('bad');this.remove()"/>
        <span class="ft-bad">${esc(r.filmTitle || "unavailable")}</span>
        ${r.filmTitle || r.director
                        ? `<div class="ft-cap">${r.filmTitle ? `<b>${esc(r.filmTitle)}</b>` : ""}${r.director ? `<i>${esc(r.director)}</i>` : ""}</div>`
                        : ""}
      </div>`
            )
            .join("");
        const tail = this.more ? `<div class="ft-more">Loading more…</div>`
            : this.done && this.rows.length >= PAGE_SIZE ? `<div class="ft-more">End of results</div>` : "";
        return `<div class="ft-grid">${cells}</div>${tail}`;
    }

    status() {
        if (this.error) return "Error";
        if (this.loading) return "Searching…";
        if (this.pinnedId) {
            const r = this.rows.find((x) => x.id === this.pinnedId);
            return r ? `<b>${esc(r.filmTitle || "Frame")}</b>${r.year ? ` · ${r.year}` : ""}` : "1 selected";
        }
        if (this.rows.length) return `${this.rows.length} frames · click one to use it`;
        return this.driven ? "query_in" : "";
    }

    render() {
        const keep = this.root.querySelector(".ft-scroll")?.scrollTop || 0;
        const focused = this.root.querySelector(".ft-search input") === document.activeElement;
        const caret = focused ? this.root.querySelector(".ft-search input").selectionStart : null;
        const mode = this.get("mode") || "hybrid";

        this.root.innerHTML = `
      <div class="ft-search">
        ${ICON.search}
        <input type="text" spellcheck="false"
               placeholder="${this.driven ? "driven by query_in" : "neon rain at night"}"
               value="${esc(this.get("query") || "")}" ${this.driven ? "disabled" : ""}/>
      </div>
      ${this.progress > 0 ? `<div class="ft-bar"><i style="width:${this.progress}%"></i></div>` : ""}
      <div class="ft-scroll">${this.body()}</div>
      <div class="ft-foot">
        <span class="ft-left">
          ${this.status_
                ? this.status_.configured
                    ? `<span class="ft-link up"><i></i>Connected</span>`
                    : `<button class="ft-link down" data-act="reconnect"><i></i>Not connected</button>`
                : ""}
          <span class="ft-stat">${this.status()}</span>
        </span>
        <span class="ft-acts">
          <select class="ft-mode" title="How the library is searched">
            ${MODES.map((m) => `<option value="${m.key}"${m.key === mode ? " selected" : ""}>${m.label}</option>`).join("")}
          </select>
          <input class="ft-size" type="range" min="56" max="220" step="4"
                 value="${this.thumb}" title="Thumbnail size"/>
          <button data-act="refresh" title="Search again">${ICON.refresh}</button>
          <button data-act="clear" title="Clear results" ${this.rows.length ? "" : "disabled"}>${ICON.x}</button>
        </span>
      </div>`;

        const input = this.root.querySelector(".ft-search input");
        if (focused && input) {
            input.focus();
            if (caret != null) input.setSelectionRange(caret, caret);
        }
        if (input) {
            input.oninput = () => {
                this.set("query", input.value);
                clearTimeout(this.debounce);
                this.debounce = setTimeout(() => this.search(), 600);
            };
            input.onkeydown = (e) => {
                if (e.key === "Enter") {
                    clearTimeout(this.debounce);
                    this.lastKey = "";
                    this.search();
                }
            };
        }

        const paste = this.root.querySelector(".ft-paste input");
        if (paste) paste.onkeydown = (e) => {
            if (e.key === "Enter") this.connect(paste.value.trim());
        };

        const sel = this.root.querySelector(".ft-mode");
        if (sel) sel.onchange = () => { this.set("mode", sel.value); this.lastKey = ""; this.search(); };

        // Drives a CSS variable rather than re-rendering: a re-render per slider
        // step would rebuild every <img> and make the grid flash while dragging.
        const size = this.root.querySelector(".ft-size");
        if (size) {
            this.root.style.setProperty("--ft-thumb", `${this.thumb}px`);
            size.oninput = () => { this.thumb = Number(size.value); };
        }

        const scroll = this.root.querySelector(".ft-scroll");
        if (scroll) {
            scroll.scrollTop = keep;
            scroll.onscroll = () => {
                if (this.loading || this.more || this.done || !this.rows.length) return;
                if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140) {
                    this.search({ append: true });
                }
            };
        }

        this.root.onclick = (e) => {
            const btn = e.target.closest("[data-act]");
            if (btn) {
                e.stopPropagation();
                const act = btn.dataset.act;
                if (act === "open") {
                    window.open(this.status_?.connectUrl || "https://framethrower.ai/settings?tab=api", "_blank", "noopener");
                } else if (act === "save") {
                    const f = this.root.querySelector(".ft-paste input");
                    if (f) this.connect(f.value.trim());
                } else if (act === "reconnect") {
                    this.clear();                       // put the panel back in view
                    this.checkStatus({ fresh: true });
                } else if (act === "refresh") {
                    // Also the way back from a connect that failed.
                    if (!this.status_?.configured) this.checkStatus({ fresh: true });
                    else { this.lastKey = ""; this.done = false; this.search(); }
                } else this.clear();
                return;
            }
            const cell = e.target.closest(".ft-cell");
            if (cell) {
                e.stopPropagation();
                const row = this.rows[Number(cell.dataset.i)];
                if (row) this.pick(row);
            }
        };
    }
}

app.registerExtension({
    name: "framethrower.reference",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE) return;
        injectCss();

        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            created?.apply(this, arguments);

            // Hide every native widget. They still serialise into the workflow
            // and Python still reads them on execute — the body above is just
            // what draws and edits them. isWidgetVisible() reads `hidden` and
            // ignores `type`, so this is the flag that matters.
            for (const name of NATIVE) {
                const w = this.widgets?.find((x) => x.name === name);
                if (w) {
                    w.hidden = true;
                    w.computeSize = () => [0, -4];
                }
            }

            const ui = new ReferenceBody(this);
            this.ftUI = ui;
            // No max means the widget takes its minimum and the leftover height
            // stays empty. Unbounded, it is the one thing that grows, so the
            // grid reaches the bottom edge at every node size.
            this.addDOMWidget("ft_body", "div", ui.root, {
                serialize: false,
                hideOnZoom: false,
                getMinHeight: () => 130,
                getMaxHeight: () => 1e6,
            });

            this.size = [320, 400];
            this.serialize_widgets = true;
        };

        // Come back showing the frame the node will actually output.
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            configure?.apply(this, arguments);
            if (!this.ftUI) return;
            const raw = this.widgets?.find((w) => w.name === "pinned")?.value;
            if (raw) {
                try {
                    const row = JSON.parse(raw);
                    this.ftUI.pinnedId = row.id;
                    this.ftUI.rows = [row];
                } catch { /* saved mid-edit — start empty */ }
            }
            this.ftUI.render();
        };
    },
});
