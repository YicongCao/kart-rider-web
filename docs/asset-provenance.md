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
| `public/assets/ui/race/` | `gui_tachometer/v1_exceed/` | Original speedometer plates, digits and indicators |
| `public/assets/ui/race/n2o_solo*.png` | P3563 `stage_speedIndiGame.rho/boostGauge.bml` | Original 198×26 solo nitro bar, 146×12 fill, 8×22 marker and full-bar highlight |
| `public/assets/ui/race/item6.png`, `slot.png` | P3563 `item.rho/slot/` | Original N₂O item card and the 72×72 / 92×92 Ctrl slot frames from `slot_template.bml` |
| `public/assets/ui/race/laptime_*.png`, `time_num.png` | P3563 `stage_speedIndiGame.rho` | Chinese race-time, best-lap and best-of-session labels plus the 198×22 numeric atlas used by the race clocks |
| `public/assets/ui/lobby/` | P3563 `myRoom.rho/2026_Face-lift_main` tomb courtyard and local field captures of the lobby, time-trial menus and practice room | Projected courtyard scenery, rider, kart and menu illustrations exported to WebP |
| `public/assets/effects/default-booster.glb` | P3563 `effect.rho/booster/default/booster.1s` and its atlases | Six animated meshes for the orange Cotton C1 exhaust jet, attached to its original left-hand port |
| `public/assets/effects/default-wave.glb` | P3563 `effect.rho/boosterWave/effect.1s` and its textures | Original chassis-level air trails visible on either side of the kart during a boost |
| `public/assets/effects/exhaust.png`, `boost-blur-mask.png` | P3563 `effect.rho/exhaust/exhaust.png`, `boosterBlur/blurMask.png` | Original exhaust puff sprite and screen-space radial blur mask |
| `public/assets/audio/booster.ogg`, `boosterDrift.ogg` | P3563 `sound_fx_kart.rho/engine_common/` | Cotton C1 uses the common bank for boost sounds. The archive supplies identical audio for `boosterStart.ogg` and `booster.ogg`, and a separate cue for drift boosts |
| `public/assets/audio/` | KartRider 1.0 sound archive | Ogg Vorbis |

The conversion scripts used for these files live outside this web project in the parent workspace. Track route files are resampled centerlines derived from the original track road data. The race displays the four exported `minimap.png` files and positions the marker using the `ToMinimap` calibration from each track.

## 比赛画面素材审查

| 画面元素 | 当前来源 |
| --- | --- |
| 道具栏 | 使用 P3563 `item.rho` 的 72×72 备用槽和 92×92 当前槽相框；集满一管集气后立即在空槽显示原版 N₂O 道具卡，槽位上限为两个。 |
| 小地图 | 全图和局部地图均使用已导出的原版 PNG，车标按赛道 `ToMinimap` 数据定位。可提供本地授权箭头图。 |
| 广告牌 | 保留 glTF 材质自带的贴图。缺贴图的 `ad_*` 优先加载本地授权贴图，缺省使用运行时生成的 Canvas 纹理。 |
| 赛道粒子、车底阴影和轮胎拖痕 | 优先加载本地授权贴图，缺省由 Web 运行时生成。喷气、加速气浪、尾气贴图与加速模糊遮罩的来源见上表。 |
| 撞击与完赛反馈 | 已导出的红色碰撞码表图层用于短时碰撞反馈。正向碰撞速度达到 10 m/s 时播放 `crash.ogg`，其余碰撞播放 `collide.ogg`。可提供本地授权的完赛音效。 |
| 暂停、声音、全屏和底栏导航 | Web 控件使用 SVG 图标。码表、集气条、道具槽、计时钟、每圈成绩和起跑倒计时使用上表列出的资源。 |

### 本地素材入口

将有权使用的文件放入 `public/local-assets/`，在同目录的 `race-assets.json` 中列出已提供的相对路径。例如：

```json
["item-slot.png", "minimap-arrow.png", "kart-shadow.png", "skidmark.png", "finish.ogg", "tracks/village/ads/ad_start.png", "tracks/village/particle.png"]
```

箭头 PNG 以朝上为初始方向。阴影、拖痕和粒子 PNG 使用透明背景。广告文件名对应 glTF 材质名。未列出的文件使用缺省素材，完赛不播放单独音效。

## Font

`public/assets/fonts/SourceHanSansCN-Bold.otf` is Source Han Sans CN Bold, distributed by Adobe under the SIL Open Font License 1.1.

## Rights

KartRider, its characters, karts, tracks, music, artwork, logos, and related marks remain the property of Nexon and their respective rights holders, including Tiancity in relevant markets. This project is unofficial and is not affiliated with or endorsed by either company.

No license is granted here to redistribute the converted game assets. Use them only with assets you are entitled to use and in compliance with the terms that apply to your copy of the game.
