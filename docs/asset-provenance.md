# Asset Provenance

The browser build uses assets converted from a local KartRider 1.0 installation for a non-commercial technical prototype.

## Converted Game Assets

| Web path | Original source | Conversion |
| --- | --- | --- |
| `public/assets/tracks/village/` | `track_village_R01` | Track and skydome meshes to glTF; card, thumbnail, and minimap to PNG; BGM to Ogg Vorbis |
| `public/assets/tracks/forest/` | `track_forest_R02` | Track and skydome meshes to glTF; card, thumbnail, and minimap to PNG; BGM to Ogg Vorbis |
| `public/assets/tracks/desert/` | `track_desert_R01` | Track and skydome meshes to glTF; card, thumbnail, and minimap to PNG; BGM to Ogg Vorbis |
| `public/assets/tracks/ice/` | `track_ice_R01` | Track and skydome meshes to glTF; card, thumbnail, and minimap to PNG; BGM to Ogg Vorbis |
| `public/assets/characters/dao/` | `character_dao/model.1s` | Character mesh and textures to glTF |
| `public/assets/karts/cotton1/` | `DataPack2_00007/kart_/cotton1/model.1s` | Kart mesh and textures to glTF |
| `public/assets/ui/` | KartRider 1.0 UI archive | PNG images |
| `public/assets/ui/countdown/` | `stage_speedIndiGame.rho/s_03@cn.png` | Four 250×98 frames from the Chinese start-signal atlas, with their original alpha and alignment |
| `public/assets/ui/race/` | `gui_tachometer/v1_exceed/` | Original speedometer plates, digits, indicators and nitro gauge |
| `public/assets/ui/lobby/` | P3563 `myRoom.rho/2026_Face-lift_main` tomb courtyard and local field captures of the lobby, time-trial menus and practice room | Projected courtyard scenery, rider, kart and menu illustrations exported to WebP |
| `public/assets/effects/default-booster.glb` | P3563 `effect.rho/booster/default/booster.1s` and its atlases | Six animated meshes for the orange Cotton C1 exhaust jet, attached to its original left-hand port |
| `public/assets/effects/default-wave.glb` | P3563 `effect.rho/boosterWave/effect.1s` and its textures | Original chassis-level air trails visible on either side of the kart during a boost |
| `public/assets/effects/exhaust.png`, `boost-blur-mask.png` | P3563 `effect.rho/exhaust/exhaust.png`, `boosterBlur/blurMask.png` | Original exhaust puff sprite and screen-space radial blur mask |
| `public/assets/audio/booster.ogg`, `boosterDrift.ogg` | P3563 `sound_fx_kart.rho/engine_common/` | Cotton C1 uses the common bank for boost sounds. The archive supplies identical audio for `boosterStart.ogg` and `booster.ogg`, and a separate cue for drift boosts |
| `public/assets/audio/` | KartRider 1.0 sound archive | Ogg Vorbis |

The conversion scripts used for these files live outside this web project in the parent workspace. Track route files are resampled centerlines derived from the original track road data. The four `minimap.png` files are retained for reference, but the in-game minimap is generated from the route centerline instead.

## Font

`public/assets/fonts/SourceHanSansCN-Bold.otf` is Source Han Sans CN Bold, distributed by Adobe under the SIL Open Font License 1.1.

## Rights

KartRider, its characters, karts, tracks, music, artwork, logos, and related marks remain the property of Nexon and their respective rights holders, including Tiancity in relevant markets. This project is unofficial and is not affiliated with or endorsed by either company.

No license is granted here to redistribute the converted game assets. Use them only with assets you are entitled to use and in compliance with the terms that apply to your copy of the game.
