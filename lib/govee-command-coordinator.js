'use strict';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class GoveeCommandCoordinator {
  constructor({ waitFn = wait } = {}) {
    this._wait = waitFn;
    this._tail = Promise.resolve();
  }

  enqueue(task) {
    const run = this._tail.catch(() => {}).then(task);
    this._tail = run.catch(() => {});
    return run;
  }

  execute({ send, read, verify, attempts = 2, readbackDelayMs = 1200, resend = true, label = 'command' }) {
    return this.enqueue(async () => {
      const totalAttempts = Math.max(1, attempts);
      let lastObserved;
      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        if (attempt === 1 || resend) await send();
        if (!read || !verify) return true;
        await this._wait(readbackDelayMs * attempt);
        lastObserved = await read();
        if (await verify(lastObserved)) return true;
      }
      const error = new Error(`${label} was accepted by Govee but could not be verified on the device`);
      error.code = 'GOVEE_COMMAND_NOT_VERIFIED';
      error.observed = lastObserved;
      throw error;
    });
  }
}

module.exports = { GoveeCommandCoordinator };
