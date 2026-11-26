# Kart Rider Web

An unofficial browser remake of the KartRider 1.0 driving loop, built with TypeScript, Vite, and Three.js.

## Run

Requirements: Node.js 20 or newer, plus a browser with WebGL 2.

```bash
npm install
npm run dev
```

For a production build:

```bash
npm run build
npm run preview
```

Before delivering changes, run the full acceptance gate:

```bash
npm run verify
```

This includes the grip-only full-lap test in `tests/grip-lap.spec.ts`.

The game expects converted assets under `public/assets/`. They are not downloaded automatically.

## Controls

- `W` / `↑`: accelerate
- `S` / `↓`: brake
- `A` / `D` or `←` / `→`: steer
- Hold a direction and tap `Shift` to drift. Countersteer to straighten, then release and press the accelerator to mini-boost. Start another short drift during the burst to chain the next one.
- `Ctrl` or `Space`: use nitro
- `R`: reset to the course
- `Esc`: pause

Touch controls are shown on narrow screens.

## Tracks

- 城镇高速公路
- 森林发夹
- 沙漠旋转工地
- 冰山滑雪场

The race uses each track's exported minimap and its projection data to place the driver marker.

## Asset Notice

This is a non-commercial, local-use prototype. KartRider, its characters, karts, tracks, music, artwork, and related marks are the property of Nexon and their respective rights holders, including Tiancity in relevant markets. This project is not affiliated with or endorsed by either company.

The repository does not grant any right to redistribute those assets. See `docs/asset-provenance.md` for the source of each asset group and keep any local copies within the terms that apply to your original game installation.
