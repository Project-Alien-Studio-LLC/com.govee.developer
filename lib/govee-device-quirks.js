'use strict';

// H5089 reports nightlightToggle through OpenAPI, but current device firmware
// acknowledges remote on/off commands without applying them. Keep its working
// RGB, brightness, scenes, and per-outlet controls while hiding the
// nonfunctional power toggle.
function supportsRemoteNightlightPower(model) {
  return model !== 'H5089';
}

// H5089's powerSwitch controls the entire extender, not its nightlight. Exposing
// it as Homey's standard onoff capability makes the device tile a dangerous
// master-power switch, so keep it out of the Homey UI.
function exposesMasterPowerControl(model) {
  return model !== 'H5089';
}

// Reject only master OFF at the command boundary so future call sites cannot
// accidentally interrupt connectivity. The two individual outlets retain
// their normal ON/OFF controls.
function assertPowerCommandAllowed(model, instance, value) {
  const isOff = value === false || value === 0 || value === '0';
  if (model !== 'H5089' || instance !== 'powerSwitch' || !isOff) return;

  const error = new Error(`${instance} OFF commands are disabled for H5089 to protect network power`);
  error.code = 'GOVEE_POWER_OFF_PROTECTED';
  throw error;
}

// H5089 firmware also acknowledges nightlight scene value 0 (Forest) without
// changing the active scene. The remaining advertised scene values verify.
function filterSupportedNightlightScenes(model, options = []) {
  if (model !== 'H5089') return options;
  return options.filter((option) => Number(option?.value) !== 0);
}

module.exports = {
  assertPowerCommandAllowed,
  exposesMasterPowerControl,
  filterSupportedNightlightScenes,
  supportsRemoteNightlightPower,
};
