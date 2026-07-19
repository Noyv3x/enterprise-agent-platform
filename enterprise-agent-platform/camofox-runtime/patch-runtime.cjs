"use strict";

// @askjo/camofox-browser 1.11.2 omits resetNativeMemBaseline from the
// disabled crash reporter, while closeBrowserFully calls it unconditionally.
// The platform deliberately disables crash reporting, so make that one call
// optional. Keep this patch exact and fail closed if the locked upstream source
// no longer has the expected shape.
const fs = require("node:fs");
const path = require("node:path");

const target = path.join(
  process.cwd(),
  "node_modules",
  "@askjo",
  "camofox-browser",
  "server.js",
);
const gracefulBefore = "reporter.resetNativeMemBaseline();";
const gracefulAfter = "reporter.resetNativeMemBaseline?.();";
const loggingBefore = `function log(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\\n');
  } else {
    process.stdout.write(line + '\\n');
  }
}`;
const loggingAfter = `function sanitizeLogUrl(value) {
  const text = String(value || '');
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\\/\\//i.test(text);
    const parsed = new URL(text, 'http://ubitech.invalid');
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      return '[redacted-url]';
    }
    const path = parsed.pathname || '/';
    return absolute ? \`\${parsed.protocol}//\${parsed.host}\${path}\` : path;
  } catch (_) {
    return '[invalid-url-redacted]';
  }
}

function sanitizeLogString(value, key) {
  const text = String(value);
  let replacedUrl = false;
  const sanitized = text.replace(
    /(?:https?|wss?):\\/\\/[^\\u0000-\\u0020\\u007f<>"']+/gi,
    (candidate) => {
      replacedUrl = true;
      return sanitizeLogUrl(candidate);
    },
  );
  if (/urls?$/i.test(key) && !replacedUrl) return sanitizeLogUrl(text);
  return sanitized;
}

function sanitizeLogFields(value, key = '', seen = new WeakSet()) {
  if (typeof value === 'string') {
    return sanitizeLogString(value, key);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeLogFields(item, key, seen));
  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = sanitizeLogFields(childValue, childKey, seen);
  }
  seen.delete(value);
  return result;
}

function log(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...sanitizeLogFields(fields),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\\n');
  } else {
    process.stdout.write(line + '\\n');
  }
}`;
const displayBefore = `    try {
      if (os.platform() === 'linux') {
        localVirtualDisplay = pluginCtx.createVirtualDisplay();
        vdDisplay = localVirtualDisplay.get();
        log('info', 'xvfb virtual display started', { display: vdDisplay, attempt });
      }
    } catch (err) {
      log('warn', 'xvfb not available, falling back to headless', { error: err.message, attempt });
      localVirtualDisplay = null;
    }`;
const cleanupBefore = `function attachBrowserCleanup(candidateBrowser, localVirtualDisplay) {
  const origClose = candidateBrowser.close.bind(candidateBrowser);
  candidateBrowser.close = async (...args) => {
    await origClose(...args);
    browserLaunchProxy = null;
    if (localVirtualDisplay) {
      localVirtualDisplay.kill();
      if (virtualDisplay === localVirtualDisplay) virtualDisplay = null;
    }
  };
}`;
const cleanupAfter = `async function stopVirtualDisplay(display) {
  if (!display) return;
  const proc = display.proc;
  try { display.kill(); } catch { /* already stopped */ }
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;

  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener('exit', done);
      proc.removeListener('error', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    proc.once('exit', done);
    proc.once('error', done);
    if (proc.exitCode !== null || proc.signalCode !== null) done();
  });

  await waitForExit(1000);
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGKILL'); } catch { /* already stopped */ }
    await waitForExit(500);
  }
}

function attachBrowserCleanup(candidateBrowser, localVirtualDisplay) {
  const origClose = candidateBrowser.close.bind(candidateBrowser);
  const launchProxyToClose = browserLaunchProxy;
  candidateBrowser.close = async (...args) => {
    try {
      return await origClose(...args);
    } finally {
      await stopVirtualDisplay(localVirtualDisplay);
      if (virtualDisplay === localVirtualDisplay) {
        virtualDisplay = null;
        if (browserLaunchProxy === launchProxyToClose) browserLaunchProxy = null;
      }
    }
  };
}`;
const proxyRetryCleanupBefore = `            await candidateBrowser.close().catch(() => {});
            if (localVirtualDisplay) localVirtualDisplay.kill();
            continue;`;
const proxyRetryCleanupAfter = `            await candidateBrowser.close().catch(() => {});
            await stopVirtualDisplay(localVirtualDisplay);
            continue;`;
const launchFailureCleanupBefore = `      await candidateBrowser?.close().catch(() => {});
      if (localVirtualDisplay) localVirtualDisplay.kill();`;
const launchFailureCleanupAfter = `      await candidateBrowser?.close().catch(() => {});
      await stopVirtualDisplay(localVirtualDisplay);`;
const closeDisplayCaptureBefore = `  const b = browser;
  if (!b) return;
  clearBrowserIdleTimer();`;
const closeDisplayCaptureAfter = `  const b = browser;
  if (!b) return;
  const displayToClose = virtualDisplay;
  const launchProxyToClose = browserLaunchProxy;
  clearBrowserIdleTimer();`;
const closeTimeoutCleanupBefore = `  } finally {
    clearTimeout(closeTimer);
  }

  // Force-kill browser survivors.`;
const closeTimeoutCleanupAfter = `  } finally {
    clearTimeout(closeTimer);
    await stopVirtualDisplay(displayToClose);
    if (virtualDisplay === displayToClose) {
      virtualDisplay = null;
      if (browserLaunchProxy === launchProxyToClose) browserLaunchProxy = null;
    }
  }

  // Force-kill browser survivors.`;
const survivorScanBefore = `if (/camoufox-bin|\\/usr\\/bin\\/Xvfb\\b/.test(cmdline))`;
const survivorScanAfter = `if (/camoufox-bin/.test(cmdline))`;
const screenshotEncodingBefore = `    const { tabState } = found;
    const buffer = await tabState.page.screenshot({ type: 'png', fullPage });
    pluginEvents.emit('tab:screenshot', { userId, tabId: req.params.tabId, buffer });
    res.set('Content-Type', 'image/png');
    res.send(buffer);`;
const screenshotEncodingAfter = `    const { tabState } = found;
    const format = req.query.format === 'jpeg' ? 'jpeg' : 'png';
    const requestedQuality = Number.parseInt(String(req.query.quality || ''), 10);
    const quality = Number.isFinite(requestedQuality)
      ? Math.max(30, Math.min(90, requestedQuality))
      : 65;
    const options = { type: format, fullPage };
    if (format === 'jpeg') options.quality = quality;
    const buffer = await tabState.page.screenshot(options);
    pluginEvents.emit('tab:screenshot', { userId, tabId: req.params.tabId, buffer });
    res.set('Content-Type', format === 'jpeg' ? 'image/jpeg' : 'image/png');
    res.send(buffer);`;
const displayAfter = `    let displayStartupError = null;
    try {
      if (os.platform() === 'linux') {
        const { default: net } = await import('node:net');
        const canConnectDisplay = (socketPath) => new Promise((resolve) => {
          let settled = false;
          const socket = net.createConnection({ path: socketPath });
          const finish = (connected) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(connected);
          };
          socket.once('connect', () => finish(true));
          socket.once('error', () => finish(false));
          socket.setTimeout(150, () => finish(false));
        });

        for (let displayAttempt = 1; displayAttempt <= 2; displayAttempt++) {
          let xvfbSpawnError = null;
          try {
            localVirtualDisplay = pluginCtx.createVirtualDisplay();
            vdDisplay = localVirtualDisplay.get();
            if (typeof vdDisplay !== 'string' || !/^:\\d+$/.test(vdDisplay)) {
              throw new Error('Xvfb returned an invalid display');
            }
            const xvfbProcess = localVirtualDisplay.proc;
            if (!xvfbProcess || typeof xvfbProcess.once !== 'function') {
              throw new Error('Xvfb process handle is unavailable');
            }
            xvfbProcess.once('error', (error) => { xvfbSpawnError = error; });
            const socketPath = \`/tmp/.X11-unix/X\${vdDisplay.slice(1)}\`;
            const readyDeadline = Date.now() + 3000;
            while (!(await canConnectDisplay(socketPath))) {
              if (xvfbSpawnError) throw xvfbSpawnError;
              if (xvfbProcess.exitCode !== null || xvfbProcess.signalCode !== null) {
                throw new Error('Xvfb exited before its display was ready');
              }
              if (Date.now() >= readyDeadline) {
                throw new Error('Xvfb display readiness timed out');
              }
              await new Promise((resolve) => setTimeout(resolve, 25));
            }

            // A socket can briefly belong to a stale/racing display. Require a
            // second connection after a short stability window and confirm the
            // child that we started is still the live owner.
            await new Promise((resolve) => setTimeout(resolve, 75));
            if (xvfbSpawnError) throw xvfbSpawnError;
            if (xvfbProcess.exitCode !== null || xvfbProcess.signalCode !== null) {
              throw new Error('Xvfb exited during display stability check');
            }
            if (!(await canConnectDisplay(socketPath))) {
              throw new Error('Xvfb display failed its stability check');
            }
            if (xvfbSpawnError || xvfbProcess.exitCode !== null || xvfbProcess.signalCode !== null) {
              throw new Error('Xvfb stopped after display stability check');
            }
            displayStartupError = null;
            break;
          } catch (error) {
            displayStartupError = error;
            await stopVirtualDisplay(localVirtualDisplay);
            localVirtualDisplay = null;
            vdDisplay = undefined;
            if (displayAttempt < 2) {
              log('warn', 'xvfb display attempt failed; retrying', {
                error: error.message,
                attempt,
                displayAttempt,
              });
            }
          }
        }
        if (displayStartupError) throw displayStartupError;
        log('info', 'xvfb virtual display started', { display: vdDisplay, attempt });
      }
    } catch (err) {
      log('warn', 'xvfb not available, falling back to headless', { error: err.message, attempt });
      await stopVirtualDisplay(localVirtualDisplay);
      localVirtualDisplay = null;
      vdDisplay = undefined;
    }`;

let patched = fs.readFileSync(target, "utf8");

function applyExactPatch(label, before, after) {
  if (patched.includes(after)) return;
  const matches = patched.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`expected exactly one ${label} patch target, found ${matches}`);
  }
  patched = patched.replace(before, after);
}

applyExactPatch("graceful-shutdown", gracefulBefore, gracefulAfter);
applyExactPatch("structured-log-redaction", loggingBefore, loggingAfter);
applyExactPatch("owned-virtual-display-cleanup", cleanupBefore, cleanupAfter);
applyExactPatch("proxy-retry-display-cleanup", proxyRetryCleanupBefore, proxyRetryCleanupAfter);
applyExactPatch("launch-failure-display-cleanup", launchFailureCleanupBefore, launchFailureCleanupAfter);
applyExactPatch("browser-close-display-capture", closeDisplayCaptureBefore, closeDisplayCaptureAfter);
applyExactPatch("browser-close-timeout-display-cleanup", closeTimeoutCleanupBefore, closeTimeoutCleanupAfter);
applyExactPatch("scoped-browser-survivor-scan", survivorScanBefore, survivorScanAfter);
applyExactPatch("platform-managed-display", displayBefore, displayAfter);
applyExactPatch("low-bandwidth-screenshot-encoding", screenshotEncodingBefore, screenshotEncodingAfter);

const source = fs.readFileSync(target, "utf8");
if (patched === source) process.exit(0);
const temporary = `${target}.ubitech-patch-${process.pid}`;
fs.writeFileSync(temporary, patched, { encoding: "utf8", mode: 0o644 });
fs.renameSync(temporary, target);
