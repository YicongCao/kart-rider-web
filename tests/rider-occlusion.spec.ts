import { existsSync } from "node:fs";
import type { Mesh, MeshBasicMaterial, Object3D } from "three";
import { chromium, type Browser } from "playwright";
import { expect, test } from "playwright/test";
import { createServer } from "vite";

function chromeExecutable() {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((path): path is string => Boolean(path && existsSync(path)));
}

test("the grid intro shows Dao's eyes before cutting to the countdown chase view", async () => {
  test.setTimeout(120_000);
  const vite = await createServer({ logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  let browser: Browser | undefined;
  try {
    await vite.listen();
    browser = await chromium.launch({
      executablePath: chromeExecutable(),
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(vite.resolvedUrls!.local[0]);
    await page.waitForFunction(() => Boolean((window as any).kartGame));
    await page.evaluate(async () => {
      await (window as any).kartGame.startTrack("village");
      const { game } = (window as any).__kartDebug;
      cancelAnimationFrame(game.animationFrame);
    });

    // Sample the production countdown loop without advancing its clock between captures.
    let previous = 0;
    for (const progress of [0, 0.39, 0.78, 1]) {
      const frame = await page.evaluate(async (delta) => {
        const { Triangle, Vector2, Vector3, Raycaster } = await import("/node_modules/three/build/three.module.js");
        const { game, world, kartView, camera } = (window as any).__kartDebug;
        game.updateGrid(delta);
        world.render();
        const state = game.vehicle.state;
        const ahead = (camera.position.x - state.x) * Math.sin(state.yaw) + (camera.position.z - state.z) * Math.cos(state.yaw);
        const rider = kartView.rider;
        const face = rider.getObjectByName("face").children[0] as Mesh;
        const visibleMeshes: Object3D[] = [];
        kartView.root.traverseVisible((object: Mesh) => { if (object.isMesh) visibleMeshes.push(object); });

        // Locate the eyes from their texture coordinates so the check follows the camera.
        // The rigid face mesh inherits the animated head bone's current world matrix.
        const { position, uv } = face.geometry.attributes;
        const indices = face.geometry.index!;
        const screen = world.renderer.domElement as HTMLCanvasElement;
        const copy = document.createElement("canvas");
        copy.width = screen.width;
        copy.height = screen.height;
        const context = copy.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(screen, 0, 0);
        function sampleEye(u: number, v: number) {
          const point = new Vector3(u, v, 0);
          for (let i = 0; i < indices.count; i += 3) {
            const vertices = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
            const [a, b, c] = vertices.map(id => new Vector3(uv.getX(id), uv.getY(id), 0));
            const weights = Triangle.getBarycoord(point, a, b, c, new Vector3());
            if (!weights || Math.min(weights.x, weights.y, weights.z) < -1e-6) continue;
            const surface = new Vector3();
            vertices.forEach((id, j) => surface.addScaledVector(new Vector3().fromBufferAttribute(position, id), weights.getComponent(j)));
            const ndc = face.localToWorld(surface).project(camera);
            const x = Math.floor((1 + ndc.x) * copy.width / 2);
            const y = Math.floor((1 - ndc.y) * copy.height / 2);
            const ray = new Raycaster();
            ray.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
            const first = ray.intersectObjects(visibleMeshes, false)[0]?.object;
            return { hit: first === face ? "face" : first?.parent?.name, rgb: Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)) };
          }
          throw new Error(`Missing face UV (${u}, ${v})`);
        }
        return {
          ahead, fov: camera.fov, mount: rider.parent.name, material: (face.material as MeshBasicMaterial).name,
          samples: ahead > 0 ? [0.42, 0.5, 0.58].map(u => sampleEye(u, 0.75)) : [],
        };
      }, (progress - previous) * 3.6);
      previous = progress;
      if (progress === 1) {
        expect(frame.ahead).toBeLessThan(-5.5);
        expect(frame.fov).toBe(60);
        continue;
      }
      expect(frame.mount).toBe("Relement");
      expect(frame.material).toBe("f00");
      expect(frame.ahead).toBeGreaterThan(4);
      expect(frame.samples.map(sample => sample.hit), `eye visibility at ${progress}`).toEqual(["face", "face", "face"]);
      // Read the rendered pupils and skin between them. A white panel covering
      // this area, a missing face texture, or an invisible rider all fail.
      const [left, skin, right] = frame.samples.map(sample => sample.rgb);
      expect(Math.max(...left, ...right), `dark pupils at ${progress}`).toBeLessThan(110);
      expect(skin[0], `skin tone at ${progress}`).toBeGreaterThan(180);
      expect(skin[0] - skin[2]).toBeGreaterThan(50);
    }
  } finally {
    await browser?.close();
    await vite.close();
  }
});
