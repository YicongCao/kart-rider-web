import { expect, test } from "playwright/test";
import { SteeringOwnership } from "../src/game/input";

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
