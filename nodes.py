"""
The Reference node.

A port of the reference node on the FrameThrower workspace canvas
(workspace-beta, src/components/Nodes/ReferenceNode.tsx). Same job: search the
library, look at the frames, pick one, and send it downstream with everything
we know about it.

Where the two differ is the drop model. On the canvas you drag a frame off the
node and it lands as new nodes — image, prompt, depth, pose, lineart. A graph
already has a word for "this thing comes out of that node": a socket. So the
five drops became five outputs, and the toggles that used to decide what landed
now decide which processors run. That mapping is deliberate, because every
processor is a real charge and nobody should discover one on an invoice.
"""

import hashlib
import json
import io
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from PIL import Image, ImageOps

from . import ft_api

# v1 accepts "semantic" but serves it as hybrid, so offering it would be the
# same search twice under a name that says otherwise.
MODES = ["hybrid", "description"]

# A processor that is switched off still has to hand back a tensor — Comfy has
# no null on an IMAGE socket. One black pixel is the cheapest honest answer:
# it is obviously not a depth map, so a mis-wired graph fails loudly.
_BLANK = torch.zeros((1, 64, 64, 3), dtype=torch.float32)

_image_cache = {}
_CACHE_MAX = 64


def _to_tensor(raw_bytes):
    img = Image.open(io.BytesIO(raw_bytes))
    img = ImageOps.exif_transpose(img).convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _load_image(url):
    if not url:
        return _BLANK
    if url in _image_cache:
        return _image_cache[url]
    tensor = _to_tensor(ft_api.fetch_bytes(url))
    if len(_image_cache) >= _CACHE_MAX:
        _image_cache.pop(next(iter(_image_cache)))
    _image_cache[url] = tensor
    return tensor


def _credit(row):
    """The line the canvas burns into a collage — title, year, director."""
    title = row.get("filmTitle") or "Untitled"
    year = row.get("year")
    director = row.get("director")
    out = f"{title} ({year})" if year else title
    if director:
        out += f" — dir. {director}"
    return out


# depth-anything/v2 rather than imageutils/depth: the canvas measured it at
# $0.00067 against $0.00261 per image for the same job.
_FAL_ENDPOINTS = {
    "depth": "fal-ai/image-preprocessors/depth-anything/v2",
    "pose": "fal-ai/dwpose",
    "lineart": "fal-ai/image-preprocessors/lineart",
}

# A cold model on fal takes about a minute to come up; the same call against a
# warm one is a second or two. 60s sat right on top of that cold start —
# measured 58.9s for depth — so the first run of the day timed out and the
# socket came back black. Generous, because the failure it prevents is
# expensive and the wait it allows is rare.
_FAL_TIMEOUT = 180

# Processed maps, keyed by (frame url, kind). The same frame wired to depth in
# two graphs, or picked again after flipping away and back, should not pay for
# the processor twice — it is a charge per call, not per picture.
_map_cache = {}
_MAP_CACHE_MAX = 128


def _fal_process(image_url, want_depth, want_pose, want_lineart):
    """depth / DW pose / lineart via fal, same three processors the canvas uses.

    Runs only what was asked for, and runs them at the same time: they are three
    independent HTTP calls, and doing them in sequence made a graph with all
    three wired cost the sum of three cold starts rather than the longest one.
    Measured 95.7s sequential against roughly the slowest single call now.

    Returns a dict of url-or-None; a failure of one processor never takes the
    others down with it.
    """
    wanted = [k for k, w in (("depth", want_depth), ("pose", want_pose), ("lineart", want_lineart)) if w]
    out = {"depth": None, "pose": None, "lineart": None}
    if not wanted:
        return out

    key = ft_api.config()["fal_key"]
    if not key:
        print("[FrameThrower] depth/pose/lineart need FAL_KEY — skipping.")
        return out

    import urllib.request

    def run(kind):
        cached = _map_cache.get((image_url, kind))
        if cached:
            return kind, cached
        endpoint = _FAL_ENDPOINTS[kind]
        req = urllib.request.Request(
            f"https://fal.run/{endpoint}",
            data=json.dumps({"image_url": image_url}).encode("utf-8"),
            headers={"Authorization": f"Key {key}", "Content-Type": "application/json"},
            method="POST",
        )
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=_FAL_TIMEOUT) as res:
                data = json.loads(res.read().decode("utf-8"))
            url = (data.get("image") or {}).get("url")
        except Exception as exc:  # noqa: BLE001
            print(f"[FrameThrower] {kind} ({endpoint}) failed after {time.time() - started:.0f}s: {exc}")
            return kind, None
        if url:
            if len(_map_cache) >= _MAP_CACHE_MAX:
                _map_cache.pop(next(iter(_map_cache)))
            _map_cache[(image_url, kind)] = url
        return kind, url

    if len(wanted) == 1:
        kind, url = run(wanted[0])
        out[kind] = url
        return out

    with ThreadPoolExecutor(max_workers=len(wanted)) as pool:
        for kind, url in pool.map(run, wanted):
            out[kind] = url
    return out


def _host_image(tensor):
    """Put a graph tensor somewhere FrameThrower can fetch it, and return the URL.

    /api/v1/search/image takes a URL and pulls the picture from its own side, so
    an image that exists only as floats in this process has to be published
    first. fal's storage is used because the node already depends on fal for the
    three processors — adding a second host for one feature would be a second
    key to manage and a second thing to explain.
    """
    key = ft_api.config()["fal_key"]
    if not key:
        raise ValueError(
            "image_in needs a FAL_KEY. FrameThrower fetches the picture by URL, "
            "so it has to be uploaded somewhere first — set FAL_KEY in the "
            "environment or in config.json. Text search does not need this."
        )
    try:
        import fal_client
    except ImportError as exc:
        raise ValueError(
            "image_in needs the fal client: pip install fal-client"
        ) from exc

    import os
    import tempfile

    arr = (tensor[0].cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
            path = fh.name
            Image.fromarray(arr).save(fh, format="PNG")
        os.environ.setdefault("FAL_KEY", key)
        return fal_client.upload_file(path)
    finally:
        if path and os.path.isfile(path):
            try:
                os.unlink(path)
            except OSError:
                pass


#: Output socket order, so a connection can be mapped back to a processor.
OUT_IMAGE, OUT_PROMPT, OUT_CREDIT, OUT_DEPTH, OUT_POSE, OUT_LINEART = range(6)


def _connected_outputs(prompt, unique_id):
    """Which of this node's output sockets something downstream actually reads.

    There used to be three toggles for depth / pose / lineart, and they were the
    wrong control: wiring the depth socket did nothing unless you also found and
    flipped a switch, so a visible connection could silently produce a black
    image. The graph already states the intent — if nobody consumes the socket,
    nobody wants the picture — so the graph decides.

    In an executing prompt every input is either a literal or a link expressed
    as [source_node_id, output_index]. Anything pointing back at us marks that
    output as wanted.

    Returns None when the graph is unavailable, which the caller treats as
    "run nothing": a missing graph must not silently bill for three processors.
    """
    if not prompt or unique_id is None:
        return None
    if not isinstance(prompt, dict):
        # Was silent for a while: `fetch` rebound `prompt` to the scene
        # description, this raised AttributeError into the catch-all below, and
        # every processor stayed off with only a vague line in the log. A wrong
        # type here is a bug in this file, so say which one.
        print(
            f"[FrameThrower] PROMPT graph arrived as {type(prompt).__name__}, not dict — "
            "depth/pose/lineart cannot be resolved. This is a bug, please report it."
        )
        return None
    me = str(unique_id)
    used = set()
    try:
        for node in prompt.values():
            for value in (node.get("inputs") or {}).values():
                if (
                    isinstance(value, (list, tuple))
                    and len(value) == 2
                    and str(value[0]) == me
                    and isinstance(value[1], int)
                ):
                    used.add(value[1])
    except Exception as exc:  # noqa: BLE001 — a malformed graph is not fatal
        print(f"[FrameThrower] could not read the graph: {exc}")
        return None
    return used


class FrameThrowerReference:
    """Search the FrameThrower library and pull a frame into the graph."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "query": ("STRING", {"multiline": True, "default": "", "placeholder": "neon rain at night"}),
                "mode": (MODES, {"default": "hybrid"}),
                "index": ("INT", {"default": 0, "min": 0, "max": 499, "step": 1}),
                # Written by the node's own grid when you click a frame. Kept as
                # a widget rather than node state so it survives save/load and
                # travels with an exported workflow.
                "pinned": ("STRING", {"default": "", "multiline": False}),
                # The filter bar's choices, as JSON. A widget rather than node
                # properties because properties never reach Python — the grid
                # would show filtered results and a queued graph would search
                # without them, which is the same node giving two answers.
                "filters": ("STRING", {"default": "", "multiline": False}),
                # Smart search. A widget, not a node property, because
                # properties never reach Python — a grid that rewrote the query
                # while the queued graph did not would hand you a different
                # frame than the one you clicked.
                "smart": ("BOOLEAN", {"default": True}),
                # What the grid is showing at `index` right now, written by the
                # node's own UI. Not something to type into: it is how a run
                # with nothing clicked executes the frame you can actually see,
                # including the colour and more-like-this searches that a plain
                # text query cannot reproduce. See syncAuto() in framethrower.js.
                "auto": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "query_in": ("STRING", {"forceInput": True}),
                # Reverse search: find frames that look like this one.
                #
                # Only takes effect on execute, and it cannot preview in the
                # grid. /api/v1/search/image takes a URL and fetches it from
                # FrameThrower's side, so a tensor sitting in a graph has to be
                # hosted somewhere public first — the node uploads it to fal,
                # which is why this route needs FAL_KEY and the text one does
                # not. The browser has no copy of the tensor either way, so
                # there is nothing the UI could show before you queue.
                "image_in": ("IMAGE",),
            },
            # The graph itself, so the node can see which of its outputs anyone
            # is actually using. See _connected_outputs.
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "IMAGE", "IMAGE", "IMAGE")
    # The four image sockets carry no type suffix: Comfy already colours them by
    # type and nobody mistakes "depth" for text. The two STRING ones are marked,
    # because in Comfy "prompt" almost always means CONDITIONING — without the
    # label the first instinct is to wire it into a KSampler, which cannot take
    # it. A suffix on all six would just widen the socket column and take that
    # width off the grid.
    RETURN_NAMES = ("image", "prompt (text)", "credit (text)", "depth", "pose", "lineart")
    # Shown when you hover a socket, and — more usefully — the thing that tells
    # you what to plug each one into before you have plugged anything in.
    OUTPUT_TOOLTIPS = (
        "The frame itself. Into Preview Image, Save Image, or a VAE Encode / "
        "ControlNet / IPAdapter that takes an IMAGE.",
        "The frame's scene description, as plain text — not conditioning. "
        "Into CLIP Text Encode, which turns it into conditioning. To read it on "
        "the canvas, add the node called 'Preview as Text'. Not a Primitive "
        "string node: that one makes text rather than showing it, so its value "
        "is a widget with nothing to connect to.",
        "Title, year and director, as text. Into 'Preview as Text' to read it, "
        "or 'Save Text' to write it beside the picture, so the attribution "
        "travels with whatever you make.",
        "Depth map. Into a depth ControlNet. Runs only while this socket is wired.",
        "DW pose skeleton. Into a pose ControlNet. Runs only while this socket is wired.",
        "Lineart. Into a lineart ControlNet. Runs only while this socket is wired.",
    )
    # "FT" no longer appears in the display name, so it has to be searchable
    # some other way — this is the field the node search actually reads.
    SEARCH_ALIASES = [
        "ft", "framethrower", "reference", "reference node", "film still",
        "movie still", "film frame", "screencap", "cinematography", "moodboard",
        "shot reference", "stills library",
    ]
    FUNCTION = "fetch"
    CATEGORY = "FrameThrower"
    DESCRIPTION = "FT / FrameThrower reference frames. Search the film-still library and output the frame, its scene description, its credit line, and optional depth / DW pose / lineart."

    @classmethod
    def IS_CHANGED(cls, query, mode, index, pinned, filters="", smart=True, auto="", query_in=None, image_in=None, prompt=None, unique_id=None):
        # Without this the node re-searches on every queue, and a search costs
        # credits. Hash the inputs so an unchanged node is a cache hit. The
        # connected outputs are part of the hash: wiring depth up has to
        # re-run the node, or the socket would stay black until something else
        # happened to invalidate the cache.
        wanted = sorted(_connected_outputs(prompt, unique_id) or [])
        # An incoming image is hashed by its content, not its identity: the
        # same picture arriving from a different node is the same search.
        img = ""
        if image_in is not None:
            try:
                img = hashlib.sha256(image_in[0].cpu().numpy().tobytes()).hexdigest()[:16]
            except Exception:
                img = "image"
        blob = f"{query_in or query}|{mode}|{index}|{pinned}|{filters}|{smart}|{auto}|{wanted}|{img}"
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def fetch(self, query, mode, index, pinned, filters="", smart=True, auto="", query_in=None, image_in=None, prompt=None, unique_id=None):
        row = None

        # A frame clicked in the grid wins over the query — you looked at it and
        # chose it, and re-running the search could quietly hand back a
        # different frame at the same index.
        if pinned:
            try:
                row = json.loads(pinned)
            except json.JSONDecodeError:
                row = None

        # An image on the wire is a more specific request than a text query, so
        # it wins — you would not connect one and expect the words to be used.
        if row is None and image_in is not None:
            url = _host_image(image_in)
            results = ft_api.search_by_image(url)
            if not results:
                raise ValueError("No frames looked like that image.")
            if index >= len(results):
                raise ValueError(f"index {index} is past the {len(results)} results for that image.")
            row = results[index]

        text = (query_in or query or "").strip()

        # Nothing clicked, but the grid is showing something — run that. The
        # first result is what `index` points at, so this is "pick the first one
        # unless you said otherwise", and it holds for colour and more-like-this
        # searches, which a text query cannot re-express.
        #
        # Only while the words still agree: an edited query with a stale grid
        # must fall through to a live search rather than execute the frame from
        # the previous one.
        if row is None and auto:
            try:
                blob = json.loads(auto)
            except json.JSONDecodeError:
                blob = None
            if isinstance(blob, dict) and isinstance(blob.get("row"), dict):
                if str(blob.get("q") or "") == text:
                    row = blob["row"]

        if row is None:
            if not text:
                raise ValueError(
                    "Reference node has no query. Type one, wire a string into "
                    "query_in, wire an image into image_in, or click a frame in "
                    "the node's grid."
                )
            try:
                chosen = json.loads(filters) if filters else {}
            except json.JSONDecodeError:
                chosen = {}
            results = ft_api.search(text, limit=min(index + 1, 50), mode=mode,
                                    filters=chosen, enhance=bool(smart))
            if not results:
                raise ValueError(f'No frames found for "{text}".')
            if index >= len(results):
                raise ValueError(f"index {index} is past the {len(results)} results for \"{text}\".")
            row = results[index]

        full = row.get("fullSrc") or row.get("src")
        image = _load_image(full)
        # NOT `prompt` — that name is the hidden PROMPT graph, and rebinding it
        # here left _connected_outputs reading a description string. It caught
        # the AttributeError, returned None, and depth/pose/lineart came out
        # black no matter how they were wired.
        description = row.get("description") or ""
        credit = _credit(row)

        # Run a processor only if something downstream is reading its socket.
        wanted = _connected_outputs(prompt, unique_id) or set()
        maps = _fal_process(full, OUT_DEPTH in wanted, OUT_POSE in wanted, OUT_LINEART in wanted)
        return (
            image,
            description,
            credit,
            _load_image(maps["depth"]) if maps["depth"] else _BLANK,
            _load_image(maps["pose"]) if maps["pose"] else _BLANK,
            _load_image(maps["lineart"]) if maps["lineart"] else _BLANK,
        )


NODE_CLASS_MAPPINGS = {"FrameThrowerReference": FrameThrowerReference}
NODE_DISPLAY_NAME_MAPPINGS = {"FrameThrowerReference": "FrameThrower Reference Node"}
