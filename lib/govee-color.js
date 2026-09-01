'use strict';

function clampUnit(value, fallback) {
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
  const colorCapability = capabilities.find((entry) => entry.instance === 'colorRgb');
  const temperatureCapability = capabilities.find(
    (entry) => entry.instance === 'colorTemperatureK',
  );

  if (temperatureCapability && Number(temperatureCapability.state?.value) !== 0) {
    return { mode: 'temperature', hue: null, saturation: null };
  }

  const rgbValue = colorCapability?.state?.value;
  if (rgbValue === null || rgbValue === undefined) return null;

  const numericRgb = Number(rgbValue);
  if (!Number.isFinite(numericRgb)) return null;

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
