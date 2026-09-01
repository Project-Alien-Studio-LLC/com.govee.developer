'use strict';

// H5089 reports nightlightToggle through OpenAPI, but current device firmware
// acknowledges remote on/off commands without applying them. Keep its working
// RGB, brightness, scene, and per-outlet controls while hiding only the
// nonfunctional power toggle.
function supportsRemoteNightlightPower(model) {
  return model !== 'H5089';
}

module.exports = { supportsRemoteNightlightPower };
