const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FocusMonitor } = require('../dist/monitor/focus-monitor.js');

test('focus monitor detects frontmost app on macOS', async () => {
  if (process.platform !== 'darwin') {
    return; // skip on non-macOS
  }

  const monitor = new FocusMonitor({ intervalMs: 200 });
  monitor.start();

  // osascript takes ~200-500ms per call; wait enough for multiple polls
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const report = monitor.stop();

  // Should have recorded at least one event (the initial frontmost app)
  assert.ok(report.totalEvents >= 1, `Expected at least 1 event, got ${report.totalEvents}`);

  // The initial event should have a valid app name and pid
  const events = monitor.getEvents();
  const first = events[0];
  assert.ok(first.app, 'First event should have an app name');
  assert.ok(first.pid > 0, 'First event should have a valid PID');
  assert.ok(first.timestamp, 'First event should have a timestamp');

  // The currently running process should NOT be Oracle Chrome
  assert.equal(first.isOracleChrome, false,
    'Test process frontmost app should not be Oracle Chrome');
});

test('focus monitor reports no violations when no Chrome runs', async () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const monitor = new FocusMonitor({ intervalMs: 100 });
  monitor.start();

  await new Promise((resolve) => setTimeout(resolve, 500));

  const report = monitor.stop();

  // No Oracle Chrome should be frontmost during a simple test
  assert.equal(report.violations.length, 0,
    'Should have no focus violations during test');
  assert.ok(report.durationMs >= 400,
    `Duration should be at least 400ms, got ${report.durationMs}`);
});

test('focus monitor with telemetry integration', async () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { Telemetry, readTelemetryLog, filterEvents } = require('../dist/monitor/telemetry.js');

  const filePath = path.join(os.tmpdir(), `oracle-focus-test-${Date.now()}.jsonl`);
  const telemetry = new Telemetry(filePath, { flushIntervalMs: 50 });
  await telemetry.open();

  const monitor = new FocusMonitor({ intervalMs: 200, telemetry });
  monitor.start();

  await new Promise((resolve) => setTimeout(resolve, 1500));

  monitor.stop();
  await telemetry.close();

  const events = await readTelemetryLog(filePath);
  const focusEvents = filterEvents(events, 'focus_change');

  // Focus events should have been logged to telemetry
  assert.ok(focusEvents.length >= 1, `Expected at least 1 telemetry event, got ${focusEvents.length}`);
  assert.ok(focusEvents[0].data.app, 'Telemetry event should include app name');
  assert.ok(typeof focusEvents[0].data.pid === 'number', 'Telemetry event should include pid');

  fs.unlinkSync(filePath);
});
