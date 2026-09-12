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

test('null picker fields preserve known color and null stored saturation defaults to color', () => {
  assert.deepEqual(resolveHomeyColor({ hue: null, saturation: null }, {
    light_hue: 0.6, light_saturation: 0.8,
  }), { hue: 0.6, saturation: 0.8 });
  assert.deepEqual(resolveHomeyColor({ hue: 0.6 }, {
    light_hue: null, light_saturation: null,
  }), { hue: 0.6, saturation: 1 });
});

test('partial cloud color state tolerates null entries and missing temperature values', () => {
  const parse = () => ({ h: 120, s: 1 });
  assert.equal(parseGoveeRgbState(null, parse), null);
  assert.deepEqual(parseGoveeRgbState([
    null, { instance: 'colorTemperatureK', state: {} },
    { instance: 'colorRgb', state: { value: 0x00ff00 } },
  ], parse), { mode: 'color', hue: 1 / 3, saturation: 1 });
});

test('invalid RGB payloads are not interpreted as valid colors', () => {
  for (const value of ['', true, {}, -1, 0x1000000, 1.5]) {
    assert.equal(parseGoveeRgbState([
      { instance: 'colorRgb', state: { value } },
    ], () => ({ h: 0, s: 1 })), null);
  }
});

test('real color handler verifies white regardless of its undefined hue', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = require.resolve('../api/govee-device-v2');
  const localRequire = createRequire(filename);
  const context = { module: { exports: {} }, require: id =>
    id === 'homey' ? { Device: class {} } : localRequire(id) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const device = new context.module.exports();
  const sends = [];
  device.data = { model: 'H5089', mac: 'mock-device' };
  device.driver = {
    color: async (...args) => sends.push(args),
    colorCommandGetParser: () => ({ h: 0, s: 0 }),
  };
  device.executeVerifiedCommand = async (_label, send, verify) => {
    await send();
    assert.equal(verify({ capabilitieslist: [
      { instance: 'colorRgb', state: { value: 0xffffff } },
    ] }), true);
    assert.equal(verify({ capabilitieslist: [] }), false);
  };
  await device.executeColorCommand({ hue: 0.65, saturation: 0 });
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], [0.65, 0, 1, 'H5089', 'mock-device']);
});
