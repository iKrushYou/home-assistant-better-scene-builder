/**
 * Scene Builder panel.
 *
 * A room-first scene creator/editor for Home Assistant.
 *
 *  - Reads the area/device/entity registries over WebSocket and groups every
 *    entity under its room. "Add all" pulls in a whole room at once.
 *  - Each entity in a scene becomes a compact, always-on control card. Adding an
 *    entity seeds its target from the current live state; you then dial in the
 *    target (on/off, brightness, color, temperature, position, mode, value)
 *    directly on the card. There is no expand/collapse: controls are always
 *    visible.
 *  - Existing scenes can be loaded, edited in place, re-saved, or deleted, via
 *    the same REST endpoints the built-in editor uses (scenes live in
 *    scenes.yaml).
 *
 * Zero build step: plain custom element loaded as an ES module. Relies only on
 * the `hass` object Home Assistant injects into custom panels.
 */

// Domains worth putting in a scene. Everything else is filtered out of the
// picker so the lists stay signal-heavy.
const SCENE_DOMAINS = new Set([
  "light",
  "switch",
  "fan",
  "cover",
  "climate",
  "media_player",
  "input_boolean",
  "input_number",
  "input_select",
  "humidifier",
  "lock",
  "select",
  "number",
  "siren",
  "water_heater",
  "vacuum",
  "valve",
  "remote",
]);

// Per-domain allowlist of settable attributes to seed from live state.
const DOMAIN_ATTRS = {
  light: [
    "brightness",
    "color_mode",
    "color_temp_kelvin",
    "color_temp",
    "rgb_color",
    "rgbw_color",
    "rgbww_color",
    "xy_color",
    "hs_color",
    "effect",
  ],
  cover: ["current_position", "current_tilt_position"],
  climate: [
    "temperature",
    "target_temp_high",
    "target_temp_low",
    "fan_mode",
    "preset_mode",
    "humidity",
    "swing_mode",
  ],
  media_player: ["volume_level", "source", "is_volume_muted"],
  fan: ["percentage", "preset_mode", "oscillating", "direction"],
  humidifier: ["humidity", "mode"],
  water_heater: ["temperature", "operation_mode"],
  vacuum: ["fan_speed"],
};

const UNASSIGNED = "__unassigned__";
const COLOR_MODES = ["rgb", "rgbw", "rgbww", "hs", "xy"];
// Domains whose primary control is an on/off (or lock) switch in the card head.
const SWITCH_DOMAINS = new Set([
  "light",
  "switch",
  "input_boolean",
  "fan",
  "humidifier",
  "siren",
  "remote",
]);

// Fallback icons per domain, used when the entity has no icon of its own.
const DOMAIN_ICONS = {
  light: "mdi:lightbulb",
  switch: "mdi:toggle-switch-variant",
  fan: "mdi:fan",
  cover: "mdi:window-shutter",
  climate: "mdi:thermostat",
  media_player: "mdi:cast",
  input_boolean: "mdi:toggle-switch",
  input_number: "mdi:ray-vertex",
  input_select: "mdi:format-list-bulleted",
  humidifier: "mdi:air-humidifier",
  lock: "mdi:lock",
  select: "mdi:format-list-bulleted",
  number: "mdi:ray-vertex",
  siren: "mdi:bullhorn",
  water_heater: "mdi:water-boiler",
  vacuum: "mdi:robot-vacuum",
  valve: "mdi:valve",
  remote: "mdi:remote-tv",
};

/** Best icon for an entity: its own icon, else a domain default. */
function iconFor(eid, stateObj) {
  const own = stateObj && stateObj.attributes && stateObj.attributes.icon;
  return own || DOMAIN_ICONS[eid.split(".")[0]] || "mdi:eye";
}

// ---- state capture / sanitize -------------------------------------------

/** Seed a scene target from an entity's current live state. */
function captureState(stateObj) {
  const domain = stateObj.entity_id.split(".")[0];
  const attrs = stateObj.attributes || {};
  const out = { state: stateObj.state };
  for (const key of DOMAIN_ATTRS[domain] || []) {
    const v = attrs[key];
    if (v !== undefined && v !== null) out[key] = v;
  }
  // No stateObj here: keep both climate setpoint forms in the captured target so
  // switching modes in the editor still has the device's real low/high values.
  // They're pruned when the scene is saved or previewed.
  return sanitizeTarget(stateObj.entity_id, out);
}

// Climate feature bits (ClimateEntityFeature).
const CLIMATE_TARGET_TEMP = 1;
const CLIMATE_TARGET_RANGE = 2;

/**
 * Whether a climate target uses a low/high range instead of one temperature:
 * range-only thermostats always do, and thermostats that support both use the
 * range in heat_cool mode.
 */
function climateUsesRange(t, attrs) {
  const feat = (attrs && attrs.supported_features) || 0;
  if (!(feat & CLIMATE_TARGET_RANGE)) return false;
  return !(feat & CLIMATE_TARGET_TEMP) || t.state === "heat_cool";
}

/**
 * Clean a (possibly edited) target before saving or previewing: drop
 * attributes that make no sense for the state, and resolve conflicting light
 * color and climate setpoint representations. `stateObj` is the entity's live
 * state, used to read its supported features; it may be missing.
 */
function sanitizeTarget(entityId, target, stateObj) {
  const domain = entityId.split(".")[0];
  const out = { ...target };

  // "Don't set" in a dropdown stores "". A preset_mode of "none"/null is a
  // device's idle indicator, not a settable target - keeping it makes the scene
  // call set_preset_mode with an invalid value (e.g. "Preset mode none is not
  // valid"). Drop both.
  for (const key of ["preset_mode", "fan_mode", "swing_mode", "source"]) {
    if (out[key] == null || out[key] === "") delete out[key];
  }
  if (out.preset_mode != null && String(out.preset_mode).toLowerCase() === "none")
    delete out.preset_mode;

  if (domain === "climate" && stateObj) {
    if (climateUsesRange(out, stateObj.attributes)) {
      delete out.temperature;
    } else {
      delete out.target_temp_low;
      delete out.target_temp_high;
    }
  }

  if (domain === "light") {
    if (out.state !== "on") return { state: out.state };
    if (out.color_mode === "color_temp") {
      delete out.rgb_color;
      delete out.rgbw_color;
      delete out.rgbww_color;
      delete out.xy_color;
      delete out.hs_color;
    } else if (out.color_mode && !["brightness", "onoff"].includes(out.color_mode)) {
      delete out.color_temp;
      delete out.color_temp_kelvin;
    }
  }

  if (domain === "cover" && typeof out.current_position === "number") {
    out.state = out.current_position > 0 ? "open" : "closed";
  }

  return out;
}

// ---- component -----------------------------------------------------------

class SceneBuilderPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._loaded = false;
    this._areas = [];
    this._entitiesByArea = new Map(); // areaId -> [{entity_id, name}]
    this._entityArea = new Map(); // entity_id -> areaId (for grouping the right pane)
    this._areaName = new Map();
    this._targets = new Map(); // entity_id -> target state {state, ...attrs}
    this._scenes = []; // [{id, name}] of editable existing scenes
    this._currentSceneId = null; // set when editing an existing scene
    this._sceneName = "";
    this._status = null; // {type, text}
    // entity_id -> state captured just before that entity was first previewed.
    // Null when nothing is previewed. Kept across scene switches, since it
    // describes the devices, not the scene; cleared by Revert.
    this._previewSnapshot = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && !this._loaded) this._loadRegistries();
  }
  get hass() {
    return this._hass;
  }

  // HA sets `narrow` on panels when the sidebar is collapsed (phones, small
  // windows). The attribute drives the mobile layout and shows the menu button.
  set narrow(v) {
    this.toggleAttribute("narrow", !!v);
  }

  async _loadRegistries() {
    this._loaded = true;
    try {
      const [areas, devices, entities] = await Promise.all([
        this._hass.callWS({ type: "config/area_registry/list" }),
        this._hass.callWS({ type: "config/device_registry/list" }),
        this._hass.callWS({ type: "config/entity_registry/list" }),
      ]);

      const deviceArea = new Map(devices.map((d) => [d.id, d.area_id || null]));
      this._areaName = new Map(areas.map((a) => [a.area_id, a.name]));
      this._areaName.set(UNASSIGNED, "Unassigned");
      const regById = new Map(entities.map((e) => [e.entity_id, e]));

      // Union the entity registry with the live-state entity ids. YAML-defined
      // helpers (input_select/input_boolean/input_number declared in
      // configuration.yaml) usually have no unique_id, so they never appear in
      // the registry - they exist only in states. Enumerate from both so
      // nothing scene-able is missed.
      const ids = new Set();
      for (const e of entities)
        if (
          !e.disabled_by &&
          !e.hidden_by &&
          SCENE_DOMAINS.has(e.entity_id.split(".")[0])
        )
          ids.add(e.entity_id);
      for (const id in this._hass.states)
        if (SCENE_DOMAINS.has(id.split(".")[0])) ids.add(id);

      const byArea = new Map();
      this._entityArea = new Map();
      for (const eid of ids) {
        const e = regById.get(eid);
        // Skip entities that are disabled (no usable state) or hidden in HA
        // (the user set them visible=false). Entities with no registry entry
        // - YAML helpers - can't be hidden, so they always pass.
        if (e && (e.disabled_by || e.hidden_by)) continue;
        const st = this._hass.states[eid];
        const areaId = (e && (e.area_id || deviceArea.get(e.device_id))) || UNASSIGNED;
        const name =
          (e && (e.name || e.original_name)) ||
          (st && st.attributes.friendly_name) ||
          eid;
        this._entityArea.set(eid, areaId);
        if (!byArea.has(areaId)) byArea.set(areaId, []);
        byArea.get(areaId).push({ entity_id: eid, name });
      }
      for (const list of byArea.values())
        list.sort((x, y) => x.name.localeCompare(y.name));

      this._areas = [...byArea.keys()].sort((x, y) => this._areaSort(x, y));
      this._entitiesByArea = byArea;
      this._refreshSceneList();
      this._render();
    } catch (err) {
      this._status = { type: "error", text: `Failed to load: ${err.message || err}` };
      this._render();
    }
  }

  /** Sort area ids by label, with Unassigned pinned last. */
  _areaSort(x, y) {
    if (x === UNASSIGNED) return 1;
    if (y === UNASSIGNED) return -1;
    return (this._areaName.get(x) || x).localeCompare(this._areaName.get(y) || y);
  }

  /** Build the editable-scene list from the scene.* entities in state. */
  _refreshSceneList() {
    const scenes = [];
    for (const id in this._hass.states) {
      if (!id.startsWith("scene.")) continue;
      const s = this._hass.states[id];
      if (s.attributes && s.attributes.id != null) {
        scenes.push({
          id: String(s.attributes.id),
          name: s.attributes.friendly_name || id,
        });
      }
    }
    scenes.sort((a, b) => a.name.localeCompare(b.name));
    this._scenes = scenes;
  }

  // ---- scene load / new / delete ----------------------------------------

  async _openScene(sceneId) {
    try {
      const cfg = await this._hass.callApi("GET", `config/scene/config/${sceneId}`);
      this._currentSceneId = sceneId;
      this._sceneName = cfg.name || "";
      this._targets = new Map();
      for (const [eid, val] of Object.entries(cfg.entities || {})) {
        this._targets.set(eid, typeof val === "string" ? { state: val } : { ...val });
      }
      this._status = null;
      this._render();
    } catch (err) {
      this._status = { type: "error", text: `Load failed: ${err.message || err}` };
      this._refreshDynamic();
    }
  }

  _newScene() {
    this._currentSceneId = null;
    this._sceneName = "";
    this._targets = new Map();
    this._status = null;
    this._render();
  }

  async _deleteScene() {
    if (!this._currentSceneId) return;
    if (!confirm(`Delete scene "${this._sceneName}"? This cannot be undone.`)) return;
    try {
      await this._hass.callApi("DELETE", `config/scene/config/${this._currentSceneId}`);
      this._scenes = this._scenes.filter((s) => s.id !== this._currentSceneId);
      const name = this._sceneName;
      this._newScene();
      this._status = { type: "ok", text: `Deleted "${name}".` };
      this._refreshDynamic();
    } catch (err) {
      this._status = { type: "error", text: `Delete failed: ${err.message || err}` };
      this._refreshDynamic();
    }
  }

  async _save() {
    const name = this._sceneName.trim();
    if (!name) {
      this._status = { type: "error", text: "Give the scene a name first." };
      this._refreshDynamic();
      return;
    }
    if (this._targets.size === 0) {
      this._status = { type: "error", text: "Add at least one entity." };
      this._refreshDynamic();
      return;
    }

    const entities = this._sceneEntities();

    const id = this._currentSceneId || String(Date.now());
    const editing = !!this._currentSceneId;
    try {
      await this._hass.callApi("POST", `config/scene/config/${id}`, { name, entities });
      this._currentSceneId = id;
      if (!this._scenes.some((s) => s.id === id)) this._scenes.push({ id, name });
      else this._scenes = this._scenes.map((s) => (s.id === id ? { id, name } : s));
      this._scenes.sort((a, b) => a.name.localeCompare(b.name));
      this._status = {
        type: "ok",
        text: `${editing ? "Updated" : "Saved"} "${name}" with ${this._targets.size} entities.`,
      };
      this._render();
    } catch (err) {
      this._status = { type: "error", text: `Save failed: ${err.message || err}` };
      this._refreshDynamic();
    }
  }

  /** The scene's entities as they'll be written or applied. */
  _sceneEntities() {
    const entities = {};
    for (const [eid, t] of this._targets)
      entities[eid] = sanitizeTarget(eid, t, this._hass.states[eid]);
    return entities;
  }

  /**
   * Apply the scene to the devices without saving it. The first time each
   * entity is previewed, its current state is recorded so Revert can put it
   * back.
   */
  async _preview() {
    if (this._targets.size === 0) return;
    const snapshot = this._previewSnapshot || new Map();
    for (const eid of this._targets.keys()) {
      const st = this._hass.states[eid];
      if (st && !snapshot.has(eid)) snapshot.set(eid, captureState(st));
    }
    this._previewSnapshot = snapshot;
    try {
      await this._hass.callService("scene", "apply", {
        entities: this._sceneEntities(),
      });
      this._status = {
        type: "ok",
        text: "Previewing. Devices are set to this scene but nothing is saved. Revert puts them back.",
      };
    } catch (err) {
      this._status = { type: "error", text: `Preview failed: ${err.message || err}` };
    }
    this._refreshDynamic();
  }

  /** Put every previewed device back the way it was before its first preview. */
  async _revert() {
    if (!this._previewSnapshot) return;
    const entities = {};
    for (const [eid, t] of this._previewSnapshot)
      entities[eid] = sanitizeTarget(eid, t, this._hass.states[eid]);
    try {
      await this._hass.callService("scene", "apply", { entities });
      this._previewSnapshot = null;
      this._status = { type: "ok", text: "Reverted devices to how they were before the preview." };
    } catch (err) {
      this._status = { type: "error", text: `Revert failed: ${err.message || err}` };
    }
    this._refreshDynamic();
  }

  /** Turn the scene being edited into a new, unsaved copy. */
  _duplicate() {
    if (!this._currentSceneId) return;
    const source = this._sceneName;
    this._currentSceneId = null;
    this._sceneName = `${source} (copy)`;
    this._targets = new Map(
      [...this._targets].map(([eid, t]) => [eid, structuredClone(t)])
    );
    this._status = {
      type: "ok",
      text: `Copied "${source}". Rename it if you like, then save to create the new scene.`,
    };
    this._render();
  }

  // ---- membership -------------------------------------------------------

  _addEntity(eid) {
    if (this._targets.has(eid)) return;
    const st = this._hass.states[eid];
    this._targets.set(eid, st ? captureState(st) : { state: "on" });
  }

  _toggleEntity(eid, on) {
    if (on) this._addEntity(eid);
    else this._targets.delete(eid);
    this._status = null;
    this._refreshDynamic();
  }

  _toggleArea(areaId) {
    const list = this._entitiesByArea.get(areaId) || [];
    const allSelected =
      list.length > 0 && list.every((e) => this._targets.has(e.entity_id));
    for (const e of list) {
      if (allSelected) this._targets.delete(e.entity_id);
      else this._addEntity(e.entity_id);
    }
    this._status = null;
    this._refreshDynamic();
  }

  // ---- rendering --------------------------------------------------------

  _render() {
    const total = [...this._entitiesByArea.values()].reduce((n, l) => n + l.length, 0);
    const editing = !!this._currentSceneId;

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="wrap">
        <header>
          <button class="menu" id="menu" title="Menu" aria-label="Open sidebar">
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 6h18v2H3V6m0 5h18v2H3v-2m0 5h18v2H3v-2Z"/></svg>
          </button>
          <div>
            <h1>Scene Builder</h1>
            <p>Pick a room, pull in its entities, dial in each control, and save.</p>
          </div>
        </header>
        <div class="cols">
          <section class="pane rooms">
            <div class="pane-head">
              <input id="search" type="search" placeholder="Filter ${total} entities..." autocomplete="off" />
            </div>
            <div class="list" id="rooms">
              ${this._areas.map((id) => this._renderArea(id)).join("")}
            </div>
          </section>
          <section class="pane selected">
            <div class="pane-head">
              <select id="scene-picker">
                <option value="" ${editing ? "" : "selected"}>+ New scene</option>
                ${this._scenes
                  .map(
                    (s) =>
                      `<option value="${escapeAttr(s.id)}" ${
                        s.id === this._currentSceneId ? "selected" : ""
                      }>${escapeHtml(s.name)}</option>`
                  )
                  .join("")}
              </select>
              <input id="scene-name" type="text" placeholder="Scene name" value="${escapeAttr(
                this._sceneName
              )}" />
            </div>
            <div class="selcount"><span id="selcount">${this._targets.size}</span> entities${
      editing ? ` · editing <em>${escapeHtml(this._sceneName || "scene")}</em>` : ""
    }</div>
            <div class="list cards" id="selected-list">${this._renderSelectedList()}</div>
            <div class="foot" id="foot">${this._renderFoot()}</div>
          </section>
        </div>
      </div>`;
    this._wireEvents();
  }

  /** Status line plus action buttons. Re-rendered whenever selection changes. */
  _renderFoot() {
    const editing = !!this._currentSceneId;
    const empty = this._targets.size === 0;
    const status = this._status
      ? `<div class="status ${this._status.type}">${escapeHtml(this._status.text)}</div>`
      : "";
    return `
      ${status}
      <button class="primary" data-action="save" ${empty ? "disabled" : ""}>${
      editing ? "Update scene" : "Save scene"
    }</button>
      <div class="btnrow">
        <button class="secondary" data-action="preview" ${empty ? "disabled" : ""}>Preview</button>
        ${this._previewSnapshot ? `<button class="secondary" data-action="revert">Revert</button>` : ""}
        ${editing ? `<button class="secondary" data-action="duplicate">Duplicate</button>` : ""}
        ${editing ? `<button class="secondary danger" data-action="delete">Delete</button>` : ""}
      </div>`;
  }

  _renderArea(areaId) {
    const list = this._entitiesByArea.get(areaId) || [];
    const label = this._areaName.get(areaId) || areaId;
    const sel = list.filter((e) => this._targets.has(e.entity_id)).length;
    return `
      <div class="area" data-area="${escapeAttr(areaId)}">
        <div class="area-head">
          <span class="area-name">${escapeHtml(label)}</span>
          <span class="area-meta">${sel}/${list.length}</span>
          <button class="addall" data-area="${escapeAttr(areaId)}">${
      sel === list.length && list.length ? "Remove all" : "Add all"
    }</button>
        </div>
        <div class="entities">
          ${list
            .map(
              (e) => `
            <label class="entity" data-name="${escapeAttr(
              e.name.toLowerCase()
            )}" data-eid="${escapeAttr(e.entity_id.toLowerCase())}">
              <input type="checkbox" class="ent-cb" data-eid="${escapeAttr(
                e.entity_id
              )}" ${this._targets.has(e.entity_id) ? "checked" : ""} />
              <ha-icon class="row-icon" icon="${escapeAttr(
                iconFor(e.entity_id, this._hass.states[e.entity_id])
              )}"></ha-icon>
              <span class="ent-name">${escapeHtml(e.name)}</span>
              <span class="ent-id">${escapeHtml(e.entity_id)}</span>
            </label>`
            )
            .join("")}
        </div>
      </div>`;
  }

  _renderSelectedList() {
    if (this._targets.size === 0)
      return `<div class="empty">Nothing selected yet. Add a room from the left, or load a scene above.</div>`;

    // Group the selected entities under their room, like the left pane.
    const groups = new Map();
    for (const eid of [...this._targets.keys()].sort()) {
      const areaId = this._entityArea.get(eid) || UNASSIGNED;
      if (!groups.has(areaId)) groups.set(areaId, []);
      groups.get(areaId).push(eid);
    }
    return [...groups.keys()]
      .sort((x, y) => this._areaSort(x, y))
      .map(
        (areaId) => `
        <div class="card-group">
          <div class="group-head">${escapeHtml(this._areaName.get(areaId) || areaId)}</div>
          ${groups.get(areaId).map((eid) => this._renderCard(eid)).join("")}
        </div>`
      )
      .join("");
  }

  /** One always-on control card per selected entity. */
  _renderCard(eid) {
    const domain = eid.split(".")[0];
    const t = this._targets.get(eid);
    const st = this._hass.states[eid];
    const name = (st && st.attributes.friendly_name) || eid;
    const missing = !st;
    const isOff = SWITCH_DOMAINS.has(domain) && domain !== "lock" && t.state !== "on";

    let headControl = "";
    if (domain === "lock") {
      headControl = switchControl("state-lock", eid, t.state === "locked");
    } else if (SWITCH_DOMAINS.has(domain)) {
      headControl = switchControl("state-onoff", eid, t.state === "on");
    }

    const body = this._renderCardBody(eid, domain, t, st);

    return `
      <div class="card ${isOff ? "is-off" : ""}" data-eid="${escapeAttr(eid)}">
        <div class="card-head">
          <ha-icon class="card-icon" icon="${escapeAttr(iconFor(eid, st))}"></ha-icon>
          <div class="card-info">
            <span class="ent-name">${escapeHtml(name)}${
      missing ? ' <span class="warn">unavailable</span>' : ""
    }</span>
            <span class="ent-id">${escapeHtml(eid)}</span>
          </div>
          ${headControl}
          <button class="remove" data-eid="${escapeAttr(eid)}" title="Remove">&times;</button>
        </div>
        ${body ? `<div class="card-body">${body}</div>` : ""}
      </div>`;
  }

  _renderCardBody(eid, domain, t, live) {
    const a = (live && live.attributes) || {};
    switch (domain) {
      case "light": {
        const modes = a.supported_color_modes || [];
        const hasBright = modes.some((m) => m !== "onoff");
        const hasTemp = modes.includes("color_temp");
        const hasRgb = modes.some((m) => COLOR_MODES.includes(m));
        let html = "";
        if (hasBright)
          html += sliderRow("Brightness", "brightness", eid, t.brightness ?? 255, 0, 255, 1, (v) => `${Math.round((v / 255) * 100)}%`);
        if (hasTemp) {
          const min = a.min_color_temp_kelvin ?? 2000;
          const max = a.max_color_temp_kelvin ?? 6500;
          html += sliderRow("Color temp", "ctemp", eid, t.color_temp_kelvin ?? min, min, max, 50, (v) => `${v}K`);
        }
        if (hasRgb) html += colorRow("Color", "rgb", eid, t.rgb_color);
        return html;
      }
      case "fan": {
        let html = "";
        const presets = Array.isArray(a.preset_modes) ? a.preset_modes : [];
        if (presets.length)
          html += presets.length <= 4
            ? segmented("fan-preset", eid, t.preset_mode, presets)
            : selectRow("Preset", "fan-preset", eid, t.preset_mode, presets);
        // Only show a percentage slider if the fan actually supports speed.
        const hasPct =
          t.percentage != null || a.percentage != null || (a.supported_features & 1);
        if (hasPct)
          html += sliderRow("Speed", "fan-pct", eid, t.percentage ?? 100, 0, 100, 1, (v) => `${v}%`);
        return html;
      }
      case "humidifier": {
        const min = a.min_humidity ?? 0;
        const max = a.max_humidity ?? 100;
        return sliderRow("Target humidity", "humidity", eid, t.humidity ?? min, min, max, 1, (v) => `${v}%`);
      }
      case "cover":
        return sliderRow("Position", "cover-pos", eid, t.current_position ?? 0, 0, 100, 1, (v) => `${v}% open`);
      case "climate": {
        const modes = a.hvac_modes || ["off", "heat", "cool", "auto", "heat_cool"];
        const min = a.min_temp ?? 7;
        const max = a.max_temp ?? 35;
        const step = a.target_temp_step ?? 0.5;
        const deg = (v) => `${v}°`;
        let html = segmented("set-state", eid, t.state, modes);
        // Store whatever setpoints the sliders display, so the scene saves
        // what you see even if you never drag them (e.g. right after switching
        // into or out of heat_cool).
        if (climateUsesRange(t, a)) {
          t.target_temp_low ??= a.target_temp_low ?? clamp((t.temperature ?? min) - 2, min, max);
          t.target_temp_high ??= a.target_temp_high ?? clamp((t.temperature ?? max) + 2, min, max);
          html +=
            sliderRow("Low", "temp-low", eid, t.target_temp_low, min, max, step, deg) +
            sliderRow("High", "temp-high", eid, t.target_temp_high, min, max, step, deg);
        } else if ((a.supported_features || 0) & CLIMATE_TARGET_TEMP || t.temperature != null) {
          t.temperature ??=
            a.temperature ??
            (t.target_temp_low != null && t.target_temp_high != null
              ? Math.round((t.target_temp_low + t.target_temp_high) / 2)
              : min);
          html += sliderRow("Temperature", "temperature", eid, t.temperature, min, max, step, deg);
        }
        // "none" is how many devices report "no preset"; it isn't settable.
        const presets = (a.preset_modes || []).filter((p) => String(p).toLowerCase() !== "none");
        if (presets.length) html += selectRow("Preset", "set-attr:preset_mode", eid, t.preset_mode, presets, true);
        if (a.fan_modes?.length) html += selectRow("Fan mode", "set-attr:fan_mode", eid, t.fan_mode, a.fan_modes, true);
        if (a.swing_modes?.length) html += selectRow("Swing", "set-attr:swing_mode", eid, t.swing_mode, a.swing_modes, true);
        return html;
      }
      case "media_player": {
        let html =
          segmented("set-state", eid, t.state, ["on", "off", "playing", "paused", "idle"]) +
          sliderRow("Volume", "mp-volume", eid, Math.round((t.volume_level ?? 0) * 100), 0, 100, 1, (v) => `${v}%`);
        if (a.source_list?.length) html += selectRow("Source", "set-attr:source", eid, t.source, a.source_list, true);
        return html;
      }
      case "water_heater": {
        const opts = a.operation_list || [t.state];
        const min = a.min_temp ?? 30;
        const max = a.max_temp ?? 80;
        const step = a.target_temp_step ?? 1;
        return (
          selectRow("Mode", "set-state", eid, t.state, opts) +
          sliderRow("Temperature", "temperature", eid, t.temperature ?? min, min, max, step, (v) => `${v}°`)
        );
      }
      case "number":
      case "input_number": {
        const min = a.min ?? 0;
        const max = a.max ?? 100;
        const step = a.step ?? 1;
        return sliderRow("Value", "number-value", eid, num(t.state, min), min, max, step, (v) => `${v}`);
      }
      case "select":
      case "input_select":
        return selectRow("Option", "set-state", eid, t.state, a.options || [t.state]);
      case "switch":
      case "input_boolean":
      case "siren":
      case "remote":
      case "lock":
        return ""; // switch in the head is the whole control
      default:
        return `<label class="ctl"><span>State</span><input type="text" data-ctrl="set-state" data-eid="${escapeAttr(
          eid
        )}" value="${escapeAttr(t.state)}" /></label>`;
    }
  }

  // ---- events -----------------------------------------------------------

  _wireEvents() {
    const root = this.shadowRoot;

    root.getElementById("search")?.addEventListener("input", (e) =>
      this._applyFilter(e.target.value)
    );
    root.getElementById("scene-name")?.addEventListener("input", (e) => {
      this._sceneName = e.target.value;
    });
    root.getElementById("scene-picker")?.addEventListener("change", (e) => {
      const v = e.target.value;
      if (v) this._openScene(v);
      else this._newScene();
    });
    // HA opens the sidebar when a panel fires hass-toggle-menu. Custom panels
    // have no header of their own on phones, so this is the only way back.
    root.getElementById("menu")?.addEventListener("click", () =>
      this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }))
    );
    // Delegated: the footer is re-rendered whenever selection changes.
    root.getElementById("foot")?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn || btn.disabled) return;
      const actions = {
        save: () => this._save(),
        preview: () => this._preview(),
        revert: () => this._revert(),
        duplicate: () => this._duplicate(),
        delete: () => this._deleteScene(),
      };
      actions[btn.dataset.action]?.();
    });

    const rooms = root.getElementById("rooms");
    rooms?.addEventListener("click", (e) => {
      const btn = e.target.closest(".addall");
      if (btn) {
        e.preventDefault();
        this._toggleArea(btn.dataset.area);
      }
    });
    rooms?.addEventListener("change", (e) => {
      const cb = e.target.closest(".ent-cb");
      if (cb) this._toggleEntity(cb.dataset.eid, cb.checked);
    });

    const sel = root.getElementById("selected-list");
    sel?.addEventListener("click", (e) => {
      const rm = e.target.closest(".remove");
      if (rm) return this._toggleEntity(rm.dataset.eid, false);
      const seg = e.target.closest(".seg");
      if (seg) return this._onSegment(seg);
    });
    // Delegated so it survives list re-renders.
    const onEdit = (e) => {
      const el = e.target.closest("[data-ctrl]");
      if (el && el.tagName !== "BUTTON") this._onEditorInput(el);
    };
    sel?.addEventListener("input", onEdit);
    sel?.addEventListener("change", onEdit);
  }

  _applyFilter(query) {
    const q = query.trim().toLowerCase();
    for (const areaEl of this.shadowRoot.querySelectorAll(".area")) {
      let visible = 0;
      for (const ent of areaEl.querySelectorAll(".entity")) {
        const match = !q || ent.dataset.name.includes(q) || ent.dataset.eid.includes(q);
        ent.style.display = match ? "" : "none";
        if (match) visible++;
      }
      areaEl.style.display = visible ? "" : "none";
    }
  }

  _onSegment(btn) {
    const eid = btn.dataset.eid;
    const t = this._targets.get(eid);
    if (!t) return;
    if (btn.dataset.ctrl === "fan-preset") {
      // Tapping the active preset again clears it, so the scene leaves the
      // fan's preset alone.
      if (btn.classList.contains("active")) {
        delete t.preset_mode;
        btn.classList.remove("active");
        return;
      }
      t.preset_mode = btn.dataset.val;
      t.state = "on";
    } else {
      t.state = btn.dataset.val;
      // A climate mode change can swap the single setpoint for a low/high
      // range, so redraw the card's controls.
      if (eid.startsWith("climate.")) return this._rerenderCard(eid);
    }
    // Highlight the active segment among its siblings.
    for (const sib of btn.parentElement.querySelectorAll(".seg"))
      sib.classList.toggle("active", sib === btn);
  }

  _rerenderCard(eid) {
    const card = this.shadowRoot.querySelector(`.card[data-eid="${cssEscape(eid)}"]`);
    if (card) card.outerHTML = this._renderCard(eid);
  }

  _onEditorInput(el) {
    const eid = el.dataset.eid;
    const t = this._targets.get(eid);
    if (!t) return;
    const ctrl = el.dataset.ctrl;

    // Dropdowns that set a single attribute ("set-attr:<name>"). An empty
    // value is "Don't set" and removes the attribute from the scene.
    if (ctrl.startsWith("set-attr:")) {
      const key = ctrl.slice("set-attr:".length);
      if (el.value === "") delete t[key];
      else t[key] = el.value;
      return;
    }

    switch (ctrl) {
      case "state-onoff":
        t.state = el.checked ? "on" : "off";
        this._setCardOff(eid, !el.checked);
        break;
      case "state-lock":
        t.state = el.checked ? "locked" : "unlocked";
        break;
      case "brightness":
        t.state = "on";
        t.brightness = parseInt(el.value, 10);
        break;
      case "ctemp":
        t.state = "on";
        t.color_temp_kelvin = parseInt(el.value, 10);
        t.color_mode = "color_temp";
        break;
      case "rgb":
        t.state = "on";
        t.rgb_color = hexToRgb(el.value);
        t.color_mode = "rgb";
        break;
      case "fan-pct":
        t.percentage = parseInt(el.value, 10);
        break;
      case "fan-preset":
        t.preset_mode = el.value;
        t.state = "on";
        break;
      case "humidity":
        t.humidity = parseInt(el.value, 10);
        break;
      case "cover-pos":
        t.current_position = parseInt(el.value, 10);
        break;
      case "temperature":
        t.temperature = parseFloat(el.value);
        break;
      case "temp-low":
      case "temp-high": {
        // Keep low <= high by pushing the other slider along.
        const v = parseFloat(el.value);
        const lowKey = ctrl === "temp-low";
        t[lowKey ? "target_temp_low" : "target_temp_high"] = v;
        const otherCtrl = lowKey ? "temp-high" : "temp-low";
        const other = el
          .closest(".card")
          ?.querySelector(`[data-ctrl="${otherCtrl}"]`);
        if (other && (lowKey ? v > Number(other.value) : v < Number(other.value))) {
          other.value = String(v);
          t[lowKey ? "target_temp_high" : "target_temp_low"] = v;
          const otherVal = other.parentElement?.querySelector(".val");
          if (otherVal) otherVal.textContent = formatCtrlValue(otherCtrl, v);
        }
        break;
      }
      case "mp-volume":
        t.volume_level = parseInt(el.value, 10) / 100;
        break;
      case "number-value":
        t.state = parseFloat(el.value);
        break;
      case "set-state":
        t.state = el.value;
        break;
    }

    // Update the slider's own value label without a re-render (CSP-safe).
    const valEl = el.parentElement?.querySelector(".val");
    if (valEl) valEl.textContent = formatCtrlValue(ctrl, el.value);
  }

  _setCardOff(eid, off) {
    const card = this.shadowRoot.querySelector(`.card[data-eid="${cssEscape(eid)}"]`);
    if (card) card.classList.toggle("is-off", off);
  }

  /** Update selection-dependent DOM without wiping search box / scroll. */
  _refreshDynamic() {
    const root = this.shadowRoot;
    for (const cb of root.querySelectorAll(".ent-cb"))
      cb.checked = this._targets.has(cb.dataset.eid);
    for (const areaEl of root.querySelectorAll(".area")) {
      const list = this._entitiesByArea.get(areaEl.dataset.area) || [];
      const sel = list.filter((e) => this._targets.has(e.entity_id)).length;
      areaEl.querySelector(".area-meta").textContent = `${sel}/${list.length}`;
      areaEl.querySelector(".addall").textContent =
        sel === list.length && list.length ? "Remove all" : "Add all";
    }
    root.getElementById("selcount").textContent = String(this._targets.size);
    root.getElementById("selected-list").innerHTML = this._renderSelectedList();
    root.getElementById("foot").innerHTML = this._renderFoot();
  }
}

// ---- control builders ----------------------------------------------------

function switchControl(ctrl, eid, checked) {
  return `
    <label class="switch">
      <input type="checkbox" data-ctrl="${ctrl}" data-eid="${escapeAttr(eid)}" ${
    checked ? "checked" : ""
  } />
      <span class="track"></span>
      <span class="knob"></span>
    </label>`;
}

function segmented(ctrl, eid, value, options) {
  return `
    <div class="segmented">
      ${options
        .map(
          (o) =>
            `<button class="seg${String(o) === String(value) ? " active" : ""}" data-ctrl="${ctrl}" data-eid="${escapeAttr(
              eid
            )}" data-val="${escapeAttr(o)}">${escapeHtml(o)}</button>`
        )
        .join("")}
    </div>`;
}

function sliderRow(label, ctrl, eid, value, min, max, step, fmt) {
  const v = clamp(Number(value), min, max);
  return `
    <label class="ctl">
      <span>${label} <em class="val">${escapeHtml(fmt ? fmt(v) : String(v))}</em></span>
      <input type="range" data-ctrl="${ctrl}" data-eid="${escapeAttr(eid)}"
        min="${min}" max="${max}" step="${step}" value="${v}" />
    </label>`;
}

// allowUnset adds a "Don't set" option (value ""), so the scene can leave that
// attribute alone.
function selectRow(label, ctrl, eid, value, options, allowUnset = false) {
  const unset = value == null || value === "";
  return `
    <label class="ctl">
      <span>${label}</span>
      <select data-ctrl="${ctrl}" data-eid="${escapeAttr(eid)}">
        ${allowUnset ? `<option value="" ${unset ? "selected" : ""}>Don't set</option>` : ""}
        ${options
          .map(
            (o) =>
              `<option value="${escapeAttr(o)}" ${
                String(o) === String(value) ? "selected" : ""
              }>${escapeHtml(o)}</option>`
          )
          .join("")}
      </select>
    </label>`;
}

function colorRow(label, ctrl, eid, rgb) {
  const hex = Array.isArray(rgb) ? rgbToHex(rgb) : "#ffffff";
  return `
    <label class="ctl toggle">
      <span>${label}</span>
      <input type="color" data-ctrl="${ctrl}" data-eid="${escapeAttr(eid)}" value="${hex}" />
    </label>`;
}

// Format a slider's displayed value by control type. Evaluated in the (CSP-safe)
// input handler; kept in sync with the fmt callbacks passed to sliderRow.
function formatCtrlValue(ctrl, raw) {
  const v = Number(raw);
  switch (ctrl) {
    case "brightness":
      return `${Math.round((v / 255) * 100)}%`;
    case "ctemp":
      return `${v}K`;
    case "fan-pct":
    case "humidity":
    case "mp-volume":
      return `${v}%`;
    case "cover-pos":
      return `${v}% open`;
    case "temperature":
    case "temp-low":
    case "temp-high":
      return `${v}°`;
    default:
      return `${v}`;
  }
}

// ---- helpers -------------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
}
function rgbToHex(rgb) {
  return "#" + rgb.map((c) => clamp(c, 0, 255).toString(16).padStart(2, "0")).join("");
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

const STYLES = `
  :host {
    display: block; height: 100%; overflow-y: auto;
    background: var(--primary-background-color, #f4f5f7);
    color: var(--primary-text-color, #212121);
    font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
  }
  .wrap { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
  header { padding: 16px 20px 8px; display: flex; align-items: center; gap: 8px; }
  .menu { display: none; border: none; background: transparent; color: inherit; cursor: pointer;
    padding: 8px; margin-left: -8px; border-radius: 50%; }
  .menu:hover { background: var(--secondary-background-color, rgba(0,0,0,.06)); }
  :host([narrow]) .menu { display: inline-flex; }
  header h1 { margin: 0; font-size: 22px; font-weight: 500; }
  header p { margin: 4px 0 0; color: var(--secondary-text-color, #727272); font-size: 14px; }
  .cols { display: grid; grid-template-columns: minmax(280px, 2fr) 3fr; gap: 16px; padding: 12px 20px 20px; flex: 1; min-height: 0; }
  .pane { display: flex; flex-direction: column; min-height: 0;
    background: var(--card-background-color, #fff); border-radius: 12px;
    box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.08)); overflow: hidden; }
  .pane-head { padding: 12px; border-bottom: 1px solid var(--divider-color, #e0e0e0); display: flex; flex-direction: column; gap: 8px; }
  .pane-head input, .pane-head select {
    width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 15px;
    border: 1px solid var(--divider-color, #e0e0e0); border-radius: 8px;
    background: var(--primary-background-color, #f4f5f7); color: inherit; }
  .pane-head input:focus, .pane-head select:focus { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: -1px; }
  .list { overflow-y: auto; flex: 1; padding: 4px 0; }
  .list.cards { padding: 10px; display: flex; flex-direction: column; gap: 10px; }

  .area { border-bottom: 1px solid var(--divider-color, #eee); }
  .area-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px;
    position: sticky; top: 0; background: var(--card-background-color, #fff); z-index: 1; }
  .area-name { font-weight: 500; flex: 1; }
  .area-meta { font-size: 12px; color: var(--secondary-text-color, #727272); font-variant-numeric: tabular-nums; }
  .addall { font-size: 12px; padding: 4px 10px; border-radius: 14px; cursor: pointer;
    border: 1px solid var(--primary-color, #03a9f4); background: transparent; color: var(--primary-color, #03a9f4); }
  .addall:hover { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .entities { padding: 0 6px 8px; }
  .entity { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 10px;
    padding: 7px 10px; border-radius: 8px; cursor: pointer; }
  .entity:hover { background: var(--secondary-background-color, #f0f0f0); }
  .row-icon { --mdc-icon-size: 20px; width: 20px; height: 20px; color: var(--state-icon-color, var(--secondary-text-color, #888)); }
  .ent-name { font-size: 14px; }
  .ent-id { font-size: 11px; color: var(--secondary-text-color, #999); font-family: monospace; }
  .warn { color: var(--error-color, #db4437); font-family: inherit; font-size: 11px; }
  .selcount { padding: 10px 14px 0; font-size: 13px; color: var(--secondary-text-color, #727272); }

  /* Control cards */
  /* Cards flow into as many columns as fit; the room heading spans them all. */
  .card-group { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px; align-items: start; }
  .group-head { grid-column: 1 / -1; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
    color: var(--secondary-text-color, #888); padding: 6px 2px 0; }
  .card { border-radius: 12px; background: var(--ha-card-background, var(--card-background-color, #fff));
    border: 1px solid var(--divider-color, #e6e6e6); padding: 12px 14px; transition: opacity .15s; }
  .card.is-off .card-body { opacity: .4; }
  .card-head { display: flex; align-items: center; gap: 12px; }
  .card-icon { --mdc-icon-size: 24px; width: 24px; height: 24px; flex: 0 0 auto;
    color: var(--state-icon-color, var(--primary-color, #03a9f4)); }
  .card.is-off .card-icon { color: var(--state-icon-color, var(--secondary-text-color, #888)); }
  .card-info { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .card-info .ent-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-body { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
  .remove { border: none; background: transparent; cursor: pointer; font-size: 20px; line-height: 1;
    color: var(--secondary-text-color, #999); padding: 2px 6px; border-radius: 6px; }
  .remove:hover { background: var(--error-color, #db4437); color: #fff; }

  /* HA-style switch */
  .switch { position: relative; width: 42px; height: 24px; flex: 0 0 auto; cursor: pointer; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; z-index: 2; }
  .switch .track { position: absolute; inset: 0; border-radius: 12px;
    background: var(--switch-unchecked-track-color, rgba(0,0,0,.25)); transition: background .2s; }
  .switch .knob { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--switch-unchecked-button-color, #fafafa); box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .2s; }
  .switch input:checked ~ .track { background: var(--primary-color, #03a9f4); }
  .switch input:checked ~ .knob { transform: translateX(18px); }

  /* Segmented mode buttons */
  .segmented { display: flex; flex-wrap: wrap; gap: 6px; }
  .seg { flex: 1 1 auto; min-width: 56px; padding: 8px 10px; font-size: 13px; text-transform: capitalize;
    border: 1px solid var(--divider-color, #e0e0e0); border-radius: 8px; cursor: pointer;
    background: var(--primary-background-color, #f4f5f7); color: inherit; }
  .seg.active { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); border-color: var(--primary-color, #03a9f4); }

  /* Sliders / selects */
  .ctl { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
  .ctl.toggle { flex-direction: row; align-items: center; justify-content: space-between; }
  .ctl > span { color: var(--secondary-text-color, #727272); }
  .ctl .val { color: var(--primary-color, #03a9f4); font-style: normal; font-variant-numeric: tabular-nums; float: right; }
  .ctl input[type=range] { width: 100%; height: 24px; accent-color: var(--primary-color, #03a9f4); }
  .ctl input[type=color] { width: 48px; height: 32px; padding: 0; border: 1px solid var(--divider-color,#ccc); border-radius: 6px; background: none; cursor: pointer; }
  .ctl select, .ctl input[type=text] { padding: 8px; border-radius: 8px;
    border: 1px solid var(--divider-color, #e0e0e0); background: var(--primary-background-color, #f4f5f7); color: inherit; }

  .empty { padding: 24px 14px; text-align: center; color: var(--secondary-text-color, #999); font-size: 14px; }
  .foot { padding: 12px 14px; border-top: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff); }
  .btnrow { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .foot button { padding: 10px 12px; font-size: 14px; font-weight: 500; border-radius: 8px; cursor: pointer; }
  .foot button:disabled { opacity: .5; cursor: not-allowed; }
  .foot button.primary { width: 100%; padding: 12px; font-size: 15px; border: none;
    background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .foot button.secondary { flex: 1 1 0; min-width: 80px; background: transparent;
    border: 1px solid var(--primary-color, #03a9f4); color: var(--primary-color, #03a9f4); }
  .foot button.secondary:hover:not(:disabled) { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .foot button.secondary.danger { border-color: var(--error-color, #db4437); color: var(--error-color, #db4437); }
  .foot button.secondary.danger:hover { background: var(--error-color, #db4437); color: #fff; }
  .status { padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 10px; }
  .status.ok { background: rgba(67,160,71,.15); color: var(--success-color, #43a047); }
  .status.error { background: rgba(219,68,55,.15); color: var(--error-color, #db4437); }

  /* Phones: one page that scrolls as a whole, with the actions pinned to the
     bottom. Panes stop being their own scroll containers so the sticky footer
     sticks to the page. */
  @media (max-width: 780px) {
    .wrap { height: auto; min-height: 100%; }
    header { padding: 12px 12px 4px; }
    header h1 { font-size: 20px; }
    .cols { display: flex; flex-direction: column; gap: 12px; padding: 8px 12px 0; }
    .pane { overflow: visible; }
    .rooms .list { max-height: 45vh; }
    .list.cards { overflow: visible; padding: 8px; }
    .card-group { grid-template-columns: 1fr; }
    .foot { position: sticky; bottom: 0; z-index: 2; border-radius: 0 0 12px 12px;
      box-shadow: 0 -4px 12px rgba(0,0,0,.15); padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
  }
`;

customElements.define("scene-builder-panel", SceneBuilderPanel);
