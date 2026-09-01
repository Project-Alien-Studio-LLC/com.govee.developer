'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGoveeRgbState,
  resolveHomeyColor,
} = require('../lib/govee-color');

test('parseGoveeRgbState supports RGB-only devices', () => {
  const result = parseGoveeRgbState(
    [{ instance: 'colorRgb', state: { value: 0x00ff00 } }],
    () => ({ h: 120, s: 1 }),
  );

  assert.deepEqual(result, { mode: 'color', hue: 1 / 3, saturation: 1 });
});

test('parseGoveeRgbState recognizes temperature mode when present', () => {
  const result = parseGoveeRgbState(
    [
      { instance: 'colorRgb', state: { value: 0xff0000 } },
      { instance: 'colorTemperatureK', state: { value: 4000 } },
    ],
    () => ({ h: 0, s: 1 }),
  );

  assert.deepEqual(result, { mode: 'temperature', hue: null, saturation: null });
});

test('resolveHomeyColor completes partial picker updates from current state', () => {
  assert.deepEqual(
    resolveHomeyColor({ hue: 0.5 }, { light_hue: 0.2, light_saturation: 0.75 }),
    { hue: 0.5, saturation: 0.75 },
  );
  assert.deepEqual(
    resolveHomeyColor({ saturation: 0.25 }, { light_hue: 0.6, light_saturation: null }),
    { hue: 0.6, saturation: 0.25 },
  );
});

test('resolveHomeyColor gives empty state safe color defaults', () => {
  assert.deepEqual(resolveHomeyColor({ hue: 0.8 }, {}), {
    hue: 0.8,
    saturation: 1,
  });
});
