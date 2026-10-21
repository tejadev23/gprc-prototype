import assert from "node:assert/strict";
import { test } from "node:test";
import { clampGuidePosition, defaultGuideState, GUIDE_STEP_COUNT, parseGuideState } from "../lib/corridor/guide-state";

test("a missing guide record uses the default corner and the first step", () => {
  const state = parseGuideState(null, 1400, 900);
  assert.equal(state.collapsed, false);
  assert.equal(state.step, 0);
  assert.equal(state.x, defaultGuideState(1400).x);
});

test("a damaged guide record does not throw and does not invent a step", () => {
  assert.deepEqual(parseGuideState("{", 800, 600).step, 0);
  assert.equal(parseGuideState(JSON.stringify({ step: 99, x: "no", collapsed: "yes" }), 800, 600).step, GUIDE_STEP_COUNT - 1);
  assert.equal(parseGuideState(JSON.stringify({ step: -3, collapsed: true, x: 40, y: 50 }), 800, 600).collapsed, true);
  assert.equal(parseGuideState(JSON.stringify({ step: -3, x: 40, y: 50 }), 800, 600).step, 0);
});

test("a saved guide position is pulled back onto the screen", () => {
  const saved = parseGuideState(JSON.stringify({ collapsed: false, x: 4000, y: -20, step: 4 }), 500, 400);
  const clamped = clampGuidePosition(saved.x, saved.y, 500, 400);
  assert.ok(clamped.x >= 8 && clamped.x <= 500 - 72);
  assert.ok(clamped.y >= 8 && clamped.y <= 400 - 48);
  assert.equal(saved.step, 4);
});
