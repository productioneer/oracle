const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WindowObserver } = require('../dist/monitor/window-observer.js');
const { launchChrome, createHiddenPage } = require('../dist/browser/chrome.js');
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TEMP_PROFILE = path.join(os.tmpdir(), `oracle-window-test-${Date.now()}`);

test('window observer detects hidden Chrome window state', async () => {
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

    // Create a hidden page (this triggers window hiding)
    const page = await createHiddenPage(browser, 'window-observer-test', {
      allowVisible: false,
      browserPid,
    });

    // Start the observer (with browserPid for macOS visibility detection)
    const observer = new WindowObserver({ intervalMs: 300, browserPid });
    await observer.start(browser);

    // Wait for at least one poll
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const report = await observer.stop();

    // Should have recorded at least one event
    assert.ok(report.totalEvents >= 1,
      `Expected at least 1 window event, got ${report.totalEvents}`);

    // All events should show the window as NOT visible
    // (because Chrome was launched hidden/offscreen/minimized)
    assert.equal(report.violations.length, 0,
      `Expected 0 visibility violations, got ${report.violations.length}: ${JSON.stringify(report.violations)}`);

    // Check the first event's properties
    const events = observer.getEvents();
    const first = events[0];
    assert.ok(first.windowId > 0, 'Should have a valid window ID');
    assert.ok(first.timestamp, 'Should have a timestamp');
    assert.equal(first.visible, false, 'Window should not be visible');

    // Oracle requests -32000,-32000 but macOS clamps to the monitor boundary
    // (around -3960 on a typical setup). The window should be at a negative
    // position — the exact value depends on the display layout, but it should
    // be well below zero on at least one axis.
    const isOffscreen = first.left < -1000 || first.top < -1000;
    assert.ok(isOffscreen,
      `Window should be parked offscreen, got left=${first.left} top=${first.top}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore cleanup errors
      }
    }
    // Also kill the Chrome process to ensure clean exit
    if (browserPid) {
      try { process.kill(browserPid, 'SIGTERM'); } catch { /* already dead */ }
      // Wait briefly for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try { process.kill(browserPid, 'SIGKILL'); } catch { /* already dead */ }
    }
    // Clean up temp profile
    fs.rmSync(TEMP_PROFILE, { recursive: true, force: true });
  }
});

test('window observer detects violation when window is un-hidden via CDP', async () => {
  if (process.platform !== 'darwin') {
    return;
  }

  const TEMP_PROFILE2 = path.join(os.tmpdir(), `oracle-window-positive-${Date.now()}`);
  let browser;
  let browserPid;
  try {
    const connection = await launchChrome({
      userDataDir: TEMP_PROFILE2,
      allowVisible: false,
    });
    browser = connection.browser;
    browserPid = connection.browserPid;

    const page = await createHiddenPage(browser, 'window-positive-test', {
      allowVisible: false,
      browserPid,
    });

    const observer = new WindowObserver({ intervalMs: 200, browserPid });
    await observer.start(browser);

    // Wait for initial hidden state to be recorded
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Use CDP to move the window to a visible position (simulating a bug)
    const cdp = await browser.newBrowserCDPSession();
    const targets = await cdp.send('Target.getTargets');
    const pageTarget = (targets?.targetInfos ?? []).find(
      (t) => t.type === 'page',
    );
    assert.ok(pageTarget, 'Should have a page target');

    const windowInfo = await cdp.send('Browser.getWindowForTarget', {
      targetId: pageTarget.targetId,
    });
    assert.ok(windowInfo?.windowId, 'Should have a window ID');

    // Un-hide Chrome via AppleScript (undo the app-level hiding from createHiddenPage).
    // Without this, the observer's macOS visibility check still sees the app as hidden
    // and won't flag the CDP position change as a violation.
    await new Promise((resolve) => {
      execFile('osascript', [
        '-e', 'tell application "System Events"',
        '-e', `set matches to (every process whose unix id is ${browserPid})`,
        '-e', 'if (count of matches) = 0 then return "missing"',
        '-e', 'set visible of item 1 of matches to true',
        '-e', 'end tell',
      ], { timeout: 2000 }, resolve);
    });

    // Move window onscreen — this should trigger a violation
    await cdp.send('Browser.setWindowBounds', {
      windowId: windowInfo.windowId,
      bounds: { left: 100, top: 100, windowState: 'normal' },
    });

    // Wait for observer's macOS visibility check cycle (2s) to detect un-hiding,
    // plus a CDP poll cycle to see the new bounds with macAppHidden=false.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const report = await observer.stop();
    await cdp.detach().catch(() => null);

    // Should have detected at least one visibility violation
    assert.ok(report.violations.length >= 1,
      `Expected at least 1 violation after un-hiding, got ${report.violations.length}`);

    // The violation event should have visible=true and not be parked offscreen
    const violation = report.violations[0];
    assert.equal(violation.visible, true, 'Violation should have visible=true');
    assert.equal(violation.windowState, 'normal', 'Violation window should be in normal state');
    // Window should NOT be at the far-offscreen hidden position
    assert.ok(violation.left > -10000,
      `Violation left should not be at hidden position, got ${violation.left}`);
    assert.ok(violation.top > -10000,
      `Violation top should not be at hidden position, got ${violation.top}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    if (browserPid) {
      try { process.kill(browserPid, 'SIGTERM'); } catch { /* already dead */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try { process.kill(browserPid, 'SIGKILL'); } catch { /* already dead */ }
    }
    fs.rmSync(TEMP_PROFILE2, { recursive: true, force: true });
  }
});
