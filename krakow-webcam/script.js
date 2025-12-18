let allSources = [];
let currentCategory = 'all';


// Constants
const INTERSECTION_THRESHOLD = 0.25;
const BACK_TO_TOP_THRESHOLD = 300;

function loadPreference(key, defaultValue) {
  try {
    const stored = localStorage.getItem(`krakowWebcam_${key}`);
    if (stored === null) return defaultValue;
    
    const parsed = JSON.parse(stored);
    
    // Type validation
    if (typeof defaultValue === 'boolean' && typeof parsed !== 'boolean') {
      return defaultValue;
    }
    if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
      return defaultValue;
    }
    
    return parsed;
  } catch {
    return defaultValue;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(`krakowWebcam_${key}`, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('Failed to save preference:', e);
    return false;
  }
}

const globalSettings = {
  autoMute: loadPreference('autoMute', true),
  layout: loadPreference('layout', 'default'),
};

const videoRegistry = new Set();

// Keep per-video state without leaks
const stateMap = new WeakMap();

document.addEventListener('DOMContentLoaded', async () => {
  const videoGrid = document.getElementById('videoGrid');
  if (!videoGrid) {
    console.error('Video grid element not found');
    return;
  }

  allSources = await getVideoSources();
  if (allSources.length === 0) {
    showLoadError(videoGrid);
    return;
  }
  
  initializeCategoryFilters();
  initializeVideoGrid(videoGrid, allSources);
  initializeLazyLoading(videoGrid);
  initializePWA();
  initializeBackToTop();
  initializeThemeToggle();
  initializeWeatherWidget();
  initializeLayoutToggle();

});

function initializeCategoryFilters() {
  const container = document.getElementById('categoryFilters');
  if (!container) return;

  const categories = ['all', ...new Set(allSources.map(s => s.category).filter(Boolean))];
  
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'category-btn';
    btn.textContent = cat === 'all' ? 'All' : cat;
    btn.dataset.category = cat;
    if (cat === 'all') btn.classList.add('active');
    
    btn.addEventListener('click', () => {
      document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCategory = cat;
      filterStreams();
    });
    
    container.appendChild(btn);
  });
}


function filterStreams() {
  const filtered = allSources.filter(source => {
    return currentCategory === 'all' || source.category === currentCategory;
  });

  const videoGrid = document.getElementById('videoGrid');
  const noResults = document.getElementById('noResults');
  
  if (filtered.length === 0) {
    videoGrid.style.display = 'none';
    noResults.style.display = 'block';
  } else {
    videoGrid.style.display = 'grid';
    noResults.style.display = 'none';
    
    const videosToRemove = Array.from(videoRegistry);
    videosToRemove.forEach(video => {
      teardownVideo(video);
      videoRegistry.delete(video);
    });
    videoGrid.innerHTML = '';
    
    initializeVideoGrid(videoGrid, filtered);
    initializeLazyLoading(videoGrid);
  }
}

function initializeBackToTop() {
  const btn = document.getElementById('backToTopBtn');
  if (!btn) return;

  window.addEventListener('scroll', () => {
    if (window.pageYOffset > BACK_TO_TOP_THRESHOLD) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  });

  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}


function initializeThemeToggle() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) {
    console.error('Theme toggle button not found');
    return;
  }

  const savedTheme = loadPreference('theme', null);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme || (prefersDark ? 'dark' : 'light');
  
  applyTheme(initialTheme);

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
    savePreference('theme', newTheme);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
}

async function initializeWeatherWidget() {
  const widget = document.getElementById('weatherWidget');
  if (!widget) return;

  try {
    const response = await fetch('https://api.open-meteo.com/v1/forecast?latitude=50.0647&longitude=19.9450&current_weather=true');
    const data = await response.json();
    
    if (data.current_weather) {
      const temp = Math.round(data.current_weather.temperature);
      const weatherCode = data.current_weather.weathercode;
      const icon = getWeatherIcon(weatherCode);
      const desc = getWeatherDescription(weatherCode);
      
      widget.innerHTML = `
        <div class="weather-content">
          <div class="weather-icon">${icon}</div>
          <div class="weather-info">
            <div class="weather-temp">${temp}°C</div>
            <div class="weather-desc">${desc}</div>
            <div class="weather-location">Kraków, Poland</div>
          </div>
        </div>
      `;
    }
  } catch (error) {
    console.warn('Failed to fetch weather:', error);
    widget.innerHTML = '<div class="weather-loading">Weather unavailable</div>';
  }
}

function getWeatherIcon(code) {
  if (code === 0) return '☀️';
  if (code <= 3) return '⛅';
  if (code <= 49) return '🌫️';
  if (code <= 59) return '🌧️';
  if (code <= 69) return '🌨️';
  if (code <= 79) return '❄️';
  if (code <= 84) return '🌧️';
  if (code <= 99) return '⛈️';
  return '🌤️';
}

function getWeatherDescription(code) {
  if (code === 0) return 'Clear sky';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 49) return 'Foggy';
  if (code <= 59) return 'Drizzle';
  if (code <= 69) return 'Rain';
  if (code <= 79) return 'Snow';
  if (code <= 84) return 'Rain showers';
  if (code <= 99) return 'Thunderstorm';
  return 'Cloudy';
}

function initializeLayoutToggle() {
  const select = document.getElementById('layoutSelect');
  if (!select) return;

  select.value = globalSettings.layout;
  applyLayout(globalSettings.layout);

  select.addEventListener('change', (e) => {
    const layout = e.target.value;
    globalSettings.layout = layout;
    savePreference('layout', layout);
    applyLayout(layout);
  });
}

function applyLayout(layout) {
  const grid = document.getElementById('videoGrid');
  if (!grid) return;

  grid.classList.remove('layout-compact', 'layout-large');
  if (layout === 'compact') {
    grid.classList.add('layout-compact');
  } else if (layout === 'large') {
    grid.classList.add('layout-large');
  }
}


function showLoadError(container) {
  container.innerHTML = '<div style="text-align: center; padding: 3rem; color: var(--text-secondary);"><h2>Failed to load streams</h2><p>Unable to fetch stream data. Please check your connection and refresh the page.</p></div>';
}

async function getVideoSources() {
  try {
    const response = await fetch('streams.json');
    if (!response.ok) throw new Error('Failed to fetch streams');
    return await response.json();
  } catch (error) {
    console.error('Error loading streams:', error);
    return [];
  }
}

function initializeVideoGrid(container, sources) {
  const fragment = document.createDocumentFragment();
  sources.forEach(source => {
    fragment.appendChild(createVideoContainer(source));
  });
  container.appendChild(fragment);
}

function createVideoContainer(source) {
  const videoContainer = document.createElement('div');
  videoContainer.classList.add('video-container');

  const header = document.createElement('div');
  header.classList.add('video-header');
  
  const titleRow = document.createElement('div');
  titleRow.classList.add('title-row');
  
  const title = document.createElement('h2');
  title.textContent = source.title || 'Live Stream';
  titleRow.appendChild(title);

  if (source.location) {
    const mapBtn = document.createElement('button');
    mapBtn.classList.add('map-btn');
    mapBtn.textContent = '📍 Map';
    mapBtn.title = 'View on Google Maps';
    mapBtn.addEventListener('click', () => {
      window.open(`https://www.google.com/maps?q=${source.location.lat},${source.location.lng}`, '_blank', 'noopener,noreferrer');
    });
    titleRow.appendChild(mapBtn);
  }

  header.appendChild(titleRow);
  videoContainer.appendChild(header);

  const videoWrapper = document.createElement('div');
  videoWrapper.classList.add('video-wrapper');
  videoContainer.appendChild(videoWrapper);

  const skeleton = document.createElement('div');
  skeleton.classList.add('skeleton-loader');
  videoWrapper.appendChild(skeleton);

  const video = document.createElement('video');
  video.controls = true;
  video.muted = globalSettings.autoMute;
  video.playsInline = true;
  if (source.poster) video.poster = source.poster;

  if (source.isVertical) {
    video.classList.add('vertical-video');
  }

  // Store initial state and defer loading
  stateMap.set(video, { 
    source, 
    hls: null,
    attached: false,
    skeleton
  });
  videoRegistry.add(video);
  videoWrapper.appendChild(video);

  return videoContainer;
}


function initializeLazyLoading(root) {
  const items = root.querySelectorAll('.video-container .video-wrapper');
  if (!('IntersectionObserver' in window)) {
    // Fallback: attach immediately
    items.forEach(wrapper => attachIfNeeded(wrapper.querySelector('video')));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const video = entry.target.querySelector('video');
      if (!video) return;
      if (entry.isIntersecting && entry.intersectionRatio > INTERSECTION_THRESHOLD) {
        attachIfNeeded(video);
      } else {
        detachIfNeeded(video);
      }
    });
  }, { root: null, rootMargin: '200px 0px', threshold: [0, INTERSECTION_THRESHOLD, 0.5] });

  items.forEach(w => observer.observe(w));
}

function initializePWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err.message || err);
      });
    });
  }

  // Add install prompt
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.getElementById('installBtn');
    if (installBtn) {
      installBtn.style.display = 'inline-flex';
      installBtn.addEventListener('click', async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          deferredPrompt = null;
          installBtn.style.display = 'none';
        }
      });
    }
  });
}


function attachIfNeeded(video) {
  const st = stateMap.get(video);
  if (!st || st.attached) return;
  st.attached = true;
  setupVideo(video, st.source);
}

function detachIfNeeded(video) {
  const st = stateMap.get(video);
  if (!st || !st.attached) return;
  st.attached = false;
  teardownVideo(video);
}


function setupVideo(video, source) {
  const st = stateMap.get(video);

  if (st?.skeleton) {
    st.skeleton.classList.remove('hidden');
  }

  const nativeSupport = video.canPlayType('application/vnd.apple.mpegurl');
  if (nativeSupport && nativeSupport !== 'no') {
    video.src = source.src;
    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {
        // Fallback: try muted
        video.muted = true;
        video.play().catch(e => console.debug('Native play failed:', e));
      });
    }
  } else if (window.Hls && Hls.isSupported()) {
    const hls = new Hls();
    stateMap.get(video).hls = hls;

    hls.loadSource(source.src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          // Fallback: try muted
          video.muted = true;
          video.play().catch(e => console.debug('HLS.js play failed:', e));
        });
      }
    });
  } else {
    console.error('HLS not supported in this browser');
    return;
  }

  // Hide skeleton when playing (only add if not already attached)
  if (!st.playingListener) {
    st.playingListener = () => {
      if (st?.skeleton) {
        st.skeleton.classList.add('hidden');
      }
    };
    video.addEventListener('playing', st.playingListener, { once: true });
  }
}


function teardownVideo(video) {
  const st = stateMap.get(video);
  
  video.pause();
  
  if (st?.hls) {
    st.hls.destroy();
    st.hls = null;
  }
  
  if (st?.playingListener) {
    video.removeEventListener('playing', st.playingListener);
    st.playingListener = null;
  }
  
  video.removeAttribute('src');
  video.load();
}


