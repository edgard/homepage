import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function loadDashboardHelpers() {
  const source = fs.readFileSync(new URL('./dashboard-layout.js', import.meta.url), 'utf8');
  const context = {
    console,
    window: {},
  };
  context.self = context.window;
  vm.runInNewContext(source, context, { filename: 'dashboard-layout.js' });
  return context.window.KrakowDashboardLayout;
}

test('computeLayout returns a grid that can fit every stream', () => {
  const { computeLayout } = loadDashboardHelpers();

  const layout = computeLayout(20, { width: 1280, height: 720 });

  assert.equal(layout.cols * layout.rows >= 20, true);
  assert.equal(layout.cols > 0, true);
  assert.equal(layout.rows > 0, true);
});

test('computeLayout falls back safely for empty stream lists', () => {
  const { computeLayout } = loadDashboardHelpers();

  const layout = computeLayout(0, { width: 320, height: 240 });

  assert.equal(layout.cols, 1);
  assert.equal(layout.rows, 1);
});
