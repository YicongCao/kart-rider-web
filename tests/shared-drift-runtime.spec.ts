import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "playwright/test";
import { loadTrack } from "./support/drift-course";

test("the shared drift harness reads a standalone asset root", async () => {
  test.setTimeout(30_000);
  const root = mkdtempSync(join(tmpdir(), "kart-standalone-assets-"));
  try {
    const village = join(root, "tracks", "village");
    cpSync(
      new URL("../public/assets/tracks/village/", import.meta.url),
      village,
      { recursive: true },
    );
    const routeFile = join(village, "route.json");
    const route = JSON.parse(readFileSync(routeFile, "utf8")) as {
      length: number;
    };
    const originalLength = route.length;
    // Sentinel route length proves the loader did not fall back to
    // public/assets. A real standalone build only needs this same layout:
    // tracks/<track>/route.json, track.gltf and track.bin.
    const sentinel = route.length + 123.5;
    route.length = sentinel;
    writeFileSync(routeFile, JSON.stringify(route));

    const loaded = await loadTrack("village", root);
    expect(loaded.route.length).toBeCloseTo(sentinel, 6);
    expect(loaded.route.length).not.toBe(originalLength);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
