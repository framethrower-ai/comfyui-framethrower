"""
FrameThrower client, plus the HTTP routes the node's own UI calls.

The token never reaches the browser. The grid inside the node is JavaScript, so
it cannot hold a PAT — anyone who exported a workflow would export the key with
it. Instead the JS calls back into ComfyUI's own aiohttp server (the routes at
the bottom of this file) and the Python side attaches the Authorization header.
This is the same shape as the workspace canvas, where /api/ft-search proxies to
framethrower.ai for exactly this reason.
"""

import json
import os
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.realpath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")

DEFAULT_BASE = "https://framethrower.ai"


def _load_config():
    """Env wins over config.json so a shared box can key per-process."""
    cfg = {}
    if os.path.isfile(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
        except Exception as exc:  # a broken file should not kill the import
            print(f"[FrameThrower] could not read config.json: {exc}")
    return {
        "base_url": os.environ.get("FT_API_URL") or cfg.get("base_url") or DEFAULT_BASE,
        "token": os.environ.get("FT_API_TOKEN") or cfg.get("token") or "",
        "fal_key": os.environ.get("FAL_KEY") or cfg.get("fal_key") or "",
    }


def config():
    return _load_config()


class FrameThrowerError(RuntimeError):
    pass


def _post(path, payload, token=None, base=None, timeout=60):
    cfg = _load_config()
    base = base or cfg["base_url"]
    token = token or cfg["token"]
    if not token:
        raise FrameThrowerError(
            "No FrameThrower token. Set FT_API_TOKEN, or put it in "
            "custom_nodes/comfyui-framethrower/config.json. Create one at "
            "framethrower.ai → Settings → API."
        )

    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "comfyui-framethrower",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:400]
        try:
            msg = json.loads(body).get("error") or body
        except Exception:
            msg = body
        if exc.code == 401:
            msg = "Token rejected (401). Check FT_API_TOKEN."
        if exc.code == 402:
            msg = "Out of credits. Top up at framethrower.ai → Settings → Billing."
        raise FrameThrowerError(f"{msg}") from exc
    except urllib.error.URLError as exc:
        raise FrameThrowerError(f"Could not reach {base}: {exc.reason}") from exc


def search(query, limit=30, mode="hybrid", offset=0):
    """Text search. Returns the raw result rows: id, src, fullSrc, filmTitle,
    director, year, description."""
    if not query or not query.strip():
        return []
    data = _post(
        "/api/external/search",
        {"query": query.strip(), "limit": limit, "mode": mode, "offset": offset},
    )
    return data.get("results") or []


def search_by_image(image_url):
    """Visually similar frames. No paging on the API side — one shot."""
    if not image_url:
        return []
    data = _post("/api/external/search-image", {"imageUrl": image_url}, timeout=120)
    return data.get("results") or []


def fetch_bytes(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "comfyui-framethrower"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


# ── routes the node's UI talks to ────────────────────────────────────────────
# Registered on ComfyUI's own server. Guarded so importing this module outside
# ComfyUI (tests, linting) doesn't explode.
try:
    from aiohttp import web as _web
    from server import PromptServer as _PromptServer

    _routes = _PromptServer.instance.routes

    @_routes.post("/framethrower/search")
    async def _route_search(request):
        try:
            body = await request.json()
            if body.get("imageUrl"):
                results = search_by_image(body["imageUrl"])
                return _web.json_response({"results": results, "exhausted": True})
            results = search(
                body.get("query", ""),
                limit=int(body.get("limit", 30)),
                mode=body.get("mode", "hybrid"),
                offset=int(body.get("offset", 0)),
            )
            return _web.json_response({"results": results, "exhausted": len(results) < int(body.get("limit", 30))})
        except FrameThrowerError as exc:
            return _web.json_response({"error": str(exc)}, status=502)
        except Exception as exc:  # noqa: BLE001 - surface anything to the node UI
            return _web.json_response({"error": f"{type(exc).__name__}: {exc}"}, status=500)

    @_routes.get("/framethrower/status")
    async def _route_status(request):
        cfg = _load_config()
        return _web.json_response(
            {
                "configured": bool(cfg["token"]),
                "baseUrl": cfg["base_url"],
                "fal": bool(cfg["fal_key"]),
                # An env-supplied token cannot be replaced from the UI — writing
                # config.json would have no effect while the variable is set,
                # and silently doing nothing is worse than saying so.
                "fromEnv": bool(os.environ.get("FT_API_TOKEN")),
                "connectUrl": f"{cfg['base_url']}/settings?tab=api",
            }
        )

    @_routes.post("/framethrower/connect")
    async def _route_connect(request):
        """Save a token from the node's Connect panel.

        Verified before it is written: a token that is wrong should fail here,
        in front of the person who just pasted it, rather than later inside a
        queued graph where the error reads as a broken node.
        """
        try:
            token = (await request.json()).get("token", "").strip()
        except Exception:
            return _web.json_response({"error": "Bad request"}, status=400)
        if not token:
            return _web.json_response({"error": "Paste a token first."}, status=400)
        if os.environ.get("FT_API_TOKEN"):
            return _web.json_response(
                {"error": "FT_API_TOKEN is set in the environment and overrides anything saved here. Unset it first."},
                status=409,
            )
        try:
            _post("/api/external/search", {"query": "test", "limit": 1}, token=token)
        except FrameThrowerError as exc:
            return _web.json_response({"error": str(exc)}, status=401)

        cfg = {}
        if os.path.isfile(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                    cfg = json.load(fh)
            except Exception:
                cfg = {}
        cfg["token"] = token
        cfg.setdefault("base_url", DEFAULT_BASE)
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh, indent=2)
            os.chmod(CONFIG_PATH, 0o600)   # a credential, not a settings file
        except OSError as exc:
            return _web.json_response({"error": f"Could not write config.json: {exc}"}, status=500)
        return _web.json_response({"ok": True})

except Exception as exc:  # noqa: BLE001
    print(f"[FrameThrower] UI routes not registered ({type(exc).__name__}: {exc})")
