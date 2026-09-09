'use strict';

function findCapability(capabilities, instance) {
  if (!Array.isArray(capabilities)) return null;
  return capabilities.find((entry) => entry && entry.instance === instance) || null;
}

function findCapabilityValue(capabilities, instance) {
  const capability = findCapability(capabilities, instance);
  if (!capability || !capability.state || !Object.prototype.hasOwnProperty.call(capability.state, 'value')) {
    return undefined;
  }
  return capability.state.value;
}

function parseBinaryState(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return undefined;
}

function nearlyEqual(actual, expected, tolerance = 0.02) {
  return Number.isFinite(actual)
    && Number.isFinite(expected)
    && Math.abs(actual - expected) <= tolerance;
}

module.exports = { findCapability, findCapabilityValue, nearlyEqual, parseBinaryState };
