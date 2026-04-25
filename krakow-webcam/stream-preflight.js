(function attachStreamPreflight(global) {
  const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10000;
  const DEFAULT_NATIVE_PROBE_TIMEOUT_MS = 5000;

  function isHlsManifest(text) {
    if (typeof text !== 'string') return false;

    const trimmed = text.trimStart();
    if (!trimmed.startsWith('#EXTM3U')) return false;

    return /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|VERSION)\b/.test(trimmed);
  }

  async function classifyStreams(sources, options = {}) {
    if (options.supportsNativeHls) {
      return classifyNativeStreams(sources, options);
    }

    const fetchManifest = options.fetchManifest || defaultFetchManifest;
    const playable = [];
    const blocked = [];

    await Promise.all(sources.map(async (source) => {
      try {
        const manifest = await fetchManifest(source, options);
        if (!isHlsManifest(manifest)) {
          blocked.push({ source, reason: 'Invalid HLS manifest' });
          return;
        }

        playable.push(source);
      } catch (error) {
        blocked.push({
          source,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }));

    return {
      playable: preserveSourceOrder(sources, playable),
      blocked: preserveBlockedOrder(sources, blocked),
    };
  }

  async function classifyNativeStreams(sources, options) {
    const probeNativeStream = options.probeNativeStream || defaultProbeNativeStream;
    const playable = [];
    const blocked = [];

    await Promise.all(sources.map(async (source) => {
      try {
        await probeNativeStream(source, options);
        playable.push(source);
      } catch (error) {
        blocked.push({
          source,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }));

    return {
      playable: preserveSourceOrder(sources, playable),
      blocked: preserveBlockedOrder(sources, blocked),
    };
  }

  async function defaultFetchManifest(source, options) {
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : DEFAULT_PREFLIGHT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response;
    try {
      response = await fetch(source.src, {
        cache: 'no-store',
        mode: 'cors',
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('Manifest preflight timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Manifest returned ${response.status}`);
    }

    return response.text();
  }

  async function defaultProbeNativeStream(source, options) {
    const timeoutMs = Number.isFinite(options.nativeProbeTimeoutMs)
      ? options.nativeProbeTimeoutMs
      : DEFAULT_NATIVE_PROBE_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    let response;
    try {
      response = await fetch(source.src, {
        cache: 'no-store',
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('Native reachability probe timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (response.type !== 'opaque' && !response.ok) {
      throw new Error(`Native reachability probe returned ${response.status}`);
    }
  }

  function preserveSourceOrder(sources, subset) {
    const set = new Set(subset);
    return sources.filter((source) => set.has(source));
  }

  function preserveBlockedOrder(sources, blocked) {
    const bySource = new Map(blocked.map((entry) => [entry.source, entry]));
    return sources
      .filter((source) => bySource.has(source))
      .map((source) => bySource.get(source));
  }

  global.KrakowStreamPreflight = {
    classifyStreams,
    isHlsManifest,
  };
})(typeof window !== 'undefined' ? window : self);
