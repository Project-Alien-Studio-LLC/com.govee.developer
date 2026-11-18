'use strict';

// Memory guards: heavy modules (mqtt, govee-lan-control, tinycolor2) must not
// be loaded at app start, and must still load and behave the same on first use.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const origLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'homey') {
    return { App: class {}, Driver: class {}, Device: class {}, SimpleClass: class {} };
  }
  return origLoad.apply(this, arguments);
};

const root = path.join(__dirname, '..');
const isLoaded = (pkg) => Object.keys(require.cache)
  .some((file) => file.includes(`${path.sep}node_modules${path.sep}${pkg}${path.sep}`));

function stubModule(resolvedPath, exports) {
  const mod = new Module(resolvedPath);
  mod.filename = resolvedPath;
  mod.loaded = true;
  mod.exports = exports;
  require.cache[resolvedPath] = mod;
}

function fakeLocalDriverHomey(app) {
  return { app, log() {}, error() {} };
}

test('app start and driver modules do not load mqtt, govee-lan-control or tinycolor2', () => {
  require('../app.js');
  require('../drivers/govee-local-device/driver.js');
  require('../drivers/govee-local-device/device.js');
  require('../drivers/govee-device/driver.js');
  require('../drivers/govee-ble-sensor/driver.js');
  require('../drivers/govee-ble-sensor/device.js');
  assert.equal(isLoaded('mqtt'), false);
  assert.equal(isLoaded('govee-lan-control'), false);
  assert.equal(isLoaded('tinycolor2'), false);
});

test('local driver with no paired devices does not start the LAN client', async () => {
  const LocalDriver = require('../drivers/govee-local-device/driver.js');
  const driver = new LocalDriver();
  driver.homey = fakeLocalDriverHomey({ localApiClient: null });
  driver.getDevices = () => [];
  driver.log = () => {};
  driver.error = () => {};
  await driver.onInit();
  assert.equal(driver.homey.app.localApiClient, null);
  assert.equal(isLoaded('govee-lan-control'), false);
});

test('tinycolor2 loads on first use and conversions are unchanged', () => {
  const CloudDriver = require('../api/govee-driver-v2');
  const LocalDriver = require('../api/govee-localdriver');
  const tinycolor = require('tinycolor2');
  const cloud = new CloudDriver();
  const local = new LocalDriver();
  assert.equal(cloud.colorCommandSetParser(120, 50, 80), tinycolor({ h: 120, s: 50, v: 80 }).toHex());
  assert.equal(cloud.colorHexCommandSetParser('#FF8800'), 'ff8800');
  assert.deepEqual(cloud.colorCommandGetParser(0xff8800), tinycolor('ff8800').toHsv());
  assert.deepEqual(local.colorCommandSetParser(240, 100, 100), { r: 0, g: 0, b: 255, a: 1 });
  assert.deepEqual(local.colorCommandGetParser({ r: 255, g: 0, b: 0 }), tinycolor({ r: 255, g: 0, b: 0 }).toHsv());
  assert.equal(local.colorHexCommandSetParser('red'), 'ff0000');
});

test('setupMqttReceiver loads mqtt on first use and connects with the same options', async () => {
  const mqttPath = require.resolve('mqtt', { paths: [root] });
  const calls = [];
  const handlers = {};
  const fakeClient = {
    on(event, fn) { handlers[event] = fn; return this; },
    subscribe(topic, cb) { calls.push(['subscribe', topic]); cb?.(null); },
  };
  stubModule(mqttPath, { connect(url, options) { calls.push(['connect', url, options]); return fakeClient; } });

  const GoveeApp = require('../app.js');
  const app = new GoveeApp();
  app.log = () => {};
  app.error = () => {};
  app.mqttClient = null;
  app.eventBus = new (require('node:events').EventEmitter)();
  app.homey = { settings: { get: (key) => (key === 'api_key' ? 'KEY' : null) } };

  await app.setupMqttReceiver();
  assert.deepEqual(calls[0], ['connect', 'mqtts://mqtt.openapi.govee.com', {
    clean: true, username: 'KEY', password: 'KEY', reconnectPeriod: 5000, connectTimeout: 10000,
  }]);
  handlers.connect();
  assert.deepEqual(calls[1], ['subscribe', 'GA/KEY']);
  assert.equal(app.mqttClient, fakeClient);

  // A second call is a no-op while connected.
  await app.setupMqttReceiver();
  assert.equal(calls.filter((c) => c[0] === 'connect').length, 1);

  // No API key: nothing connects.
  const noKey = new GoveeApp();
  noKey.log = () => {}; noKey.error = () => {};
  noKey.mqttClient = null;
  noKey.homey = { settings: { get: () => null } };
  await noKey.setupMqttReceiver();
  assert.equal(noKey.mqttClient, null);
  delete require.cache[mqttPath];
});

test('LAN client is created once for paired devices, on pairing, and wired to the event bus', async () => {
  let constructed = 0;
  const { EventEmitter } = require('node:events');
  class FakeLocalClient {
    constructor() {
      constructed += 1;
      this.GoveeClient = new EventEmitter();
      this.localDevices = [];
    }
    getInitError() { return null; }
    isClientReady() { return true; }
    triggerDiscovery() {}
  }
  stubModule(require.resolve('../api/govee-localapi'), { GoveeClient: FakeLocalClient });

  const LocalDriver = require('../drivers/govee-local-device/driver.js');

  // One paired device: driver init starts the client exactly once.
  const bus = new EventEmitter();
  const driver = new LocalDriver();
  driver.homey = fakeLocalDriverHomey({ localApiClient: null, eventBus: bus });
  driver.getDevices = () => [{}];
  driver.log = () => {};
  driver.error = () => {};
  await driver.onInit();
  driver.ensureLocalClient();
  assert.equal(constructed, 1);
  const seen = [];
  bus.on('local_device_online_abc', (v) => seen.push(v));
  driver.homey.app.localApiClient.GoveeClient.emit('deviceAdded', { deviceID: 'abc', model: 'H6000' });
  driver.homey.app.localApiClient.GoveeClient.emit('deviceOffline', { deviceID: 'abc', model: 'H6000' });
  driver.homey.app.localApiClient.GoveeClient.emit('deviceOnline', { deviceID: 'abc', model: 'H6000' });
  assert.deepEqual(seen, [true, false, true]);

  // No paired devices: opening pairing creates the client.
  const pairing = new LocalDriver();
  pairing.homey = fakeLocalDriverHomey({ localApiClient: null, eventBus: new EventEmitter() });
  pairing.getDevices = () => [];
  pairing.log = () => {};
  pairing.error = () => {};
  await pairing.onInit();
  assert.equal(pairing.homey.app.localApiClient, null);
  const handlers = {};
  await pairing.onPair({ setHandler(name, fn) { handlers[name] = fn; } });
  assert.ok(pairing.homey.app.localApiClient instanceof FakeLocalClient);
  assert.equal(typeof handlers.list_devices, 'function');
  assert.equal(constructed, 2);
});

test('BLE sensors polling together share one scan and each gets its own reading', async () => {
  const BleDriver = require('../drivers/govee-ble-sensor/driver.js');
  const BleDevice = require('../drivers/govee-ble-sensor/device.js');

  // H5075 payload: 3 bytes packed temp/humidity + battery (see lib/ble-parser).
  const h5075 = (tempC, hum, battery) => {
    const packed = Math.round(tempC * 10) * 1000 + Math.round(hum * 10);
    const buf = Buffer.alloc(6);
    buf.writeUInt16LE(0xec88, 0);
    buf[2] = (packed >> 16) & 0xff; buf[3] = (packed >> 8) & 0xff; buf[4] = packed & 0xff; buf[5] = battery;
    return buf;
  };
  const sensors = [
    { uuid: 'u1', address: 'a1', t: 21.5, h: 40.1 },
    { uuid: 'u2', address: 'a2', t: 18.2, h: 55.3 },
    { uuid: 'u3', address: 'a3', t: 25.0, h: 33.3 },
  ];
  let discoverCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const timers = [];
  const homey = {
    ble: {
      async discover() {
        discoverCalls += 1;
        await gate;
        return sensors.map((s) => ({ uuid: s.uuid, address: s.address, localName: 'GVH5075_X', manufacturerData: h5075(s.t, s.h, 90) }));
      },
    },
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); timers.push(t); return t; },
  };
  const driver = new BleDriver();
  driver.homey = homey;

  const devices = sensors.map((s) => {
    const device = new BleDevice();
    device.homey = homey;
    device.driver = driver;
    device._uuid = s.uuid;
    device._address = s.address;
    device._model = 'H5075';
    device.values = {};
    device.log = () => {};
    device.error = () => {};
    device.hasCapability = () => true;
    device.setCapabilityValue = async (cap, value) => { device.values[cap] = value; };
    return device;
  });

  const polls = devices.map((d) => d._pollBleData());
  release();
  await Promise.all(polls);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(discoverCalls, 1);
  const { parseByModel } = require('../lib/ble-parser');
  sensors.forEach((s, i) => {
    const expected = parseByModel('H5075', h5075(s.t, s.h, 90));
    assert.ok(expected, 'fixture must parse');
    assert.equal(devices[i].values.measure_temperature, expected.temperature);
    assert.equal(devices[i].values.measure_humidity, expected.humidity);
  });

  // A poll shortly after reuses the finished scan; after the reuse window a new scan runs.
  await devices[0]._pollBleData();
  assert.equal(discoverCalls, 1);
  driver._sharedScan = null; // simulate the reuse window expiring
  await devices[0]._pollBleData();
  assert.equal(discoverCalls, 2);
  timers.forEach(clearTimeout);
});

test('a failed shared BLE scan is not cached', async () => {
  const BleDriver = require('../drivers/govee-ble-sensor/driver.js');
  let calls = 0;
  const driver = new BleDriver();
  driver.homey = {
    ble: { async discover() { calls += 1; if (calls === 1) throw new Error('stall'); return []; } },
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); return t; },
  };
  await assert.rejects(driver.getSharedAdvertisements(), /stall/);
  assert.deepEqual(await driver.getSharedAdvertisements(), []);
  assert.equal(calls, 2);
});

test('a hung shared BLE scan does not block later polls from scanning again', async () => {
  const BleDriver = require('../drivers/govee-ble-sensor/driver.js');
  let calls = 0;
  const driver = new BleDriver();
  driver.homey = {
    ble: {
      discover() {
        calls += 1;
        if (calls === 1) return new Promise(() => {}); // BLE stack stall: never settles
        return Promise.resolve([{ uuid: 'u1' }]);
      },
    },
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); return t; },
  };
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    driver.getSharedAdvertisements(); // never settles
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    now += 10000; // a poll during a normal ~10 s scan still joins it
    driver.getSharedAdvertisements();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    now += 20000; // next 30 s poll: the stuck scan is abandoned
    assert.deepEqual(await driver.getSharedAdvertisements(), [{ uuid: 'u1' }]);
    assert.equal(calls, 2);
  } finally {
    Date.now = realNow;
  }
});
