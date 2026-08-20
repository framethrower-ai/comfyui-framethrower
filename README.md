# FrameThrower Reference Node for ComfyUI

The reference node from the [FrameThrower](https://framethrower.ai) workspace canvas, as a ComfyUI node. Search ~410,000 frames from 5,490 films, look at the results in a grid inside the node, click the one you want, and it comes out the other side as an `IMAGE`.

## Install

**ComfyUI Manager** — open Manager, search **FrameThrower**, click Install, restart ComfyUI.

Or by hand:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/framethrower-ai/comfyui-framethrower
```

Restart. The node is under **Add Node → FrameThrower → Reference Node**.

Needs ComfyUI 0.3.30 or newer. No pip install step — everything it imports already ships with ComfyUI.

## Connect

There is no key to copy. Drop the node on the canvas and click **Connect**: it shows a short code, opens [framethrower.ai/link](https://framethrower.ai/link), and you approve it there. The node picks the token up on its own.

Sign up free if you have not — new accounts get credits, and searches are metered against the balance. No card.

The token is written to `ComfyUI/user/framethrower/config.json`, mode `600`. It is deliberately **not** kept in a node widget: widget values serialise into the workflow `.json`, so a shared workflow would carry your key with it. It is never sent to the browser either — the grid calls back into ComfyUI's own server, and Python attaches the header.

**Headless or shared boxes:** set `FT_API_TOKEN` in the environment instead (create one at framethrower.ai → Settings → API). It overrides the saved file, and the node will say so rather than letting the Connect panel write somewhere with no effect.

## Using it

Two ways to pick a frame, and they behave differently on purpose.

**Click one.** Type a query, watch the grid fill, click the frame you want. It pins to the top of the node and that exact frame is what executes — the search is not re-run, so a queue can never quietly hand you a different picture than the one you looked at. Clicking a pinned frame's neighbours searches for *visually similar* frames, the same as on the canvas.

**Wire one.** Connect a string into `query_in` and set `index`. Nothing is pinned, so the node searches at execution time and takes result *n*. This is the mode for batches and for anything driven by another node.

Clear (the eraser) empties the node. It leaves the query alone, so results come back when you change the prompt rather than instantly repopulating.

Dragging a frame out of the grid onto the canvas makes a plain `LoadImage` pointing at a real file in your input folder — useful when you want the picture to stop depending on this node at all.

## Outputs

| socket | what it is |
|---|---|
| `image` | the frame |
| `prompt` | the scene description — wire straight into CLIP Text Encode |
| `credit` | `Blade Runner (1982) — dir. Ridley Scott` |
| `depth` | depth map |
| `pose` | DW pose skeleton |
| `lineart` | lineart |

**To see the two text outputs, wire them into the node called `Preview as Text`** (its internal id is `PreviewAny`, so search the menu for the display name, not that). `Save Text` writes them to a file instead.

A Primitive string node looks like the right target and is not: it *makes* text rather than showing it, so its `value` is a widget with no input socket and the wire cannot be made at all. `workflows/reference-basic.json` has all of this connected already — load it rather than rebuilding it.

**The last three run only if you wire them.** There is no toggle: the node reads the executing graph and runs a processor when something downstream is reading that socket. Unwired, a socket outputs a single black pixel rather than nothing — Comfy has no null on an `IMAGE` socket, and one black pixel fails loudly instead of silently passing the wrong picture downstream.

**`depth` and `lineart` run on your machine.** No key, no network call, nothing per image. Depth is Depth-Anything-V2-Small through the `transformers` pipeline that already ships with ComfyUI, on whichever device ComfyUI chose; the weights (~100MB) download once on first use. Lineart is a gradient magnitude kept only on the one-pixel spine of each edge, so lines stay thin without going flat — a firm edge comes out brighter than a faint one. A slider appears in the node's footer once the `lineart` socket is wired — hidden until then, because a dial for a socket nobody is reading is permanent clutter. It sets **how much detail** survives: low is sparse and structural, high picks up fine texture. **3.0** is the default. Anything unreadable in that slot falls back to it rather than refusing to run. Measured on an M-series GPU: **65ms for depth, against 58.9s on a cold fal model** for output that looks the same.

**`pose` still calls fal** and still needs a `FAL_KEY`, because there is no local path for it that does not drag in a new dependency — `transformers` has no pose pipeline, and onnxruntime, mediapipe and ultralytics are none of them things ComfyUI already installs. Without a key the node says so and carries on. It is cached per frame, since it is a real charge per call.

`image_in` (search by picture rather than words) also needs `FAL_KEY`, plus `pip install fal-client` — FrameThrower fetches the picture by URL, so it has to be uploaded somewhere first.

## Search modes

| mode | what it matches |
|---|---|
| `hybrid` | text + semantic. The default, and the right answer nearly always |
| `semantic` | visual meaning only |
| `description` | the text metadata only |

The filter grid and the hue bar narrow a search rather than replacing it, so a query and a colour compose.

## Credits and rights

Frames are reduced-resolution stills shown as reference, under the same terms as the FrameThrower app — see [framethrower.ai/legal/intended-use](https://framethrower.ai/legal/intended-use). The `credit` output exists so the attribution can travel with the picture into whatever you build. Use it.

## Cost

Searches are metered against your FrameThrower credits. The node caches on its inputs (`IS_CHANGED`), so re-queueing an unchanged graph does not spend anything.

## Troubleshooting

**The node draws as a stack of plain widgets.** Your ComfyUI frontend is older than 1.16. The console says so on load. Update ComfyUI.

**"Not connected to FrameThrower" on execute.** The Connect panel never finished, or `FT_API_TOKEN` is set to something stale. Check `ComfyUI/user/framethrower/config.json`.

**Connect says it cannot write.** Rare — it means `ComfyUI/user/` is read-only. Use `FT_API_TOKEN` instead.

MIT.
