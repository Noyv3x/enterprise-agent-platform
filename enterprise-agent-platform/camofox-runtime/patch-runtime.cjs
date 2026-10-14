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
    const parsed = new URL(text, 'http://agent-platform.invalid');
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
    const options = { type: format, fullPage, scale: 'css' };
    if (format === 'jpeg') options.quality = quality;
    // Optional page-coordinate clip (artifact renderer): bounds the work of a full-page capture to the rectangle needed.
    const clipX = Number(req.query.clipX ?? 0);
    const clipY = Number(req.query.clipY ?? 0);
    const clipWidth = Number(req.query.clipWidth);
    const clipHeight = Number(req.query.clipHeight);
    if (req.query.clipWidth !== undefined || req.query.clipHeight !== undefined) {
      if (![clipX, clipY, clipWidth, clipHeight].every(Number.isFinite) || clipX < 0 || clipY < 0 || clipX > 1000000
          || clipY > 1000000 || clipWidth < 1 || clipWidth > 16384 || clipHeight < 1 || clipHeight > 32768) {
        return res.status(400).json({ error: 'invalid clip' });
      }
      options.fullPage = true;
      options.clip = { x: clipX, y: clipY, width: clipWidth, height: clipHeight };
    }
    const buffer = await tabState.page.screenshot(options);
    pluginEvents.emit('tab:screenshot', { userId, tabId: req.params.tabId, buffer });
    res.set('Content-Type', format === 'jpeg' ? 'image/jpeg' : 'image/png');
    res.send(buffer);`;
const coordinateClickRequestBefore = `    const { userId, ref, selector } = req.body;`;
const coordinateClickRequestAfter = `    const { userId, ref, selector, x, y, doubleClick = false } = req.body;
    const coordinateX = Number(x);
    const coordinateY = Number(y);
    const hasCoordinate = Number.isFinite(coordinateX) && Number.isFinite(coordinateY);`;
const coordinateClickValidationBefore = `    if (!ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required' });
    }`;
const coordinateClickValidationAfter = `    if (!ref && !selector && !hasCoordinate) {
      return res.status(400).json({ error: 'ref, selector, or coordinates required' });
    }
    if (hasCoordinate && (coordinateX < 0 || coordinateY < 0 || coordinateX > 16384 || coordinateY > 16384)) {
      return res.status(400).json({ error: 'coordinates out of range' });
    }`;
const coordinateClickBranchBefore = `      if (ref) {
        let locator = refToLocator(tabState.page, ref, tabState.refs);
        if (!locator) {
          // Use tight timeout (4s max) to leave budget for click + post-click buildRefs`;
const coordinateClickBranchAfter = `      if (hasCoordinate) {
        await tabState.page.mouse.click(coordinateX, coordinateY, {
          clickCount: doubleClick === true ? 2 : 1,
          delay: 50,
        });
      } else if (ref) {
        let locator = refToLocator(tabState.page, ref, tabState.refs);
        if (!locator) {
          // Use tight timeout (4s max) to leave budget for click + post-click buildRefs`;
const pointerRouteBefore = `// Type
/**
 * @openapi
 * /tabs/{tabId}/type:`;
const pointerRouteAfter = `// Platform-owned atomic human pointer gestures.
// A complete drag is validated before entering the tab lock, then executes as
// one down/move/up unit. Platform's lease-bound monotonic sequence is the sole
// replay fence, so this internal route has no second gesture identity.
app.post('/tabs/:tabId/pointer', async (req, res) => {
  const tabId = req.params.tabId;
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'pointer body must be an object' });
    }
    const allowedFields = new Set(['userId', 'action', 'points']);
    if (Object.keys(body).some((key) => !allowedFields.has(key))) {
      return res.status(400).json({ error: 'unsupported pointer field' });
    }
    const { userId, action, points } = body;
    if (typeof userId !== 'string' || !userId) {
      return res.status(400).json({ error: 'userId required' });
    }
    if (action !== 'drag') {
      return res.status(400).json({ error: 'pointer action is invalid' });
    }

    if (!Array.isArray(points) || points.length < 2 || points.length > 64) {
      return res.status(400).json({ error: 'drag point count is invalid' });
    }
    let previousAtMs = -1;
    const normalizedPoints = [];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (!point || typeof point !== 'object' || Array.isArray(point)
          || Object.keys(point).length !== 3
          || !Object.hasOwn(point, 'x')
          || !Object.hasOwn(point, 'y')
          || !Object.hasOwn(point, 'at_ms')) {
        return res.status(400).json({ error: 'drag point is invalid' });
      }
      if (typeof point.x !== 'number' || typeof point.y !== 'number') {
        return res.status(400).json({ error: 'drag coordinates are invalid' });
      }
      const x = point.x;
      const y = point.y;
      const atMs = point.at_ms;
      if (!Number.isFinite(x) || !Number.isFinite(y)
          || x < 0 || y < 0 || x > 16384 || y > 16384) {
        return res.status(400).json({ error: 'drag coordinates are out of range' });
      }
      if (!Number.isSafeInteger(atMs)
          || (index === 0 && atMs !== 0)
          || (index > 0 && atMs <= previousAtMs)
          || atMs > 10000) {
        return res.status(400).json({ error: 'drag timing is invalid' });
      }
      normalizedPoints.push({ x, y, atMs });
      previousAtMs = atMs;
    }

    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return tabNotFoundResponse(res, tabId);
    session.lastAccess = Date.now();
    const { tabState } = found;
    tabState.toolCalls += 1;
    tabState.consecutiveTimeouts = 0;
    tabState.consecutiveFailures = 0;

    const result = await withUserLimit(userId, () => withTabLock(tabId, async () => {
      if (tabState.agentPlatformPointerDown) {
        try {
          await tabState.page.mouse.up({ button: 'left' });
        } finally {
          tabState.agentPlatformPointerDown = false;
        }
      }
      const first = normalizedPoints[0];
      await tabState.page.mouse.move(first.x, first.y);
      let dragError = null;
      try {
        tabState.agentPlatformPointerDown = true;
        await tabState.page.mouse.down({ button: 'left' });
        let previousAtMs = first.atMs;
        for (const point of normalizedPoints.slice(1)) {
          const delayMs = point.atMs - previousAtMs;
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          await tabState.page.mouse.move(point.x, point.y);
          previousAtMs = point.atMs;
        }
      } catch (error) {
        dragError = error;
        throw error;
      } finally {
        if (tabState.agentPlatformPointerDown) {
          try {
            await tabState.page.mouse.up({ button: 'left' });
          } catch (upError) {
            if (!dragError) throw upError;
            log('warn', 'pointer cleanup failed after drag error', {
              reqId: req.reqId,
              tabId,
              error: upError.message,
            });
          } finally {
            tabState.agentPlatformPointerDown = false;
          }
        }
      }
      return {
        ok: true,
        points: normalizedPoints.length,
        durationMs: normalizedPoints[normalizedPoints.length - 1].atMs,
      };
    }));

    pluginEvents.emit('tab:pointer', { userId, tabId, action });
    res.json(result);
  } catch (err) {
    log('error', 'pointer action failed', { reqId: req.reqId, tabId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Type
/**
 * @openapi
 * /tabs/{tabId}/type:`;
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

// The preload's strict renderer egress policy keys on the Camofox user id, which upstream does not hand to
// browser.newContext. Pass it as an ignored second argument that the preload's wrapper reads.
const contextOwnerBefore = "const context = await b.newContext(contextOptions);";
const contextOwnerAfter = "const context = await b.newContext(contextOptions, { agentPlatformUserId: String(key) });";

// Platform's throwaway browser identities (`artifact-render:<uuid>` renders, `web-fetch:<uuid>` page fetches) must leave
// nothing on disk. Upstream's persistence plugin saves every identity's cookies and localStorage under
// profiles/<sha256(userId)[:32]>/ on session close and imports the bootstrap cookies.txt into new ones; the patched plugin
// sees no session events for ephemeral identities, and on startup removes profiles an earlier version saved for them
// (recognised by meta.json's userId; other identities' profiles are never touched).
const persistencePlugin = path.join(path.dirname(target), "plugins", "persistence", "index.js");
const pluginImportsBefore = "import { importBootstrapCookies } from '../../lib/cookies.js';";
const pluginImportsAfter = `import { importBootstrapCookies } from '../../lib/cookies.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// Agent Platform: ephemeral identities are never persisted, restored or seeded with bootstrap cookies.
export function isEphemeralIdentity(userId) {
  return /^(?:artifact-render|web-fetch):/.test(String(userId ?? ''));
}

export async function removeEphemeralProfiles(profileDir) {
  const root = path.resolve(profileDir);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{32}$/.test(entry.name)) continue;
    const userDir = path.join(root, entry.name);
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(userDir, 'meta.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!isEphemeralIdentity(meta?.userId)) continue;
    await fs.rm(userDir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}`;
const pluginEventsBefore = "  const { events, config, log } = ctx;";
const pluginEventsAfter = `  const { config, log } = ctx;
  // Agent Platform: session hooks never run for ephemeral identities, so they are not tracked, checkpointed or restored.
  const events = {
    on: (name, handler) => ctx.events.on(name, (payload, ...rest) =>
      (name.startsWith('session:') && isEphemeralIdentity(payload?.userId) ? undefined : handler(payload, ...rest))),
  };`;
const pluginCleanupBefore = "  log('info', 'persistence plugin enabled', { profileDir });";
const pluginCleanupAfter = `  log('info', 'persistence plugin enabled', { profileDir });
  const removedEphemeral = await removeEphemeralProfiles(profileDir).catch((err) => {
    log('warn', 'could not remove ephemeral identity profiles', { error: err?.message || String(err) });
    return 0;
  });
  if (removedEphemeral) log('info', 'removed persisted state of ephemeral identities', { removed: removedEphemeral });`;

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
applyExactPatch("context-owner-for-network-policy", contextOwnerBefore, contextOwnerAfter);
applyExactPatch("structured-log-redaction", loggingBefore, loggingAfter);
applyExactPatch("owned-virtual-display-cleanup", cleanupBefore, cleanupAfter);
applyExactPatch("proxy-retry-display-cleanup", proxyRetryCleanupBefore, proxyRetryCleanupAfter);
applyExactPatch("launch-failure-display-cleanup", launchFailureCleanupBefore, launchFailureCleanupAfter);
applyExactPatch("browser-close-display-capture", closeDisplayCaptureBefore, closeDisplayCaptureAfter);
applyExactPatch("browser-close-timeout-display-cleanup", closeTimeoutCleanupBefore, closeTimeoutCleanupAfter);
applyExactPatch("scoped-browser-survivor-scan", survivorScanBefore, survivorScanAfter);
applyExactPatch("platform-managed-display", displayBefore, displayAfter);
applyExactPatch("low-bandwidth-screenshot-encoding", screenshotEncodingBefore, screenshotEncodingAfter);
applyExactPatch("coordinate-click-request", coordinateClickRequestBefore, coordinateClickRequestAfter);
applyExactPatch("coordinate-click-validation", coordinateClickValidationBefore, coordinateClickValidationAfter);
applyExactPatch("coordinate-click-branch", coordinateClickBranchBefore, coordinateClickBranchAfter);
const pointerRouteMarker = "app.post('/tabs/:tabId/pointer'";
const pointerRouteMatches = patched.split(pointerRouteMarker).length - 1;
if (pointerRouteMatches === 0) {
  applyExactPatch("atomic-human-pointer-route", pointerRouteBefore, pointerRouteAfter);
} else if (pointerRouteMatches !== 1) {
  throw new Error(`expected at most one atomic-human-pointer-route, found ${pointerRouteMatches}`);
}

function patchPlugin(source) {
  let text = source;
  for (const [label, before, after] of [["ephemeral-identity-imports", pluginImportsBefore, pluginImportsAfter],
    ["ephemeral-identity-events", pluginEventsBefore, pluginEventsAfter],
    ["ephemeral-identity-startup-cleanup", pluginCleanupBefore, pluginCleanupAfter]]) {
    if (text.includes(after)) continue;
    const matches = text.split(before).length - 1;
    if (matches !== 1) throw new Error(`expected exactly one ${label} patch target, found ${matches}`);
    text = text.replace(before, after);
  }
  return text;
}

function writeIfChanged(file, text) {
  if (text === fs.readFileSync(file, "utf8")) return;
  const temporary = `${file}.agent-platform-patch-${process.pid}`;
  fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o644 });
  fs.renameSync(temporary, file);
}

const pluginPatched = patchPlugin(fs.readFileSync(persistencePlugin, "utf8"));
writeIfChanged(target, patched);
writeIfChanged(persistencePlugin, pluginPatched);
