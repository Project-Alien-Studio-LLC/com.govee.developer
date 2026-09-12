'use strict';

function clampUnit(value, fallback) {
  if (value === null || value === undefined || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function resolveHomeyColor(values = {}, currentState = {}) {
  return {
    hue: clampUnit(values.hue, clampUnit(currentState.light_hue, 0)),
    saturation: clampUnit(
      values.saturation,
      clampUnit(currentState.light_saturation, 1),
    ),
  };
}

function parseGoveeRgbState(capabilities = [], parseColor) {
  if (!Array.isArray(capabilities)) return null;
  const colorCapability = capabilities.find((entry) => entry?.instance === 'colorRgb');
  const temperatureCapability = capabilities.find(
    (entry) => entry?.instance === 'colorTemperatureK',
  );

  const temperature = Number(temperatureCapability?.state?.value);
  if (Number.isFinite(temperature) && temperature > 0) {
    return { mode: 'temperature', hue: null, saturation: null };
  }

  const rgbValue = colorCapability?.state?.value;
  if (typeof rgbValue !== 'number' && typeof rgbValue !== 'string') return null;
  if (typeof rgbValue === 'string' && rgbValue.trim() === '') return null;

  const numericRgb = Number(rgbValue);
  if (!Number.isInteger(numericRgb) || numericRgb < 0 || numericRgb > 0xffffff) return null;

  const hsv = parseColor(numericRgb);
  if (!hsv || !Number.isFinite(Number(hsv.h)) || !Number.isFinite(Number(hsv.s))) {
    return null;
  }

  return {
    mode: 'color',
    hue: clampUnit(Number(hsv.h) / 360, 0),
    saturation: clampUnit(hsv.s, 1),
  };
}

module.exports = {
  parseGoveeRgbState,
  resolveHomeyColor,
};
