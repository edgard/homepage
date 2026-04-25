(function attachStreamRuntime(global) {
  let runtimeContext = null;
  let healthTimer = null;
  let outageSince = null;

  function configure(options) {
    runtimeContext = {
      config: options.config || {},
      phases: options.phases || {},
      streamStates: options.streamStates,
      streamVideos: options.streamVideos,
      attachStreamOverride: options.attachStream || null,
      enqueueRetryAttach: options.enqueueRetryAttach,
      getRetryDelay: options.getRetryDelay,
      setStreamPhase: options.setStreamPhase,
      clearRetryQueue: options.clearRetryQueue || (() => {}),
    };

    return api;
  }

  function context() {
    if (!runtimeContext) {
      throw new Error('KrakowStreamRuntime must be configured before use.');
    }

    return runtimeContext;
  }

  function config(key) {
    return context().config[key];
  }

  function streams() {
    return context().streamVideos;
  }

  function states() {
    return context().streamStates;
  }

  function markPhase(state, phaseKey, detail) {
    const phase = context().phases[phaseKey];
    context().setStreamPhase(state, phase, detail);
  }

  function attachAllStreams() {
    streams().forEach((video, index) => {
      queueAttach(video, index * config('INITIAL_ATTACH_STAGGER_MS'));
    });
  }

  function attachStream(video) {
    if (context().attachStreamOverride) {
      context().attachStreamOverride(video);
      return;
    }

    const state = states().get(video);
    if (!state || state.attached) return;

    clearAttachTimer(state);
    state.attached = true;
    clearRetryTimer(state);
    markPhase(state, 'CONNECTING');
    setStreamStatus(state, 'Connecting...', 'info');
    state.skeleton.classList.remove('hidden');
    state.lastProgressAt = Date.now();
    state.lastCurrentTime = 0;
    state.lastBufferedEnd = 0;
    state.bufferingSince = 0;
    clearNudgeCheckTimer(state);
    state.networkRecoveryCount = 0;
    state.lastLiveNudgeAt = 0;

    bindVideoListeners(state);
    startStartupTimer(state);
    startWatchdog(state);

    const nativeSupport = video.canPlayType('application/vnd.apple.mpegurl');
    if (nativeSupport && nativeSupport !== 'no') {
      video.src = state.source.src;
      attemptPlay(state);
      return;
    }

    if (!window.Hls || !Hls.isSupported()) {
      failStream(state, 'Stream format not supported by this browser');
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      capLevelToPlayerSize: true,
      ignoreDevicePixelRatio: true,
      startLevel: 0,
      liveSyncDurationCount: config('HLS_LIVE_SYNC_DURATION_COUNT'),
      liveMaxLatencyDurationCount: config('HLS_LIVE_MAX_LATENCY_DURATION_COUNT'),
      maxLiveSyncPlaybackRate: 1.2,
      maxBufferLength: config('HLS_MAX_BUFFER_LENGTH_SECONDS'),
      backBufferLength: config('HLS_BACK_BUFFER_LENGTH_SECONDS'),
      abrEwmaDefaultEstimate: 350000,
      manifestLoadingTimeOut: 30000,
      levelLoadingTimeOut: 30000,
      fragLoadingTimeOut: 30000,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 4,
      fragLoadingRetryDelay: 1500,
    });

    state.hls = hls;

    state.hlsErrorListener = (_event, data) => {
      if (!data) return;

      if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
        const nudged = tryNudgeToLive(state, 'Buffer stall detected');
        if (nudged) return;
      }

      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && state.mediaRecoveryCount < 1) {
        state.mediaRecoveryCount += 1;
        try {
          markPhase(state, 'RECOVERING', { reason: 'media error' });
          hls.recoverMediaError();
          setStreamStatus(state, 'Recovering media pipeline...', 'warning');
          return;
        } catch {
          // Continue into normal retry flow.
        }
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && state.networkRecoveryCount < 2) {
        state.networkRecoveryCount += 1;
        state.lastSoftRecoveryAt = Date.now();
        state.lastProgressAt = Date.now();
        markPhase(state, 'RECOVERING', { reason: 'network error' });
        setStreamStatus(state, 'Network hiccup. Re-syncing...', 'warning');
        try {
          hls.startLoad(-1);
          attemptPlay(state);
          return;
        } catch {
          // Fall through to full recovery.
        }
      }

      scheduleRecovery(state, data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'Network interruption' : 'Playback error');
    };

    hls.on(Hls.Events.ERROR, state.hlsErrorListener);
    hls.loadSource(state.source.src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      attemptPlay(state);
    });
  }

  function bindVideoListeners(state) {
    const { video } = state;

    if (!state.playingListener) {
      state.playingListener = () => {
        state.retryCount = 0;
        state.mediaRecoveryCount = 0;
        state.networkRecoveryCount = 0;
        state.lastCurrentTime = video.currentTime || 0;
        state.lastBufferedEnd = getBufferedEnd(video);
        state.lastProgressAt = Date.now();
        state.bufferingSince = 0;
        clearNudgeCheckTimer(state);
        state.skeleton.classList.add('hidden');
        clearStartupTimer(state);
        markPhase(state, 'PLAYING');
        clearStreamStatus(state);
      };
      video.addEventListener('playing', state.playingListener);
    }

    if (!state.canPlayListener) {
      state.canPlayListener = () => {
        state.lastBufferedEnd = getBufferedEnd(video);
        state.lastProgressAt = Date.now();
        state.bufferingSince = 0;
        clearNudgeCheckTimer(state);
      };
      video.addEventListener('canplay', state.canPlayListener);
    }

    if (!state.timeUpdateListener) {
      state.timeUpdateListener = () => {
        state.lastCurrentTime = video.currentTime || 0;
        state.lastBufferedEnd = getBufferedEnd(video);
        state.lastProgressAt = Date.now();
        state.bufferingSince = 0;
        clearNudgeCheckTimer(state);
      };
      video.addEventListener('timeupdate', state.timeUpdateListener);
    }

    if (!state.videoErrorListener) {
      state.videoErrorListener = () => {
        scheduleRecovery(state, 'Video element error');
      };
      video.addEventListener('error', state.videoErrorListener);
    }

    if (!state.stalledListener) {
      state.stalledListener = () => {
        const now = Date.now();
        if (!state.bufferingSince) {
          state.bufferingSince = now;
          markPhase(state, 'BUFFERING', { reason: 'stalled event' });
          return;
        }
        if (now - state.bufferingSince < config('STALL_EVENT_GRACE_MS')) {
          return;
        }
        const nudged = tryNudgeToLive(state, 'Stream stalled');
        if (!nudged) {
          scheduleRecovery(state, 'Stream stalled');
        }
      };
      video.addEventListener('stalled', state.stalledListener);
    }

    if (!state.waitingListener) {
      state.waitingListener = () => {
        if (!state.bufferingSince) {
          state.bufferingSince = Date.now();
          markPhase(state, 'BUFFERING', { reason: 'waiting event' });
        }
      };
      video.addEventListener('waiting', state.waitingListener);
    }
  }

  function attemptPlay(state) {
    const { video } = state;

    const playPromise = video.play();
    if (playPromise === undefined) return;

    playPromise
      .catch(() => {
        video.muted = true;
        return video.play();
      })
      .catch(() => {
        scheduleRecovery(state, 'Autoplay blocked');
      });
  }

  function startStartupTimer(state) {
    clearStartupTimer(state);
    state.startupTimer = setTimeout(() => {
      if (state.attached) {
        scheduleRecovery(state, 'Startup timeout');
      }
    }, config('STARTUP_TIMEOUT_MS'));
  }

  function startWatchdog(state) {
    clearWatchdogTimer(state);

    state.watchdogTimer = setInterval(() => {
      if (!state.attached) return;

      const now = Date.now();
      const { video } = state;
      const bufferedEnd = getBufferedEnd(video);

      if (bufferedEnd > state.lastBufferedEnd + 0.2) {
        state.lastBufferedEnd = bufferedEnd;
        state.lastProgressAt = now;
      }

      if (state.bufferingSince && now - state.bufferingSince < config('BUFFERING_GRACE_MS')) {
        return;
      }

      if (video.paused) {
        const staleFor = now - state.lastProgressAt;
        if (staleFor >= config('STALL_WINDOW_MS')) {
          scheduleRecovery(state, 'Playback paused unexpectedly');
        }
        return;
      }

      const current = video.currentTime || 0;
      if (current > state.lastCurrentTime + 0.01) {
        state.lastCurrentTime = current;
        state.lastProgressAt = Date.now();
        return;
      }

      const stalledFor = now - state.lastProgressAt;
      if (stalledFor < config('STALL_WINDOW_MS')) return;

      const nudged = tryNudgeToLive(state, 'Stream lag detected');
      if (nudged) {
        return;
      }

      if (state.hls && now - state.lastSoftRecoveryAt >= config('SOFT_RECOVERY_COOLDOWN_MS') && state.networkRecoveryCount < 2) {
        state.networkRecoveryCount += 1;
        state.lastSoftRecoveryAt = now;
        state.lastProgressAt = now;
        state.bufferingSince = now;
        markPhase(state, 'RECOVERING', { reason: 'watchdog lag' });
        setStreamStatus(state, 'Stream lag detected. Re-syncing...', 'warning');
        try {
          state.hls.startLoad(-1);
          attemptPlay(state);
          return;
        } catch {
          // Fall through to full recovery.
        }
      }

      const lowBuffer = video.readyState < 2 || bufferedEnd - (video.currentTime || 0) < 0.35;
      if (lowBuffer || stalledFor >= config('STALL_WINDOW_MS') * 2) {
        scheduleRecovery(state, 'Playback heartbeat timeout');
      }
    }, config('STALL_TICK_MS'));
  }

  function scheduleRecovery(state, reason) {
    if (!state.attached || state.retryTimer) return;

    state.retryCount += 1;
    state.bufferingSince = 0;
    clearNudgeCheckTimer(state);
    const retryDelay = context().getRetryDelay(state.retryCount);
    const delay = Math.min(
      retryDelay + Math.floor(Math.random() * config('RETRY_JITTER_MS')),
      config('MAX_RETRY_DELAY_MS')
    );
    const seconds = Math.ceil(delay / 1000);

    markPhase(state, 'RETRYING', {
      reason,
      delayMs: delay,
    });
    teardownStream(state, { keepStatus: true });
    setStreamStatus(state, `${reason}. Retrying in ${seconds}s...`, 'warning');

    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      context().enqueueRetryAttach(state.video);
    }, delay);
  }

  function failStream(state, message) {
    markPhase(state, 'FAILED', { reason: message });
    teardownStream(state, { keepStatus: true });
    state.skeleton.classList.add('hidden');
    setStreamStatus(state, message, 'error');
  }

  function teardownStream(state, { keepStatus = false } = {}) {
    state.attached = false;
    state.bufferingSince = 0;
    clearNudgeCheckTimer(state);

    clearStartupTimer(state);
    clearWatchdogTimer(state);

    const { video } = state;
    video.pause();

    if (state.hls) {
      if (state.hlsErrorListener && window.Hls) {
        state.hls.off(Hls.Events.ERROR, state.hlsErrorListener);
      }
      state.hls.destroy();
      state.hls = null;
      state.hlsErrorListener = null;
    }

    video.removeAttribute('src');
    video.load();

    if (!keepStatus) {
      clearStreamStatus(state);
    }
  }

  function teardownAllStreams() {
    clearInterval(healthTimer);
    healthTimer = null;
    context().clearRetryQueue();

    streams().forEach((video) => {
      const state = states().get(video);
      if (!state) return;

      clearRetryTimer(state);
      clearAttachTimer(state);
      clearStartupTimer(state);
      clearWatchdogTimer(state);
      teardownStream(state, { keepStatus: false });

      if (state.playingListener) {
        video.removeEventListener('playing', state.playingListener);
        state.playingListener = null;
      }

      if (state.canPlayListener) {
        video.removeEventListener('canplay', state.canPlayListener);
        state.canPlayListener = null;
      }

      if (state.timeUpdateListener) {
        video.removeEventListener('timeupdate', state.timeUpdateListener);
        state.timeUpdateListener = null;
      }

      if (state.videoErrorListener) {
        video.removeEventListener('error', state.videoErrorListener);
        state.videoErrorListener = null;
      }

      if (state.stalledListener) {
        video.removeEventListener('stalled', state.stalledListener);
        state.stalledListener = null;
      }

      if (state.waitingListener) {
        video.removeEventListener('waiting', state.waitingListener);
        state.waitingListener = null;
      }

      if (state.fullscreenBtn && state.fullscreenClickListener) {
        state.fullscreenBtn.removeEventListener('click', state.fullscreenClickListener);
        state.fullscreenClickListener = null;
      }

      if (state.wrapper && state.hoverInListener) {
        state.wrapper.removeEventListener('mouseenter', state.hoverInListener);
        state.hoverInListener = null;
      }

      if (state.wrapper && state.hoverOutListener) {
        state.wrapper.removeEventListener('mouseleave', state.hoverOutListener);
        state.hoverOutListener = null;
      }

      states().delete(video);
    });

    streams().length = 0;
  }

  function startGlobalHealthLoop() {
    clearInterval(healthTimer);

    healthTimer = setInterval(() => {
      let healthyStreams = 0;

      streams().forEach((video) => {
        const state = states().get(video);
        if (!state) return;

        if (!state.attached && !state.retryTimer) {
          queueAttach(video, 200 + Math.floor(Math.random() * 1200));
          return;
        }

        const healthy =
          state.attached &&
          !video.paused &&
          Date.now() - state.lastProgressAt < config('STALL_WINDOW_MS') * 1.5;

        if (healthy) {
          healthyStreams += 1;
        }
      });

      if (streams().length === 0 || !navigator.onLine) {
        outageSince = null;
        return;
      }

      if (healthyStreams > 0) {
        outageSince = null;
        return;
      }

      if (!outageSince) {
        outageSince = Date.now();
        return;
      }

      if (Date.now() - outageSince >= config('FULL_OUTAGE_RELOAD_MS')) {
        window.location.reload();
      }
    }, 30000);
  }

  function retryAllStreams(resetBackoff) {
    streams().forEach((video, index) => {
      const state = states().get(video);
      if (!state) return;

      if (resetBackoff) {
        state.retryCount = 0;
        state.mediaRecoveryCount = 0;
      }

      clearRetryTimer(state);
      clearAttachTimer(state);

      if (state.attached) {
        teardownStream(state, { keepStatus: false });
      }

      queueAttach(video, index * config('BULK_REATTACH_STAGGER_MS'));
    });
  }

  function getBufferedEnd(video) {
    if (!video || !video.buffered || video.buffered.length === 0) return 0;
    try {
      return video.buffered.end(video.buffered.length - 1);
    } catch {
      return 0;
    }
  }

  function tryNudgeToLive(state, label) {
    if (!state?.attached) return false;

    const now = Date.now();
    if (now - state.lastLiveNudgeAt < config('LIVE_EDGE_NUDGE_COOLDOWN_MS')) {
      return false;
    }

    const { video } = state;
    const current = video.currentTime || 0;
    const bufferedEnd = getBufferedEnd(video);
    const bufferAhead = bufferedEnd - current;
    const seekable = getSeekableRange(video);
    let target = null;

    if (state.hls && Number.isFinite(state.hls.liveSyncPosition)) {
      target = state.hls.liveSyncPosition - 0.15;
    } else if (bufferAhead >= config('LIVE_EDGE_BUFFER_MIN_SECONDS')) {
      target = bufferedEnd - 0.12;
    } else if (seekable.end - seekable.start > 0.25) {
      target = seekable.end - 0.2;
    }

    if (!Number.isFinite(target)) return false;
    if (!Number.isFinite(seekable.start) || !Number.isFinite(seekable.end)) return false;

    target = Math.min(target, seekable.end - 0.05);
    target = Math.max(target, seekable.start + 0.05);

    if (target < 0) target = 0;
    if (Math.abs(target - current) < 0.2) return false;

    try {
      if (state.hls) {
        try {
          state.hls.startLoad(-1);
        } catch {
          // Ignore startLoad hiccups during nudge.
        }
      }

      video.currentTime = target;
      state.lastLiveNudgeAt = now;
      state.lastProgressAt = now;
      state.bufferingSince = now;
      setStreamStatus(state, `${label}. Jumping to live edge...`, 'warning');
      attemptPlay(state);
      startNudgeVerification(state, current);
      return true;
    } catch {
      return false;
    }
  }

  function startNudgeVerification(state, beforeTime) {
    clearNudgeCheckTimer(state);

    state.nudgeCheckTimer = setTimeout(() => {
      state.nudgeCheckTimer = null;
      if (!state.attached) return;

      const now = Date.now();
      const advanced = (state.video.currentTime || 0) > beforeTime + 0.12;
      const recentProgress = now - state.lastProgressAt < 3000;
      if (advanced || recentProgress) {
        return;
      }

      scheduleRecovery(state, 'Live-edge jump did not recover playback');
    }, config('LIVE_EDGE_NUDGE_VERIFY_MS'));
  }

  function clearNudgeCheckTimer(state) {
    if (!state?.nudgeCheckTimer) return;
    clearTimeout(state.nudgeCheckTimer);
    state.nudgeCheckTimer = null;
  }

  function getSeekableRange(video) {
    if (!video?.seekable || video.seekable.length === 0) {
      return { start: NaN, end: NaN };
    }

    try {
      const endIndex = video.seekable.length - 1;
      return {
        start: video.seekable.start(0),
        end: video.seekable.end(endIndex),
      };
    } catch {
      return { start: NaN, end: NaN };
    }
  }

  function setStreamStatus(state, message, kind = 'info') {
    state.status.dataset.kind = kind;
    state.status.classList.add('visible');
    state.statusText.textContent = message;
  }

  function clearStreamStatus(state) {
    state.status.classList.remove('visible');
    state.status.dataset.kind = 'info';
    state.statusText.textContent = '';
  }

  function clearStartupTimer(state) {
    if (!state.startupTimer) return;
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
  }

  function clearRetryTimer(state) {
    if (!state.retryTimer) return;
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }

  function queueAttach(video, delayMs = 0) {
    const state = states().get(video);
    if (!state || state.attached || state.retryTimer || state.attachTimer) return;

    state.attachTimer = setTimeout(() => {
      state.attachTimer = null;
      if (!state.attached && !state.retryTimer) {
        attachStream(video);
      }
    }, Math.max(0, delayMs));
  }

  function clearAttachTimer(state) {
    if (!state?.attachTimer) return;
    clearTimeout(state.attachTimer);
    state.attachTimer = null;
  }

  function clearWatchdogTimer(state) {
    if (!state.watchdogTimer) return;
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }

  const api = {
    attachAllStreams,
    clearAttachTimer,
    clearRetryTimer,
    clearStartupTimer,
    clearWatchdogTimer,
    configure,
    getBufferedEnd,
    getSeekableRange,
    queueAttach,
    retryAllStreams,
    setStreamStatus,
    startGlobalHealthLoop,
    teardownAllStreams,
  };

  global.KrakowStreamRuntime = api;
})(typeof window !== 'undefined' ? window : self);
