const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Telemetry, readTelemetryLog, filterEvents } = require('../dist/monitor/telemetry.js');

function tempPath() {
  return path.join(os.tmpdir(), `oracle-test-telemetry-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

test('telemetry writes and reads events', async () => {
  const filePath = tempPath();
  const telemetry = new Telemetry(filePath, { flushIntervalMs: 50 });
  await telemetry.open();

  telemetry.emit('test_event', { key: 'value1' });
  telemetry.emit('test_event', { key: 'value2' });
  telemetry.emit('other_event', { count: 42 });

  await telemetry.close();

  const events = await readTelemetryLog(filePath);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'test_event');
  assert.deepEqual(events[0].data, { key: 'value1' });
  assert.equal(events[2].type, 'other_event');
  assert.deepEqual(events[2].data, { count: 42 });

  // Each event should have a timestamp
  for (const event of events) {
    assert.ok(event.timestamp);
    assert.ok(new Date(event.timestamp).getTime() > 0);
  }

  fs.unlinkSync(filePath);
});

test('telemetry filterEvents works', async () => {
  const filePath = tempPath();
  const telemetry = new Telemetry(filePath, { flushIntervalMs: 50 });
  await telemetry.open();

  telemetry.emit('focus_change', { app: 'Terminal' });
  telemetry.emit('window_state', { visible: false });
  telemetry.emit('focus_change', { app: 'Finder' });

  await telemetry.close();

  const events = await readTelemetryLog(filePath);
  const focusEvents = filterEvents(events, 'focus_change');
  assert.equal(focusEvents.length, 2);
  assert.equal(focusEvents[0].data.app, 'Terminal');
  assert.equal(focusEvents[1].data.app, 'Finder');

  fs.unlinkSync(filePath);
});

test('telemetry tracks event count', async () => {
  const filePath = tempPath();
  const telemetry = new Telemetry(filePath, { flushIntervalMs: 50 });
  await telemetry.open();

  assert.equal(telemetry.getEventCount(), 0);
  telemetry.emit('a', {});
  telemetry.emit('b', {});
  assert.equal(telemetry.getEventCount(), 2);

  await telemetry.close();
  fs.unlinkSync(filePath);
});

test('telemetry handles empty log', async () => {
  const filePath = tempPath();
  const telemetry = new Telemetry(filePath, { flushIntervalMs: 50 });
  await telemetry.open();
  await telemetry.close();

  const events = await readTelemetryLog(filePath);
  assert.equal(events.length, 0);

  fs.unlinkSync(filePath);
});
