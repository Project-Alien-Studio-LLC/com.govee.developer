'use strict';

const TRANSIENT_CODES = new Set([
  'GOVEE_NETWORK_ERROR',
  'GOVEE_TIMEOUT',
]);

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isTransientGoveeError(error) {
  let current = error;
  const visited = new Set();

  while (current && !visited.has(current)) {
    visited.add(current);
    if (TRANSIENT_CODES.has(current.code)) return true;
    if (current.retryable === true) return true;
    if (TRANSIENT_STATUS_CODES.has(Number(current.status))) return true;
    if (/\b(offline|network|fetch failed|timed?\s*out|connection)\b/i.test(String(current.message || ''))) return true;
    current = current.cause;
  }

  return false;
}

class GoveeWarningRecovery {
  constructor() {
    this._clearAfterRefresh = false;
  }

  recordFailure(error) {
    this._clearAfterRefresh = isTransientGoveeError(error);
  }

  recordSuccess() {
    this._clearAfterRefresh = false;
  }

  consumeAfterSuccessfulRefresh() {
    const shouldClear = this._clearAfterRefresh;
    this._clearAfterRefresh = false;
    return shouldClear;
  }
}

module.exports = {
  GoveeWarningRecovery,
  isTransientGoveeError,
};
