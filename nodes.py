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

import numpy as np
import torch
from PIL import Image, ImageOps

from . import ft_api

MODES = ["hybrid", "semantic", "description"]

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


def _fal_process(image_url, want_depth, want_pose, want_lineart):
    """depth / DW pose / lineart via fal, same three processors the canvas uses.

    Runs only what was asked for. Returns a dict of url-or-None; a failure of
    one processor never takes the others down with it.
    """
    out = {"depth": None, "pose": None, "lineart": None}
    if not (want_depth or want_pose or want_lineart):
        return out

    key = ft_api.config()["fal_key"]
    if not key:
        print("[FrameThrower] depth/pose/lineart need FAL_KEY — skipping.")
        return out

    try:
        import fal_client  # noqa: F401
    except ImportError:
        pass

    import urllib.request
    import urllib.error

    def run(endpoint):
        req = urllib.request.Request(
            f"https://fal.run/{endpoint}",
            data=json.dumps({"image_url": image_url}).encode("utf-8"),
            headers={"Authorization": f"Key {key}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                data = json.loads(res.read().decode("utf-8"))
            return (data.get("image") or {}).get("url")
        except Exception as exc:  # noqa: BLE001
            print(f"[FrameThrower] {endpoint} failed: {exc}")
            return None

    # depth-anything/v2 rather than imageutils/depth: the canvas measured it at
    # $0.00067 against $0.00261 per image for the same job.
    if want_depth:
        out["depth"] = run("fal-ai/image-preprocessors/depth-anything/v2")
    if want_pose:
        out["pose"] = run("fal-ai/dwpose")
    if want_lineart:
        out["lineart"] = run("fal-ai/image-preprocessors/lineart")
    return out


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
            },
            "optional": {
                "query_in": ("STRING", {"forceInput": True}),
            },
            # The graph itself, so the node can see which of its outputs anyone
            # is actually using. See _connected_outputs.
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "prompt", "credit", "depth", "pose", "lineart")
    # Shown when you hover a socket, and — more usefully — the thing that tells
    # you what to plug each one into before you have plugged anything in.
    OUTPUT_TOOLTIPS = (
        "The frame itself. Into Preview Image, Save Image, or a VAE Encode / "
        "ControlNet / IPAdapter that takes an IMAGE.",
        "The frame's scene description, as text. Into CLIP Text Encode.",
        "Title, year and director, as text. Into a text overlay or Save Text, "
        "so the attribution travels with whatever you make.",
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
    def IS_CHANGED(cls, query, mode, index, pinned, query_in=None, prompt=None, unique_id=None):
        # Without this the node re-searches on every queue, and a search costs
        # credits. Hash the inputs so an unchanged node is a cache hit. The
        # connected outputs are part of the hash: wiring depth up has to
        # re-run the node, or the socket would stay black until something else
        # happened to invalidate the cache.
        wanted = sorted(_connected_outputs(prompt, unique_id) or [])
        blob = f"{query_in or query}|{mode}|{index}|{pinned}|{wanted}"
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def fetch(self, query, mode, index, pinned, query_in=None, prompt=None, unique_id=None):
        row = None

        # A frame clicked in the grid wins over the query — you looked at it and
        # chose it, and re-running the search could quietly hand back a
        # different frame at the same index.
        if pinned:
            try:
                row = json.loads(pinned)
            except json.JSONDecodeError:
                row = None

        if row is None:
            text = (query_in or query or "").strip()
            if not text:
                raise ValueError(
                    "Reference node has no query. Type one, wire a string into "
                    "query_in, or click a frame in the node's grid."
                )
            results = ft_api.search(text, limit=min(index + 1, 50), mode=mode)
            if not results:
                raise ValueError(f'No frames found for "{text}".')
            if index >= len(results):
                raise ValueError(f"index {index} is past the {len(results)} results for \"{text}\".")
            row = results[index]

        full = row.get("fullSrc") or row.get("src")
        image = _load_image(full)
        prompt = row.get("description") or ""
        credit = _credit(row)

        # Run a processor only if something downstream is reading its socket.
        wanted = _connected_outputs(prompt, unique_id) or set()
        maps = _fal_process(full, OUT_DEPTH in wanted, OUT_POSE in wanted, OUT_LINEART in wanted)
        return (
            image,
            prompt,
            credit,
            _load_image(maps["depth"]) if maps["depth"] else _BLANK,
            _load_image(maps["pose"]) if maps["pose"] else _BLANK,
            _load_image(maps["lineart"]) if maps["lineart"] else _BLANK,
        )


NODE_CLASS_MAPPINGS = {"FrameThrowerReference": FrameThrowerReference}
NODE_DISPLAY_NAME_MAPPINGS = {"FrameThrowerReference": "FrameThrower Reference Node"}
