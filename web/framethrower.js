/**
 * The FT Reference node's body.
 *
 * One DOM widget for the whole node, and every native widget hidden behind it.
 *
 * The previous versions mixed the two: Comfy laid out query / mode / index /
 * three toggles its own way, and the results panel was laid out mine, and the
 * seam between them was where all the dead space and clipping lived. Two layout
 * engines splitting one node was never going to look composed. So the native
 * widgets stay — they are what serialises into the workflow and what Python
 * reads on execute — but nothing draws them. The controls you see here write
 * straight into their values.
 *
 * Shape, top to bottom: one search row, a settings drawer that is closed by
 * default, the grid, and a status strip. The grid is the only thing that grows.
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

/** Every native widget, so they can all be hidden in one pass. */
const NATIVE = ["query", "mode", "index", "depth", "pose", "lineart", "pinned"];

const MODES = [
    { key: "hybrid", label: "Hybrid" },
    { key: "semantic", label: "Semantic" },
    { key: "description", label: "Text" },
];

/** Sits in the top row, in socket order, so each toggle lines up with the
 *  output it feeds. Icons rather than words because three words plus a search
 *  box do not fit across a node this narrow. */
const PROCESSORS = [
    { key: "depth", label: "Depth map" },
    { key: "pose", label: "DW pose" },
    { key: "lineart", label: "Lineart" },
];

const CSS = `
.ft { --ft-accent:#e8542f; --ft-line:rgba(255,255,255,.09); --ft-dim:rgba(255,255,255,.38);
  display:flex; flex-direction:column; height:100%; min-height:140px; overflow:hidden;
  border-radius:6px; background:#0d0d0f; border:1px solid var(--ft-line);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:11px; }

/* search row */
.ft-search { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:6px 7px;
  border-bottom:1px solid var(--ft-line); }
.ft-search svg { width:12px; height:12px; color:var(--ft-dim); flex:0 0 auto; }
.ft-search input { flex:1 1 auto; min-width:0; border:none; outline:none; background:transparent;
  color:#fff; font:inherit; font-size:11.5px; padding:2px 0; }
.ft-search input::placeholder { color:rgba(255,255,255,.25); }
.ft-search input:disabled { color:rgba(255,255,255,.35); font-style:italic; }
.ft-cog { flex:0 0 auto; display:flex; padding:3px; border:none; border-radius:4px;
  background:transparent; color:var(--ft-dim); cursor:pointer; }
.ft-cog:hover { background:rgba(255,255,255,.1); color:#fff; }
.ft-cog.on { background:rgba(232,84,47,.16); color:var(--ft-accent); }
/* the three map toggles, in output-socket order */
.ft-maps { flex:0 0 auto; display:flex; gap:1px; padding-right:2px; margin-right:2px;
  border-right:1px solid var(--ft-line); }
.ft-map { display:flex; padding:3px; border:none; border-radius:4px; background:transparent;
  color:rgba(255,255,255,.28); cursor:pointer; }
.ft-map svg { width:12px; height:12px; }
.ft-map:hover { background:rgba(255,255,255,.1); color:#fff; }
.ft-map.on { color:var(--ft-accent); background:rgba(232,84,47,.14); }

/* settings drawer */
.ft-set { flex:0 0 auto; display:flex; flex-direction:column; gap:6px; padding:7px;
  background:#151517; border-bottom:1px solid var(--ft-line); }
.ft-row { display:flex; align-items:center; gap:6px; }
.ft-lbl { width:44px; flex:0 0 auto; font-size:9.5px; letter-spacing:.04em;
  text-transform:uppercase; color:rgba(255,255,255,.3); }
.ft-pills { display:flex; gap:3px; flex:1 1 auto; }
.ft-pill { flex:1 1 0; padding:3px 4px; border:1px solid var(--ft-line); border-radius:4px;
  background:transparent; color:var(--ft-dim); font:inherit; font-size:10px; cursor:pointer;
  text-align:center; }
.ft-pill:hover { color:#fff; border-color:rgba(255,255,255,.25); }
.ft-pill.on { background:var(--ft-accent); border-color:var(--ft-accent); color:#fff; }
.ft-num { width:52px; padding:3px 5px; border:1px solid var(--ft-line); border-radius:4px;
  background:#0d0d0f; color:#fff; font:inherit; font-size:10px; outline:none; }
.ft-hint { flex:1 1 auto; font-size:9px; color:rgba(255,255,255,.22); line-height:1.3; }

/* progress */
.ft-bar { flex:0 0 auto; height:2px; }
.ft-bar > i { display:block; height:100%; width:0; background:var(--ft-accent);
  transition:width .1s linear; }

/* results — the only thing that grows */
.ft-scroll { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; padding:3px; }
.ft-scroll::-webkit-scrollbar { width:5px; }
.ft-scroll::-webkit-scrollbar-thumb { background:rgba(255,255,255,.14); border-radius:3px; }
.ft-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(84px,1fr)); gap:2px; }
.ft-cell { position:relative; aspect-ratio:16/9; overflow:hidden; background:#151517;
  cursor:pointer; border-radius:2px; box-shadow:inset 0 0 0 .5px rgba(255,255,255,.18); }
.ft-cell:hover { box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.55); }
.ft-cell.on { box-shadow:inset 0 0 0 2px var(--ft-accent); }
.ft-cell img { width:100%; height:100%; object-fit:cover; display:block; }
.ft-cap { position:absolute; left:0; right:0; bottom:0; padding:2px 4px; opacity:0;
  transition:opacity .12s; pointer-events:none;
  background:linear-gradient(to top,rgba(0,0,0,.88),transparent); }
.ft-cell:hover .ft-cap, .ft-cell.on .ft-cap { opacity:1; }
.ft-cap b { display:block; font-size:8px; font-weight:500; color:#fff; line-height:1.25;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-cap i { display:block; font-size:7px; font-style:normal; color:rgba(255,255,255,.55);
  line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-msg { display:flex; align-items:center; justify-content:center; height:100%; min-height:70px;
  padding:14px; text-align:center; font-size:10.5px; color:rgba(255,255,255,.26); line-height:1.5; }
.ft-msg.err { color:#f87171; }
.ft-more { padding:5px 0; text-align:center; font-size:9px; color:rgba(255,255,255,.2); }

/* status strip */
.ft-foot { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between;
  gap:6px; padding:3px 7px; border-top:1px solid var(--ft-line); background:#151517; }
.ft-stat { min-width:0; font-size:9.5px; color:rgba(255,255,255,.35);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-stat b { color:rgba(255,255,255,.7); font-weight:500; }
.ft-acts { display:flex; gap:1px; flex:0 0 auto; }
.ft-acts button { display:flex; padding:3px; border:none; border-radius:4px; background:transparent;
  color:var(--ft-dim); cursor:pointer; }
.ft-acts button:hover:not(:disabled) { background:rgba(255,255,255,.1); color:#fff; }
.ft-acts button:disabled { opacity:.2; cursor:default; }
.ft-acts svg { width:11px; height:11px; }
`;

const SVG = (d, extra = "") =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

const ICON = {
    search: SVG('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    cog: SVG('<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/>'),
    depth: SVG('<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'),
    pose: SVG('<circle cx="12" cy="4" r="2"/><path d="M12 6v6M6 9h12M12 12l-3 8M12 12l3 8"/>'),
    lineart: SVG('<path d="M12 19l7-7 3 3-7 7-3-3Z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5Z"/><path d="m2 2 7.6 7.6"/><circle cx="11" cy="11" r="2"/>'),
    refresh: SVG('<path d="M21 12a9 9 0 0 0-9-9 9.8 9.8 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.8 9.8 0 0 0 6.7-2.7L21 16"/><path d="M16 16h5v5"/>'),
    x: SVG('<path d="M18 6 6 18M6 6l12 12"/>'),
};

const esc = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function injectCss() {
    if (document.getElementById("ft-node-css")) return;
    const el = document.createElement("style");
    el.id = "ft-node-css";
    el.textContent = CSS;
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
        this.label = "";
        this.progress = 0;
        this.lastKey = "";
        this.timer = null;
        this.debounce = null;
        this.settingsOpen = false;

        this.root = document.createElement("div");
        this.root.className = "ft";
        // Comfy pans and zooms the graph on wheel and drag. Without this,
        // scrolling the grid zooms the whole canvas and typing moves the node.
        for (const ev of ["wheel", "pointerdown", "mousedown", "contextmenu", "keydown"]) {
            this.root.addEventListener(ev, (e) => e.stopPropagation());
        }
        this.render();
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

    /** True when something is wired into query_in, which overrides the box. */
    get driven() {
        return Boolean(this.node.inputs?.find((i) => i.name === "query_in")?.link != null);
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
            this.label = "";
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
            this.label = q;
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
        this.label = "";
        this.error = null;
        this.done = false;
        this.lastKey = "";
        this.set("pinned", "");
        this.render();
    }

    // ── view ─────────────────────────────────────────────────────────────────
    settings() {
        if (!this.settingsOpen) return "";
        const mode = this.get("mode") || "hybrid";
        const pills = MODES.map(
            (m) => `<button class="ft-pill${m.key === mode ? " on" : ""}" data-mode="${m.key}">${m.label}</button>`
        ).join("");
        // Maps are not repeated here — they live in the top row now, and a
        // control in two places is a control you can disagree with itself.
        return `<div class="ft-set">
      <div class="ft-row"><span class="ft-lbl">Search</span><span class="ft-pills">${pills}</span></div>
      <div class="ft-row"><span class="ft-lbl">Index</span>
        <input class="ft-num" type="number" min="0" max="499" value="${Number(this.get("index") ?? 0)}"/>
        <span class="ft-hint">Which result to use when query_in is wired and nothing is selected.</span>
      </div>
    </div>`;
    }

    body() {
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
        <img src="${esc(r.src)}" alt="" loading="lazy" draggable="false"/>
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

        this.root.innerHTML = `
      <div class="ft-search">
        ${ICON.search}
        <input type="text" spellcheck="false"
               placeholder="${this.driven ? "driven by query_in" : "neon rain at night"}"
               value="${esc(this.get("query") || "")}" ${this.driven ? "disabled" : ""}/>
        <span class="ft-maps">${PROCESSORS.map(
        (p) => `<button class="ft-map${this.get(p.key) ? " on" : ""}" data-proc="${p.key}"
                  title="${p.label} — costs one fal call per frame">${ICON[p.key]}</button>`
    ).join("")}</span>
        <button class="ft-cog${this.settingsOpen ? " on" : ""}" data-act="cog" title="Search mode and index">${ICON.cog}</button>
      </div>
      ${this.settings()}
      <div class="ft-bar"><i style="width:${this.progress}%"></i></div>
      <div class="ft-scroll">${this.body()}</div>
      <div class="ft-foot">
        <span class="ft-stat">${this.status()}</span>
        <span class="ft-acts">
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

        const num = this.root.querySelector(".ft-num");
        if (num) num.onchange = () => this.set("index", Math.max(0, Math.min(499, Number(num.value) || 0)));

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
            const hit = (sel) => e.target.closest(sel);
            const btn = hit("[data-act]");
            if (btn) {
                e.stopPropagation();
                const act = btn.dataset.act;
                if (act === "cog") { this.settingsOpen = !this.settingsOpen; this.render(); }
                else if (act === "refresh") { this.lastKey = ""; this.done = false; this.search(); }
                else this.clear();
                return;
            }
            const mode = hit("[data-mode]");
            if (mode) {
                e.stopPropagation();
                this.set("mode", mode.dataset.mode);
                this.lastKey = "";
                this.search();
                return;
            }
            const proc = hit("[data-proc]");
            if (proc) {
                e.stopPropagation();
                const k = proc.dataset.proc;
                this.set(k, !this.get(k));
                this.render();
                return;
            }
            const cell = hit(".ft-cell");
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
                getMinHeight: () => 140,
                getMaxHeight: () => 1e6,
            });

            this.size = [320, 420];
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
