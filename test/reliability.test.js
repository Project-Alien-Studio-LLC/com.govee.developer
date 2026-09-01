'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGoveeMqttMessage, MAX_MQTT_PAYLOAD_BYTES } = require('../lib/govee-mqtt');
const { findCapabilityValue, nearlyEqual } = require('../lib/govee-state');
const { GoveePollScheduler } = require('../lib/govee-poll-scheduler');
const { GoveeCommandCoordinator } = require('../lib/govee-command-coordinator');
const { GoveeClient } = require('../api/govee-api-v2');
const { SharedDevice } = require('../api/govee-shared-device');

test('MQTT parser accepts validated device events and rejects malformed input', () => {
  const payload = parseGoveeMqttMessage(Buffer.from(JSON.stringify({
    device: 'device-1',
    capabilities: [],
  })));
  assert.equal(payload.device, 'device-1');
  assert.throws(() => parseGoveeMqttMessage('{'), /invalid JSON/);
  assert.throws(() => parseGoveeMqttMessage('{}'), /device identifier/);
  assert.throws(
    () => parseGoveeMqttMessage(JSON.stringify({ device: 'device-1', capabilities: {} })),
    /must be an array/,
  );
  assert.throws(() => parseGoveeMqttMessage('x'.repeat(MAX_MQTT_PAYLOAD_BYTES + 1)), /size is invalid/);
});

test('state helper tolerates partial capability payloads', () => {
  assert.equal(findCapabilityValue(undefined, 'powerSwitch'), undefined);
  assert.equal(findCapabilityValue([null, { instance: 'powerSwitch' }], 'powerSwitch'), undefined);
  assert.equal(findCapabilityValue([{ instance: 'powerSwitch', state: { value: 1 } }], 'powerSwitch'), 1);
  assert.equal(nearlyEqual(0.51, 0.5, 0.02), true);
  assert.equal(nearlyEqual(undefined, 0.5), false);
});

test('poll scheduler runs due device refreshes serially', async () => {
  let now = 1000;
  let callback;
  const calls = [];
  const scheduler = new GoveePollScheduler({
    setInterval: (fn) => { callback = fn; return 1; },
    clearInterval: () => {},
    now: () => now,
    random: () => 0,
  });
  scheduler.register('a', async () => calls.push('a'), 60000);
  scheduler.register('b', async () => calls.push('b'), 60000);
  assert.equal(typeof callback, 'function');
  assert.equal(await scheduler.tick(), true);
  assert.deepEqual(calls, ['a']);
  assert.equal(await scheduler.tick(), true);
  assert.deepEqual(calls, ['a', 'b']);
  now += 60000;
  assert.equal(await scheduler.tick(), true);
  assert.equal(calls.length, 3);
  scheduler.stop();
});

test('command coordinator retries idempotent commands until readback verifies', async () => {
  let sends = 0;
  let reads = 0;
  const coordinator = new GoveeCommandCoordinator({ waitFn: async () => {} });
  await coordinator.execute({
    label: 'power',
    send: async () => { sends += 1; },
    read: async () => { reads += 1; return reads; },
    verify: (observed) => observed === 2,
    attempts: 2,
  });
  assert.equal(sends, 2);
  assert.equal(reads, 2);
});

test('command coordinator serializes concurrent commands', async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const coordinator = new GoveeCommandCoordinator();
  const first = coordinator.execute({
    send: async () => { events.push('first-start'); await firstGate; events.push('first-end'); },
  });
  const second = coordinator.execute({ send: async () => events.push('second') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
});

test('Flow cards register once and route actions through args.device', async () => {
  const registrations = new Set();
  let listener;
  let registerCount = 0;
  const actionCard = {
    registerRunListener: (handler) => { listener = handler; registerCount += 1; },
  };
  const app = {
    claimFlowRegistration: (key) => {
      if (registrations.has(key)) return false;
      registrations.add(key);
      return true;
    },
  };
  const makeDevice = () => ({
    goveedevicetype: 'socket',
    homey: { app, flow: { getActionCard: async () => actionCard } },
    log: () => {},
  });
  const firstDevice = makeDevice();
  const secondDevice = makeDevice();
  const shared = new SharedDevice();
  await shared.setupFlowNightLight(firstDevice);
  await shared.setupFlowNightLight(secondDevice);
  assert.equal(registerCount, 1);

  let routedValue;
  const selectedDevice = {
    log: () => {},
    onCapabilityNightlight: async (value) => { routedValue = value; },
  };
  await listener({ device: selectedDevice, activate: true });
  assert.equal(routedValue, true);
});

function response(status, data, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] },
    text: async () => JSON.stringify(data),
  };
}

test('cloud API retries rate limits and preserves request diagnostics', async () => {
  const calls = [];
  const client = new GoveeClient({
    api_key: 'secret',
    max_retries: 1,
    wait: async () => {},
    fetch: async (_url, config) => {
      calls.push(config);
      return calls.length === 1
        ? response(429, { code: 429, msg: 'slow down' }, { 'retry-after': '0' })
        : response(200, { code: 200, payload: { ok: true } });
    },
  });
  const result = await client.request('/device/state', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'request-123' }),
  });
  assert.equal(result.payload.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['Govee-API-Key'], 'secret');
});

test('cloud API reports non-JSON and non-retryable failures clearly', async () => {
  const client = new GoveeClient({
    api_key: 'secret',
    max_retries: 0,
    fetch: async () => ({ status: 401, headers: { get: () => null }, text: async () => 'unauthorized' }),
  });
  await assert.rejects(() => client.request('/ping'), /non-JSON response/);
});
