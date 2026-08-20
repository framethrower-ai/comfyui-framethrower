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

# v1 accepts "semantic" but serves it as hybrid, so offering it would be the
# same search twice under a name that says otherwise.
MODES = ["hybrid", "description"]

# A processor that is switched off still has to hand back a tensor — Comfy has
# no null on an IMAGE socket. One black pixel is the cheapest honest answer:
# it is obviously not a depth map, so a mis-wired graph fails loudly.
_BLANK = torch.zeros((1, 64, 64, 3), dtype=torch.float32)

_image_cache = {}
_pil_cache = {}
_CACHE_MAX = 64


def _to_tensor(img):
    arr = np.array(img.convert("RGB")).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _load_pil(url):
    """The decoded frame. Kept as PIL because the local preprocessors want a
    picture, not a tensor — and the picture is already here, so depth and
    lineart cost no network at all."""
    if url in _pil_cache:
        return _pil_cache[url]
    img = Image.open(io.BytesIO(ft_api.fetch_bytes(url)))
    img = ImageOps.exif_transpose(img).convert("RGB")
    if len(_pil_cache) >= _CACHE_MAX:
        _pil_cache.pop(next(iter(_pil_cache)))
    _pil_cache[url] = img
    return img


def _load_image(url):
    if not url:
        return _BLANK
    if url in _image_cache:
        return _image_cache[url]
    tensor = _to_tensor(_load_pil(url))
    if len(_image_cache) >= _CACHE_MAX:
        _image_cache.pop(next(iter(_image_cache)))
    _image_cache[url] = tensor
    return tensor


# ── local preprocessors ──────────────────────────────────────────────────────
#
# depth and lineart run on this machine. Measured on an M-series GPU: 65ms for
# depth, against 58.9s on a cold fal model and 1.2s on a warm one, for output
# that looks the same. Neither makes a network call — the frame is already
# decoded here — so neither needs FAL_KEY and neither costs anything per image.
#
# Depth-Anything-V2-Small is a transformers `depth-estimation` pipeline, and
# transformers ships with ComfyUI, so this adds no dependency. The weights
# (~100MB) download once on first use and are cached by huggingface_hub.
DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"

# Sobel magnitude on 8-bit grey below which an edge is film grain, not content.
NOISE_FLOOR = 12.0
_depth_pipe = None


def _torch_device():
    """Whatever ComfyUI decided to use, so --cpu and --gpu-only are honoured
    rather than second-guessed."""
    try:
        import comfy.model_management as mm

        return mm.get_torch_device()
    except Exception:  # noqa: BLE001 — running outside ComfyUI
        if torch.cuda.is_available():
            return torch.device("cuda")
        if torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")


def _local_depth(img):
    global _depth_pipe
    if _depth_pipe is None:
        from transformers import pipeline

        dev = _torch_device()
        print(f"[FrameThrower] loading {DEPTH_MODEL} on {dev} — one-off, then cached on disk")
        _depth_pipe = pipeline("depth-estimation", model=DEPTH_MODEL, device=dev)
    return _depth_pipe(img)["depth"]


def _strength(raw, default=3.0, lo=0.5, hi=8.0):
    """Whatever is in the widget, as a usable number.

    Anything unreadable becomes the default rather than an exception: this is a
    dial on a picture, and a graph should not fail to run because a slot holds
    something odd. Clamped, because the widget is a plain text box now and there
    is nothing stopping anyone typing 400.
    """
    try:
        return max(lo, min(hi, float(str(raw).strip())))
    except (TypeError, ValueError):
        return default


def _local_lineart(img, strength=3.0):
    """Edge ridges at a chosen scale, carrying the gradient's weight.

    A filter, not a network: nothing to download and a few milliseconds to run.
    White lines on black, the polarity a lineart ControlNet expects and the one
    fal returned, so a graph does not invert when it switches over.

    Two earlier versions, and what each got wrong, because the fix is the
    combination of them:

    Canny alone read as vague. It is binary — every line is one pixel wide and
    equally bright, so a firm edge and a faint one arrive identical and the
    picture loses its weight.

    Sobel magnitude alone read as thick. A gradient does not stop at the edge,
    it ramps across it, so every line came out several pixels of smear.

    So: take the magnitude for its weight, and keep only the pixels Canny marks.
    Canny's first step is non-maximum suppression, which is exactly the
    one-pixel spine of each edge — multiplying the two gives thin lines that are
    still bright where the edge is strong. Measured density on the test frame
    fell from 0.266 to 0.140 at a comparable brightness.

    Magnitude is normalised against the 99.5th percentile rather than the
    maximum: one blown highlight or a dust speck would otherwise set the scale
    and drag everything else towards black. Canny's thresholds come off the
    median, because film stills are not uniformly exposed — the frames measured
    sit at median 18 for a night exterior and 54 for a daylight wide.
    """
    import cv2

    # The slider is detail, not brightness. Turning the gain down only dimmed a
    # picture that was too busy, which is not the same complaint.
    detail = float(strength)
    blur = max(0.4, min(3.4, 3.4 - 0.45 * detail))
    gain = 2.4 + 0.2 * detail

    g8 = cv2.GaussianBlur(cv2.cvtColor(np.array(img), cv2.COLOR_RGB2GRAY), (0, 0), blur)

    # Thresholds come off the gradient, not the brightness.
    #
    # They used to be a fraction of the median grey level, which is the standard
    # auto-Canny trick and is wrong for film. Brightness says nothing about edge
    # strength: a fog exterior at median 155 got thresholds of 77/232, which are
    # enormous in gradient terms, so Canny found exactly zero edges and the
    # socket returned a black frame. Three of five soft-lit frames tested failed
    # that way.
    #
    # A pure percentile is the opposite failure — it promises a fixed share of
    # pixels will be edges, so a featureless frame returns 5% of itself as
    # sensor noise contours. Measured: the Quintet fog frame came back as pure
    # grain.
    #
    # So: a percentile, floored. NOISE_FLOOR is in Sobel units on 8-bit grey,
    # below which a gradient is film grain rather than anything in the shot —
    # the frames measured sit at a median gradient of 1.4 to 4.0 where a normal
    # frame is 13. At 12 the four figures in The Grey's whiteout come through
    # with the horizon and nothing else, the Quintet fog gives its horizon line
    # only, and every ordinary frame is untouched because its percentile is far
    # above the floor.
    gx = cv2.Sobel(g8, cv2.CV_16S, 1, 0, ksize=3)
    gy = cv2.Sobel(g8, cv2.CV_16S, 0, 1, ksize=3)
    mag = np.hypot(gx.astype(np.float32), gy.astype(np.float32))

    hi = max(NOISE_FLOOR, float(np.percentile(mag, 95.0)))
    lo = max(1.0, 0.4 * hi)
    ridge = cv2.Canny(gx, gy, lo, hi, L2gradient=True) > 0

    # Same floor on the normaliser: without it a frame whose brightest gradient
    # is grain would have that grain scaled up to full white.
    m = mag / (max(float(np.percentile(mag, 99.5)), NOISE_FLOOR) + 1e-6)

    lines = np.clip(m * gain, 0.0, 1.0) * ridge
    return Image.fromarray((lines * 255).astype(np.uint8)).convert("RGB")


# ── local pose ───────────────────────────────────────────────────────────────
#
# Two models, both from transformers, so still no new dependency: a small
# detector for person boxes and ViTPose for the joints inside each. Measured on
# MPS at 63ms for five people, against 1.97s on a warm fal dwpose and a minute
# on a cold one.
#
# There is no `pose-estimation` pipeline, which is what made this look
# impossible at first glance — the models are there, the convenience wrapper is
# not.
DETECT_MODEL = "hustvl/yolos-tiny"          # ~26MB, only has to find people
POSE_MODEL = "usyd-community/vitpose-base-simple"
_pose_models = None

# COCO's 17 joints in the order OpenPose draws its 18, with the neck — which
# COCO does not label — taken as the midpoint of the shoulders. ControlNet's
# openpose models were trained on OpenPose renderings, so matching the layout
# and the colours is the difference between a useful hint and a confusing one.
_COCO_TO_OP = [0, None, 6, 8, 10, 5, 7, 9, 12, 14, 16, 11, 13, 15, 2, 1, 4, 3]
_LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9),
          (9, 10), (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16),
          (0, 15), (15, 17)]
_COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0),
           (85, 255, 0), (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255),
           (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255), (170, 0, 255),
           (255, 0, 255), (255, 0, 170), (255, 0, 85)]
_KP_MIN = 0.3   # below this a joint is a guess, and a drawn guess is a wrong hint


def _load_pose_models():
    global _pose_models
    if _pose_models is None:
        from transformers import (AutoProcessor, AutoModelForObjectDetection,
                                  VitPoseForPoseEstimation, VitPoseImageProcessor)

        dev = _torch_device()
        print(f"[FrameThrower] loading pose models on {dev} — one-off, then cached on disk")
        dproc = AutoProcessor.from_pretrained(DETECT_MODEL)
        dmodel = AutoModelForObjectDetection.from_pretrained(DETECT_MODEL).to(dev).eval()
        pproc = VitPoseImageProcessor.from_pretrained(POSE_MODEL)
        pmodel = VitPoseForPoseEstimation.from_pretrained(POSE_MODEL).to(dev).eval()
        _pose_models = (dproc, dmodel, pproc, pmodel, dev)
    return _pose_models


def _local_pose(img):
    """An OpenPose-style skeleton on black, or None when nobody is in the frame.

    None rather than an empty black image on purpose: "no people here" and "the
    processor failed" should not look identical downstream, and the caller turns
    None into the same single black pixel every unwired socket gets.
    """
    import cv2

    dproc, dmodel, pproc, pmodel, dev = _load_pose_models()

    with torch.no_grad():
        di = dproc(images=img, return_tensors="pt").to(dev)
        det = dmodel(**di)
    sizes = torch.tensor([[img.height, img.width]])
    found = dproc.post_process_object_detection(det, target_sizes=sizes, threshold=0.5)[0]
    boxes = [
        [float(x1), float(y1), float(x2 - x1), float(y2 - y1)]
        for box, label in zip(found["boxes"], found["labels"])
        for x1, y1, x2, y2 in [box.tolist()]
        if dmodel.config.id2label[int(label)] == "person" and x2 > x1 and y2 > y1
    ]
    if not boxes:
        return None

    with torch.no_grad():
        pi = pproc(img, boxes=[boxes], return_tensors="pt").to(dev)
        po = pmodel(**pi)
    people = pproc.post_process_pose_estimation(po, boxes=[boxes])[0]

    canvas = np.zeros((img.height, img.width, 3), dtype=np.uint8)
    for person in people:
        kp = person["keypoints"].cpu().numpy()
        sc = person["scores"].cpu().numpy()

        pts, ok = [], []
        for op_i, coco_i in enumerate(_COCO_TO_OP):
            if coco_i is None:                      # the neck, from the shoulders
                if sc[5] >= _KP_MIN and sc[6] >= _KP_MIN:
                    pts.append(((kp[5] + kp[6]) / 2.0)); ok.append(True)
                else:
                    pts.append(np.zeros(2)); ok.append(False)
            else:
                pts.append(kp[coco_i]); ok.append(bool(sc[coco_i] >= _KP_MIN))

        # Limbs as filled ellipses along the bone rather than plain lines: that
        # is what OpenPose renders and what the ControlNets were trained on.
        for i, (a, b) in enumerate(_LIMBS):
            if not (ok[a] and ok[b]):
                continue
            ax, ay = pts[a]; bx, by = pts[b]
            mx, my = (ax + bx) / 2.0, (ay + by) / 2.0
            length = float(np.hypot(ax - bx, ay - by))
            angle = float(np.degrees(np.arctan2(ay - by, ax - bx)))
            poly = cv2.ellipse2Poly((int(mx), int(my)), (int(length / 2), 4), int(angle), 0, 360, 1)
            cv2.fillConvexPoly(canvas, poly, _COLORS[i % len(_COLORS)])
        for i, (p, good) in enumerate(zip(pts, ok)):
            if good:
                cv2.circle(canvas, (int(p[0]), int(p[1])), 4, _COLORS[i % len(_COLORS)], -1)

    return Image.fromarray(canvas)


def _credit(row):
    """The line the canvas burns into a collage — title, year, director."""
    title = row.get("filmTitle") or "Untitled"
    year = row.get("year")
    director = row.get("director")
    out = f"{title} ({year})" if year else title
    if director:
        out += f" — dir. {director}"
    return out


def _process(img, image_url, want_depth, want_pose, want_lineart, lineart_strength=3.0):
    """The three maps, as tensors. Runs only what something downstream reads.

    All three are local now, so there is no network call to hide behind a
    thread and no key to check first. `image_url` is kept in the signature
    because the caller has it and a cache keyed on the frame is the obvious
    next step if any of these ever gets slow.
    """
    out = {"depth": _BLANK, "pose": _BLANK, "lineart": _BLANK}
    if want_depth:
        try:
            out["depth"] = _to_tensor(_local_depth(img))
        except Exception as exc:  # noqa: BLE001
            print(f"[FrameThrower] local depth failed: {exc}")
    if want_lineart:
        try:
            out["lineart"] = _to_tensor(_local_lineart(img, lineart_strength))
        except Exception as exc:  # noqa: BLE001
            print(f"[FrameThrower] local lineart failed: {exc}")
    if want_pose:
        try:
            skeleton = _local_pose(img)
            if skeleton is None:
                print("[FrameThrower] no people in this frame — pose is empty.")
            else:
                out["pose"] = _to_tensor(skeleton)
        except Exception as exc:  # noqa: BLE001
            print(f"[FrameThrower] local pose failed: {exc}")
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
                # A STRING holding a number, not a FLOAT, and that is deliberate.
                # Comfy validates a FLOAT widget before the node runs, so a graph
                # saved against an older build — one widget short — maps a saved
                # string into this slot and the whole node refuses to execute
                # with "couldn't be converted to FLOAT". There is nothing the
                # node can do about that from Python. A STRING accepts whatever
                # lands in it, and _strength() below decides what it meant.
                "lineart_strength": ("STRING", {"default": "3.0", "multiline": False}),
            },
            "optional": {
                "query_in": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Words to search for, from another node. Automatic — "
                               "the grid follows the wire as you type upstream, no "
                               "queue needed.",
                }),
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
    def IS_CHANGED(cls, query, mode, index, pinned, filters="", smart=True, auto="", lineart_strength="3.0", query_in=None, prompt=None, unique_id=None):
        # Without this the node re-searches on every queue, and a search costs
        # credits. Hash the inputs so an unchanged node is a cache hit. The
        # connected outputs are part of the hash: wiring depth up has to
        # re-run the node, or the socket would stay black until something else
        # happened to invalidate the cache.
        wanted = sorted(_connected_outputs(prompt, unique_id) or [])
        blob = f"{query_in or query}|{mode}|{index}|{pinned}|{filters}|{smart}|{auto}|{lineart_strength}|{wanted}"
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def fetch(self, query, mode, index, pinned, filters="", smart=True, auto="", lineart_strength="3.0", query_in=None, prompt=None, unique_id=None):
        row = None

        # A frame clicked in the grid wins over the query — you looked at it and
        # chose it, and re-running the search could quietly hand back a
        # different frame at the same index.
        if pinned:
            try:
                row = json.loads(pinned)
            except json.JSONDecodeError:
                row = None

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
                    "query_in, or click a frame in the node's grid."
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
        pil = _load_pil(full)
        image = _load_image(full)
        # NOT `prompt` — that name is the hidden PROMPT graph, and rebinding it
        # here left _connected_outputs reading a description string. It caught
        # the AttributeError, returned None, and depth/pose/lineart came out
        # black no matter how they were wired.
        description = row.get("description") or ""
        credit = _credit(row)

        # Run a processor only if something downstream is reading its socket.
        wanted = _connected_outputs(prompt, unique_id) or set()
        maps = _process(pil, full, OUT_DEPTH in wanted, OUT_POSE in wanted, OUT_LINEART in wanted,
                        _strength(lineart_strength))
        return (image, description, credit, maps["depth"], maps["pose"], maps["lineart"])


NODE_CLASS_MAPPINGS = {"FrameThrowerReference": FrameThrowerReference}
NODE_DISPLAY_NAME_MAPPINGS = {"FrameThrowerReference": "FrameThrower Reference Node"}
