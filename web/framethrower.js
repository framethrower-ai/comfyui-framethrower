/**
 * The results area for the FT Reference node.
 *
 * Deliberately not a port of the canvas node's chrome. The canvas node carries
 * its own header, mode menu and footer because on that canvas nothing else
 * provides them; in ComfyUI the node already has a title bar and real widgets
 * for query, mode and the toggles. Re-drawing all of that inside the body just
 * produced a second, emptier node hanging off the bottom of the first.
 *
 * So this is one thing: somewhere to see the frames and click one.
 *
 * The CSS is injected from here rather than shipped as a sibling .css file
 * because the URL a custom node's assets are served from depends on the folder
 * name on disk, which we do not control — a renamed directory would give an
 * unstyled node and no error to explain it.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "FrameThrowerReference";
const PAGE_SIZE = 30;

const CSS = `
.ft-wrap { display:flex; flex-direction:column; height:100%; min-height:120px;
  border-radius:6px; overflow:hidden; background:#0a0a0a;
  border:1px solid rgba(255,255,255,.08); --ft-accent:#e8542f;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
.ft-top { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between;
  gap:8px; padding:4px 6px; border-bottom:1px solid rgba(255,255,255,.08); }
.ft-stat { font-size:10px; color:rgba(255,255,255,.4); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; min-width:0; }
.ft-tools { display:flex; gap:2px; flex:0 0 auto; }
.ft-tools button { border:none; background:transparent; cursor:pointer; border-radius:4px;
  padding:2px 6px; font-size:10px; color:rgba(255,255,255,.4); }
.ft-tools button:hover { background:rgba(255,255,255,.1); color:#fff; }
.ft-tools button:disabled { opacity:.25; cursor:default; background:transparent; }
.ft-bar { flex:0 0 auto; height:2px; background:transparent; }
.ft-bar > i { display:block; height:100%; background:var(--ft-accent); transition:width .1s linear; }
.ft-scroll { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; padding:4px; }
.ft-scroll::-webkit-scrollbar { width:6px; }
.ft-scroll::-webkit-scrollbar-thumb { background:rgba(255,255,255,.12); border-radius:3px; }
.ft-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:2px; }
.ft-cell { position:relative; aspect-ratio:16/9; overflow:hidden; background:#111;
  cursor:pointer; box-shadow:inset 0 0 0 .5px rgba(255,255,255,.25); }
.ft-cell:hover { box-shadow:inset 0 0 0 1.5px var(--ft-accent); }
.ft-cell.on { box-shadow:inset 0 0 0 2px var(--ft-accent); }
.ft-cell img { width:100%; height:100%; object-fit:cover; display:block; }
.ft-cap { position:absolute; left:0; right:0; bottom:0; padding:2px 4px; opacity:0;
  transition:opacity .12s; pointer-events:none;
  background:linear-gradient(to top,rgba(0,0,0,.85),transparent); }
.ft-cell:hover .ft-cap, .ft-cell.on .ft-cap { opacity:1; }
.ft-cap b { display:block; font-size:8px; font-weight:400; color:#fff; line-height:1.25;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-cap i { display:block; font-size:7px; font-style:normal; color:rgba(255,255,255,.55);
  line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ft-msg { display:flex; align-items:center; justify-content:center; height:100%;
  min-height:80px; padding:12px; text-align:center; font-size:11px;
  color:rgba(255,255,255,.28); }
.ft-msg.err { color:#f87171; }
.ft-more { padding:6px 0; text-align:center; font-size:9px; color:rgba(255,255,255,.25); }
`;

const esc = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function injectCss() {
    if (document.getElementById("ft-node-css")) return;
    const style = document.createElement("style");
    style.id = "ft-node-css";
    style.textContent = CSS;
    document.head.appendChild(style);
}

class Results {
    constructor(node) {
        this.node = node;
        this.rows = [];
        this.pinnedId = null;
        this.loading = false;
        this.more = false;
        this.done = false;
        this.error = null;
        this.query = "";
        this.progress = 0;
        this.lastKey = "";
        this.timer = null;

        this.root = document.createElement("div");
        this.root.className = "ft-wrap";
        // Comfy pans and zooms the graph on wheel and drag; without this,
        // scrolling the grid zooms the whole canvas instead.
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

    untick() {
        clearInterval(this.timer);
        this.progress = 0;
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

    async search(query, { append = false, imageUrl = null } = {}) {
        const q = (query || "").trim();
        if (!imageUrl && !q) {
            this.rows = [];
            this.query = "";
            this.render();
            return;
        }
        const key = imageUrl ? `img::${imageUrl}` : `${q}::${this.mode}`;
        if (!append && key === this.lastKey && this.rows.length) return;
        if (!append) {
            this.lastKey = key;
            this.loading = true;
            this.error = null;
            this.done = false;
            this.query = imageUrl ? "similar frames" : q;
            this.tick(imageUrl ? 12000 : 3000);
        } else {
            this.more = true;
        }
        this.render();

        try {
            const data = imageUrl
                ? await this.post({ imageUrl })
                : await this.post({ query: q, limit: PAGE_SIZE, mode: this.mode, offset: append ? this.rows.length : 0 });
            const rows = data.results || [];
            if (append) {
                // The vector index returns the same frame in overlapping
                // windows; a duplicate id would also break the DOM diff.
                const seen = new Set(this.rows.map((r) => r.id));
                const fresh = rows.filter((r) => !seen.has(r.id));
                if (!fresh.length) this.done = true;
                this.rows = this.rows.concat(fresh);
            } else {
                this.rows = rows;
            }
            if (imageUrl || rows.length < PAGE_SIZE) this.done = true;
        } catch (e) {
            if (append) this.done = true; // don't hammer a failing endpoint
            else this.error = e.message;
        } finally {
            this.loading = false;
            this.more = false;
            this.untick();
            this.render();
        }
    }

    pick(row) {
        // Clicking the pinned frame again unpins it, so a mis-click is one
        // click to undo rather than a hunt for a clear button.
        if (this.pinnedId === row.id) {
            this.pinnedId = null;
            const w = this.widget("pinned");
            if (w) w.value = "";
        } else {
            this.pinnedId = row.id;
            const w = this.widget("pinned");
            if (w) w.value = JSON.stringify(row);
        }
        this.node.setDirtyCanvas(true, true);
        this.render();
    }

    refresh() {
        this.lastKey = "";
        this.done = false;
        this.search(this.widget("query")?.value || "");
    }

    // Leaves the query widget alone on purpose: results come back when you
    // change the prompt, so Clear feels like a clear rather than a reload.
    clear() {
        this.rows = [];
        this.pinnedId = null;
        this.query = "";
        this.error = null;
        this.done = false;
        this.lastKey = "";
        const w = this.widget("pinned");
        if (w) w.value = "";
        this.render();
    }

    body() {
        if (this.error) return `<div class="ft-msg err">${esc(this.error)}</div>`;
        if (this.loading && !this.rows.length) return `<div class="ft-msg">Searching…</div>`;
        if (!this.rows.length) {
            return `<div class="ft-msg">Type a query above, or wire a prompt into query_in</div>`;
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
            : this.done ? `<div class="ft-more">End of results</div>` : "";
        return `<div class="ft-grid">${cells}</div>${tail}`;
    }

    status() {
        if (this.error) return "Error";
        if (this.loading) return "Searching…";
        if (this.pinnedId) {
            const r = this.rows.find((x) => x.id === this.pinnedId);
            return r ? `Using: ${r.filmTitle || "frame"}` : "1 frame selected";
        }
        if (this.rows.length) return `${this.rows.length} frames — click one to use it`;
        return this.query || "No results";
    }

    render() {
        const keep = this.root.querySelector(".ft-scroll")?.scrollTop || 0;
        this.root.innerHTML = `
      <div class="ft-top">
        <span class="ft-stat" title="${esc(this.status())}">${esc(this.status())}</span>
        <span class="ft-tools">
          <button data-act="refresh">Refresh</button>
          <button data-act="clear" ${this.rows.length ? "" : "disabled"}>Clear</button>
        </span>
      </div>
      <div class="ft-bar"><i style="width:${this.progress}%"></i></div>
      <div class="ft-scroll">${this.body()}</div>`;

        const scroll = this.root.querySelector(".ft-scroll");
        if (scroll) {
            scroll.scrollTop = keep;
            scroll.onscroll = () => {
                if (this.loading || this.more || this.done) return;
                if (!this.query || this.query === "similar frames") return;
                if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120) {
                    this.search(this.query, { append: true });
                }
            };
        }

        this.root.onclick = (e) => {
            const btn = e.target.closest("[data-act]");
            if (btn) {
                e.stopPropagation();
                if (btn.dataset.act === "refresh") this.refresh();
                else this.clear();
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

            const ui = new Results(this);
            this.ftUI = ui;
            this.addDOMWidget("ft_results", "div", ui.root, { serialize: false, hideOnZoom: false });

            // `pinned` is written by the grid, never typed into. Hidden so a
            // blob of JSON stays off the node face without dropping out of the
            // saved workflow.
            const pinned = this.widgets.find((w) => w.name === "pinned");
            if (pinned) {
                pinned.type = "hidden";
                pinned.computeSize = () => [0, -4];
            }

            const debounceOn = (name, fn, ms) => {
                const w = this.widgets.find((x) => x.name === name);
                if (!w) return;
                let t = null;
                const prev = w.callback;
                w.callback = function (value) {
                    prev?.apply(this, arguments);
                    clearTimeout(t);
                    t = setTimeout(() => fn(value), ms);
                };
            };
            // 1s on typing, matching the canvas node's debounce; instant on a
            // mode change, since that is a deliberate single click.
            debounceOn("query", (v) => ui.search(v), 1000);
            debounceOn("mode", () => { ui.lastKey = ""; ui.refresh(); }, 0);

            this.size = [340, 480];
            this.serialize_widgets = true;
        };

        // Bring a saved workflow back showing the frame it will actually output.
        const configure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            configure?.apply(this, arguments);
            const raw = this.widgets?.find((w) => w.name === "pinned")?.value;
            if (raw && this.ftUI) {
                try {
                    const row = JSON.parse(raw);
                    this.ftUI.pinnedId = row.id;
                    this.ftUI.rows = [row];
                    this.ftUI.render();
                } catch { /* saved mid-edit — start empty */ }
            }
        };
    },
});
