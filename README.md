# Better Scene Builder for Home Assistant

A room-first scene editor. The built-in scene editor makes you add entities one
at a time. This panel lets you pick a room and pull in all of its entities in one
click, set each entity's target state on a control card, and save.

Scenes are written through the same REST endpoint the built-in editor uses, so
they land in `scenes.yaml` and show up under
**Settings > Automations & Scenes > Scenes** like any other scene.

## Features

- **Room-first picker:** entities are grouped by area, with **Add all** per room
  and a filter across every entity.
- **Always-visible control cards** for each entity in the scene:
  - on/off switches (lights, switches, fans, humidifiers, locks)
  - sliders for brightness, color temperature, fan speed, humidity, cover
    position, volume, and number values
  - color picker for RGB lights
  - mode buttons for climate and media players
  - dropdowns for select helpers and fan presets
- **Live snapshot:** adding an entity starts from its current state, so you can
  set the room the way you want it and then save.
- **Edit existing scenes:** load a scene from the dropdown, change it, then
  update or delete it.
- Includes YAML-defined helpers that aren't in the entity registry. Skips
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
