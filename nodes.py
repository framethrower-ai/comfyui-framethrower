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


class FrameThrowerReference:
    """Search the FrameThrower library and pull a frame into the graph."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "query": ("STRING", {"multiline": True, "default": "", "placeholder": "neon rain at night"}),
                "mode": (MODES, {"default": "hybrid"}),
                "index": ("INT", {"default": 0, "min": 0, "max": 499, "step": 1}),
                "depth": ("BOOLEAN", {"default": False, "label_on": "Depth map", "label_off": "Depth map"}),
                "pose": ("BOOLEAN", {"default": False, "label_on": "DW pose", "label_off": "DW pose"}),
                "lineart": ("BOOLEAN", {"default": False, "label_on": "Lineart", "label_off": "Lineart"}),
                # Written by the node's own grid when you click a frame. Kept as
                # a widget rather than node state so it survives save/load and
                # travels with an exported workflow.
                "pinned": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "query_in": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("image", "prompt", "credit", "depth", "pose", "lineart")
    FUNCTION = "fetch"
    CATEGORY = "FrameThrower"
    DESCRIPTION = "FT / FrameThrower reference frames. Search the film-still library and output the frame, its scene description, its credit line, and optional depth / DW pose / lineart."

    @classmethod
    def IS_CHANGED(cls, query, mode, index, depth, pose, lineart, pinned, query_in=None):
        # Without this the node re-searches on every queue, and a search costs
        # credits. Hash the inputs so an unchanged node is a cache hit.
        blob = f"{query_in or query}|{mode}|{index}|{depth}|{pose}|{lineart}|{pinned}"
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def fetch(self, query, mode, index, depth, pose, lineart, pinned, query_in=None):
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

        maps = _fal_process(full, depth, pose, lineart)
        return (
            image,
            prompt,
            credit,
            _load_image(maps["depth"]) if maps["depth"] else _BLANK,
            _load_image(maps["pose"]) if maps["pose"] else _BLANK,
            _load_image(maps["lineart"]) if maps["lineart"] else _BLANK,
        )


NODE_CLASS_MAPPINGS = {"FrameThrowerReference": FrameThrowerReference}
# "FT" leads the name because that is what it gets called, and the node search
# is a substring match — typing FT found nothing when this read
# "Reference Node (FrameThrower)".
NODE_DISPLAY_NAME_MAPPINGS = {"FrameThrowerReference": "FT Reference Node"}
