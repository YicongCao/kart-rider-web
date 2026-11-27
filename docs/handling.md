# P3563 漂移与赛道碰撞

## 证据边界

这份实现不是用曲线拟合去“看起来像漂移”。横向轮胎、漂移触发时序、自动滑移、
四轮支撑和刚体积分都来自 P3563 二进制反编译与实机采集。仍有未闭合的模块，
本文在“已知差距”中逐项列出，不把局部证据当成完整等价移植。

| 来源 | 证据 | 用途 |
| --- | --- | --- |
| P3563 `KartRider.exe`，`FUN_00B53F80` | 反编译、反汇编、实机同状态力/力矩对照 | 前后轴滑移角、漂移 factor、trigger 后轴力、侧倾力矩 |
| P3563 `FUN_00B53380` | 反编译、实机载荷/力矩样本 | 四轮弹簧力、车身 up 方向、支撑力矩 |
| P3563 `FUN_00B53610` | 反编译、逐子步实机 trace | 油门牵引、负前速恢复力、自动滑移推力切换 |
| P3563 `FUN_00B48960` / `FUN_00B4EFC0` | 反编译、2 ms 子步调用顺序 | Shift 入口、trigger、linger、转向 |
| P3563 `Launcher.dll` | S7 与 `cotton1` 参数合成 | 质量、最大转角、抓地系数、阻力、推力 |
| 2004 demo 重建 | 已归档的 lateral / trajectory oracle CSV | 公式与积分结构的独立对照 |
| 实机采集 | `work/rea/town_first_bend_20261128/`、`work/rea/p3563_paired_drift_20261128_0027/` | 首弯、直道、持续漂移、自动滑移 |
| KSV 回放 | 31 个回放、17 条原版赛道、218 个 player record、7454 段漂移 | 效果分布对照，不是同赛道逐弯坐标映射 |

2004 oracle 的力最大误差为 `0.000149 N`，横摆力矩 `0.0000284 N·m`，位置
`1.07e-5 m`。这份 oracle 使用 demo 的 `driftTriggerFactor=0.05`，不是 P3563
的 `0.2`；它证明公式和积分复现，不证明 P3563 全链路等价。

## 固定步与状态机

车辆内部固定步长是 **2 ms**。每个子步的原版顺序是：

```text
B53380 支撑/接触
B53610 转向与纵向力
B48960 Shift 入口（只在按键事件帧调用）
B53F80 横向轮胎、trigger/linger、自动滑移
```

Shift 按下时，如果 linger 已归零：

```text
inputActive = true       // AF4
triggerActive = true     // B08
triggerTimer = 0         // B0C，下一子步播种 0.2 s
lingerTimer = 2 * 0.2    // AF8 = 0.4 s
```

- trigger 窗口为 **0.2 s**，期间前轴力为零，只有后轴触发力。
- trigger 窗口内 linger **不递减**；trigger 结束后才开始从 0.4 s 倒数。
- 松 Shift 只清 `inputActive`，不清 trigger 或 linger。早松 Shift 不会把低抓地
  窗口砍成“按下后 0.4 s”。
- trigger + linger 结束后才允许下一次 Shift 触发。
- 速度 `<= 5 m/s` 时清空 AF4/AF8/B08/B0C，低抓地状态不会在停车后残留。
- 自动滑移在 `AF4 == 0 && B08 == 0` 时检测：速度 `> 15 m/s` 且
  `|vLateral| > 1.2 * |vForward|` 进入 active。P3563 的门槛是 15 m/s，
  不是 2004 demo 的 5 m/s。

`src/game/lateral-physics.ts` 的 trigger/active/linger 已由
`tests/original-physics.spec.ts` 覆盖；零舵不会结束按住 Shift 的漂移，只有
松 Shift 或低速清除会结束。

## 横向轮胎

高速普通/漂移分支：

```text
speed      = hypot(vForward, vLateral)
travelSign = vForward > 0 ? +1 : -1
yawTerm    = 0.5 * yawRate / speed
frontSlip  = steerAngle * travelSign - vLateral/speed - yawTerm
rearSlip   =                         - vLateral/speed + yawTerm

frontForce = weight * FrontGripFactor * frontSlip
rearForce  = weight * RearGripFactor  * rearSlip
lateralForce = frontForce + rearForce
yawTorque    = 0.5 * frontForce - 0.5 * rearForce
```

其中 `weight = mass * 9.8`，不是世界重力 `58.8`。trigger 分支为
`frontForce = 0`、`rearForce = -weight * FrontGripFactor * rawSteer *
MaxSteerAngle * DriftTriggerFactor`。按住 Shift 的漂移使用原始 `rawSteer ×
MaxSteerAngle` 全锁角；普通抓地使用速度衰减后的 `+0xAA4` 转角。active/linger
分支的前后轴力都会乘 `DriftSlipFactor`。

实机同状态对照中，横向力最大误差 `0.00230 N`、横摆力矩 `0.000165 N·m`、
侧倾力矩 `0.000029 N·m`、有效转角 `3.3e-8 rad`。这是在 surface 0 的普通
路面上取得的，不是全部表面模式。

## 支撑、重力和防穿透

P3563 的地面支撑不是一条“贴地弹簧”，而是四个轮载沿车身 up 轴施加的力：

```text
springForce = max(0, 2940 * compression + damping * dCompression/dt)
wheelForce  = springForce * max(0, dot(groundNormal, bodyUp)) * bodyUp
```

- 压缩方向阻尼 `0`，回弹方向阻尼 `588 N/(m/s)`。
- 静止压缩约 `0.5 m`，四轮合计约 `4 × 1470 = 5880 N`。
- 世界重力为 `-58.8 m/s²`，与 `mass=100` 的 `5880 N` 对消。
- 支撑力矩使用实测半宽 `0.766791 m`、半长 `0.817228 m` 和 native 的 `0.1`
  力矩比例。

地面支撑只从实际接触产生；没有接触样本时不会凭空加力。空中弹道仍沿用 Web
原有的 `9.81 m/s²` 悬架轨迹，因为现有采集没有 P3563 跳跃样本，不能把地面
重力直接推成空中重力。

### 防穿透边界

实机支撑射线必须覆盖从全伸展到 bump stop 的行程。Web 早期实现只从静止压缩
`0.5 m` 处向下查地面；一旦底盘下沉超过 0.5 m，射线看不到路面，四轮支撑同时
消失，车身会持续下坠。森林 7 弯曾复现到接地状态下刚体低于车道 `63.73 m`。

现在：

- 支撑射线延伸到 `2 × 0.5 = 1.0 m` 的全压缩行程；
- 接地时车身相对行程限制在 `[-1.0, +0.5] m`，并在 bump stop 处清除同向速度；
- 支撑弹簧在 1.0 m 压缩处钳位，不会因为 `|distance| > 0.5` 直接判为无接触。

`tests/contact-force.spec.ts` 用 `-40 m/s` 的垂直入射和平面地面验证底盘不会
穿过路面；`tests/support/drift-course.ts` 还会把“接地状态下下沉超过 1.05 m”
作为逐弯失败条件。

## 抓地驾驶

抓地阶段直接使用上面的 P3563 双轴轮胎模型，不再使用之前的限幅自行车模型。
转向输入是键盘的 `-1/0/1`；左右键采用“最近按下者拥有转向”的仲裁，松开旧
方向不会取消仍按住的新方向。`Route.query` 的横向基已修正为驾驶员右侧正方向。

首弯对照来自 `townb02.ndjson` 与实际 HUD：

- 原版 `+2.879 s` 的前向轴航向为 `106.194°`。
- Web 正式回放为 `105.443°`，误差 `0.751°`。
- 八个 HUD 采样点最大误差 `5.63 km/h`，上限保持 `< 9 km/h`。
- 测试同时检查三个时刻的有符号航向/侧滑，并验证左右镜像。

抓地整圈验收 `tests/grip-lap.spec.ts` 的最终实测：

| 指标 | 值 |
| --- | ---: |
| 圈时 | `133.27 s` |
| 允许上限 | `191.43 s` |
| 最大侧滑比 | `0.1827` |
| 最大偏离中心线 | `3.25 m` |
| 碰撞 | `0` |
| 逆行 | `false` |
| 使用漂移 | `false` |

这证明抓地跑法可以完整、无碰撞地完成城镇高速一圈；它不证明该线路是最快圈速。
键盘离散控制（`steer` 只取 `-1/0/1`，曲率前视 40 m）另跑一整圈：
`140.35 s`、最大侧滑比 `0.1451`、碰撞 `0`、未逆行、未进入漂移；同一
`< 0.25` 门槛不放宽。

## 每弯漂移验收

`tests/support/drift-course.ts` 是不依赖浏览器、DOM、`Game` 或 `KartView` 的
确定性模拟器。它使用共享的 `KartVehicle`、`Route`、`TrackCollision`，再加
测试侧的弯道分析、三 GLTF 解析和驾驶控制器。控制器 100 Hz 采样，车辆内部
仍按 2 ms 固定步积分，键盘转向只允许 `-1/0/1`。路面倍率直接调用生产
`trackSurface()`；冰山使用 `grip=0.64`，不再以测试专用的 `grip=1.0` 代替。

四条赛道从生产 `Route` 提取真实弯，过滤小于 20 m 的导出伪段：

| 赛道 | 真实弯 | 通过 |
| --- | ---: | ---: |
| 城镇高速 | 13 | 13 |
| 沙漠旋转工地 | 27 | 27 |
| 森林发夹 | 33 | 33 |
| 冰山滑雪场 | 21 | 21 |
| 合计 | 94 | 94 |

每个弯独立从弯前起漂，验收条件：

- 弯内漂移覆盖率至少 0.8，最大断档不超过 0.25 s；
- 单次漂移 episode 至少 0.9 s；
- 弯末速度航向误差不超过 45°，最终车身航向误差不超过 30°；
- 弯内侧滑中位数 20°–70°；
- 漂移保速 0.75–1.2；
- 无碰撞、无倒车、无离路、无接地穿透；
- 起漂必须在弯体之前，并覆盖弯体入口。

当前 94 个弯全部一次通过，report 在 `test-results/drift-corners/<track>.json`。
每个弯还必须提供一段完整、可测的 active/linger effect；trigger 不计入。

## 与原版 KSV 的效果对照

KSV fixture 只保存统计量，不保存原始逐帧数据或玩家名：

```bash
python3 scripts/ksv_drift_reference.py \
  --inputs /path/to/ksv-directory \
  --out tests/fixtures/drift-reference.json
```

比较方法按原版脚本的 10 Hz 位置差分：

- 只取 KSV effect 2/3 对应的 active/linger；trigger 不算。
- 10 Hz 重采样，允许一个 tick（0.2 s）的断点，最少 4 个 tick（0.4 s）。
- 侧滑用速度航向减车身航向，速度低于 5 m/s 的样本不计。
- 横向/纵向速度用相邻采样位置差分，不用 Web 的瞬时速度字段直接冒充原版口径。
- effect 时长不足 0.4 s 的弯没有完整样本组，报告会显式列出，不用截断样本凑数。

原版 KSV 分布与 Web 的逐弯完整 effect 中位数：

| 赛道 | 保速 | 横摆率 | 侧滑角 |
| --- | ---: | ---: | ---: |
| 城镇 | 0.9991 | 30.13 °/s | 42.81° |
| 沙漠 | 0.9951 | 61.02 °/s | 49.71° |
| 森林 | 0.9969 | 43.22 °/s | 45.78° |
| 冰山 | 0.9932 | 41.97 °/s | 54.30° |
| 原版 p25–p75 | 0.837–1.0175 | 28.352–91.043 °/s | 41.414–60.045° |

四条赛道的三项中位数都落在原版 IQR 内，`effectIqrMisses` 为空，
`truncatedEpisodes=0`。Web 原始整段漂移时长中位约 1.98–5.21 s，KSV corpus
的 duration 中位为 1.5 s；这是“整弯持续按住 Shift”的验收策略造成的口径差异，
报告中只作描述，不参与 effect 判定。

## 共享运行时与单机资产根

测试入口支持显式资产根：

```bash
KART_DRIFT_ASSET_ROOT=/path/to/standalone/assets \
  npx playwright test tests/drift-corners.spec.ts --reporter=line
```

资产根布局：

```text
tracks/<track>/route.json
tracks/<track>/track.gltf
tracks/<track>/track.bin
```

`tests/shared-drift-runtime.spec.ts` 会把城镇资产复制到临时根，改写
`route.json.length` 为哨兵值，再通过 `loadTrack("village", root)` 读回该值，
证明测试没有写死 `public/assets`。仓库没有独立单机工程或单机运行时二进制，
因此这里只验证“共享运行时 + 不同资产根”的机制，不声称已经实际驱动单机版。
单机版要复用这套验收，必须共用 `KartVehicle`、`Route`、`TrackCollision` 的
同一实现；如果使用另一套物理代码，结论不能直接迁移。

## 已知差距

- **表面模式 1/2 与 `+0x65C` 未移植。** 实机 paired trace 的 surface 都是 0。
  冰山等赛道目前使用 Web 的 grip 倍率，不是 P3563 的完整 surface 表；不能声称
  冰山漂移已逐帧等价。
- **空中弹道未按 P3563 的 58.8 m/s² 验证。** 现有采集没有跳跃样本，悬架空中
  分支仍用 Web 的 9.81 m/s²，坡道和断崖测试只证明既有 Web 轨迹未回归。
- **4200 N 是采集值，不是全局常数。** 城镇首弯这场 S7/棉花糖配置实测自动滑移
  推力为 `4200 N`；Launcher 的 2600 + 1600 合成来源尚未独立闭合。其他车型或
  速度模式需要各自采集，不能直接套用。
- **live trace fixture 只有 12 个采样，截至 0.846 s。** 侧向速度由速度模长
  重建并带符号推断；它是短时回归，不是完整 P3563 长漂移证明。2004 oracle 和
  同状态力对照补足公式层，但不能替代同场景长 trace。
- **支撑几何来自共享实机候选。** 半宽/半长/0.8 探点由支撑力矩残差支持，
  未独立读到每个 getter；当前 `contact-force` 单测验证公式和输入样本。
- **KSV 是跨 17 条赛道的 corpus，不是同赛道逐弯映射。** 城镇没有原版 KSV
  回放，因此城镇只做硬指标和跨赛道分布检查，不声称逐弯对应原版。
- **逐弯测试证明“可通过”，不证明“最快”。** 驾驶器是确定性验收器，不是人类
  最优线路；圈速上限由 `tests/grip-lap.spec.ts` 单独约束。
- **练习 D 的小喷差异仍记录为 known gap。** 原版记录中该次补油点火，Web
  不点火；测试明确记录差异，没有通过放宽阈值隐藏。

## 验收命令

交付前必须运行：

```bash
npm run verify
```

单独的快速回归：

```bash
npx playwright test \
  tests/grip-lap.spec.ts \
  tests/drift-corners.spec.ts \
  tests/drift-reference.spec.ts \
  tests/original-physics.spec.ts \
  tests/original-trajectory.spec.ts \
  tests/p3563-drift-trace.spec.ts \
  tests/contact-force.spec.ts \
  --reporter=line
```
