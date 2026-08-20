# FrameThrower Reference Node

Search ~410,000 film stills from 5,490 films, look at the results in the grid, click one, and it comes out as an `IMAGE` — with its scene description, its credit line, and depth, pose or lineart if you wire them.

## Connect

There is no key to paste. Click **Connect** on the node: it shows a short code and opens framethrower.ai/link, where you approve it. The token is saved by ComfyUI's server and never reaches the browser, so a shared workflow cannot carry it.

Free accounts get credits. Searches are metered against them; nothing else on this node costs anything.

## Picking a frame

**Click one.** Type a query, click the frame you want. It pins, and that exact frame executes — the search is not re-run, so a queue cannot hand you a different picture than the one you looked at.

**Click nothing.** Whatever sits at `index` in the grid runs. That holds for colour and film searches too, not just typed ones.

**Wire `query_in`.** Automatic — the grid follows the wire as you type on the upstream node, no queue needed. Use the node called **Text**.

## The two badges on a frame

- **Eye** — frames that *look like* this one, from anywhere in the library.
- **Shelf** — every frame of the film this one came from, in the order the film runs. Scroll to page through it.

## Outputs

| socket | what it is |
|---|---|
| `image` | the frame |
| `depth` | depth map, for a depth ControlNet |
| `pose` | OpenPose skeleton, for a pose ControlNet |
| `lineart` | lineart, for a lineart ControlNet |
| `prompt (text)` | the scene description — into CLIP Text Encode |
| `credit (text)` | `Blade Runner (1982) — dir. Ridley Scott` |

**Depth, pose and lineart run only while their socket is wired.** There is no toggle — the node reads the executing graph. An unwired socket outputs a single black pixel, because Comfy has no null on an `IMAGE` socket and one black pixel fails loudly rather than passing the wrong picture downstream.

All three run **on your machine**. No key, no network call, nothing per image. The models download once.

To read the two text outputs, wire them into **Preview as Text**. A **Text** node cannot show them — that one makes text rather than displaying it.

## Controls

- **Funnel** — filter by shot, angle, time, lighting, era, focus, lens and style. Narrows a search rather than replacing it.
- **Spark** — smart search, on by default. Rewrites your words the way framethrower.ai does; recall@10 is 0.72 raw against 0.88 rewritten.
- **Hue bar** — narrow by colour. Composes with the query, so "ocean" in teal stays about the sea.
- **Sliders** — thumbnail size, and lineart detail once that socket is wired. Low is sparse and structural, high picks up fine texture.
- **Eraser** — clears results but leaves the query, so they come back when you change the words.

Dragging a frame onto the canvas makes a plain `LoadImage`, so the picture stops depending on this node at all.

## Rights

Frames are reduced-resolution stills, shown as reference under the terms at [framethrower.ai/legal/intended-use](https://framethrower.ai/legal/intended-use). The `credit` output exists so attribution travels with the picture. Use it.
