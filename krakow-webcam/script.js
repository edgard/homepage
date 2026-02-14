const APP_VERSION = '20260214-1';
const STARTUP_TIMEOUT_MS = 12000;
const STALL_WINDOW_MS = 40000;
const STALL_TICK_MS = 4000;
const BUFFERING_GRACE_MS = 25000;
const STALL_EVENT_GRACE_MS = 6000;
const BASE_RETRY_DELAY_MS = 1500;
const MAX_RETRY_DELAY_MS = 20000;
const SOFT_RECOVERY_COOLDOWN_MS = 15000;
const LIVE_EDGE_NUDGE_COOLDOWN_MS = 12000;
const LIVE_EDGE_BUFFER_MIN_SECONDS = 0.6;
const LIVE_EDGE_NUDGE_VERIFY_MS = 6000;
const HLS_LIVE_SYNC_DURATION_COUNT = 5;
const HLS_LIVE_MAX_LATENCY_DURATION_COUNT = 12;
const HLS_MAX_BUFFER_LENGTH_SECONDS = 45;
const HLS_BACK_BUFFER_LENGTH_SECONDS = 90;
const INITIAL_ATTACH_STAGGER_MS = 220;
const RETRY_JITTER_MS = 1200;
const BULK_REATTACH_STAGGER_MS = 140;
const RESIZE_DEBOUNCE_MS = 180;
const SOFT_RELOAD_MS = 6 * 60 * 60 * 1000;
const FULL_OUTAGE_RELOAD_MS = 2 * 60 * 1000;

let allSources = [];
let resizeTimer = null;
let healthTimer = null;
let reloadTimer = null;
let outageSince = null;
let fullscreenListenersBound = false;

const streamStates = new WeakMap();
const streamVideos = [];

document.addEventListener('DOMContentLoaded', async () => {
  await disableLegacyServiceWorkers();
  bindFullscreenListeners();

  allSources = await loadStreams();
  if (allSources.length === 0) {
    showNoResults('Unable to load streams');
    return;
  }

  renderDashboard();
  scheduleSoftReload();

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      applyDashboardLayout();
    }, RESIZE_DEBOUNCE_MS);
  });

  window.addEventListener('online', () => {
    retryAllStreams(true);
  });

  window.addEventListener('offline', () => {
    streamVideos.forEach((video) => {
      const state = streamStates.get(video);
      if (state) {
        setStreamStatus(state, 'Offline. Waiting for network...', 'warning');
      }
    });
  });
});

async function disableLegacyServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch (error) {
    console.warn('Service worker cleanup failed:', error);
  }

  if (!('caches' in window)) return;

  try {
    const keys = await caches.keys();
    const staleKeys = keys.filter((key) => key.startsWith('krakow-webcam-'));
    await Promise.all(staleKeys.map((key) => caches.delete(key)));
  } catch (error) {
    console.warn('Cache cleanup failed:', error);
  }
}

async function loadStreams() {
  try {
    const response = await fetch(`streams.json?v=${APP_VERSION}&ts=${Date.now()}`, {
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) return [];

    return payload.filter((source) => typeof source?.src === 'string' && source.src.length > 0);
  } catch (error) {
    console.error('Failed to load streams:', error);
    return [];
  }
}

function renderDashboard() {
  const grid = document.getElementById('videoGrid');
  const noResults = document.getElementById('noResults');
  if (!grid || !noResults) return;

  outageSince = null;
  teardownAllStreams();

  if (allSources.length === 0) {
    showNoResults('No streams available');
    return;
  }

  noResults.hidden = true;
  grid.style.display = 'grid';
  grid.innerHTML = '';

  const fragment = document.createDocumentFragment();
  allSources.forEach((source) => {
    fragment.appendChild(createStreamCard(source));
  });

  grid.appendChild(fragment);
  applyDashboardLayout();
  attachAllStreams();
  syncFullscreenState();
  startGlobalHealthLoop();
}

function applyDashboardLayout() {
  const grid = document.getElementById('videoGrid');
  if (!grid) return;

  const layout = computeLayout(allSources.length);
  document.documentElement.style.setProperty('--dashboard-cols', String(layout.cols));
  document.documentElement.style.setProperty('--dashboard-rows', String(layout.rows));
  stretchLastRow(grid, layout.cols);
}

function computeLayout(totalStreams) {
  const total = Math.max(1, totalStreams);
  const width = Math.max(window.innerWidth, 320);
  const height = Math.max(window.innerHeight, 240);
  const gap = width >= 1000 ? 4 : 3;
  const targetAspect = 16 / 9;

  let best = null;

  for (let cols = 1; cols <= total; cols += 1) {
    const rows = Math.ceil(total / cols);
    const cellWidth = (width - (cols - 1) * gap) / cols;
    const cellHeight = (height - (rows - 1) * gap) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;

    const aspectScore = Math.abs(Math.log((cellWidth / cellHeight) / targetAspect));
    const emptyCells = cols * rows - total;
    const score = aspectScore + emptyCells * 0.08;

    if (!best || score < best.score) {
      best = { cols, rows, score };
    }
  }

  if (!best) {
    const fallbackCols = Math.ceil(Math.sqrt(total));
    return { cols: fallbackCols, rows: Math.ceil(total / fallbackCols) };
  }

  return { cols: best.cols, rows: best.rows };
}

function createStreamCard(source) {
  const card = document.createElement('article');
  card.className = 'video-container';

  const header = document.createElement('div');
  header.className = 'video-header';

  const title = document.createElement('h2');
  title.textContent = source.title || 'Live Stream';
  header.appendChild(title);

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.type = 'button';
  fullscreenBtn.className = 'fullscreen-btn';
  fullscreenBtn.textContent = 'FS';
  fullscreenBtn.title = 'Fullscreen';
  fullscreenBtn.setAttribute('aria-label', 'Fullscreen');
  header.appendChild(fullscreenBtn);

  const wrapper = document.createElement('div');
  wrapper.className = 'video-wrapper';

  const skeleton = document.createElement('div');
  skeleton.className = 'skeleton-loader';
  wrapper.appendChild(skeleton);

  const status = document.createElement('div');
  status.className = 'stream-status';
  status.dataset.kind = 'info';

  const statusText = document.createElement('p');
  statusText.className = 'stream-status-text';
  status.appendChild(statusText);
  wrapper.appendChild(status);

  const video = document.createElement('video');
  video.autoplay = true;
  video.controls = false;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'none';
  if (source.isVertical) {
    video.classList.add('vertical-video');
  }
  wrapper.appendChild(video);

  const fullscreenClickListener = (event) => {
    event.stopPropagation();
    toggleStreamFullscreen(card, video);
  };
  fullscreenBtn.addEventListener('click', fullscreenClickListener);

  const hoverInListener = () => {
    video.controls = true;
  };
  const hoverOutListener = () => {
    if (!isCardInFullscreen(card)) {
      video.controls = false;
    }
  };
  wrapper.addEventListener('mouseenter', hoverInListener);
  wrapper.addEventListener('mouseleave', hoverOutListener);

  streamStates.set(video, {
    source,
    card,
    wrapper,
    video,
    skeleton,
    status,
    statusText,
    fullscreenBtn,
    fullscreenClickListener,
    hoverInListener,
    hoverOutListener,
    hls: null,
    attached: false,
    playingListener: null,
    canPlayListener: null,
    timeUpdateListener: null,
    videoErrorListener: null,
    stalledListener: null,
    waitingListener: null,
    hlsErrorListener: null,
    startupTimer: null,
    retryTimer: null,
    attachTimer: null,
    nudgeCheckTimer: null,
    watchdogTimer: null,
    retryCount: 0,
    mediaRecoveryCount: 0,
    networkRecoveryCount: 0,
    lastSoftRecoveryAt: 0,
    lastLiveNudgeAt: 0,
    lastCurrentTime: 0,
    lastBufferedEnd: 0,
    lastProgressAt: Date.now(),
    bufferingSince: 0,
  });

  streamVideos.push(video);

  card.appendChild(header);
  card.appendChild(wrapper);
  return card;
}

function stretchLastRow(grid, cols) {
  const cards = Array.from(grid.children);
  cards.forEach((card) => {
    card.style.gridColumn = '';
  });
  if (cols <= 1) return;

  const remainder = cards.length % cols;
  if (remainder === 0) return;

  const start = cards.length - remainder;
  const baseSpan = Math.floor(cols / remainder);
  let extras = cols - baseSpan * remainder;

  for (let i = 0; i < remainder; i += 1) {
    const span = baseSpan + (extras > 0 ? 1 : 0);
    if (extras > 0) extras -= 1;
    if (span > 1) {
      cards[start + i].style.gridColumn = `span ${span}`;
    }
  }
}

function attachAllStreams() {
  streamVideos.forEach((video, index) => {
    queueAttach(video, index * INITIAL_ATTACH_STAGGER_MS);
  });
}

function attachStream(video) {
  const state = streamStates.get(video);
  if (!state || state.attached) return;

  clearAttachTimer(state);
  state.attached = true;
  clearRetryTimer(state);
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
    liveSyncDurationCount: HLS_LIVE_SYNC_DURATION_COUNT,
    liveMaxLatencyDurationCount: HLS_LIVE_MAX_LATENCY_DURATION_COUNT,
    maxLiveSyncPlaybackRate: 1.2,
    maxBufferLength: HLS_MAX_BUFFER_LENGTH_SECONDS,
    backBufferLength: HLS_BACK_BUFFER_LENGTH_SECONDS,
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
        return;
      }
      if (now - state.bufferingSince < STALL_EVENT_GRACE_MS) {
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
  }, STARTUP_TIMEOUT_MS);
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

    if (state.bufferingSince && now - state.bufferingSince < BUFFERING_GRACE_MS) {
      return;
    }

    if (video.paused) {
      const staleFor = now - state.lastProgressAt;
      if (staleFor >= STALL_WINDOW_MS) {
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
    if (stalledFor < STALL_WINDOW_MS) return;

    const nudged = tryNudgeToLive(state, 'Stream lag detected');
    if (nudged) {
      return;
    }

    if (state.hls && now - state.lastSoftRecoveryAt >= SOFT_RECOVERY_COOLDOWN_MS && state.networkRecoveryCount < 2) {
      state.networkRecoveryCount += 1;
      state.lastSoftRecoveryAt = now;
      state.lastProgressAt = now;
      state.bufferingSince = now;
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
    if (lowBuffer || stalledFor >= STALL_WINDOW_MS * 2) {
      scheduleRecovery(state, 'Playback heartbeat timeout');
    }
  }, STALL_TICK_MS);
}

function scheduleRecovery(state, reason) {
  if (!state.attached || state.retryTimer) return;

  state.retryCount += 1;
  state.bufferingSince = 0;
  clearNudgeCheckTimer(state);
  const retryStep = Math.min(state.retryCount - 1, 6);
  const delay = Math.min(BASE_RETRY_DELAY_MS * (2 ** retryStep), MAX_RETRY_DELAY_MS);
  const seconds = Math.ceil(delay / 1000);

  teardownStream(state, { keepStatus: true });
  setStreamStatus(state, `${reason}. Retrying in ${seconds}s...`, 'warning');

  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
    queueAttach(state.video, jitter);
  }, delay);
}

function failStream(state, message) {
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

  streamVideos.forEach((video) => {
    const state = streamStates.get(video);
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

    streamStates.delete(video);
  });

  streamVideos.length = 0;
}

function startGlobalHealthLoop() {
  clearInterval(healthTimer);

  healthTimer = setInterval(() => {
    let healthyStreams = 0;

    streamVideos.forEach((video) => {
      const state = streamStates.get(video);
      if (!state) return;

      if (!state.attached && !state.retryTimer) {
        queueAttach(video, 200 + Math.floor(Math.random() * 1200));
        return;
      }

      const healthy =
        state.attached &&
        !video.paused &&
        Date.now() - state.lastProgressAt < STALL_WINDOW_MS * 1.5;

      if (healthy) {
        healthyStreams += 1;
      }
    });

    if (streamVideos.length === 0 || !navigator.onLine) {
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

    if (Date.now() - outageSince >= FULL_OUTAGE_RELOAD_MS) {
      window.location.reload();
    }
  }, 30000);
}

function retryAllStreams(resetBackoff) {
  streamVideos.forEach((video, index) => {
    const state = streamStates.get(video);
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

    queueAttach(video, index * BULK_REATTACH_STAGGER_MS);
  });
}

function scheduleSoftReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    window.location.reload();
  }, SOFT_RELOAD_MS);
}

function showNoResults(message) {
  const grid = document.getElementById('videoGrid');
  const noResults = document.getElementById('noResults');
  if (!grid || !noResults) return;

  grid.style.display = 'none';
  noResults.hidden = false;

  const text = noResults.querySelector('p');
  if (text) {
    text.textContent = message;
  }
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
  if (now - state.lastLiveNudgeAt < LIVE_EDGE_NUDGE_COOLDOWN_MS) {
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
  } else if (bufferAhead >= LIVE_EDGE_BUFFER_MIN_SECONDS) {
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
  }, LIVE_EDGE_NUDGE_VERIFY_MS);
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
  const state = streamStates.get(video);
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

function bindFullscreenListeners() {
  if (fullscreenListenersBound) return;

  document.addEventListener('fullscreenchange', syncFullscreenState);
  document.addEventListener('webkitfullscreenchange', syncFullscreenState);
  fullscreenListenersBound = true;
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isCardInFullscreen(card) {
  const fullscreenElement = getFullscreenElement();
  return Boolean(fullscreenElement && (fullscreenElement === card || card.contains(fullscreenElement)));
}

function toggleStreamFullscreen(card, video) {
  if (isCardInFullscreen(card)) {
    exitFullscreen();
    return;
  }

  const request =
    card.requestFullscreen ||
    card.webkitRequestFullscreen ||
    card.msRequestFullscreen;

  if (request) {
    Promise.resolve(request.call(card)).catch(() => {
      // Ignore; some kiosk browsers block fullscreen API.
    });
    return;
  }

  if (typeof video.webkitEnterFullscreen === 'function') {
    try {
      video.webkitEnterFullscreen();
    } catch {
      // Ignore fallback failure.
    }
  }
}

function exitFullscreen() {
  const exit =
    document.exitFullscreen ||
    document.webkitExitFullscreen ||
    document.msExitFullscreen;

  if (!exit) return;
  Promise.resolve(exit.call(document)).catch(() => {
    // Ignore exit errors.
  });
}

function syncFullscreenState() {
  const fullscreenElement = getFullscreenElement();

  streamVideos.forEach((video) => {
    const state = streamStates.get(video);
    if (!state) return;

    const active = Boolean(
      fullscreenElement &&
      (state.card === fullscreenElement || state.card.contains(fullscreenElement))
    );
    state.card.classList.toggle('is-fullscreen', active);
    state.video.controls = active;

    if (state.fullscreenBtn) {
      state.fullscreenBtn.textContent = active ? 'Exit' : 'FS';
      state.fullscreenBtn.title = active ? 'Exit fullscreen' : 'Fullscreen';
      state.fullscreenBtn.setAttribute('aria-label', state.fullscreenBtn.title);
    }
  });
}
