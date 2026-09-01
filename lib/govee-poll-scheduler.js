'use strict';

class GoveePollScheduler {
  constructor({ setInterval, clearInterval, now = Date.now, random = Math.random, logger = () => {}, tickMs = 5000 }) {
    this._setInterval = setInterval;
    this._clearInterval = clearInterval;
    this._now = now;
    this._random = random;
    this._logger = logger;
    this._tickMs = tickMs;
    this._entries = new Map();
    this._timer = null;
    this._busy = false;
  }

  register(key, task, intervalMs, { immediate = false } = {}) {
    const interval = Math.max(60000, Number(intervalMs) || 60000);
    const jitter = Math.floor(interval * 0.1 * this._random());
    this._entries.set(key, {
      task,
      interval,
      nextAt: immediate ? this._now() : this._now() + jitter,
    });
    this.start();
  }

  unregister(key) {
    this._entries.delete(key);
    if (this._entries.size === 0) this.stop();
  }

  start() {
    if (this._timer) return;
    this._timer = this._setInterval(() => {
      void this.tick();
    }, this._tickMs);
  }

  stop() {
    if (this._timer) this._clearInterval(this._timer);
    this._timer = null;
    this._busy = false;
  }

  async tick() {
    if (this._busy) return false;
    const now = this._now();
    const due = [...this._entries.entries()]
      .filter(([, entry]) => entry.nextAt <= now)
      .sort((a, b) => a[1].nextAt - b[1].nextAt)[0];
    if (!due) return false;

    const [key, entry] = due;
    this._busy = true;
    try {
      await entry.task();
    } catch (error) {
      this._logger(`Scheduled refresh failed for ${key}: ${error.message}`);
    } finally {
      const current = this._entries.get(key);
      if (current) {
        const jitter = Math.floor(current.interval * 0.1 * this._random());
        current.nextAt = this._now() + current.interval + jitter;
      }
      this._busy = false;
    }
    return true;
  }
}

module.exports = { GoveePollScheduler };
