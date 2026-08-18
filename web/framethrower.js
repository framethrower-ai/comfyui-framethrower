/**
 * The Reference node's face.
 *
 * Everything visible here — the header, the mode menu, the progress ring, the
 * thumbnail grid, the pinned frame — is a port of the canvas node in
 * workspace-beta (src/components/Nodes/ReferenceNode.tsx). Stock ComfyUI
 * widgets can draw a text box and a toggle; they cannot draw thirty film
 * frames, so the node body is a DOM widget and this file is what goes in it.
 *
 * The CSS is injected from here rather than shipped as a sibling .css file
 * because the URL a custom node's assets are served from depends on the folder
 * name on disk, which we do not control — a user who renames the directory
 * would get an unstyled node and no error to explain it.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "FrameThrowerReference";
const PAGE_SIZE = 30;
const AVG_SEARCH_MS = 3000;
const AVG_IMAGE_SEARCH_MS = 12000;

const MODES = [
    { key: "hybrid", label: "Hybrid", desc: "Text + semantic" },
    { key: "semantic", label: "Semantic", desc: "Visual meaning" },
    { key: "description", label: "Description", desc: "Text metadata" },
];

const CSS = `
.ft-node { display:flex; flex-direction:column; height:100%; min-height:200px;
  background:#1a1a1a; border-radius:12px; overflow:hidden; font-family:-apple-system,
  BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; --ft-accent:#e8542f; }
.ft-head { display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:8px; background:#1a1a1a; border-bottom:1px solid rgba(255,255,255,.1); flex:0 0 auto; }
.ft-id { display:flex; align-items:center; gap:8px; min-width:0; }
.ft-badge { display:flex; align-items:center; justify-content:center; width:24px; height:24px;
  background:#222; border-radius:6px; color:var(--ft-accent); flex:0 0 auto; }
.ft-badge svg { width:14px; height:14px; }
.ft-names { display:flex; flex-direction:column; min-width:0; line-height:1.15; }
.ft-name { font-size:12px; color:#fff; font-weight:600; letter-spacing:-.01em;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-name .ft-sub { margin-left:6px; font-weight:400; color:rgba(255,255,255,.4); }
.ft-api { font-size:10px; color:rgba(255,255,255,.45); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.ft-actions { display:flex; align-items:center; gap:4px; flex:0 0 auto; position:relative; }
.ft-btn { display:flex; align-items:center; justify-content:center; gap:4px; padding:5px;
  border:none; background:transparent; border-radius:6px; color:rgba(255,255,255,.4);
  cursor:pointer; transition:all .15s; }
.ft-btn:hover { color:#fff; background:rgba(255,255,255,.1); }
.ft-btn:disabled { opacity:.25; cursor:default; background:transparent; }
.ft-btn svg { width:14px; height:14px; }
.ft-mode { padding:4px 6px; background:#222; border:1px solid rgba(255,255,255,.1);
  border-radius:6px; font-size:9px; color:rgba(255,255,255,.5); }
.ft-mode:hover { color:#fff; background:rgba(255,255,255,.05); }
.ft-mode svg { width:10px; height:10px; }
.ft-menu { position:absolute; top:100%; right:0; margin-top:4px; width:150px; background:#222;
  border:1px solid rgba(255,255,255,.1); border-radius:8px; padding:4px; z-index:60;
  box-shadow:0 10px 30px rgba(0,0,0,.6); }
.ft-menu button { display:flex; flex-direction:column; width:100%; text-align:left; gap:1px;
  padding:5px 8px; border:none; background:transparent; border-radius:4px;
  color:rgba(255,255,255,.6); cursor:pointer; }
.ft-menu button:hover { background:rgba(255,255,255,.05); color:#fff; }
.ft-menu button.on { background:rgba(255,255,255,.1); color:#fff; }
.ft-menu .l { font-size:10px; font-weight:500; }
.ft-menu .d { font-size:8px; color:rgba(255,255,255,.3); }
.ft-bar { height:2px; background:#0a0a0a; flex:0 0 auto; }
.ft-bar > i { display:block; height:100%; background:var(--ft-accent); transition:width .1s linear; }
.ft-grid-wrap { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden;
  background:#0a0a0a; padding:8px; }
.ft-grid-wrap::-webkit-scrollbar { width:6px; }
.ft-grid-wrap::-webkit-scrollbar-thumb { background:rgba(255,255,255,.1); border-radius:3px; }
.ft-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; }
.ft-cell { position:relative; aspect-ratio:16/9; overflow:hidden; background:rgba(0,0,0,.5);
  cursor:pointer; box-shadow:inset 0 0 0 .5px rgba(255,255,255,.35); }
.ft-cell:hover { box-shadow:inset 0 0 0 1px var(--ft-accent); }
.ft-cell img { width:100%; height:100%; object-fit:cover; display:block; }
.ft-cap { position:absolute; left:0; right:0; bottom:0; padding:3px 4px; opacity:0;
  transition:opacity .15s; pointer-events:none;
  background:linear-gradient(to top, rgba(0,0,0,.8), transparent); }
.ft-cell:hover .ft-cap { opacity:1; }
.ft-cap b { display:block; font-size:8px; font-weight:400; color:#fff; line-height:1.2;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-cap i { display:block; font-size:7px; font-style:normal; color:rgba(255,255,255,.6);
  line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-pin { position:relative; margin-bottom:8px; border:2px solid var(--ft-accent);
  border-radius:8px; overflow:hidden; }
.ft-pin img { width:100%; aspect-ratio:16/9; object-fit:cover; display:block; }
.ft-pin-bar { position:absolute; left:0; right:0; bottom:0; display:flex; align-items:flex-end;
  justify-content:space-between; gap:8px; padding:8px;
  background:linear-gradient(to top, rgba(0,0,0,.9), transparent); }
.ft-pin-bar b { display:block; font-size:10px; font-weight:400; color:#fff; line-height:1.2; }
.ft-pin-bar i { display:block; font-size:8px; font-style:normal; color:rgba(255,255,255,.5); }
.ft-pin-x { flex:0 0 auto; padding:4px; border:none; border-radius:999px; cursor:pointer;
  background:rgba(0,0,0,.6); color:rgba(255,255,255,.5); display:flex; }
.ft-pin-x:hover { background:rgba(0,0,0,.85); color:#fff; }
.ft-pin-x svg { width:12px; height:12px; }
.ft-empty { display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:8px; height:100%; min-height:120px; color:rgba(255,255,255,.2); font-size:12px;
  text-align:center; border:1px dashed rgba(255,255,255,.1); border-radius:8px; padding:12px; }
.ft-empty svg { width:20px; height:20px; color:rgba(255,255,255,.1); }
.ft-err { color:#f87171; }
.ft-ring { position:relative; width:40px; height:40px; }
.ft-ring svg { width:100%; height:100%; transform:rotate(-90deg); }
.ft-ring span { position:absolute; inset:0; display:flex; align-items:center;
  justify-content:center; font-size:8px; font-weight:700; color:rgba(255,255,255,.5); }
.ft-more { padding:8px 0; text-align:center; font-size:9px; color:rgba(255,255,255,.25); }
.ft-foot { flex:0 0 auto; padding:6px 12px; background:#1a1a1a;
  border-top:1px solid rgba(255,255,255,.1); font-size:9px; color:rgba(255,255,255,.3);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
`;

const ICON = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
    eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a2 2 0 0 1 2.8 0l5.2 5.2a2 2 0 0 1 0 2.8L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

function injectCss() {
    if (document.getElementById("ft-node-css")) return;
    const style = document.createElement("style");
    style.id = "ft-node-css";
    style.textContent = CSS;
    document.head.appendChild(style);
}

const esc = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

class ReferenceUI {
    constructor(node) {
        this.node = node;
        this.results = [];
        this.pinned = null;
        this.loading = false;
        this.loadingMore = false;
        this.exhausted = false;
        this.error = null;
        this.currentQuery = "";
        this.progress = 0;
        this.menuOpen = false;
        this.lastKey = "";
        this.timer = null;

        this.root = document.createElement("div");
        this.root.className = "ft-node";
        // Comfy pans and zooms the canvas on wheel/drag. Without this, scrolling
        // the grid zooms the whole graph out instead.
        for (const ev of ["wheel", "pointerdown", "mousedown", "contextmenu"]) {
            this.root.addEventListener(ev, (e) => e.stopPropagation());
        }
        this.render();
    }

    widget(name) {
        return this.node.widgets?.find((w) => w.name === name);
    }

    get mode() {
        return this.widget("mode")?.value || "hybrid";
    }

    setMode(v) {
        const w = this.widget("mode");
        if (w) w.value = v;
        this.menuOpen = false;
        if (this.currentQuery && this.currentQuery !== "[image search]") {
            this.lastKey = "";
            this.searchText(this.currentQuery);
        } else {
            this.render();
        }
    }

    startProgress(ms) {
        this.progress = 0;
        clearInterval(this.timer);
        const inc = 95 / (ms / 50);
        this.timer = setInterval(() => {
            this.progress = Math.min(95, this.progress + inc);
            this.paintProgress();
        }, 50);
    }

    stopProgress() {
        clearInterval(this.timer);
        this.progress = 100;
        setTimeout(() => {
            this.progress = 0;
            this.render();
        }, 300);
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

    async searchText(query, { append = false } = {}) {
        const q = (query || "").trim();
        if (!q) {
            this.results = [];
            this.currentQuery = "";
            this.render();
            return;
        }
        const key = `${q}::${this.mode}`;
        if (!append && key === this.lastKey && this.results.length) return;
        if (!append) this.lastKey = key;

        if (append) this.loadingMore = true;
        else {
            this.loading = true;
            this.error = null;
            this.currentQuery = q;
            this.startProgress(AVG_SEARCH_MS);
        }
        this.render();

        try {
            const data = await this.post({
                query: q,
                limit: PAGE_SIZE,
                mode: this.mode,
                offset: append ? this.results.length : 0,
            });
            const rows = data.results || [];
            if (append) {
                // The vector index can return the same frame in overlapping
                // windows; a duplicate key would also break the grid's DOM diff.
                const seen = new Set(this.results.map((r) => r.id));
                const fresh = rows.filter((r) => !seen.has(r.id));
                if (!fresh.length) this.exhausted = true;
                this.results = this.results.concat(fresh);
            } else {
                this.results = rows;
            }
            if (rows.length < PAGE_SIZE) this.exhausted = true;
        } catch (e) {
            if (append) this.exhausted = true; // don't hammer a failing endpoint
            else this.error = e.message;
        } finally {
            this.loading = false;
            this.loadingMore = false;
            if (!append) this.stopProgress();
            this.render();
        }
    }

    async searchImage(imageUrl) {
        this.loading = true;
        this.error = null;
        this.currentQuery = "[image search]";
        this.startProgress(AVG_IMAGE_SEARCH_MS);
        this.render();
        try {
            const data = await this.post({ imageUrl });
            this.results = data.results || [];
            this.exhausted = true;
        } catch (e) {
            this.error = e.message;
        } finally {
            this.loading = false;
            this.stopProgress();
            this.render();
        }
    }

    pin(row) {
        this.pinned = row;
        const w = this.widget("pinned");
        if (w) w.value = JSON.stringify(row);
        this.node.setDirtyCanvas(true, true);
        this.lastKey = "";
        this.searchImage(row.src);
    }

    unpin() {
        this.pinned = null;
        const w = this.widget("pinned");
        if (w) w.value = "";
        this.lastKey = "";
        this.refresh();
    }

    refresh() {
        this.exhausted = false;
        this.lastKey = "";
        const q = this.widget("query")?.value || "";
        this.searchText(q);
    }

    // Deliberately does not clear the query widget: the node stays empty until
    // you change the prompt, which is what makes Clear feel like a clear rather
    // than a reload.
    clear() {
        this.results = [];
        this.pinned = null;
        this.currentQuery = "";
        this.exhausted = false;
        this.error = null;
        const w = this.widget("pinned");
        if (w) w.value = "";
        this.render();
    }

    paintProgress() {
        const bar = this.root.querySelector(".ft-bar > i");
        if (bar) bar.style.width = `${this.progress}%`;
        const ring = this.root.querySelector(".ft-ring path.v");
        if (ring) ring.setAttribute("stroke-dasharray", `${this.progress}, 100`);
        const pct = this.root.querySelector(".ft-ring span");
        if (pct) pct.textContent = `${Math.round(this.progress)}%`;
    }

    body() {
        if (this.loading && !this.results.length) {
            const d = "M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831";
            return `<div class="ft-empty"><div class="ft-ring"><svg viewBox="0 0 36 36">
        <path d="${d}" fill="none" stroke="#222" stroke-width="3"/>
        <path class="v" d="${d}" fill="none" stroke="var(--ft-accent)" stroke-width="3"
              stroke-dasharray="${this.progress}, 100"/></svg>
        <span>${Math.round(this.progress)}%</span></div><span>Searching…</span></div>`;
        }
        if (this.error) return `<div class="ft-empty ft-err">${esc(this.error)}</div>`;
        if (!this.results.length && !this.pinned) {
            return `<div class="ft-empty">${ICON.search}<span>Type a query, or wire a prompt into query_in</span></div>`;
        }

        const pin = this.pinned
            ? `<div class="ft-pin"><img src="${esc(this.pinned.src)}" alt=""/>
         <div class="ft-pin-bar"><div>
           ${this.pinned.filmTitle ? `<b>${esc(this.pinned.filmTitle)}</b>` : ""}
           ${this.pinned.director ? `<i>${esc(this.pinned.director)}</i>` : ""}
         </div><button class="ft-pin-x" data-act="unpin">${ICON.x}</button></div></div>`
            : "";

        const cells = this.results
            .filter((r) => r.id !== this.pinned?.id)
            .map(
                (r, i) => `<div class="ft-cell" data-i="${i}">
        <img src="${esc(r.src)}" alt="${esc(r.filmTitle || "Reference frame")}" loading="lazy" draggable="false"/>
        ${r.filmTitle || r.director
                        ? `<div class="ft-cap">${r.filmTitle ? `<b>${esc(r.filmTitle)}</b>` : ""}${r.director ? `<i>${esc(r.director)}</i>` : ""}</div>`
                        : ""}
      </div>`
            )
            .join("");

        const tail =
            this.loadingMore || this.exhausted
                ? `<div class="ft-more">${this.loadingMore ? "Loading more…" : "End of results"}</div>`
                : "";

        return `${pin}<div class="ft-grid">${cells}</div>${tail}`;
    }

    render() {
        const m = MODES.find((x) => x.key === this.mode) || MODES[0];
        const scrollTop = this.root.querySelector(".ft-grid-wrap")?.scrollTop || 0;

        this.root.innerHTML = `
      <div class="ft-head">
        <div class="ft-id">
          <div class="ft-badge">${this.pinned ? ICON.image : ICON.search}</div>
          <div class="ft-names">
            <span class="ft-name">Reference Node${this.pinned ? '<span class="ft-sub">· similar frames</span>' : ""}</span>
            <span class="ft-api">FrameThrower API</span>
          </div>
        </div>
        <div class="ft-actions">
          <button class="ft-btn ft-mode" data-act="menu">${ICON.gear}${m.label}${ICON.chevron}</button>
          ${this.menuOpen
                ? `<div class="ft-menu">${MODES.map(
                    (x) =>
                        `<button data-act="mode" data-mode="${x.key}" class="${x.key === m.key ? "on" : ""}">
                 <span class="l">${x.label}</span><span class="d">${x.desc}</span></button>`
                ).join("")}</div>`
                : ""}
          <button class="ft-btn" data-act="refresh" title="Refresh references">${ICON.refresh}</button>
          <button class="ft-btn" data-act="clear" title="Clear results" ${this.results.length ? "" : "disabled"}>${ICON.eraser}</button>
        </div>
      </div>
      ${this.progress > 0 && this.progress < 100 ? `<div class="ft-bar"><i style="width:${this.progress}%"></i></div>` : ""}
      <div class="ft-grid-wrap">${this.body()}</div>
      ${this.currentQuery ? `<div class="ft-foot" title="${esc(this.currentQuery)}">${esc(this.currentQuery)}</div>` : ""}
    `;

        const wrap = this.root.querySelector(".ft-grid-wrap");
        if (wrap) {
            wrap.scrollTop = scrollTop;
            wrap.onscroll = () => {
                if (this.loading || this.loadingMore || this.exhausted) return;
                if (!this.currentQuery || this.currentQuery === "[image search]") return;
                if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 120) {
                    this.searchText(this.currentQuery, { append: true });
                }
            };
        }

        this.root.onclick = (e) => {
            const cell = e.target.closest(".ft-cell");
            const btn = e.target.closest("[data-act]");
            if (btn) {
                e.stopPropagation();
                const act = btn.dataset.act;
                if (act === "menu") { this.menuOpen = !this.menuOpen; this.render(); }
                else if (act === "mode") this.setMode(btn.dataset.mode);
                else if (act === "refresh") this.refresh();
                else if (act === "clear") this.clear();
                else if (act === "unpin") this.unpin();
                return;
            }
            if (cell) {
                e.stopPropagation();
                const shown = this.results.filter((r) => r.id !== this.pinned?.id);
                const row = shown[Number(cell.dataset.i)];
                if (row) this.pin(row);
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

            const ui = new ReferenceUI(this);
            this.ftUI = ui;
            this.addDOMWidget("ft_grid", "div", ui.root, { serialize: false, hideOnZoom: false });

            // `pinned` is written by the grid, never typed into. Hiding it keeps
            // a blob of JSON off the node face without losing it from the saved
            // workflow — the widget is still there, just not drawn.
            const pinned = this.widgets.find((w) => w.name === "pinned");
            if (pinned) {
                pinned.type = "hidden";
                pinned.computeSize = () => [0, -4];
            }

            // Typing in the query box searches, on the same 1s debounce the
            // canvas node uses for an upstream prompt.
            const query = this.widgets.find((w) => w.name === "query");
            if (query) {
                let debounce = null;
                const prev = query.callback;
                query.callback = function (value) {
                    prev?.apply(this, arguments);
                    clearTimeout(debounce);
                    debounce = setTimeout(() => ui.searchText(value), 1000);
                };
            }

            this.size = [360, 560];
            this.serialize_widgets = true;
        };

        // Restore the pinned frame when a saved workflow is opened, so the node
        // comes back showing the frame it will actually output.
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            configure?.apply(this, arguments);
            const raw = this.widgets?.find((w) => w.name === "pinned")?.value;
            if (raw && this.ftUI) {
                try {
                    this.ftUI.pinned = JSON.parse(raw);
                    this.ftUI.render();
                } catch { /* a workflow saved mid-edit — just start empty */ }
            }
        };
    },
});
