(function attachStreamSupervisor(global) {
  function getRetryDelay(retryCount, options) {
    const retryStep = Math.min(Math.max(retryCount - 1, 0), 6);
    return Math.min(options.baseMs * (2 ** retryStep), options.maxMs);
  }

  function createRetryQueue(options) {
    const pending = [];
    const intervalMs = options.intervalMs;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const attach = options.attach;
    let drainTimer = null;

    function enqueue(video) {
      pending.push(video);
      scheduleDrain(0);
    }

    function clear() {
      pending.length = 0;
      if (drainTimer) {
        clearTimer(drainTimer);
        drainTimer = null;
      }
    }

    function scheduleDrain(delay) {
      if (drainTimer || pending.length === 0) return;
      drainTimer = setTimer(drain, delay);
    }

    function drain() {
      drainTimer = null;
      const video = pending.shift();
      if (video) {
        attach(video);
      }
      if (pending.length > 0) {
        scheduleDrain(intervalMs);
      }
    }

    return {
      enqueue,
      clear,
      size() {
        return pending.length;
      },
    };
  }

  global.KrakowStreamSupervisor = {
    createRetryQueue,
    getRetryDelay,
  };
})(typeof window !== 'undefined' ? window : self);
