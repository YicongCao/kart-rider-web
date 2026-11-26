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

The game expects converted assets under `public/assets/`. They are not downloaded automatically.

## Controls

- `W` / `↑`: accelerate
- `S` / `↓`: brake
- `A` / `D` or `←` / `→`: steer
- `Shift`: drift
- `Ctrl` or `Space`: use nitro
- `R`: reset to the course
- `Esc`: pause

Touch controls are shown on narrow screens.

## Tracks

- 城镇高速公路
- 森林发夹
- 沙漠旋转工地
- 冰山滑雪场

The minimap is generated from each track's route centerline so that the marker and route share the same projection.

## Asset Notice

This is a non-commercial, local-use prototype. KartRider, its characters, karts, tracks, music, artwork, and related marks are the property of Nexon and their respective rights holders, including Tiancity in relevant markets. This project is not affiliated with or endorsed by either company.

The repository does not grant any right to redistribute those assets. See `docs/asset-provenance.md` for the source of each asset group and keep any local copies within the terms that apply to your original game installation.
