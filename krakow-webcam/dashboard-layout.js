(function attachDashboardLayout(global) {
  let fullscreenListenersBound = false;

  function renderDashboard(options) {
    const {
      sources,
      streamStates,
      streamVideos,
      phases,
      teardownAllStreams,
      attachAllStreams,
      startGlobalHealthLoop,
    } = options;
    const grid = document.getElementById('videoGrid');
    const noResults = document.getElementById('noResults');
    if (!grid || !noResults) return;

    teardownAllStreams();

    if (sources.length === 0) {
      showNoResults('No streams available');
      return;
    }

    noResults.hidden = true;
    grid.style.display = 'grid';
    grid.innerHTML = '';

    const fragment = document.createDocumentFragment();
    sources.forEach((source) => {
      fragment.appendChild(createStreamCard({
        source,
        streamStates,
        streamVideos,
        phases,
      }));
    });

    grid.appendChild(fragment);
    applyDashboardLayout(sources.length);
    attachAllStreams();
    syncFullscreenState(streamVideos, streamStates);
    startGlobalHealthLoop();
  }

  function applyDashboardLayout(totalStreams) {
    const grid = document.getElementById('videoGrid');
    if (!grid) return;

    const layout = computeLayout(totalStreams);
    document.documentElement.style.setProperty('--dashboard-cols', String(layout.cols));
    document.documentElement.style.setProperty('--dashboard-rows', String(layout.rows));
    stretchLastRow(grid, layout.cols);
  }

  function computeLayout(totalStreams, viewport = {}) {
    const total = Math.max(1, totalStreams);
    const viewportWidth = viewport.width ?? window.innerWidth;
    const viewportHeight = viewport.height ?? window.innerHeight;
    const width = Math.max(viewportWidth, 320);
    const height = Math.max(viewportHeight, 240);
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

  function createStreamCard(options) {
    const { source, streamStates, streamVideos, phases } = options;
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
      phase: phases.PENDING,
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

  function bindFullscreenListeners(syncCallback) {
    if (fullscreenListenersBound) return;

    document.addEventListener('fullscreenchange', syncCallback);
    document.addEventListener('webkitfullscreenchange', syncCallback);
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

  function syncFullscreenState(streamVideos, streamStates) {
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

  global.KrakowDashboardLayout = {
    applyDashboardLayout,
    bindFullscreenListeners,
    computeLayout,
    renderDashboard,
    showNoResults,
    syncFullscreenState,
  };
})(typeof window !== 'undefined' ? window : self);
