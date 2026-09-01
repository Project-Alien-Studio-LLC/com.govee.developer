'use strict';

const MAX_MQTT_PAYLOAD_BYTES = 64 * 1024;

function parseGoveeMqttMessage(message) {
  if (!Buffer.isBuffer(message) && typeof message !== 'string') {
    throw new Error('MQTT message must be a buffer or string');
  }
  const bytes = Buffer.byteLength(message);
  if (bytes === 0 || bytes > MAX_MQTT_PAYLOAD_BYTES) {
    throw new Error('MQTT message size is invalid');
  }
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (_error) {
    throw new Error('MQTT message contains invalid JSON');
  }
  if (!payload || typeof payload !== 'object' || typeof payload.device !== 'string' || payload.device.length === 0) {
    throw new Error('MQTT message is missing a device identifier');
  }
  if (payload.capabilities !== undefined && !Array.isArray(payload.capabilities)) {
    throw new Error('MQTT message capabilities must be an array');
  }
  return payload;
}

module.exports = { MAX_MQTT_PAYLOAD_BYTES, parseGoveeMqttMessage };
