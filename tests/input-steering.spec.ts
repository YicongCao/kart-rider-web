import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { expect, test } from "playwright/test";
import { createServer } from "vite";
import { SteeringOwnership } from "../src/game/input";

function chromeExecutable() {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((path): path is string => Boolean(path && existsSync(path)));
}

test("releasing the owner restores the direction that is still held", () => {
  const steering = new SteeringOwnership();

  steering.press("KeyA", -1);
  expect(steering.steer).toBe(-1);

  steering.press("KeyD", 1);
  expect(steering.steer).toBe(1);

  steering.release("KeyD");
  expect(steering.steer).toBe(-1);

  steering.release("KeyA");
  expect(steering.steer).toBe(0);
});

test("releasing an older direction does not disturb the current owner", () => {
  const steering = new SteeringOwnership();

  steering.press("KeyA", -1);
  steering.press("KeyD", 1);
  steering.release("KeyA");
  expect(steering.steer).toBe(1);

  steering.release("KeyD");
  expect(steering.steer).toBe(0);
});

test("releasing one key of the same direction preserves steering", () => {
  const steering = new SteeringOwnership();

  steering.press("KeyA", -1);
  steering.press("ArrowLeft", -1);
  steering.release("ArrowLeft");
  expect(steering.steer).toBe(-1);

  steering.release("KeyA");
  expect(steering.steer).toBe(0);
});

test("touch direction buttons restore the direction that is still held", () => {
  const steering = new SteeringOwnership();

  steering.press("touch:left", -1);
  expect(steering.steer).toBe(-1);

  steering.press("touch:right", 1);
  expect(steering.steer).toBe(1);

  steering.release("touch:right");
  expect(steering.steer).toBe(-1);

  steering.release("touch:left");
  expect(steering.steer).toBe(0);
});

test("keyboard and touch share the same steering ownership", () => {
  const steering = new SteeringOwnership();

  steering.press("touch:left", -1);
  steering.press("KeyD", 1);
  steering.release("KeyD");
  expect(steering.steer).toBe(-1);

  steering.release("touch:left");
  expect(steering.steer).toBe(0);
});

test("real browser key events produce discrete steering after repeated alternation", async () => {
  test.setTimeout(120_000);
  const vite = await createServer({
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  let browser: Browser | undefined;
  try {
    await vite.listen();
    browser = await chromium.launch({
      executablePath: chromeExecutable(),
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(vite.resolvedUrls!.local[0]);
    await page.waitForFunction(() => Boolean((window as any).kartGame));
    await page.evaluate(async () => {
      await (window as any).kartGame.startTrack("village");
    });
    const steer = () => page.evaluate(() =>
      (window as any).__kartDebug.game.input.snapshot().steer as number);

    const samples: number[] = [];
    for (let index = 0; index < 12; index++) {
      await page.keyboard.down("a");
      samples.push(await steer());
      await page.keyboard.down("d");
      samples.push(await steer());
      await page.keyboard.up("a");
      samples.push(await steer());
      await page.keyboard.up("d");
      samples.push(await steer());
    }
    await page.keyboard.down("ArrowLeft");
    samples.push(await steer());
    await page.keyboard.up("ArrowLeft");
    samples.push(await steer());

    const expected: number[] = [];
    for (let index = 0; index < 12; index++) expected.push(-1, 1, 1, 0);
    expected.push(-1, 0);
    expect(samples).toEqual(expected);
  } finally {
    await browser?.close();
    await vite.close();
  }
});
