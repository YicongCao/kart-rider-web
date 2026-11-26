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
| `public/assets/audio/` | KartRider 1.0 sound archive | Ogg Vorbis |

The conversion scripts used for these files live outside this web project in the parent workspace. Track route files are resampled centerlines derived from the original track road data. The four `minimap.png` files are retained for reference, but the in-game minimap is generated from the route centerline instead.

## Font

`public/assets/fonts/SourceHanSansCN-Bold.otf` is Source Han Sans CN Bold, distributed by Adobe under the SIL Open Font License 1.1.

## Rights

KartRider, its characters, karts, tracks, music, artwork, logos, and related marks remain the property of Nexon and their respective rights holders, including Tiancity in relevant markets. This project is unofficial and is not affiliated with or endorsed by either company.

No license is granted here to redistribute the converted game assets. Use them only with assets you are entitled to use and in compliance with the terms that apply to your copy of the game.
