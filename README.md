# FrameThrower Reference Node for ComfyUI

The reference node from the [FrameThrower](https://framethrower.ai) workspace canvas, as a ComfyUI node. Search ~410,000 frames from 5,490 films, look at the results in a grid inside the node, click the one you want, and it comes out the other side as an `IMAGE`.

![the node](docs/node.png)

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/leo-kadieff/comfyui-framethrower
```

Then give it a token — create one at **framethrower.ai → Settings → API**:

```bash
export FT_API_TOKEN=ft_xxxxxxxx
```

Or copy `config.example.json` to `config.json` and put it there. `config.json` is gitignored, and the token is never sent to the browser — the node's grid calls back into ComfyUI's own server, which attaches the header. **Do not** paste a token into a node widget: widget values are saved inside the workflow `.json`, and shared workflows leak them.

Restart ComfyUI. The node is under **Add Node → FrameThrower → Reference Node**.

## Using it

Two ways to pick a frame, and they behave differently on purpose.

**Click one.** Type a query, watch the grid fill, click the frame you want. It pins to the top of the node and that exact frame is what executes — the search is not re-run, so a queue can never quietly hand you a different picture than the one you looked at. Clicking a pinned frame's neighbours searches for *visually similar* frames, the same as on the canvas.

**Wire one.** Connect a string into `query_in` and set `index`. Nothing is pinned, so the node searches at execution time and takes result *n*. This is the mode for batches and for anything driven by another node.

Clear (the eraser) empties the node. It leaves the query alone, so results come back when you change the prompt rather than instantly repopulating.

## Outputs

| socket | what it is |
|---|---|
| `image` | the frame |
| `prompt` | the scene description — wire straight into CLIP Text Encode |
| `credit` | `Blade Runner (1982) — dir. Ridley Scott` |
| `depth` | depth map |
| `pose` | DW pose skeleton |
| `lineart` | lineart |

**The last three run only if you wire them.** There is no toggle: the node reads the executing graph and runs a processor when something downstream is reading that socket. Each one is a real charge per image (roughly $0.0007 for depth), so the wire you can see is the only thing that spends money — no hidden switch that leaves a connected socket black.

They need a `FAL_KEY`. Unwired, a socket outputs a single black pixel rather than nothing: Comfy has no null on an `IMAGE` socket, and one black pixel fails loudly instead of silently passing the wrong picture downstream.

## Search modes

| mode | what it matches |
|---|---|
| `hybrid` | text + semantic. The default, and the right answer nearly always |
| `semantic` | visual meaning only |
| `description` | the text metadata only |

## Credits and rights

Frames are reduced-resolution stills shown as reference, under the same terms as the FrameThrower app — see [framethrower.ai/legal/intended-use](https://framethrower.ai/legal/intended-use). The `credit` output exists so the attribution can travel with the picture into whatever you build. Use it.

## Cost

Searches are metered against your FrameThrower credits. The node caches on its inputs (`IS_CHANGED`), so re-queueing an unchanged graph does not spend anything.
