import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadRuntimeHelpers(extraContext = {}) {
  const source = fs.readFileSync(new URL('./stream-runtime.js', import.meta.url), 'utf8');
  const context = {
    console,
    window: {},
    ...extraContext,
  };
  context.self = context.window;
  vm.runInNewContext(source, context, { filename: 'stream-runtime.js' });
  return context.window.KrakowStreamRuntime;
}

test('getBufferedEnd returns the final buffered range end', () => {
  const { getBufferedEnd } = loadRuntimeHelpers();

  const video = {
    buffered: {
      length: 2,
      end(index) {
        return index === 0 ? 4 : 9.5;
      },
    },
  };

  assert.equal(getBufferedEnd(video), 9.5);
});

test('getSeekableRange returns the full seekable range', () => {
  const { getSeekableRange } = loadRuntimeHelpers();

  const video = {
    seekable: {
      length: 2,
      start() {
        return 1.25;
      },
      end(index) {
        return index === 0 ? 4 : 12;
      },
    },
  };

  const range = getSeekableRange(video);

  assert.equal(range.start, 1.25);
  assert.equal(range.end, 12);
});

test('configured runtime attaches all streams with the configured startup stagger', () => {
  const { configure } = loadRuntimeHelpers({
    setTimeout(callback) {
      callback();
      return 1;
    },
  });
  const streamVideos = [{ id: 'a' }, { id: 'b' }];
  const streamStates = new WeakMap(streamVideos.map((video) => [
    video,
    {
      attached: false,
      retryTimer: null,
      attachTimer: null,
    },
  ]));
  const delays = [];

  const runtime = configure({
    config: {
      INITIAL_ATTACH_STAGGER_MS: 220,
    },
    streamStates,
    streamVideos,
    attachStream(video) {
      delays.push(video.id);
    },
  });

  runtime.attachAllStreams();

  assert.deepEqual(delays, ['a', 'b']);
});
