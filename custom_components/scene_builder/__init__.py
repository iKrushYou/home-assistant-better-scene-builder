"""Scene Builder integration.

Registers a custom sidebar panel that provides a room-first UI for building
scenes: pick an area, pull in all of its entities in one click, then snapshot
their current live states into a scene. Scenes are written through the same
REST endpoint the built-in editor uses, so they land in scenes.yaml and behave
identically to natively-created scenes.

Set up from the UI (Settings > Devices & Services > Add Integration). A legacy
`scene_builder:` line in configuration.yaml is still accepted and is imported
into a config entry on startup.
"""
from __future__ import annotations

import json
import logging
import os

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# The integration takes no options; `scene_builder:` with nothing under it is
# the only valid YAML form.
CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)

# Single source of truth is manifest.json (which HACS also reads). It is
# appended to the module URL as a cache-buster so the HA frontend's service
# worker fetches the new JS instead of serving a stale cached copy. Read at
# import time, which HA runs in an executor, so this doesn't block the loop.
with open(os.path.join(os.path.dirname(__file__), "manifest.json")) as _f:
    VERSION = json.load(_f)["version"]

PANEL_URL_PATH = "scene-builder"
PANEL_TITLE = "Scene Builder"
PANEL_ICON = "mdi:palette-swatch"

# Web component tag defined in scene-builder-panel.js
PANEL_ELEMENT = "scene-builder-panel"

# URL the browser fetches the JS module from, and the file that backs it.
JS_URL = "/scene_builder_frontend/scene-builder-panel.js"
JS_FILENAME = "scene-builder-panel.js"

# hass.data flag: static paths can't be unregistered, so register them once per
# HA run even if the entry is unloaded and set up again.
_STATIC_REGISTERED = f"{DOMAIN}_static_registered"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Import a legacy YAML `scene_builder:` line into a config entry."""
    if DOMAIN in config:
        hass.async_create_task(
            hass.config_entries.flow.async_init(
                DOMAIN, context={"source": SOURCE_IMPORT}, data={}
            )
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Register the Scene Builder panel."""
    if not hass.data.get(_STATIC_REGISTERED):
        js_path = os.path.join(os.path.dirname(__file__), "frontend", JS_FILENAME)
        await hass.http.async_register_static_paths(
            [StaticPathConfig(JS_URL, js_path, cache_headers=False)]
        )
        hass.data[_STATIC_REGISTERED] = True

    # Register the custom element as a sidebar panel. require_admin mirrors the
    # built-in scene editor, which needs admin to write config. The ?v= query
    # busts the frontend service-worker cache whenever VERSION changes.
    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=PANEL_ELEMENT,
        frontend_url_path=PANEL_URL_PATH,
        module_url=f"{JS_URL}?v={VERSION}",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=True,
        embed_iframe=False,
    )

    _LOGGER.info("Scene Builder panel registered at /%s", PANEL_URL_PATH)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the panel when the integration is removed or reloaded."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    return True
