"""comfyui-framethrower — the FrameThrower reference node, inside ComfyUI."""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Serves web/ to the frontend. The grid, the mode menu and the progress ring
# are all in there — none of that is expressible with stock Comfy widgets.
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
