/**
 * Scene Builder panel.
 *
 * A room-first scene editor for Home Assistant, laid out like scenes in the
 * Apple Home app:
 *
 *  - Scenes: a grid of your scenes plus "New scene".
 *  - Customize: the scene's accessories as tiles grouped by room, each showing
 *    its target state. Tapping a tile's icon toggles it; tapping the tile opens
 *    a control sheet (brightness, color, temperature, modes, ...). Preview
 *    applies the scene without saving; Revert undoes the preview.
 *  - Accessories: every accessory as a tile grouped by room. Tap to check it
 *    off, or select a whole room, then Done.
 *
 * Adding an accessory seeds its target from its current live state. Scenes are
 * read and written through the same REST endpoints the built-in editor uses,
 * so they live in scenes.yaml.
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

// ---- summaries -------------------------------------------------------------

const cap = (s) => {
  const str = String(s ?? "").replace(/_/g, " ");
  return str.charAt(0).toUpperCase() + str.slice(1);
};

/** One-line description of a target (or live) state, shown on a tile. */
function stateSummary(eid, t) {
  const domain = eid.split(".")[0];
  const pct = (v, max = 1) => `${Math.round((v / max) * 100)}%`;
  if (t.state === "unavailable" || t.state === "unknown") return cap(t.state);
  switch (domain) {
    case "light":
      if (t.state !== "on") return "Off";
      return t.brightness != null ? pct(t.brightness, 255) : "On";
    case "fan":
      if (t.state !== "on") return "Off";
      if (t.preset_mode) return cap(t.preset_mode);
      return t.percentage != null ? `${t.percentage}%` : "On";
    case "humidifier":
      if (t.state !== "on") return "Off";
      return t.humidity != null ? `On, ${t.humidity}%` : "On";
    case "lock":
      return cap(t.state);
    case "cover":
      if (t.current_position != null)
        return t.current_position === 0 ? "Closed" : `${t.current_position}% open`;
      return cap(t.state);
    case "climate": {
      if (t.state === "off") return "Off";
      const mode = cap(t.state === "heat_cool" ? "heat/cool" : t.state);
      if (t.target_temp_low != null && t.target_temp_high != null && t.temperature == null)
        return `${mode}, ${t.target_temp_low}-${t.target_temp_high}°`;
      if (t.state === "heat_cool" && t.target_temp_low != null && t.target_temp_high != null)
        return `${mode}, ${t.target_temp_low}-${t.target_temp_high}°`;
      return t.temperature != null ? `${mode}, ${t.temperature}°` : mode;
    }
    case "media_player":
      if (t.state === "off") return "Off";
      return t.volume_level != null ? `${cap(t.state)}, ${pct(t.volume_level)}` : cap(t.state);
    case "water_heater":
      return t.temperature != null ? `${cap(t.state)}, ${t.temperature}°` : cap(t.state);
    case "switch":
    case "input_boolean":
    case "siren":
    case "remote":
      return t.state === "on" ? "On" : "Off";
    default:
      return String(t.state);
  }
}

/** Whether a tile should render as "on" (bright), like Apple Home. */
function isActive(eid, t) {
  const domain = eid.split(".")[0];
  if (["select", "input_select", "number", "input_number"].includes(domain)) return true;
  return !["off", "closed", "locked", "idle", "paused", "standby", "unavailable", "unknown"].includes(
    String(t.state)
  );
}

/**
 * When a dimmable light is turned on in the editor, give it a brightness so
 * the scene sets one (and the tile can show it). Uses the light's current
 * level if it's on, otherwise 100%, which is what the slider shows.
 */
function seedLightBrightness(eid, t, live) {
  if (!eid.startsWith("light.") || t.state !== "on" || t.brightness != null || !live) return;
  const modes = live.attributes.supported_color_modes || [];
  if (!modes.some((m) => m !== "onoff")) return;
  t.brightness = live.state === "on" && live.attributes.brightness != null ? live.attributes.brightness : 255;
}

/** Accent color for an active tile's icon. */
function tileColor(eid, t) {
  const domain = eid.split(".")[0];
  if (domain === "climate") {
    if (t.state === "heat") return "#ff9500";
    if (t.state === "cool") return "#0a84ff";
    return "#34c759";
  }
  return (
    {
      light: "#ffb300",
      fan: "#34c759",
      cover: "#5e5ce6",
      media_player: "#ff375f",
      lock: "#30b0c7",
      humidifier: "#64d2ff",
      water_heater: "#ff9500",
    }[domain] || "var(--primary-color, #03a9f4)"
  );
}

/**
 * Drop the room name from an accessory name when it's shown under that room,
 * the way Apple Home does: "Master Bedroom Fan" under Master Bedroom -> "Fan".
 */
function shortName(name, areaName) {
  if (!areaName) return name;
  const prefix = areaName.toLowerCase() + " ";
  if (name.toLowerCase().startsWith(prefix) && name.length > prefix.length) {
    const rest = name.slice(prefix.length);
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return name;
}

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>';
const ICON_BACK =
  '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12l4.6-4.6Z"/></svg>';
const ICON_MENU =
  '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 6h18v2H3V6m0 5h18v2H3v-2m0 5h18v2H3v-2Z"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z"/></svg>';
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4Z"/></svg>';

const VIEW_SCENES = "scenes";
const VIEW_EDIT = "customize";
const VIEW_PICK = "accessories";

// ---- component -------------------------------------------------------------

class SceneBuilderPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._loaded = false;
    this._areas = [];
    this._entitiesByArea = new Map(); // areaId -> [{entity_id, name}]
    this._entityArea = new Map(); // entity_id -> areaId
    this._entityName = new Map(); // entity_id -> registry/friendly name
    this._areaName = new Map();
    this._targets = new Map(); // entity_id -> target state {state, ...attrs}
    this._scenes = []; // [{id, name, count}] of editable scenes
    this._yamlOnlyScenes = 0; // scene.* entities with no config id
    this._sceneSig = ""; // detects scene changes made elsewhere
    // HA takes a moment to reload scenes after a save or delete. Until its
    // states catch up, these keep the scene list showing what we just did.
    this._pendingScenes = new Map(); // id -> {id, name, count}
    this._deletedIds = new Set();
    this._currentSceneId = null; // set when editing an existing scene
    this._sceneName = "";
    this._dirty = false; // unsaved changes in the Customize view
    this._status = null; // {type, text}
    this._view = VIEW_SCENES;
    this._pick = null; // Set of entity_ids while the Accessories view is open
    this._query = ""; // Accessories view filter
    this._sheetEid = null; // entity whose control sheet is open
    this._lastClimateMode = new Map(); // for the climate tile's quick toggle
    // entity_id -> state captured just before that entity was first previewed.
    // Null when nothing is previewed. Kept across scenes, since it describes
    // the devices, not the scene; cleared by Revert.
    this._previewSnapshot = null;

    this.shadowRoot.innerHTML = `<style>${STYLES}</style><div id="app"></div><div id="sheet"></div>`;
    const root = this.shadowRoot;
    root.addEventListener("click", (e) => this._onClick(e));
    root.addEventListener("input", (e) => this._onInput(e));
    root.addEventListener("change", (e) => this._onInput(e));
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._sheetEid) this._closeSheet();
    });
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this.toggleAttribute("dark", !!(hass.themes && hass.themes.darkMode));
    if (first && !this._loaded) {
      this._loadRegistries();
      return;
    }
    // Keep the scene list current when scenes change elsewhere (or after a
    // save, once HA reports the new scene). Only re-render if it changed.
    if (this._loaded && this._view === VIEW_SCENES) {
      const before = this._sceneSig;
      this._refreshSceneList();
      if (this._sceneSig !== before) this._render();
    }
  }
  get hass() {
    return this._hass;
  }

  // HA sets `narrow` on panels when the sidebar is collapsed (phones, small
  // windows). It shows the menu button, the only way to open the sidebar.
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
      // the registry - they exist only in states.
      const ids = new Set();
      for (const e of entities)
        if (SCENE_DOMAINS.has(e.entity_id.split(".")[0])) ids.add(e.entity_id);
      for (const id in this._hass.states)
        if (SCENE_DOMAINS.has(id.split(".")[0])) ids.add(id);

      const byArea = new Map();
      for (const eid of ids) {
        const e = regById.get(eid);
        const st = this._hass.states[eid];
        const areaId = (e && (e.area_id || deviceArea.get(e.device_id))) || UNASSIGNED;
        const name =
          (e && (e.name || e.original_name)) || (st && st.attributes.friendly_name) || eid;
        // Remember area and name for every entity, so scene members that are
        // hidden from the picker still show up properly in Customize.
        this._entityArea.set(eid, areaId);
        this._entityName.set(eid, name);
        // Disabled (no usable state) and hidden (visible=false) entities stay
        // out of the picker. YAML helpers can't be hidden, so they always pass.
        if (e && (e.disabled_by || e.hidden_by)) continue;
        if (!byArea.has(areaId)) byArea.set(areaId, []);
        byArea.get(areaId).push({ entity_id: eid, name });
      }
      for (const list of byArea.values()) list.sort((x, y) => x.name.localeCompare(y.name));

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
    let yamlOnly = 0;
    for (const id in this._hass.states) {
      if (!id.startsWith("scene.")) continue;
      const s = this._hass.states[id];
      // Only scenes created through the config store have an id and can be
      // edited via the REST endpoint.
      if (s.attributes && s.attributes.id != null) {
        scenes.push({
          id: String(s.attributes.id),
          name: s.attributes.friendly_name || id,
          count: (s.attributes.entity_id || []).length,
        });
      } else {
        yamlOnly++;
      }
    }
    for (const [id, pending] of this._pendingScenes) {
      const known = scenes.find((s) => s.id === id);
      // HA has caught up once the scene shows the saved name.
      if (known && known.name === pending.name) this._pendingScenes.delete(id);
      else if (known) Object.assign(known, pending);
      else scenes.push(pending);
    }
    for (const id of this._deletedIds) {
      if (!scenes.some((s) => s.id === id)) this._deletedIds.delete(id);
    }
    this._scenes = scenes.filter((s) => !this._deletedIds.has(s.id));
    this._scenes.sort((a, b) => a.name.localeCompare(b.name));
    this._yamlOnlyScenes = yamlOnly;
    this._sceneSig = JSON.stringify(scenes);
  }

  _nameFor(eid) {
    const st = this._hass.states[eid];
    return this._entityName.get(eid) || (st && st.attributes.friendly_name) || eid;
  }

  // ---- navigation -----------------------------------------------------------

  async _openScene(sceneId) {
    try {
      const cfg = await this._hass.callApi("GET", `config/scene/config/${sceneId}`);
      this._currentSceneId = sceneId;
      this._sceneName = cfg.name || "";
      this._targets = new Map();
      for (const [eid, val] of Object.entries(cfg.entities || {})) {
        // scenes.yaml allows a bare state string as shorthand.
        this._targets.set(eid, typeof val === "string" ? { state: val } : { ...val });
      }
      this._dirty = false;
      this._status = null;
      this._view = VIEW_EDIT;
      this._render(true);
    } catch (err) {
      this._status = { type: "error", text: `Couldn't open the scene: ${err.message || err}` };
      this._render();
    }
  }

  /** New scene: start by picking accessories, like Apple Home. */
  _newScene() {
    this._currentSceneId = null;
    this._sceneName = "";
    this._targets = new Map();
    this._dirty = false;
    this._status = null;
    this._enterPicker();
  }

  _leaveEditor() {
    if (this._dirty && !confirm("Discard your unsaved changes to this scene?")) return;
    this._currentSceneId = null;
    this._sceneName = "";
    this._targets = new Map();
    this._dirty = false;
    this._status = null;
    this._view = VIEW_SCENES;
    this._refreshSceneList();
    this._render(true);
  }

  _enterPicker() {
    this._pick = new Set(this._targets.keys());
    this._query = "";
    this._view = VIEW_PICK;
    this._render(true);
  }

  /** Done: add newly checked accessories, drop unchecked ones. */
  _applyPicker() {
    const pickable = new Set();
    for (const list of this._entitiesByArea.values())
      for (const e of list) pickable.add(e.entity_id);
    for (const eid of this._pick) {
      if (!this._targets.has(eid)) {
        this._addEntity(eid);
        this._dirty = true;
      }
    }
    // Only drop accessories the picker showed; members that are hidden from
    // the picker can't be unchecked, so they stay.
    for (const eid of [...this._targets.keys()]) {
      if (pickable.has(eid) && !this._pick.has(eid)) {
        this._targets.delete(eid);
        this._dirty = true;
      }
    }
    this._pick = null;
    this._view = VIEW_EDIT;
    this._render(true);
  }

  _cancelPicker() {
    this._pick = null;
    // Cancelling the first pick of a brand-new, empty scene goes back home.
    if (!this._currentSceneId && this._targets.size === 0 && !this._sceneName) {
      this._view = VIEW_SCENES;
    } else {
      this._view = VIEW_EDIT;
    }
    this._render(true);
  }

  // ---- scene actions --------------------------------------------------------

  async _deleteScene() {
    if (!this._currentSceneId) return;
    if (!confirm(`Delete the scene "${this._sceneName}"? This can't be undone.`)) return;
    try {
      await this._hass.callApi("DELETE", `config/scene/config/${this._currentSceneId}`);
      const name = this._sceneName;
      this._pendingScenes.delete(this._currentSceneId);
      this._deletedIds.add(this._currentSceneId);
      this._dirty = false;
      this._leaveEditor();
      this._status = { type: "ok", text: `Deleted "${name}".` };
      this._render();
    } catch (err) {
      this._status = { type: "error", text: `Delete failed: ${err.message || err}` };
      this._render();
    }
  }

  async _save() {
    const name = this._sceneName.trim();
    if (!name) {
      this._status = { type: "error", text: "Give the scene a name first." };
      this._render();
      this.shadowRoot.getElementById("scene-name")?.focus();
      return;
    }
    if (this._targets.size === 0) {
      this._status = { type: "error", text: "Add at least one accessory." };
      this._render();
      return;
    }
    const id = this._currentSceneId || String(Date.now());
    const editing = !!this._currentSceneId;
    try {
      await this._hass.callApi("POST", `config/scene/config/${id}`, {
        name,
        entities: this._sceneEntities(),
      });
      this._currentSceneId = id;
      this._pendingScenes.set(id, { id, name, count: this._targets.size });
      this._dirty = false;
      this._status = { type: "ok", text: `${editing ? "Updated" : "Saved"} "${name}".` };
    } catch (err) {
      this._status = { type: "error", text: `Save failed: ${err.message || err}` };
    }
    this._render();
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
      await this._hass.callService("scene", "apply", { entities: this._sceneEntities() });
      this._status = {
        type: "ok",
        text: "Previewing. Your accessories are set to this scene, but nothing is saved.",
      };
    } catch (err) {
      this._status = { type: "error", text: `Preview failed: ${err.message || err}` };
    }
    this._render();
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
      this._status = { type: "ok", text: "Put your accessories back the way they were." };
    } catch (err) {
      this._status = { type: "error", text: `Revert failed: ${err.message || err}` };
    }
    this._render();
  }

  /** Turn the scene being edited into a new, unsaved copy. */
  _duplicate() {
    if (!this._currentSceneId) return;
    const source = this._sceneName;
    this._currentSceneId = null;
    this._sceneName = `${source} (copy)`;
    this._targets = new Map([...this._targets].map(([eid, t]) => [eid, structuredClone(t)]));
    this._dirty = true;
    this._status = { type: "ok", text: `Copied "${source}". Rename it if you like, then save.` };
    this._render(true);
  }

  _addEntity(eid) {
    if (this._targets.has(eid)) return;
    const st = this._hass.states[eid];
    this._targets.set(eid, st ? captureState(st) : { state: "on" });
  }

  /**
   * Tile icon tap: flip the accessory's main on/off-style setting. Returns
   * false when the accessory has no single toggle, so the caller opens its
   * control sheet instead.
   */
  _quickToggle(eid) {
    const t = this._targets.get(eid);
    if (!t) return false;
    const domain = eid.split(".")[0];
    if (domain === "lock") {
      t.state = t.state === "locked" ? "unlocked" : "locked";
    } else if (SWITCH_DOMAINS.has(domain)) {
      t.state = t.state === "on" ? "off" : "on";
      seedLightBrightness(eid, t, this._hass.states[eid]);
    } else if (domain === "cover") {
      const open = t.current_position != null ? t.current_position > 0 : t.state === "open";
      t.current_position = open ? 0 : 100;
      t.state = open ? "closed" : "open";
    } else if (domain === "media_player") {
      t.state = t.state === "off" ? "on" : "off";
    } else if (domain === "climate") {
      if (t.state !== "off") {
        this._lastClimateMode.set(eid, t.state);
        t.state = "off";
      } else {
        const live = this._hass.states[eid];
        const modes = (live && live.attributes.hvac_modes) || [];
        const back =
          this._lastClimateMode.get(eid) || modes.find((m) => m !== "off");
        if (!back) return false;
        t.state = back;
      }
    } else {
      return false;
    }
    this._dirty = true;
    return true;
  }

  // ---- rendering --------------------------------------------------------------

  /** Render the current view. `toTop` scrolls back up after switching views. */
  _render(toTop = false) {
    const app = this.shadowRoot.getElementById("app");
    if (this._view === VIEW_PICK) app.innerHTML = this._renderPicker();
    else if (this._view === VIEW_EDIT) app.innerHTML = this._renderEditor();
    else app.innerHTML = this._renderScenes();
    if (this._view === VIEW_PICK && this._query) this._applyFilter();
    if (toTop) this.scrollTop = 0;
    this._renderSheet();
  }

  _statusHtml() {
    return this._status
      ? `<div class="status ${this._status.type}">${escapeHtml(this._status.text)}</div>`
      : "";
  }

  _renderScenes() {
    const tiles = this._scenes
      .map(
        (s) => `
        <button class="scene-tile" data-action="open-scene" data-scene="${escapeAttr(s.id)}">
          <span class="scene-icon"><ha-icon icon="mdi:palette-swatch"></ha-icon></span>
          <span class="tile-text">
            <span class="tile-name">${escapeHtml(s.name)}</span>
            <span class="tile-state">${s.count} ${s.count === 1 ? "accessory" : "accessories"}</span>
          </span>
        </button>`
      )
      .join("");
    const note = this._yamlOnlyScenes
      ? `<p class="note">${this._yamlOnlyScenes} ${
          this._yamlOnlyScenes === 1 ? "scene was" : "scenes were"
        } written in YAML without an <code>id</code>, so ${
          this._yamlOnlyScenes === 1 ? "it isn't" : "they aren't"
        } listed here.</p>`
      : "";
    return `
      <div class="topbar">
        <button class="icon-btn menu" data-action="menu" aria-label="Open sidebar">${ICON_MENU}</button>
        <div class="topbar-title">Scene Builder</div>
      </div>
      <main class="content">
        <h1 class="page-title">Scenes</h1>
        ${this._statusHtml()}
        <div class="scene-grid">
          <button class="scene-tile new" data-action="new-scene">
            <span class="scene-icon">${ICON_PLUS}</span>
            <span class="tile-text"><span class="tile-name">New scene</span>
            <span class="tile-state">Pick accessories by room</span></span>
          </button>
          ${tiles}
        </div>
        ${note}
      </main>`;
  }

  /** Group entity ids by area, in area sort order. */
  _groupByArea(eids) {
    const groups = new Map();
    for (const eid of eids) {
      const areaId = this._entityArea.get(eid) || UNASSIGNED;
      if (!groups.has(areaId)) groups.set(areaId, []);
      groups.get(areaId).push(eid);
    }
    for (const list of groups.values())
      list.sort((a, b) => this._nameFor(a).localeCompare(this._nameFor(b)));
    return [...groups.keys()].sort((x, y) => this._areaSort(x, y)).map((a) => [a, groups.get(a)]);
  }

  _renderEditor() {
    const editing = !!this._currentSceneId;
    const groups = this._groupByArea([...this._targets.keys()]);
    const sections = groups
      .map(
        ([areaId, eids]) => `
        <section class="room">
          <h2>${escapeHtml(this._areaName.get(areaId) || areaId)}</h2>
          <div class="tile-grid">${eids.map((eid) => this._renderEditTile(eid)).join("")}</div>
        </section>`
      )
      .join("");
    const body = this._targets.size
      ? `${sections}
         <button class="wide-btn" data-action="pick">Add or remove accessories</button>`
      : `<div class="empty">
           <p>This scene doesn't have any accessories yet.</p>
           <button class="wide-btn" data-action="pick">Add accessories</button>
         </div>`;
    const extra = editing
      ? `<div class="danger-zone">
           <button class="text-btn" data-action="duplicate">Duplicate scene</button>
           <button class="text-btn danger" data-action="delete">Delete scene</button>
         </div>`
      : "";
    return `
      <div class="topbar">
        <button class="nav-btn" data-action="back">${ICON_BACK}<span>Scenes</span></button>
        <div class="topbar-title">${editing ? "Edit scene" : "New scene"}</div>
        <span class="topbar-spacer"></span>
      </div>
      <main class="content">
        <input id="scene-name" class="name-input" type="text" placeholder="Scene name"
          value="${escapeAttr(this._sceneName)}" autocomplete="off" />
        <p class="hint">Tap an icon to turn it on or off. Tap a tile for more settings.</p>
        ${body}
        ${extra}
      </main>
      <div class="bottombar">
        ${this._statusHtml()}
        <div class="bar-row">
          <button class="btn secondary" data-action="preview" ${
            this._targets.size ? "" : "disabled"
          }>Preview</button>
          ${this._previewSnapshot ? `<button class="btn secondary" data-action="revert">Revert</button>` : ""}
          <button class="btn primary" data-action="save" ${this._targets.size ? "" : "disabled"}>${
      editing ? "Save changes" : "Save scene"
    }</button>
        </div>
      </div>`;
  }

  _renderEditTile(eid) {
    const t = this._targets.get(eid);
    const st = this._hass.states[eid];
    const areaName = this._areaName.get(this._entityArea.get(eid));
    const name = shortName(this._nameFor(eid), areaName);
    const on = isActive(eid, t);
    const summary = st ? stateSummary(eid, t) : "Unavailable";
    return `
      <div class="tile ${on ? "on" : ""} ${st ? "" : "missing"}" data-action="tile-open"
        data-eid="${escapeAttr(eid)}" role="button" tabindex="0" style="--tile-color:${tileColor(eid, t)}">
        <button class="tile-icon" data-action="tile-toggle" data-eid="${escapeAttr(eid)}"
          aria-label="Turn ${escapeAttr(name)} on or off">
          <ha-icon icon="${escapeAttr(iconFor(eid, st))}"></ha-icon>
        </button>
        <span class="tile-text">
          <span class="tile-name">${escapeHtml(name)}</span>
          <span class="tile-state">${escapeHtml(summary)}</span>
        </span>
      </div>`;
  }

  _updateTile(eid) {
    const tile = this.shadowRoot.querySelector(`#app .tile[data-eid="${cssEscape(eid)}"]`);
    if (tile && this._targets.has(eid)) tile.outerHTML = this._renderEditTile(eid);
  }

  _renderPicker() {
    const sections = this._areas
      .map((areaId) => {
        const list = this._entitiesByArea.get(areaId) || [];
        if (!list.length) return "";
        const areaName = this._areaName.get(areaId) || areaId;
        const all = list.every((e) => this._pick.has(e.entity_id));
        return `
          <section class="room" data-area="${escapeAttr(areaId)}">
            <div class="room-head">
              <h2>${escapeHtml(areaName)}</h2>
              <button class="text-btn" data-action="pick-area" data-area="${escapeAttr(areaId)}">${
          all ? "Deselect all" : "Select all"
        }</button>
            </div>
            <div class="tile-grid">
              ${list.map((e) => this._renderPickTile(e, areaName)).join("")}
            </div>
          </section>`;
      })
      .join("");
    return `
      <div class="topbar">
        <button class="nav-btn" data-action="pick-cancel"><span>Cancel</span></button>
        <div class="topbar-title">
          Accessories
          <span class="topbar-sub" id="pick-count">${this._pick.size} selected</span>
        </div>
        <button class="nav-btn strong" data-action="pick-done"><span>Done</span></button>
      </div>
      <main class="content">
        <input id="search" class="search" type="search" placeholder="Search accessories"
          value="${escapeAttr(this._query)}" autocomplete="off" />
        ${sections}
        <p class="empty hidden" id="no-match">No accessories match your search.</p>
      </main>`;
  }

  _renderPickTile(e, areaName) {
    const eid = e.entity_id;
    const st = this._hass.states[eid];
    const live = st ? { state: st.state, ...st.attributes } : { state: "unavailable" };
    const selected = this._pick.has(eid);
    const name = shortName(e.name, areaName);
    return `
      <button class="tile pick ${isActive(eid, live) ? "on" : ""} ${selected ? "selected" : ""}"
        data-action="pick-toggle" data-eid="${escapeAttr(eid)}"
        data-search="${escapeAttr(`${e.name} ${eid} ${areaName}`.toLowerCase())}"
        aria-pressed="${selected}" style="--tile-color:${tileColor(eid, live)}">
        <span class="tile-icon"><ha-icon icon="${escapeAttr(iconFor(eid, st))}"></ha-icon></span>
        <span class="check">${ICON_CHECK}</span>
        <span class="tile-text">
          <span class="tile-name">${escapeHtml(name)}</span>
          <span class="tile-state">${escapeHtml(stateSummary(eid, live))}</span>
        </span>
      </button>`;
  }

  /** Update picker counts and per-room button labels without re-rendering. */
  _refreshPickChrome() {
    const root = this.shadowRoot;
    root.getElementById("pick-count").textContent = `${this._pick.size} selected`;
    for (const btn of root.querySelectorAll('[data-action="pick-area"]')) {
      const list = this._entitiesByArea.get(btn.dataset.area) || [];
      btn.textContent = list.every((e) => this._pick.has(e.entity_id))
        ? "Deselect all"
        : "Select all";
    }
    for (const tile of root.querySelectorAll(".tile.pick")) {
      const sel = this._pick.has(tile.dataset.eid);
      tile.classList.toggle("selected", sel);
      tile.setAttribute("aria-pressed", String(sel));
    }
  }

  _applyFilter() {
    const q = this._query.trim().toLowerCase();
    let any = false;
    for (const room of this.shadowRoot.querySelectorAll("section.room")) {
      let visible = 0;
      for (const tile of room.querySelectorAll(".tile.pick")) {
        const match = !q || tile.dataset.search.includes(q);
        tile.classList.toggle("hidden", !match);
        if (match) visible++;
      }
      room.classList.toggle("hidden", !visible);
      if (visible) any = true;
    }
    this.shadowRoot.getElementById("no-match")?.classList.toggle("hidden", any);
  }

  // ---- control sheet ------------------------------------------------------------

  _openSheet(eid) {
    this._sheetEid = eid;
    this._renderSheet();
    this.shadowRoot.querySelector(".sheet")?.focus();
  }

  _closeSheet() {
    const eid = this._sheetEid;
    this._sheetEid = null;
    this._renderSheet();
    if (eid) this._updateTile(eid);
  }

  _renderSheet() {
    const host = this.shadowRoot.getElementById("sheet");
    const eid = this._sheetEid;
    if (!eid || !this._targets.has(eid) || this._view !== VIEW_EDIT) {
      this._sheetEid = null;
      host.innerHTML = "";
      return;
    }
    const domain = eid.split(".")[0];
    const t = this._targets.get(eid);
    const st = this._hass.states[eid];
    const areaName = this._areaName.get(this._entityArea.get(eid)) || "";

    let headControl = "";
    if (domain === "lock") headControl = switchControl("state-lock", eid, t.state === "locked");
    else if (SWITCH_DOMAINS.has(domain)) headControl = switchControl("state-onoff", eid, t.state === "on");

    const body = this._renderCardBody(eid, domain, t, st);
    const isOff = SWITCH_DOMAINS.has(domain) && t.state !== "on";
    host.innerHTML = `
      <div class="backdrop" data-action="sheet-backdrop">
        <div class="sheet" role="dialog" aria-modal="true" aria-label="${escapeAttr(
          this._nameFor(eid)
        )}" tabindex="-1">
          <div class="sheet-head">
            <span class="sheet-icon" style="--tile-color:${tileColor(eid, t)}"><ha-icon icon="${escapeAttr(
      iconFor(eid, st)
    )}"></ha-icon></span>
            <div class="sheet-title">
              <div class="sheet-name">${escapeHtml(this._nameFor(eid))}</div>
              <div class="sheet-sub">${escapeHtml(areaName)}${
      st ? "" : ' <span class="warn">Unavailable</span>'
    }</div>
            </div>
            ${headControl}
            <button class="icon-btn" data-action="sheet-close" aria-label="Close">${ICON_CLOSE}</button>
          </div>
          <div class="sheet-body ${isOff ? "is-off" : ""}">${
      body || `<p class="hint">On and off is the only setting for this accessory.</p>`
    }</div>
          <button class="text-btn danger sheet-remove" data-action="sheet-remove" data-eid="${escapeAttr(
            eid
          )}">Remove from scene</button>
        </div>
      </div>`;
  }

  _setCardOff(eid, off) {
    this.shadowRoot.querySelector("#sheet .sheet-body")?.classList.toggle("is-off", off);
  }

  // ---- events ---------------------------------------------------------------------

  _onClick(e) {
    const seg = e.target.closest(".seg");
    if (seg) {
      this._onSegment(seg);
      this._dirty = true;
      this._updateTile(seg.dataset.eid);
      return;
    }
    const a = e.target.closest("[data-action]");
    if (!a || a.disabled) return;
    const { action, eid } = a.dataset;
    switch (action) {
      case "menu":
        // HA opens the sidebar when a panel fires hass-toggle-menu.
        this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
        break;
      case "open-scene":
        this._openScene(a.dataset.scene);
        break;
      case "new-scene":
        this._newScene();
        break;
      case "back":
        this._leaveEditor();
        break;
      case "pick":
        this._enterPicker();
        break;
      case "pick-toggle":
        if (this._pick.has(eid)) this._pick.delete(eid);
        else this._pick.add(eid);
        this._refreshPickChrome();
        break;
      case "pick-area": {
        const list = this._entitiesByArea.get(a.dataset.area) || [];
        const all = list.every((x) => this._pick.has(x.entity_id));
        for (const x of list) {
          if (all) this._pick.delete(x.entity_id);
          else this._pick.add(x.entity_id);
        }
        this._refreshPickChrome();
        break;
      }
      case "pick-done":
        this._applyPicker();
        break;
      case "pick-cancel":
        this._cancelPicker();
        break;
      case "tile-toggle":
        if (this._quickToggle(eid)) this._updateTile(eid);
        else this._openSheet(eid);
        break;
      case "tile-open":
        this._openSheet(eid);
        break;
      case "sheet-close":
        this._closeSheet();
        break;
      case "sheet-backdrop":
        // Only a click on the dimmed area itself, not inside the sheet.
        if (e.target === a) this._closeSheet();
        break;
      case "sheet-remove":
        this._targets.delete(eid);
        this._dirty = true;
        this._sheetEid = null;
        this._render();
        break;
      case "save":
        this._save();
        break;
      case "preview":
        this._preview();
        break;
      case "revert":
        this._revert();
        break;
      case "duplicate":
        this._duplicate();
        break;
      case "delete":
        this._deleteScene();
        break;
    }
  }

  _onInput(e) {
    const target = e.target;
    if (target.id === "search") {
      this._query = target.value;
      this._applyFilter();
      return;
    }
    if (target.id === "scene-name") {
      if (this._sceneName !== target.value) this._dirty = true;
      this._sceneName = target.value;
      return;
    }
    const el = target.closest("[data-ctrl]");
    if (!el || el.tagName === "BUTTON") return;
    this._onEditorInput(el);
    this._dirty = true;
    const edited = this._targets.get(el.dataset.eid);
    if (edited) seedLightBrightness(el.dataset.eid, edited, this._hass.states[el.dataset.eid]);
    this._updateTile(el.dataset.eid);
    // Sliders can turn an accessory on (e.g. brightness on a light that was
    // off), so keep the sheet's own switch in step.
    const t = this._targets.get(el.dataset.eid);
    const sw = this.shadowRoot.querySelector('#sheet [data-ctrl="state-onoff"]');
    if (t && sw && el !== sw) {
      sw.checked = t.state === "on";
      this._setCardOff(el.dataset.eid, t.state !== "on");
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
      // range, and changes the tile color, so redraw the sheet.
      if (eid.startsWith("climate.")) return this._renderSheet();
    }
    // Highlight the active segment among its siblings.
    for (const sib of btn.parentElement.querySelectorAll(".seg"))
      sib.classList.toggle("active", sib === btn);
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
          .closest(".sheet")
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
    display: block; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch;
    background: var(--primary-background-color, #f4f5f7);
    color: var(--primary-text-color, #212121);
    font-family: var(--paper-font-body1_-_font-family, -apple-system, BlinkMacSystemFont, Roboto, sans-serif);
    /* Apple Home-style tiles: translucent when off, bright when on. */
    --sb-tile-off: rgba(0, 0, 0, .05);
    --sb-tile-on: #ffffff;
    --sb-tile-on-text: #1c1c1e;
    --sb-tile-on-sub: rgba(28, 28, 30, .6);
    --sb-tile-shadow: 0 1px 3px rgba(0, 0, 0, .12);
    --sb-radius: 16px;
  }
  :host([dark]) {
    --sb-tile-off: rgba(255, 255, 255, .08);
    --sb-tile-on: rgba(255, 255, 255, .92);
    --sb-tile-shadow: none;
  }
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; }
  .hidden { display: none !important; }

  /* Top bar */
  .topbar {
    position: sticky; top: 0; z-index: 5;
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
    min-height: 56px; padding: 0 8px;
    background: color-mix(in srgb, var(--primary-background-color, #f4f5f7) 85%, transparent);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.08));
  }
  .topbar > :first-child { justify-self: start; }
  .topbar > :last-child { justify-self: end; }
  .topbar-title { font-size: 17px; font-weight: 600; text-align: center; display: flex; flex-direction: column; align-items: center; }
  .topbar-sub { font-size: 12px; font-weight: 400; color: var(--secondary-text-color, #727272); }
  .nav-btn { display: inline-flex; align-items: center; gap: 2px; border: none; background: none; cursor: pointer;
    color: var(--primary-color, #03a9f4); font-size: 16px; padding: 8px; border-radius: 8px; }
  .nav-btn.strong { font-weight: 600; }
  .nav-btn:hover { background: var(--secondary-background-color, rgba(0,0,0,.05)); }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; border: none; background: none;
    cursor: pointer; padding: 8px; border-radius: 50%; color: var(--secondary-text-color, #727272); }
  .icon-btn:hover { background: var(--secondary-background-color, rgba(0,0,0,.06)); }
  .menu { visibility: hidden; color: inherit; }
  :host([narrow]) .menu { visibility: visible; }

  .content { max-width: 1100px; margin: 0 auto; padding: 8px 20px 32px; }
  .page-title { font-size: 30px; font-weight: 700; margin: 12px 0 16px; }
  .hint { margin: 4px 2px 8px; font-size: 13px; color: var(--secondary-text-color, #727272); }
  .note { margin-top: 20px; font-size: 13px; color: var(--secondary-text-color, #727272); }
  .warn { color: var(--error-color, #db4437); }

  /* Rooms */
  .room { margin-top: 20px; }
  .room h2 { font-size: 20px; font-weight: 700; margin: 0 0 10px 2px; }
  .room-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .room-head h2 { margin-bottom: 10px; }

  /* Tiles */
  .tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .tile {
    position: relative; display: flex; flex-direction: column; justify-content: space-between; gap: 10px;
    min-height: 104px; padding: 12px; border-radius: var(--sb-radius); border: none; width: 100%;
    background: var(--sb-tile-off); color: var(--primary-text-color, #212121);
    text-align: left; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
    transition: background .15s, transform .08s, box-shadow .15s;
  }
  .tile:active { transform: scale(.97); }
  .tile:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
  .tile.on { background: var(--sb-tile-on); color: var(--sb-tile-on-text); box-shadow: var(--sb-tile-shadow); }
  .tile.missing { opacity: .55; }
  .tile-icon {
    display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
    width: 38px; height: 38px; border-radius: 50%; border: none; padding: 0; cursor: pointer;
    background: rgba(127, 127, 127, .18); color: var(--secondary-text-color, #8e8e93);
    --mdc-icon-size: 22px;
  }
  .tile.on .tile-icon { color: var(--tile-color); background: color-mix(in srgb, var(--tile-color) 18%, transparent); }
  button.tile-icon:hover { filter: brightness(1.1); }
  .tile-text { display: flex; flex-direction: column; min-width: 0; }
  .tile-name { font-size: 14px; font-weight: 600; line-height: 1.25;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .tile-state { font-size: 13px; color: var(--secondary-text-color, #8e8e93); margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile.on .tile-state { color: var(--sb-tile-on-sub); }

  /* Picker: check-off tiles */
  .tile.pick .check {
    position: absolute; top: 10px; right: 10px; width: 24px; height: 24px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    border: 2px solid rgba(127, 127, 127, .45); color: transparent;
  }
  .tile.pick.selected .check { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); color: #fff; }
  .tile.pick.selected { box-shadow: 0 0 0 2px var(--primary-color, #03a9f4); }

  /* Scene list */
  .scene-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .scene-tile {
    display: flex; align-items: center; gap: 12px; padding: 14px; min-height: 72px; width: 100%;
    border-radius: var(--sb-radius); border: none; cursor: pointer; text-align: left;
    background: var(--sb-tile-on); color: var(--sb-tile-on-text); box-shadow: var(--sb-tile-shadow);
    transition: transform .08s;
  }
  .scene-tile:active { transform: scale(.98); }
  .scene-tile .tile-state { color: var(--sb-tile-on-sub); }
  .scene-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
    width: 40px; height: 40px; border-radius: 50%; --mdc-icon-size: 22px;
    background: color-mix(in srgb, var(--primary-color, #03a9f4) 16%, transparent); color: var(--primary-color, #03a9f4); }
  .scene-tile.new { background: var(--sb-tile-off); color: var(--primary-text-color, #212121); box-shadow: none; }
  .scene-tile.new .tile-state { color: var(--secondary-text-color, #8e8e93); }

  /* Inputs and buttons */
  .name-input, .search {
    width: 100%; margin-top: 12px; padding: 12px 14px; border-radius: 12px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12));
    background: var(--card-background-color, #fff); color: inherit;
  }
  .name-input { font-size: 22px; font-weight: 600; }
  .search { font-size: 16px; }
  .name-input:focus, .search:focus { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: -1px; }
  .wide-btn { display: block; width: 100%; margin-top: 20px; padding: 14px; border-radius: 12px; border: none; cursor: pointer;
    background: var(--sb-tile-off); color: var(--primary-color, #03a9f4); font-size: 16px; font-weight: 600; }
  .wide-btn:hover { filter: brightness(1.05); }
  .text-btn { border: none; background: none; cursor: pointer; padding: 6px 4px;
    color: var(--primary-color, #03a9f4); font-size: 15px; }
  .text-btn.danger { color: var(--error-color, #db4437); }
  .empty { text-align: center; padding: 32px 8px; color: var(--secondary-text-color, #8e8e93); }
  .danger-zone { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 24px; margin-top: 28px; }

  /* Bottom bar */
  .bottombar {
    position: sticky; bottom: 0; z-index: 5; padding: 10px 20px calc(10px + env(safe-area-inset-bottom, 0px));
    background: color-mix(in srgb, var(--card-background-color, #fff) 92%, transparent);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
  }
  .bar-row { display: flex; gap: 8px; max-width: 1100px; margin: 0 auto; }
  .btn { flex: 1 1 0; padding: 12px; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn.primary { flex: 2 1 0; border: none; background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .btn.secondary { border: 1px solid var(--primary-color, #03a9f4); background: transparent; color: var(--primary-color, #03a9f4); }
  .status { max-width: 1100px; margin: 0 auto 8px; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
  .content > .status { margin: 0 0 12px; }
  .status.ok { background: rgba(52, 199, 89, .15); color: var(--success-color, #2e7d32); }
  .status.error { background: rgba(219, 68, 55, .15); color: var(--error-color, #db4437); }

  /* Control sheet */
  .backdrop { position: fixed; inset: 0; z-index: 20; background: rgba(0, 0, 0, .45);
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .sheet { width: 100%; max-width: 440px; max-height: 85vh; overflow-y: auto; outline: none;
    background: var(--card-background-color, #fff); border-radius: 20px; padding: 16px 18px 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, .3); }
  .sheet-head { display: flex; align-items: center; gap: 12px; }
  .sheet-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
    width: 40px; height: 40px; border-radius: 50%; --mdc-icon-size: 22px;
    color: var(--tile-color); background: color-mix(in srgb, var(--tile-color) 18%, transparent); }
  .sheet-title { flex: 1; min-width: 0; }
  .sheet-name { font-size: 17px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sheet-sub { font-size: 13px; color: var(--secondary-text-color, #8e8e93); }
  .sheet-body { display: flex; flex-direction: column; gap: 16px; margin-top: 18px; transition: opacity .15s; }
  .sheet-body.is-off { opacity: .4; }
  .sheet-body .hint { margin: 0; }
  .sheet-remove { display: block; margin: 18px auto 0; }

  /* HA-style switch */
  .switch { position: relative; width: 46px; height: 28px; flex: 0 0 auto; cursor: pointer; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; z-index: 2; }
  .switch .track { position: absolute; inset: 0; border-radius: 14px;
    background: var(--switch-unchecked-track-color, rgba(127,127,127,.4)); transition: background .2s; }
  .switch .knob { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .2s; }
  .switch input:checked ~ .track { background: #34c759; }
  .switch input:checked ~ .knob { transform: translateX(18px); }

  /* Segmented mode buttons */
  .segmented { display: flex; flex-wrap: wrap; gap: 6px; }
  .seg { flex: 1 1 auto; min-width: 56px; padding: 9px 10px; font-size: 13px; text-transform: capitalize;
    border: none; border-radius: 10px; cursor: pointer; background: var(--sb-tile-off); color: inherit; }
  .seg.active { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }

  /* Sliders and dropdowns */
  .ctl { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
  .ctl.toggle { flex-direction: row; align-items: center; justify-content: space-between; }
  .ctl > span { color: var(--secondary-text-color, #727272); }
  .ctl .val { color: var(--primary-text-color, #212121); font-style: normal; font-weight: 600;
    font-variant-numeric: tabular-nums; float: right; }
  .ctl input[type=range] { width: 100%; height: 28px; accent-color: var(--primary-color, #03a9f4); }
  .ctl input[type=color] { width: 52px; height: 34px; padding: 0; border: 1px solid var(--divider-color,#ccc);
    border-radius: 8px; background: none; cursor: pointer; }
  .ctl select, .ctl input[type=text] { padding: 10px; border-radius: 10px; font-size: 15px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--primary-background-color, #f4f5f7); color: inherit; }

  /* Phones */
  @media (max-width: 600px) {
    .content { padding: 4px 14px 24px; }
    .page-title { font-size: 28px; }
    .tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .scene-grid { grid-template-columns: 1fr; }
    .bottombar { padding-left: 14px; padding-right: 14px; }
    .backdrop { align-items: flex-end; padding: 0; }
    .sheet { max-width: none; border-radius: 20px 20px 0 0; max-height: 90vh;
      padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px)); }
  }
`;

customElements.define("scene-builder-panel", SceneBuilderPanel);
