const APP_VERSION = '20260425-3';
const RESIZE_DEBOUNCE_MS = 180;
const SOFT_RELOAD_MS = 6 * 60 * 60 * 1000;
const STREAM_RUNTIME_CONFIG = Object.freeze({
  BUFFERING_GRACE_MS: 25000,
  BULK_REATTACH_STAGGER_MS: 140,
  FULL_OUTAGE_RELOAD_MS: 2 * 60 * 1000,
  HLS_BACK_BUFFER_LENGTH_SECONDS: 12,
  HLS_LIVE_MAX_LATENCY_DURATION_COUNT: 12,
  HLS_LIVE_SYNC_DURATION_COUNT: 5,
  HLS_MAX_BUFFER_LENGTH_SECONDS: 18,
  INITIAL_ATTACH_STAGGER_MS: 220,
  LIVE_EDGE_BUFFER_MIN_SECONDS: 0.6,
  LIVE_EDGE_NUDGE_COOLDOWN_MS: 12000,
  LIVE_EDGE_NUDGE_VERIFY_MS: 6000,
  MAX_RETRY_DELAY_MS: 20000,
  RETRY_JITTER_MS: 1200,
  SOFT_RECOVERY_COOLDOWN_MS: 15000,
  STALL_EVENT_GRACE_MS: 6000,
  STALL_TICK_MS: 4000,
  STALL_WINDOW_MS: 40000,
  STARTUP_TIMEOUT_MS: 12000,
});
const RETRY_CONFIG = Object.freeze({
  BASE_RETRY_DELAY_MS: 1500,
  MAX_RETRY_DELAY_MS: STREAM_RUNTIME_CONFIG.MAX_RETRY_DELAY_MS,
});
const STREAM_PHASES = {
  PENDING: 'pending',
  CONNECTING: 'connecting',
  PLAYING: 'playing',
  BUFFERING: 'buffering',
  RECOVERING: 'recovering',
  RETRYING: 'retrying',
  FAILED: 'failed',
};

let allSources = [];
let resizeTimer = null;
let reloadTimer = null;
let retryQueue = null;
let streamRuntime = null;

const streamStates = new WeakMap();
const streamVideos = [];

document.addEventListener('DOMContentLoaded', async () => {
  await disableLegacyServiceWorkers();
  KrakowDashboardLayout.bindFullscreenListeners(() => {
    KrakowDashboardLayout.syncFullscreenState(streamVideos, streamStates);
  });
  initializeRetryQueue();
  initializeStreamRuntime();

  const loadedSources = await loadStreams();
  const classification = await classifyStreamSources(loadedSources);
  logBlockedStreams(classification.blocked);

  allSources = classification.playable;
  if (allSources.length === 0) {
    KrakowDashboardLayout.showNoResults(loadedSources.length === 0 ? 'Unable to load streams' : 'No playable streams available');
    return;
  }

  renderDashboard();
  scheduleSoftReload();

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      KrakowDashboardLayout.applyDashboardLayout(allSources.length);
    }, RESIZE_DEBOUNCE_MS);
  });

  window.addEventListener('online', () => {
    streamRuntime.retryAllStreams(true);
  });

  window.addEventListener('offline', () => {
    streamVideos.forEach((video) => {
      const state = streamStates.get(video);
      if (state) {
        streamRuntime.setStreamStatus(state, 'Offline. Waiting for network...', 'warning');
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

async function classifyStreamSources(sources) {
  const preflight = window.KrakowStreamPreflight;
  if (!preflight?.classifyStreams) {
    console.warn('Stream preflight helper unavailable; rendering all configured streams.');
    return { playable: sources, blocked: [] };
  }

  return preflight.classifyStreams(sources, {
    supportsNativeHls: hasNativeHlsSupport(),
  });
}

function logBlockedStreams(blockedStreams) {
  if (!blockedStreams.length) return;

  console.warn(
    `${blockedStreams.length} stream${blockedStreams.length === 1 ? '' : 's'} hidden after manifest preflight.`
  );

  blockedStreams.forEach(({ source, reason }) => {
    console.warn(`Hidden stream: ${source.title || source.src} (${reason})`, source.src);
  });
}

function hasNativeHlsSupport() {
  const video = document.createElement('video');
  const support = video.canPlayType('application/vnd.apple.mpegurl');
  return support && support !== 'no';
}

function initializeRetryQueue() {
  const supervisor = window.KrakowStreamSupervisor;
  if (!supervisor?.createRetryQueue) {
    console.warn('Stream supervisor helper unavailable; falling back to direct retry attaches.');
    retryQueue = null;
    return;
  }

  retryQueue = supervisor.createRetryQueue({
    intervalMs: STREAM_RUNTIME_CONFIG.BULK_REATTACH_STAGGER_MS,
    attach: (video) => {
      streamRuntime.queueAttach(video, 0);
    },
  });
}

function initializeStreamRuntime() {
  streamRuntime = KrakowStreamRuntime.configure({
    config: STREAM_RUNTIME_CONFIG,
    phases: STREAM_PHASES,
    streamStates,
    streamVideos,
    clearRetryQueue() {
      if (retryQueue) {
        retryQueue.clear();
      }
    },
    enqueueRetryAttach,
    getRetryDelay,
    setStreamPhase,
  });
}

function enqueueRetryAttach(video) {
  if (retryQueue) {
    retryQueue.enqueue(video);
    return;
  }

  streamRuntime.queueAttach(video, Math.floor(Math.random() * STREAM_RUNTIME_CONFIG.RETRY_JITTER_MS));
}

function getRetryDelay(retryCount) {
  const supervisor = window.KrakowStreamSupervisor;
  if (supervisor?.getRetryDelay) {
    return supervisor.getRetryDelay(retryCount, {
      baseMs: RETRY_CONFIG.BASE_RETRY_DELAY_MS,
      maxMs: RETRY_CONFIG.MAX_RETRY_DELAY_MS,
    });
  }

  const retryStep = Math.min(Math.max(retryCount - 1, 0), 6);
  return Math.min(RETRY_CONFIG.BASE_RETRY_DELAY_MS * (2 ** retryStep), RETRY_CONFIG.MAX_RETRY_DELAY_MS);
}

function setStreamPhase(state, phase, detail = {}) {
  if (!state || (state.phase === phase && !detail.reason)) return;

  state.phase = phase;
  logStreamPhase(state, phase, detail);
}

function logStreamPhase(state, phase, detail) {
  const title = state.source.title || state.source.src;
  let host = '';
  try {
    host = new URL(state.source.src).host;
  } catch {
    host = state.source.src;
  }

  console.info('[krakow-webcam]', phase, {
    title,
    host,
    retryCount: state.retryCount,
    reason: detail.reason || '',
    delayMs: detail.delayMs || 0,
  });
}

function renderDashboard() {
  KrakowDashboardLayout.renderDashboard({
    sources: allSources,
    streamStates,
    streamVideos,
    phases: STREAM_PHASES,
    teardownAllStreams: streamRuntime.teardownAllStreams,
    attachAllStreams: streamRuntime.attachAllStreams,
    startGlobalHealthLoop: streamRuntime.startGlobalHealthLoop,
  });
}

function scheduleSoftReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    window.location.reload();
  }, SOFT_RELOAD_MS);
}
