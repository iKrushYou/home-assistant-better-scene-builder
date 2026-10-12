"""Config flow for Scene Builder.

There is nothing to configure: the flow is a single confirm step that creates
the one allowed entry, which registers the sidebar panel.
"""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN

TITLE = "Scene Builder"


class SceneBuilderConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle setup of Scene Builder."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm adding the integration from the UI."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(title=TITLE, data={})
        return self.async_show_form(step_id="user")

    async def async_step_import(
        self, import_data: dict[str, Any]
    ) -> ConfigFlowResult:
        """Create the entry from a legacy `scene_builder:` YAML line."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        return self.async_create_entry(title=TITLE, data={})
