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
// One call to /api/v1/search. Scrolling to the bottom asks for the next
// page by offset; v1 stops ranking past 500, which is where the grid ends.
const PAGE_SIZE = 50;

/** One /status request per page load, shared by every node on the canvas. */
let statusPromise = null;

/**
 * How long a search takes, learned rather than assumed.
 *
 * Measured here: 3.1s on the first call of a session, then 1.0–1.2s once
 * Qdrant and the embedder are warm — and both numbers move with the machine and
 * the connection. A fixed duration is wrong for somebody every time, so the
 * fill aims at a rolling average of what this install actually sees, seeded at
 * two seconds and weighted toward recent searches.
 */
let searchMs = 2000;
const rememberSearchMs = (ms) => {
    if (ms > 200 && ms < 30000) searchMs = Math.round(searchMs * 0.6 + ms * 0.4);
};

/** The frame currently being dragged out of some node's grid, if any. */
let dragging = null;

/**
 * Registered once, on the canvas, rather than per node: the drop lands on the
 * canvas element, not on the node the drag started in, so a per-node handler
 * would never fire.
 */
function installDropHandler() {
    const canvas = app.canvas?.canvas;
    if (!canvas || canvas.dataset.ftDrop) return;
    canvas.dataset.ftDrop = "1";

    canvas.addEventListener("dragover", (e) => {
        if (!dragging) return;
        e.preventDefault();                    // without this, drop never fires
        e.dataTransfer.dropEffect = "copy";
    });

    canvas.addEventListener("drop", async (e) => {
        const row = dragging;
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();                   // Comfy also handles drops, for files
        dragging = null;

        // A plain LoadImage, not another node of ours. What lands on the canvas
        // is then an ordinary Comfy node that works in any workflow and does
        // not depend on this package existing — which is the point of dragging
        // a picture out rather than wiring a socket.
        //
        // LoadImage reads the input folder by filename and knows nothing about
        // URLs, so the server fetches the frame to disk first and hands back
        // the name it saved it under.
        const pos = app.canvas.convertEventToCanvasOffset(e);
        try {
            const label = [row.filmTitle, row.year].filter(Boolean).join(" ") || "frame";
            const res = await api.fetchApi("/framethrower/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: row.fullSrc || row.src, name: `${label}_${row.id}` }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Could not save the frame (${res.status})`);

            const node = LiteGraph.createNode("LoadImage");
            if (!node) throw new Error("LoadImage is not available");
            app.graph.add(node);
            node.pos = pos;
            const w = node.widgets?.find((x) => x.name === "image");
            if (w) {
                // The combo only offers what it listed at load time, so a file
                // saved a moment ago has to be added to its options by hand.
                if (Array.isArray(w.options?.values) && !w.options.values.includes(data.filename)) {
                    w.options.values.push(data.filename);
                }
                w.value = data.filename;
                w.callback?.(data.filename);
            }
            node.title = label;
            app.graph.setDirtyCanvas(true, true);
        } catch (err) {
            console.error("[FrameThrower] could not drop frame:", err);
            alert(`Could not add that frame: ${err.message}`);
        }
    });
}

/** Every native widget, so they can all be hidden in one pass. */
const NATIVE = ["query", "mode", "index", "pinned", "filters", "smart"];

// The node always searches hybrid. `description` ranks on the written
// descriptions alone and is worse for nearly every query anyone brings to a
// reference tool, and a control that is wrong to touch is a control that
// should not be there. The widget still exists for a workflow that sets it.

/**
 * The filters, in the same v4 vocabulary the app's own tag filters use.
 *
 * These are the axes you cannot say in words and get reliably — asking for "a
 * close-up" ranks frames whose description mentions close-ups rather than
 * frames that are one. Lighting is the one worth knowing about: it is what is
 * lighting the frame (neon, firelight, a screen), which is a different question
 * from the time of day, and it was not reachable through the API until now.
 *
 * Left out: director, genre and film_title are free text and belong in the
 * query itself.
 *
 * Every value here was tested against live search on 2026-08-18. The app's own
 * tag UI offers a finer v4 vocabulary — extreme_closeup, cowboy_shot,
 * medium_wide, ground_level — and all of those match zero frames through
 * search, so they are deliberately absent. A dropdown option that can never
 * return a result is worse than one that is not there.
 */
const FILTERS = [
    { key: "shot_type", label: "Shot", values: ["closeup", "medium", "fullbody", "wide", "establishing"] },
    { key: "camera_angle", label: "Angle", values: ["eye_level", "low_angle", "high_angle", "overhead", "top_down", "dutch_angle", "pov", "worms_eye", "birds_eye"] },
    { key: "time_of_day", label: "Time", values: ["day", "night", "golden_hour", "blue_hour", "dawn", "dusk", "overcast"] },
    { key: "lighting", label: "Light", values: ["sun", "window", "moonlight", "practical", "neon", "fluorescent", "firelight", "candlelight", "streetlamp", "screen_glow", "headlight", "lightning"] },
    { key: "setting", label: "Where", values: ["interior", "exterior"] },
    { key: "era", label: "Era", values: ["ancient", "medieval", "renaissance", "1800s", "1900s_1910s", "1920s", "1930s", "1940s", "1950s", "1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "contemporary", "near_future", "far_future", "fantasy"] },
    { key: "depth_of_field", label: "Focus", values: ["shallow", "deep", "rack_focus", "medium"] },
    { key: "lens", label: "Lens", values: ["anamorphic", "spherical", "vintage_soft"] },
    { key: "visual_style", label: "Style", values: ["live_action", "anime", "noir", "cg_stylized", "cg_photorealistic", "cartoon_2d", "stop_motion", "painterly", "documentary", "expressionist", "surreal", "minimalist", "watercolor", "rotoscope", "mixed_media"] },
];

/**
 * The hue bar, ported from the site's HueBarPicker.
 *
 * Saturation and lightness are held off full — 70/45, the values the site
 * uses — so the swatches read filmic rather than neon, and because the frames
 * being matched are photographed, not screen-printed. The gradient and the hex
 * a click returns come from the same formula, so what you click is exactly
 * what gets searched.
 */
const HUE_SAT = 70;
const HUE_LIGHT = 45;

function hslToHex(h, sPct = HUE_SAT, lPct = HUE_LIGHT) {
    const a = (sPct / 100) * Math.min(lPct / 100, 1 - lPct / 100);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        const c = lPct / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
        return Math.round(255 * c).toString(16).padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/** Nine stops is enough for a smooth ramp and keeps the CSS short. */
const HUE_GRADIENT = [0, 45, 90, 135, 180, 225, 270, 315, 360]
    .map((h) => `${hslToHex(h % 360)} ${(h / 360) * 100}%`)
    .join(",");

/** night → Night, golden_hour → Golden hour. */
const pretty = (v) => v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

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

/* the hue bar, above the field. Horizontal here rather than the site's
   vertical bar: a node is wide and short, and the search box it belongs to
   runs the same way. */
/* The row exists so the handle has somewhere to overhang into. It stands 2px
   proud of the bar at each end, and the bar is the first thing in the node
   body — without this padding the top of the handle is clipped by the body's
   own overflow:hidden, which is what made it look sawn off. */
.ft-hue-row { flex:0 0 auto; display:flex; align-items:center; gap:5px;
  padding:3px 0 2px; margin-bottom:4px; }
.ft-hue { position:relative; flex:1 1 auto; height:12px; cursor:crosshair; }
/* Clearing the colour belongs beside the thing that set it, not only down in
   the status line — that is where you are looking when you change your mind. */
.ft-hue-x { flex:0 0 auto; display:flex; padding:2px; border:none; border-radius:3px;
  background:transparent; color:var(--ft-dim); cursor:pointer; }
.ft-hue-x svg { width:10px; height:10px; }
.ft-hue-x:hover { color:var(--ft-fg); background:var(--p-content-hover-background,rgba(255,255,255,.12)); }
.ft-hue-bar { display:block; height:100%; border-radius:3px;
  border:1px solid var(--ft-line); }
.ft-hue-mark { position:absolute; top:-2px; width:8px; height:16px; margin-left:-4px;
  border-radius:2px; border:2px solid #fff; box-shadow:0 0 0 1px rgba(0,0,0,.6);
  pointer-events:none; }

/* one row: search box and the mode it searches in. The loading fill lives
   here rather than on a separate hairline — the thing you are waiting on is
   the query, so the progress belongs in the box you typed it into. */
.ft-search { position:relative; flex:0 0 auto; display:flex; align-items:center; gap:6px;
  margin-bottom:6px; padding:4px 6px; border-radius:4px; overflow:hidden;
  background:var(--comfy-input-bg,#1a1a1a); border:1px solid var(--ft-line); }
.ft-search:focus-within { border-color:var(--ft-on); }
.ft-load { position:absolute; left:0; top:0; bottom:0; width:0; pointer-events:none;
  background:linear-gradient(90deg, rgba(37,99,235,.05), rgba(37,99,235,.30));
  background-color:color-mix(in srgb, var(--ft-on) 22%, transparent);
  transition:width .12s linear; }
.ft-search > *:not(.ft-load) { position:relative; z-index:1; }
.ft-search > svg { width:12px; height:12px; color:var(--ft-dim); flex:0 0 auto; }
.ft-search input { flex:1 1 auto; min-width:0; border:none; outline:none; background:transparent;
  color:var(--ft-fg); font:inherit; font-size:11.5px; padding:2px 0; }
.ft-search input::placeholder { color:var(--ft-dim); opacity:.6; }
.ft-search input:disabled { color:var(--ft-dim); font-style:italic; }

/* filter bar, above the search field */
/* A grid rather than a wrapping flex: nine controls of different label widths
   wrap into a ragged stack, and columns keep the rows readable at any node
   width. auto-fit means a narrow node gets two per row and a wide one gets
   five, without a breakpoint. */
.ft-filters { flex:0 0 auto; display:grid; gap:3px 6px; padding:0 2px 6px;
  grid-template-columns:repeat(auto-fit,minmax(96px,1fr)); align-items:center; }
.ft-f { display:flex; align-items:center; gap:3px; min-width:0; font-size:9px;
  color:var(--ft-dim); }
.ft-f > span { flex:0 0 auto; }
.ft-f select { flex:1 1 auto; min-width:0; }
.ft-f select { border:1px solid var(--ft-line); border-radius:3px; background:transparent;
  color:var(--ft-fg); font:inherit; font-size:9.5px; padding:1px 2px; outline:none;
  cursor:pointer; }
.ft-f select option { background:var(--comfy-menu-bg,#252525); }
.ft-clearf { grid-column:1/-1; justify-self:start; border:none; background:transparent; color:var(--ft-dim); font:inherit;
  font-size:9px; cursor:pointer; text-decoration:underline; }
.ft-clearf:hover { color:var(--ft-fg); }
.ft-funnel { position:relative; flex:0 0 auto; display:flex; align-items:center; gap:2px;
  padding:3px; border:none; border-radius:3px; background:transparent; color:var(--ft-dim);
  cursor:pointer; font:inherit; font-size:9px; }
.ft-funnel svg { width:11px; height:11px; }
.ft-funnel:hover { color:var(--ft-fg); }
.ft-funnel.on { color:var(--ft-on); }

/* "more like this", on each frame */
.ft-eye { position:absolute; top:2px; right:2px; z-index:2; display:flex; padding:2px;
  border:none; border-radius:3px; background:rgba(0,0,0,.55); color:#fff; cursor:pointer;
  opacity:0; transition:opacity .12s; }
.ft-eye svg { width:11px; height:11px; }
.ft-cell:hover .ft-eye { opacity:.85; }
.ft-eye:hover { opacity:1; background:var(--ft-on); }

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
/* Selected. Two rings — the accent inside, a dark one outside — so it reads
   against a bright frame and a dark one both, which a single inset line does
   not. Nothing else is dimmed: the other frames are still the thing you are
   choosing between, and greying them out made the grid look disabled. */
.ft-cell.on { box-shadow:inset 0 0 0 2.5px var(--ft-on), 0 0 0 1px rgba(0,0,0,.9);
  outline:1px solid var(--ft-on); outline-offset:1px; z-index:1; }
.ft-cell.on::after { content:""; position:absolute; inset:0;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.35); pointer-events:none; }
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
.ft-conn .ft-alt { padding:5px 12px; border:1px solid var(--ft-line); border-radius:3px;
  background:transparent; color:var(--ft-fg); font:inherit; font-size:11px; cursor:pointer; }
.ft-conn .ft-alt:hover { border-color:var(--ft-on); }
.ft-back { border:none; background:transparent; color:var(--ft-dim); font:inherit;
  font-size:9px; cursor:pointer; padding:0; }
.ft-back:hover { color:var(--ft-fg); }
.ft-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:19px;
  letter-spacing:.16em; color:var(--ft-fg); padding:5px 11px; border:1px solid var(--ft-line);
  border-radius:4px; }
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
.ft-link.up { color:#3fb950; cursor:pointer; }
.ft-link.up:hover { background:rgba(63,185,80,.12); }
.ft-link.down { color:#f85149; cursor:pointer; }
.ft-link.down:hover { background:rgba(248,81,73,.12); }
.ft-stat { display:flex; align-items:center; min-width:0; font-size:9.5px;
  color:var(--ft-dim); white-space:nowrap; }
.ft-stat b { color:var(--ft-fg); font-weight:500; overflow:hidden; text-overflow:ellipsis; }
.ft-smart.on { color:var(--ft-on); }
/* An enabled toggle keeps its colour on hover: the generic .ft-acts hover
   rule is more specific, so without this, pointing at a switch that is on
   makes it look off. */
.ft-acts button.ft-smart.on:hover, .ft-acts button.ft-funnel.on:hover { color:var(--ft-on); }
.ft-chip { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:4px;
  border:1px solid rgba(255,255,255,.35); flex:0 0 auto; }
.ft-undo { display:inline-flex; vertical-align:-1px; margin-left:4px; padding:1px;
  border:none; border-radius:2px; background:transparent; color:var(--ft-dim);
  cursor:pointer; }
.ft-undo svg { width:9px; height:9px; }
.ft-undo:hover { color:var(--ft-fg); background:var(--p-content-hover-background,rgba(255,255,255,.12)); }
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

`;

const SVG = (d) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const ICON = {
    search: SVG('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    refresh: SVG('<path d="M21 12a9 9 0 0 0-9-9 9.8 9.8 0 0 0-6.7 2.7L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.8 9.8 0 0 0 6.7-2.7L21 16"/><path d="M16 16h5v5"/>'),
    x: SVG('<path d="M18 6 6 18M6 6l12 12"/>'),
    spark: SVG('<path d="M12 3v3.2M12 17.8V21M3 12h3.2M17.8 12H21M5.6 5.6l2.3 2.3M16.1 16.1l2.3 2.3M18.4 5.6l-2.3 2.3M7.9 16.1l-2.3 2.3"/><circle cx="12" cy="12" r="2.8"/>'),
    funnel: SVG('<path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3Z"/>'),
    eye: SVG('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
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
        this.error = null;
        this.progress = 0;
        this.lastKey = "";
        this.timer = null;
        this.debounce = null;
        this.more = false;
        this.done = false;
        this.status_ = null;      // null until /status answers; then {configured,…}
        this.mirrored = null;     // last text seen on the query_in wire
        this.filtersOpen = false;
        this.likeOf = null;      // the frame we are searching 'more like this' from
        this.colorOf = null;     // the hex we are searching by, if any
        this.hueOf = null;
        this.enhanced = null;    // the rewritten query, when smart search fired
        this.watch = null;
        this.connError = null;
        this.connStep = null;   // null | "paste" | "code"
        this.pairCode = null;

        this.root = document.createElement("div");
        this.root.className = "ft";
        // Comfy pans and zooms the graph on wheel and drag. Without this,
        // scrolling the grid zooms the whole canvas and typing moves the node.
        for (const ev of ["wheel", "pointerdown", "mousedown", "contextmenu", "keydown"]) {
            this.root.addEventListener(ev, (e) => e.stopPropagation());
        }
        this.render();
        this.checkStatus();
        this.watchUpstream();
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

    /** Chosen filters, on node properties for the same reason the thumbnail
     *  size is: they shape what you see, they belong in a saved workflow, and
     *  they are not something another node should be able to wire into. */
    get filters() {
        return this.node.properties?.ftFilters || {};
    }
    setFilter(key, value) {
        this.node.properties = this.node.properties || {};
        const next = { ...this.filters };
        if (value) next[key] = value; else delete next[key];
        this.node.properties.ftFilters = next;
        // Mirrored into the hidden widget so the executing graph filters the
        // same way the grid does.
        this.set("filters", Object.keys(next).length ? JSON.stringify(next) : "");
        this.lastKey = "";          // same words, different question
        this.search();
    }
    get filterCount() {
        return Object.keys(this.filters).length;
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

    /**
     * The text coming down the query_in wire, read straight off the upstream
     * node's widget.
     *
     * Comfy does not evaluate the graph until you queue it, so there is no
     * "current value" of a link to ask for — the only way to show what is
     * arriving is to walk to the node on the other end and read it. Widget
     * names differ by node (CLIP Text Encode calls it `text`, a primitive
     * calls it `value`), so try the usual ones and then any string widget.
     */
    upstreamText() {
        const slot = this.node.inputs?.findIndex((i) => i.name === "query_in");
        if (slot == null || slot < 0) return null;
        const src = this.node.getInputNode?.(slot);
        if (!src?.widgets) return null;
        for (const name of ["text", "value", "string", "prompt"]) {
            const w = src.widgets.find((x) => x.name === name);
            if (typeof w?.value === "string") return w.value;
        }
        const any = src.widgets.find((x) => typeof x.value === "string");
        return typeof any?.value === "string" ? any.value : null;
    }

    /**
     * Show what the wire is carrying, and search on it.
     *
     * Polled rather than hooked: the upstream widget can change from typing, an
     * undo, a workflow load or another extension, and only some of those fire a
     * callback we could subscribe to. 400ms is under the threshold where it
     * feels like lag and far above the cost of reading one string.
     */
    watchUpstream() {
        clearInterval(this.watch);
        this.watch = setInterval(() => {
            if (!this.driven) {
                if (this.mirrored != null) { this.mirrored = null; this.render(); }
                return;
            }
            const text = (this.upstreamText() || "").trim();
            if (text === this.mirrored) return;
            this.mirrored = text;
            this.set("query", text);
            this.render();
            clearTimeout(this.debounce);
            // A second, like the canvas node: long enough that typing upstream
            // does not spend a search per keystroke.
            this.debounce = setTimeout(() => this.search(), 1000);
        }, 400);
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

    /** Ask for a code, then poll until someone approves it at /link.
     *
     *  The loop lives here rather than in a long-held server request: a poll
     *  that waits server-side would tie up one of ComfyUI's workers for the
     *  full ten minutes, and a canvas with three unsigned-in nodes would tie up
     *  three. Stops on approval, expiry, or the panel being left. */
    async pair() {
        this.pairCode = null;
        this.pairExpires = null;
        this.render();
        let deviceId;
        try {
            const res = await api.fetchApi("/framethrower/pair", { method: "POST" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Pairing failed (${res.status})`);
            this.pairCode = data.code;
            this.pairExpires = Date.parse(data.expiresAt) || Date.now() + 600000;
            deviceId = data.deviceId;
            // On a machine where the browser IS to hand, skip the retyping.
            const url = `${data.verifyUrl || "https://framethrower.ai/link"}?code=${encodeURIComponent(data.code)}`;
            window.open(url, "_blank", "noopener");
        } catch (e) {
            this.connError = e.message;
            this.render();
            return;
        }

        this.pairToken = (this.pairToken || 0) + 1;
        const mine = this.pairToken;
        const tick = async () => {
            // A different pairing started, or the panel moved on. Stop.
            if (mine !== this.pairToken || this.connStep !== "code") return;
            if (Date.now() > this.pairExpires) {
                this.connError = "That code expired. Try again.";
                this.render();
                return;
            }
            try {
                const res = await api.fetchApi(`/framethrower/pair/poll?deviceId=${encodeURIComponent(deviceId)}`);
                const data = await res.json().catch(() => ({}));
                if (data.status === "approved") {
                    this.connStep = null;
                    this.connError = null;
                    await this.checkStatus({ fresh: true });
                    if (this.get("query")) this.search();
                    return;
                }
                if (data.status === "expired") {
                    this.connError = "That code expired. Try again.";
                    this.render();
                    return;
                }
            } catch {
                // A dropped poll is not a failed pairing — keep waiting.
            }
            this.render();
            setTimeout(tick, 3000);
        };
        setTimeout(tick, 3000);
    }

    /** What the Smart button says on hover — including the sentence actually
     *  searched, which is the detail worth having and costs no layout here. */
    smartTitle() {
        if (this.get("smart") === false) {
            return "Smart search off — your words are searched exactly as typed. Right for a title, a line of dialogue, or a term to match literally.";
        }
        if (this.enhanced) return `Smart search on. Searched as: ${this.enhanced}`;
        return "Smart search on — your words are rewritten into the register the frames were described in, which finds more of them.";
    }

    /** Minutes and seconds left on the current code, or nothing if unknown. */
    pairLeft() {
        if (!this.pairExpires) return "";
        const ms = this.pairExpires - Date.now();
        if (ms <= 0) return "";
        const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
        return ` expires in ${m}:${String(sec).padStart(2, "0")}`;
    }

    async signOut() {
        try {
            const res = await api.fetchApi("/framethrower/connect", { method: "DELETE" });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Could not sign out");
            this.clear();
            this.connStep = null;
            await this.checkStatus({ fresh: true });
        } catch (e) {
            this.connError = e.message;
            this.render();
        }
    }

    async connect(token) {
        this.connError = null;
        this.connStep = null;   // null | "paste" | "code"
        this.pairCode = null;
        try {
            const res = await api.fetchApi("/framethrower/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Could not save (${res.status})`);
            this.connStep = null;
            await this.checkStatus({ fresh: true });
            if (this.get("query")) this.search();
        } catch (e) {
            this.connError = e.message;
            this.render();
        }
    }

    // ── search ───────────────────────────────────────────────────────────────
    /**
     * Fill the search field while we wait.
     *
     * A real percentage is not available — the server does not stream progress
     * — so this eases toward 95% over roughly how long a search takes and the
     * response snaps it to full. Deliberately never reaching 100 on its own:
     * a bar that sits at 100% while nothing happens is worse than one that is
     * still visibly moving.
     */
    tick(ms) {
        this.progress = 0;
        clearInterval(this.timer);
        const inc = 95 / (ms / 50);
        this.timer = setInterval(() => {
            this.progress = Math.min(95, this.progress + inc);
            const bar = this.root.querySelector(".ft-load");
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
        if (!q && !this.colorOf) {
            this.rows = [];
            this.render();
            return;
        }
        // Read from the widget, not a local: the mode dropdown is gone from the
        // face but the widget remains, so a saved workflow that set it is still
        // honoured — and the cache key still has to change when it differs.
        const mode = this.get("mode") || "hybrid";
        const key = `${q}::${mode}::${JSON.stringify(this.filters)}`;
        if (!append && key === this.lastKey && this.rows.length) return;
        if (append) {
            this.more = true;
        } else {
            this.lastKey = key;
            this.loading = true;
            this.error = null;
            this.done = false;
            this.tick(searchMs);
        }
        this.render();

        const startedAt = performance.now();
        try {
            const data = await this.post({
                // Later pages search the rewritten query with enhancement off:
                // re-rewriting could return something slightly different and
                // page two would rank in another neighbourhood than page one.
                query: append && this.enhanced ? this.enhanced : q,
                enhance: this.get("smart") !== false && !append,
                limit: PAGE_SIZE, mode,
                offset: append ? this.rows.length : 0,
                // Sent alongside the query rather than instead of it: v1 fuses
                // the two, so "ocean" in teal stays about the sea.
                ...(this.colorOf ? { color: this.colorOf } : {}),
                ...this.filters,
            });
            if (!append) this.enhanced = data.enhancedQuery || null;
            const rows = data.results || [];
            if (append) {
                // The vector index can return the same frame in overlapping
                // windows, and a duplicate id would break the grid's diff too.
                const seen = new Set(this.rows.map((r) => r.id));
                const fresh = rows.filter((r) => !seen.has(r.id));
                if (!fresh.length) this.done = true;
                this.rows = this.rows.concat(fresh);
            } else {
                this.rows = rows;
            }
            if (data.exhausted) this.done = true;
        } catch (e) {
            if (append) this.done = true;   // don't hammer a failing endpoint
            else this.error = e.message;
        } finally {
            if (!append) rememberSearchMs(performance.now() - startedAt);
            this.loading = false;
            this.more = false;
            clearInterval(this.timer);
            this.progress = 0;
            this.render();
        }
    }

    /**
     * Find frames that look like this one.
     *
     * The frame is already on a public URL, so this needs no upload and no fal
     * key — unlike image_in, where the picture only exists as floats in a graph.
     *
     * It replaces the results rather than narrowing them: FrameThrower has no
     * endpoint that takes a query and a reference image together, and pretending
     * otherwise by filtering one set by the other would be a different, worse
     * search wearing the same name. The words stay in the box, so one click on
     * Refresh gets them back.
     */
    async searchLike(row) {
        this.loading = true;
        this.error = null;
        this.done = true;              // image search returns one page
        this.likeOf = row;
        this.lastKey = `like::${row.id}`;
        this.tick(searchMs * 4);   // image search is far slower
        this.render();
        try {
            const data = await this.post({ imageUrl: row.fullSrc || row.src });
            this.rows = data.results || [];
        } catch (e) {
            this.error = e.message;
        } finally {
            this.loading = false;
            clearInterval(this.timer);
            this.progress = 0;
            this.render();
        }
    }

    /**
     * Search by colour.
     *
     * Its own endpoint, not a filter on the text search — the colour histogram
     * is a separate index, and there is no call that takes a mood and a hue
     * together. So this replaces the results, like the eye does, and the words
     * stay in the box to come back to.
     */
    setColor(hex, hue) {
        this.colorOf = hex;
        this.hueOf = hue;
        this.likeOf = null;
        this.lastKey = "";            // same words, different question
        this.search();
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
        this.lastKey = "";
        this.set("pinned", "");
        this.render();
    }

    // ── view ─────────────────────────────────────────────────────────────────
    /** Shown instead of results until the server has a token.
     *
     *  Two doors, because they are not alternatives for the same person. The
     *  browser route only works when the browser and ComfyUI are on one machine
     *  — a redirect to 127.0.0.1:8188 means nothing from a laptop pointed at a
     *  rented GPU — and that is a large share of ComfyUI. The pairing code works
     *  everywhere. Neither is a fallback for the other. */
    connectPanel() {
        const err = this.connError
            ? `<p style="color:var(--error-text,#f87171)">${esc(this.connError)}</p>` : "";

        if (this.connStep === "paste") {
            return `<div class="ft-conn">
        <p>Create a token on the page that just opened, then paste it here.</p>
        <div class="ft-paste">
          <input type="password" placeholder="ft_…" spellcheck="false" autofocus/>
          <button data-act="save">Save</button>
        </div>
        ${err}
        <button class="ft-back" data-act="back">← back</button>
      </div>`;
        }

        if (this.connStep === "code") {
            return `<div class="ft-conn">
        <p>Go to <b style="color:var(--ft-fg);font-weight:500">framethrower.ai/link</b> and enter</p>
        <div class="ft-code">${esc(this.pairCode || "————")}</div>
        ${err || `<p style="font-size:9px;opacity:.8">Waiting for approval…${this.pairLeft()}</p>`}
        <button class="ft-back" data-act="back">← back</button>
      </div>`;
        }

        return `<div class="ft-conn">
      <p>Sign in to FrameThrower to search the library.</p>
      <button class="ft-go" data-act="browser">Sign in with browser</button>
      <span class="ft-or">OR</span>
      <button class="ft-alt" data-act="code">Use a pairing code</button>
      <p style="font-size:9px;opacity:.75">Running ComfyUI on a remote GPU? Use the code.</p>
      ${err}
    </div>`;
    }

    body() {
        if (this.status_ && !this.status_.configured) return this.connectPanel();
        if (this.error) return `<div class="ft-msg err">${esc(this.error)}</div>`;
        if (this.loading && !this.rows.length) return `<div class="ft-msg">Searching…</div>`;
        if (!this.rows.length) {
            return `<div class="ft-msg">${this.driven
                ? "Waiting for text on query_in"
                : "Search the library, then click a frame to use it"}</div>`;
        }
        const cells = this.rows
            .map(
                (r, i) => `<div class="ft-cell${r.id === this.pinnedId ? " on" : ""}" data-i="${i}">
        <img src="${esc(r.src)}" alt="" loading="lazy" draggable="true"
             referrerpolicy="no-referrer"
             onerror="this.closest('.ft-cell').classList.add('bad');this.remove()"/>
        <span class="ft-bad">${esc(r.filmTitle || "unavailable")}</span>
        <button class="ft-eye" data-like="${i}" title="Find frames that look like this one">${ICON.eye}</button>
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
        // The selected film, named. It is the one thing you want confirmed
        // before queueing — that the picture about to go downstream is the one
        // you meant — and the outline in the grid tells you which cell, not
        // which film.
        // Both states are things you opted into and should be able to leave
        // from where you can see them, rather than by hunting for the frame you
        // clicked — which after scrolling may not be on screen at all.
        const undo = (act, title) =>
            `<button class="ft-undo" data-act="${act}" title="${title}">${ICON.x}</button>`;

        if (this.pinnedId) {
            const r = this.rows.find((x) => x.id === this.pinnedId);
            const name = r ? `<b>${esc(r.filmTitle || "Frame")}</b>${r.year ? ` · ${r.year}` : ""}` : "1 selected";
            return `${name}${undo("unpin", "Deselect this frame")}`;
        }
        if (this.likeOf) {
            return `Like <b>${esc(this.likeOf.filmTitle || "that frame")}</b>${undo("unlike", "Back to the text search")}`;
        }
        if (this.colorOf) {
            return `<span class="ft-chip" style="background:${esc(this.colorOf)}"></span>${this.rows.length} frames${undo("uncolor", "Drop the colour")}`;
        }
        // The rewrite is reported by the button that controls it, not here. As
        // text in this line it collided with the count — .ft-stat is a nowrap
        // flex row, so an inline span appearing after a search had nowhere to
        // go and sat on top of it.
        if (this.rows.length) return `${this.rows.length} frames · click one to use it`;
        return this.driven ? "query_in" : "";
    }

    render() {
        const keep = this.root.querySelector(".ft-scroll")?.scrollTop || 0;
        const focused = this.root.querySelector(".ft-search input") === document.activeElement;
        const caret = focused ? this.root.querySelector(".ft-search input").selectionStart : null;

        this.root.innerHTML = `
      ${this.filtersOpen ? `<div class="ft-filters">${FILTERS.map((f) => `
        <label class="ft-f">
          <span>${f.label}</span>
          <select data-filter="${f.key}">
            <option value="">Any</option>
            ${f.values.map((v) => `<option value="${v}"${this.filters[f.key] === v ? " selected" : ""}>${pretty(v)}</option>`).join("")}
          </select>
        </label>`).join("")}
        ${this.filterCount ? `<button class="ft-clearf" data-act="clearfilters">Clear ${this.filterCount}</button>` : ""}
      </div>` : ""}
      <div class="ft-hue-row">
        <div class="ft-hue" title="Click a colour to narrow the search to frames dominated by it">
          <i class="ft-hue-bar" style="background:linear-gradient(90deg,${HUE_GRADIENT})"></i>
          ${this.colorOf ? `<i class="ft-hue-mark" style="left:${(this.hueOf ?? 0) / 360 * 100}%;background:${esc(this.colorOf)}"></i>` : ""}
        </div>
        ${this.colorOf
                ? `<button class="ft-hue-x" data-act="uncolor" title="Drop the colour">${ICON.x}</button>`
                : ""}
      </div>
      <div class="ft-search">
        <i class="ft-load" style="width:${this.progress}%"></i>
        ${ICON.search}
        <input type="text" spellcheck="false"
               placeholder="${this.driven ? "waiting for query_in…" : "neon rain at night"}"
               value="${esc(this.get("query") || "")}" ${this.driven ? "readonly" : ""}
               title="${this.driven ? "Coming from query_in — edit it on the node that feeds this one" : ""}"/>
      </div>
      <div class="ft-scroll">${this.body()}</div>
      <div class="ft-foot">
        <span class="ft-left">
          ${this.status_
                ? this.status_.configured
                    ? `<button class="ft-link up" data-act="signout" title="Sign out"><i></i>Connected</button>`
                    : `<button class="ft-link down" data-act="reconnect"><i></i>Not connected</button>`
                : ""}
          <span class="ft-stat">${this.status()}</span>
        </span>
        <span class="ft-acts">
          <button class="ft-funnel${this.filtersOpen || this.filterCount ? " on" : ""}" data-act="filters"
                title="Filter by shot, angle, time, lighting, era, focus, lens and style">${ICON.funnel}${this.filterCount ? `<span>${this.filterCount}</span>` : ""}</button>
          <button class="ft-smart${this.get("smart") === false ? "" : " on"}" data-act="smart"
                title="${esc(this.smartTitle())}">${ICON.spark}</button>
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

        for (const el of this.root.querySelectorAll("[data-filter]")) {
            el.onchange = () => this.setFilter(el.dataset.filter, el.value);
        }

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

        // Dragging a frame onto the canvas drops a new Reference node already
        // pinned to it. On the workspace canvas a dragged frame became an image
        // node; a graph has no such thing, and a pinned Reference is the same
        // idea — a node that outputs exactly that picture — while keeping the
        // credit and the description attached to it.
        this.root.ondragstart = (e) => {
            const cell = e.target.closest(".ft-cell");
            if (!cell) return;
            const row = this.rows[Number(cell.dataset.i)];
            if (!row) return;
            dragging = row;
            e.dataTransfer.effectAllowed = "copy";
            // Some payload is required or Chrome cancels the drag outright.
            e.dataTransfer.setData("text/plain", row.fullSrc || row.src || "");
        };
        this.root.ondragend = () => { dragging = null; };

        const hue = this.root.querySelector(".ft-hue");
        if (hue) hue.onclick = (e) => {
            e.stopPropagation();
            const box = hue.getBoundingClientRect();
            const h = Math.max(0, Math.min(359, Math.round(((e.clientX - box.left) / box.width) * 360)));
            this.setColor(hslToHex(h), h);
        };

        this.root.onclick = (e) => {
            const btn = e.target.closest("[data-act]");
            if (btn) {
                e.stopPropagation();
                const act = btn.dataset.act;
                if (act === "smart") {
                    this.set("smart", this.get("smart") === false);
                    this.lastKey = "";        // same words, different question
                    this.search();
                } else if (act === "unpin") {
                    this.pinnedId = null;
                    this.set("pinned", "");
                    this.render();
                } else if (act === "uncolor") {
                    this.colorOf = null;
                    this.hueOf = null;
                    this.lastKey = "";
                    if (String(this.get("query") || "").trim()) this.search();
                    else { this.rows = []; this.render(); }
                } else if (act === "unlike") {
                    this.likeOf = null;
                    this.lastKey = "";
                    this.search();
                } else if (act === "filters") {
                    this.filtersOpen = !this.filtersOpen;
                    this.render();
                } else if (act === "clearfilters") {
                    this.node.properties.ftFilters = {};
                    this.set("filters", "");
                    this.lastKey = "";
                    this.search();
                } else if (act === "browser") {
                    window.open((this.status_?.connectUrl || "https://framethrower.ai/settings?tab=api") + "&for=comfyui", "_blank", "noopener");
                    // Straight to the paste step: the token is created in that
                    // tab, and the only thing left to do is bring it back.
                    this.connError = null; this.connStep = "paste"; this.render();
                } else if (act === "code") {
                    this.connError = null; this.connStep = "code"; this.pair();
                } else if (act === "back") {
                    this.connError = null; this.connStep = null; this.render();
                } else if (act === "save") {
                    const f = this.root.querySelector(".ft-paste input");
                    if (f) this.connect(f.value.trim());
                } else if (act === "signout") {
                    this.signOut();
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
            const eye = e.target.closest("[data-like]");
            if (eye) {
                e.stopPropagation();
                const row = this.rows[Number(eye.dataset.like)];
                if (row) this.searchLike(row);
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

            installDropHandler();
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
