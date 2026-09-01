'use strict';

// H5089 reports nightlightToggle through OpenAPI, but current device firmware
// acknowledges remote on/off commands without applying them. Keep its working
// RGB, brightness, scenes, and per-outlet controls while hiding the
// nonfunctional power toggle.
function supportsRemoteNightlightPower(model) {
  return model !== 'H5089';
}

// H5089 firmware also acknowledges nightlight scene value 0 (Forest) without
// changing the active scene. The remaining advertised scene values verify.
function filterSupportedNightlightScenes(model, options = []) {
  if (model !== 'H5089') return options;
  return options.filter((option) => Number(option?.value) !== 0);
}

module.exports = {
  filterSupportedNightlightScenes,
  supportsRemoteNightlightPower,
};
