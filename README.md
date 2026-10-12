# Better Scene Builder for Home Assistant

A room-first scene editor, laid out like scenes in the Apple Home app. The
built-in scene editor makes you add entities one at a time. Here you check off
accessories by room, then set each one from a tile.

Scenes are written through the same REST endpoint the built-in editor uses, so
they land in `scenes.yaml` and show up under
**Settings > Automations & Scenes > Scenes** like any other scene.

## How it works

1. **Scenes:** your scenes as tiles, plus **New scene**.
2. **Accessories:** every accessory as a tile, grouped by room. Tap a tile to
   check it off, or use **Select all** for a whole room. Search filters across
   every room. **Done** takes you to Customize.
3. **Customize:** the scene's accessories as tiles, grouped by room, each
   showing what the scene will set it to.
   - Tap a tile's **icon** to turn it on or off.
   - Tap the **tile** to open its settings: brightness, color temperature,
     color, fan speed or preset, thermostat mode and setpoints (including
     heat/cool ranges), preset, fan and swing modes, cover position, volume and
     source, and select or number values.
   - **Preview** applies the scene to your accessories without saving it.
     **Revert** puts them back the way they were.
   - **Duplicate scene** and **Delete scene** are at the bottom.

Adding an accessory starts from its current state, so you can set the room the
way you want it and then save. Dropdowns have a **Don't set** option so a scene
can leave that setting alone, and tapping the active fan preset again clears it.

Includes YAML-defined helpers that aren't in the entity registry. Skips
entities that are disabled or hidden in Home Assistant.

## Install with HACS (recommended)

1. In HACS, open the menu (three dots, top right) > **Custom repositories**.
2. Add `https://github.com/iKrushYou/home-assistant-better-scene-builder`
   with type **Integration**.
3. Search for **Scene Builder**, click **Download**, and restart Home Assistant.
4. Go to **Settings > Devices & Services > Add Integration**, search for
   **Scene Builder**, and click **Submit**. It appears in the sidebar.

## Manual install

Copy `custom_components/scene_builder` into your config directory's
`custom_components/` folder, restart, then add it from **Settings > Devices &
Services > Add Integration**.

For Docker with a named volume, copy the folder in through the container:

```sh
docker exec <container> mkdir -p /config/custom_components
docker cp scene_builder <container>:/config/custom_components/
```

## Requirements

- Home Assistant 2024.7 or newer.
- An admin account (same as the built-in scene editor).
- `scene: !include scenes.yaml` in `configuration.yaml`. It's in the default
  config; if it's missing, saved scenes won't load.

## Notes

- Only scenes created through the UI (scenes with an `id`) can be edited. Scenes
  written by hand in YAML without an `id` won't appear in the dropdown.
- On lights that support both color temperature and RGB, whichever you set last
  is saved.
- A `preset_mode` of `none` is dropped on save, since most devices reject it as
  a target.

## Releasing

Bump `version` in `custom_components/scene_builder/manifest.json`, commit, and
publish a GitHub release tagged `v<version>`. The version is also used to
cache-bust the panel's JS, so browsers pick up the new code after an update.

## Upgrading from the YAML setup

Versions before 0.8.0 were enabled with a `scene_builder:` line in
`configuration.yaml`. That line still works: on startup it is imported into a UI
config entry. Once Scene Builder shows under Devices & Services you can delete
the line.

## Uninstall

Delete Scene Builder from **Settings > Devices & Services**, remove any
`scene_builder:` line from `configuration.yaml`, remove the files (via HACS, or
delete `custom_components/scene_builder/`), and restart. Scenes you
created stay in `scenes.yaml`.
