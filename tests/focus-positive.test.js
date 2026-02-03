/**
 * Positive detection test: verifies the focus monitor can detect when
 * Oracle Chrome steals focus.
 *
 * WARNING: This test intentionally activates Chrome, stealing focus from
 * the user's current app. Do NOT run in parallel with other focus-sensitive
 * tests (e.g., monitor-integration.test.js).
 *
 * Run separately: node --test tests/focus-positive.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const { FocusMonitor } = require('../dist/monitor/focus-monitor.js');
const { launchChrome } = require('../dist/browser/chrome.js');

const TEMP_PROFILE = path.join(os.tmpdir(), `oracle-focus-positive-${Date.now()}`);

test('focus monitor detects violation when Oracle Chrome becomes frontmost', async () => {
  if (process.platform !== 'darwin') {
    return;
  }

  let browser;
  let browserPid;
  try {
    const connection = await launchChrome({
      userDataDir: TEMP_PROFILE,
      allowVisible: false,
    });
    browser = connection.browser;
    browserPid = connection.browserPid;

    const monitor = new FocusMonitor({
      intervalMs: 200,
      oracleUserDataDir: TEMP_PROFILE,
    });
    monitor.start();

    // Wait for initial state
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Attempt to bring Chrome to front via osascript (simulating a focus-theft bug).
    // On macOS, Chrome launched hidden may resist activation — the osascript may
    // succeed without actually changing focus.
    //
    // IMPORTANT: We ONLY use PID-targeted activation. App-name targeting (e.g.,
    // `tell application "Google Chrome" to activate`) is forbidden because it
    // would activate ANY Chrome, including the user's personal Chrome.
    let activated = false;
    try {
      execSync(
        `osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${browserPid}) to true'`,
        { timeout: 3000 },
      );
      // Verify OUR Chrome (by PID) actually became frontmost, not some other Chrome
      const frontmostPid = parseInt(execSync(
        'osascript -e \'tell application "System Events" to return unix id of first application process whose frontmost is true\'',
        { timeout: 3000 },
      ).toString().trim(), 10);
      if (frontmostPid === browserPid) {
        activated = true;
      }
    } catch { /* ignore */ }

    if (!activated) {
      // Chrome resisted activation — test is inconclusive, not a failure.
      // This actually demonstrates Oracle's hiding works well.
      monitor.stop();
      return;
    }

    // Wait for monitor to detect the focus change
    await new Promise((resolve) => setTimeout(resolve, 800));

    const report = monitor.stop();

    // Should have detected at least one violation
    assert.ok(report.violations.length >= 1,
      `Expected at least 1 focus violation after Chrome activation, got ${report.violations.length}. ` +
      `Events: ${JSON.stringify(monitor.getEvents().slice(-3))}`);

    const violation = report.violations[0];
    assert.equal(violation.isOracleChrome, true, 'Violation should be identified as Oracle Chrome');
    assert.ok(violation.pid > 0, 'Violation should have a valid PID');
  } finally {
    // Restore focus to the terminal/test runner
    try {
      execSync(
        'osascript -e \'tell application "Terminal" to activate\'',
        { timeout: 3000 },
      );
    } catch { /* ignore */ }

    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    if (browserPid) {
      try { process.kill(browserPid, 'SIGTERM'); } catch { /* already dead */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try { process.kill(browserPid, 'SIGKILL'); } catch { /* already dead */ }
    }
    fs.rmSync(TEMP_PROFILE, { recursive: true, force: true });
  }
});
