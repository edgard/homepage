import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadPreflightHelpers() {
  const source = fs.readFileSync(new URL('./stream-preflight.js', import.meta.url), 'utf8');
  const context = {
    AbortController,
    console,
    fetch,
    setTimeout,
    clearTimeout,
    window: {},
  };
  context.self = context.window;
  vm.runInNewContext(source, context, { filename: 'stream-preflight.js' });
  return context.window.KrakowStreamPreflight;
}

test('classifyStreams keeps valid HLS manifests and blocks failed preflights', async () => {
  const { classifyStreams } = loadPreflightHelpers();
  const sources = [
    { title: 'Playable', src: 'https://example.test/playable.m3u8' },
    { title: 'Blocked', src: 'https://example.test/blocked.m3u8' },
  ];
  const fetchManifest = async (source) => {
    if (source.title === 'Playable') {
      return '#EXTM3U\n#EXT-X-TARGETDURATION:6\nsegment.ts\n';
    }
    throw new TypeError('Failed to fetch');
  };

  const result = await classifyStreams(sources, { fetchManifest });

  assert.deepEqual(result.playable.map((source) => source.title), ['Playable']);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].source.title, 'Blocked');
  assert.match(result.blocked[0].reason, /Failed to fetch/);
});

test('classifyStreams blocks responses that are not HLS manifests', async () => {
  const { classifyStreams } = loadPreflightHelpers();
  const sources = [{ title: 'HTML Error', src: 'https://example.test/error.m3u8' }];

  const result = await classifyStreams(sources, {
    fetchManifest: async () => '<html>not a stream</html>',
  });

  assert.deepEqual(result.playable, []);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].reason, 'Invalid HLS manifest');
});

test('classifyStreams keeps native HLS sources when the light probe succeeds', async () => {
  const { classifyStreams } = loadPreflightHelpers();
  const sources = [
    { title: 'Native Playable', src: 'https://example.test/native.m3u8' },
  ];
  const probed = [];

  const result = await classifyStreams(sources, {
    supportsNativeHls: true,
    probeNativeStream: async (source) => {
      probed.push(source.title);
    },
  });

  assert.deepEqual(probed, ['Native Playable']);
  assert.deepEqual(result.playable, sources);
  assert.equal(result.blocked.length, 0);
});

test('classifyStreams blocks native HLS sources when the light probe fails', async () => {
  const { classifyStreams } = loadPreflightHelpers();
  const sources = [
    { title: 'Native Dead', src: 'https://example.test/dead.m3u8' },
  ];

  const result = await classifyStreams(sources, {
    supportsNativeHls: true,
    probeNativeStream: async () => {
      throw new Error('Native reachability probe timed out');
    },
  });

  assert.deepEqual(result.playable, []);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].source.title, 'Native Dead');
  assert.match(result.blocked[0].reason, /timed out/);
});

test('classifyStreams times out stalled default manifest fetches', async () => {
  const source = fs.readFileSync(new URL('./stream-preflight.js', import.meta.url), 'utf8');
  const context = {
    AbortController,
    console,
    setTimeout,
    clearTimeout,
    window: {},
  };
  context.self = context.window;
  context.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(new Error('aborted'));
    });
  });
  vm.runInNewContext(source, context, { filename: 'stream-preflight.js' });

  const result = await context.window.KrakowStreamPreflight.classifyStreams(
    [{ title: 'Stalled', src: 'https://example.test/stalled.m3u8' }],
    { timeoutMs: 1 }
  );

  assert.deepEqual(result.playable, []);
  assert.equal(result.blocked.length, 1);
  assert.match(result.blocked[0].reason, /aborted|timed out/i);
});
