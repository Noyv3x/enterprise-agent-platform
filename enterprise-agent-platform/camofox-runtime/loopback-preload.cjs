"use strict";

// @askjo/camofox-browser 1.11.2 calls app.listen(PORT), so Express binds to
// every interface and ignores HOST/CAMOFOX_HOST. The managed runtime is an
// internal sidecar; constrain every TCP listener opened by this Node process
// to the loopback address selected by the platform.
const net = require("node:net");
const http = require("node:http");
const dns = require("node:dns").promises;

const bindHost = process.env.UBITECH_CAMOFOX_BIND_HOST || "127.0.0.1";
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function managedLoopbackListen(...args) {
  const target = args[0];
  if (target && typeof target === "object" && !Array.isArray(target) && "port" in target) {
    args[0] = { ...target, host: bindHost };
  } else if (
    typeof target === "number"
    || (typeof target === "string" && /^\d+$/.test(target))
  ) {
    if (typeof args[1] === "string") args[1] = bindHost;
    else args.splice(1, 0, bindHost);
  }
  return originalListen.apply(this, args);
};

const contextGuardInstalled = Symbol.for("ubitech.camofox.context-network-guard");
const browserGuardInstalled = Symbol.for("ubitech.camofox.browser-network-guard");
const browserTypeGuardInstalled = Symbol.for("ubitech.camofox.browser-type-network-guard");
const browserProxyPolicy = Symbol.for("ubitech.camofox.browser-proxy-policy");

const blockedMetadataHosts = new Set([
  "instance-data.ec2.internal",
  "metadata",
  "metadata.azure.internal",
  "metadata.google.internal",
  "metadata.oraclecloud.com",
]);
const blockedMetadataAddresses = new Set([
  "100.100.100.200", // Alibaba Cloud metadata service.
  "fd00:ec2::254",   // AWS IMDS IPv6 endpoint.
]);

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .split("%", 1)[0]
    .toLowerCase();
}

function parseIpv4(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result * 256) + octet;
  }
  return result >>> 0;
}

function parseIpv6(value) {
  let input = normalizeHostname(value);
  if (!input || input.includes(":::")) return null;
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const ipv4 = parseIpv4(input.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) return null;
    input = `${input.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  return words.reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n);
}

const blockedMetadataIpv4Numbers = new Set([
  parseIpv4("100.100.100.200"),
]);
const blockedMetadataIpv6Numbers = new Set([
  parseIpv6("fd00:ec2::254"),
]);

function isBlockedNetworkAddress(rawAddress) {
  const address = normalizeHostname(rawAddress);
  if (blockedMetadataAddresses.has(address)) return true;
  const family = net.isIP(address);
  if (family === 4) {
    const numeric = parseIpv4(address);
    // RFC 3927 link-local range, including every common 169.254.x metadata IP.
    return numeric !== null && (
      ((numeric & 0xffff0000) >>> 0) === 0xa9fe0000
      || blockedMetadataIpv4Numbers.has(numeric)
    );
  }
  if (family === 6) {
    const numeric = parseIpv6(address);
    if (numeric === null) return false;
    // RFC 4291 fe80::/10 link-local unicast.
    if ((numeric >> 118n) === 0x3fan) return true;
    // IPv4-mapped IPv6 addresses must receive the same link-local checks.
    if ((numeric >> 32n) === 0xffffn) {
      const mapped = Number(numeric & 0xffffffffn);
      return (
        ((mapped & 0xffff0000) >>> 0) === 0xa9fe0000
        || blockedMetadataIpv4Numbers.has(mapped)
      );
    }
    return blockedMetadataIpv6Numbers.has(numeric);
  }
  return false;
}

function isBlockedMetadataHostname(hostname) {
  const host = normalizeHostname(hostname);
  return blockedMetadataHosts.has(host) || host.endsWith(".metadata.google.internal");
}

async function inspectNetworkTarget(rawUrl, lookup = dns.lookup, { resolveDns = true } = {}) {
  let target;
  try {
    target = new URL(String(rawUrl));
  } catch {
    return { blocked: false, reason: "not-a-url" };
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(target.protocol)) {
    return { blocked: false, reason: "non-network-scheme" };
  }
  const hostname = normalizeHostname(target.hostname);
  if (isBlockedMetadataHostname(hostname)) {
    return { blocked: true, reason: "metadata-hostname", hostname };
  }
  if (net.isIP(hostname)) {
    return {
      blocked: isBlockedNetworkAddress(hostname),
      reason: isBlockedNetworkAddress(hostname) ? "metadata-or-link-local-address" : "public-address",
      hostname,
    };
  }
  if (!resolveDns) {
    return { blocked: false, reason: "dns-enforced-by-configured-proxy", hostname };
  }
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    for (const answer of answers || []) {
      if (isBlockedNetworkAddress(answer.address)) {
        return { blocked: true, reason: "dns-resolved-to-metadata-or-link-local", hostname };
      }
    }
  } catch {
    return { blocked: true, reason: "dns-resolution-failed", hostname };
  }
  return { blocked: false, reason: "public-hostname", hostname };
}

class PinningProxyError extends Error {
  constructor(message, { blocked = false, decision = null } = {}) {
    super(message);
    this.name = "PinningProxyError";
    this.blocked = blocked;
    this.decision = decision;
  }
}

function configuredPinningLookup() {
  const servers = String(process.env.UBITECH_CAMOFOX_PINNING_DNS_SERVERS || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!servers.length) return dns.lookup.bind(dns);

  const resolver = new dns.Resolver();
  resolver.setServers(servers);
  return async (hostname) => {
    const [ipv4, ipv6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    const answers = [];
    if (ipv4.status === "fulfilled") {
      answers.push(...ipv4.value.map((address) => ({ address, family: 4 })));
    }
    if (ipv6.status === "fulfilled") {
      answers.push(...ipv6.value.map((address) => ({ address, family: 6 })));
    }
    if (!answers.length) {
      const cause = ipv4.reason || ipv6.reason;
      throw new PinningProxyError(`DNS resolution failed for ${hostname}`, { decision: { hostname } }, { cause });
    }
    return answers;
  };
}

const pinningLookup = configuredPinningLookup();

async function resolvePinnedNetworkTarget(rawHostname, lookup = pinningLookup) {
  const hostname = normalizeHostname(rawHostname);
  if (!hostname) {
    throw new PinningProxyError("network target has no hostname");
  }
  if (isBlockedMetadataHostname(hostname)) {
    const decision = { blocked: true, reason: "metadata-hostname", hostname };
    throw new PinningProxyError("blocked metadata hostname", { blocked: true, decision });
  }
  if (net.isIP(hostname)) {
    if (isBlockedNetworkAddress(hostname)) {
      const decision = { blocked: true, reason: "metadata-or-link-local-address", hostname };
      throw new PinningProxyError("blocked metadata or link-local address", { blocked: true, decision });
    }
    return { address: hostname, family: net.isIP(hostname), hostname };
  }

  let answers;
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    if (error instanceof PinningProxyError) throw error;
    throw new PinningProxyError(`DNS resolution failed for ${hostname}`, {
      decision: { hostname, reason: "dns-resolution-failed" },
    });
  }
  if (!Array.isArray(answers)) answers = answers ? [answers] : [];
  const usable = answers
    .map((answer) => ({
      address: normalizeHostname(typeof answer === "string" ? answer : answer?.address),
      family: Number(typeof answer === "string" ? net.isIP(answer) : answer?.family),
    }))
    .filter((answer) => net.isIP(answer.address) && [4, 6].includes(answer.family));
  if (!usable.length) {
    throw new PinningProxyError(`DNS resolution returned no usable address for ${hostname}`, {
      decision: { hostname, reason: "dns-resolution-failed" },
    });
  }
  const denied = usable.find((answer) => isBlockedNetworkAddress(answer.address));
  if (denied) {
    const decision = {
      blocked: true,
      reason: "dns-resolved-to-metadata-or-link-local",
      hostname,
      address: denied.address,
    };
    throw new PinningProxyError("DNS resolved to a blocked address", { blocked: true, decision });
  }
  usable.sort((left, right) => left.family - right.family);
  // Prefer IPv4 on dual-stack hosts because many deployments have IPv6 DNS
  // answers but no working IPv6 route. The chosen numeric address is still
  // from this one fully validated answer set, with no second hostname lookup.
  // The proxy connects to this numeric address directly. There is no second
  // hostname lookup between policy evaluation and the actual socket.
  return { ...usable[0], hostname };
}

function reportBlockedNetworkTarget(kind, decision) {
  // Keep the audit line free of paths, query strings, and credentials while
  // making it possible to distinguish a Playwright route denial from an
  // ordinary browser/network failure.
  process.stderr.write(
    `[ubitech-camofox-network-guard] blocked ${kind} ${decision.hostname || "unknown"} (${decision.reason})\n`,
  );
}

function reportProxyPolicy(policy) {
  process.stderr.write(`[ubitech-camofox-network-policy] ${policy}\n`);
}

function targetPort(target, fallback) {
  const port = Number(target.port || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PinningProxyError("network target has an invalid port");
  }
  return port;
}

function parseAbsoluteProxyTarget(rawUrl, protocols) {
  let target;
  try {
    target = new URL(String(rawUrl));
  } catch {
    throw new PinningProxyError("proxy request target is not an absolute URL");
  }
  if (!protocols.has(target.protocol) || !target.hostname) {
    throw new PinningProxyError("proxy request target uses an unsupported protocol");
  }
  if (target.username || target.password) {
    throw new PinningProxyError("proxy request target must not contain userinfo");
  }
  return target;
}

function parseConnectTarget(authority) {
  let target;
  try {
    target = new URL(`http://${String(authority)}`);
  } catch {
    throw new PinningProxyError("CONNECT target is invalid");
  }
  if (
    !target.hostname
    || target.username
    || target.password
    || target.pathname !== "/"
    || target.search
    || target.hash
  ) {
    throw new PinningProxyError("CONNECT target is invalid");
  }
  return {
    hostname: normalizeHostname(target.hostname),
    port: targetPort(target, 443),
  };
}

function sanitizedProxyHeaders(headers) {
  const result = { ...headers };
  const hopByHop = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const named of String(headers.connection || "").split(",")) {
    if (named.trim()) hopByHop.add(named.trim().toLowerCase());
  }
  for (const name of hopByHop) delete result[name];
  return result;
}

function proxyFailureStatus(error) {
  return error?.blocked ? 403 : 502;
}

function proxyFailureText(error) {
  return error?.blocked
    ? "Blocked by managed browser network policy"
    : "Managed browser proxy could not resolve or connect to the target";
}

function auditProxyFailure(kind, error) {
  const decision = error?.decision || { hostname: "unknown", reason: "proxy-failure" };
  if (error?.blocked) reportBlockedNetworkTarget(kind, decision);
  else process.stderr.write(
    `[ubitech-camofox-network-guard] denied ${kind} ${decision.hostname || "unknown"} (${decision.reason || "resolution-or-connect-failed"})\n`,
  );
}

function writeSocketFailure(socket, error) {
  if (socket.destroyed) return;
  const status = proxyFailureStatus(error);
  const reason = status === 403 ? "Forbidden" : "Bad Gateway";
  const body = proxyFailureText(error);
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function trackSocket(sockets, socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

function createPinningProxy({ lookup = pinningLookup } = {}) {
  const sockets = new Set();
  let proxyUrl = "";

  const server = http.createServer((request, response) => {
    void (async () => {
      const target = parseAbsoluteProxyTarget(request.url, new Set(["http:"]));
      const pinned = await resolvePinnedNetworkTarget(target.hostname, lookup);
      const upstream = http.request(
        {
          host: pinned.address,
          family: pinned.family,
          port: targetPort(target, 80),
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers: sanitizedProxyHeaders(request.headers),
          agent: false,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode || 502,
            upstreamResponse.statusMessage,
            sanitizedProxyHeaders(upstreamResponse.headers),
          );
          upstreamResponse.once("error", (error) => response.destroy(error));
          upstreamResponse.once("aborted", () => response.destroy(new Error("upstream response aborted")));
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("socket", (socket) => trackSocket(sockets, socket));
      upstream.setTimeout(60_000, () => upstream.destroy(new Error("upstream request timed out")));
      upstream.once("error", (error) => {
        if (!response.headersSent) {
          response.statusCode = 502;
          response.setHeader("Connection", "close");
          response.end(proxyFailureText(error));
        } else {
          response.destroy(error);
        }
      });
      request.once("aborted", () => upstream.destroy(new Error("proxy client aborted")));
      request.pipe(upstream);
    })().catch((error) => {
      auditProxyFailure("proxy-request", error);
      if (!response.headersSent) {
        response.statusCode = proxyFailureStatus(error);
        response.setHeader("Connection", "close");
        response.end(proxyFailureText(error));
      } else {
        response.destroy(error);
      }
    });
  });

  server.on("connect", (request, clientSocket, head) => {
    clientSocket.pause();
    let upstreamSocket = null;
    let established = false;
    clientSocket.once("error", () => upstreamSocket?.destroy());
    void (async () => {
      const target = parseConnectTarget(request.url);
      const pinned = await resolvePinnedNetworkTarget(target.hostname, lookup);
      upstreamSocket = trackSocket(
        sockets,
        net.connect({ host: pinned.address, family: pinned.family, port: target.port }),
      );
      upstreamSocket.setTimeout(60_000, () => upstreamSocket.destroy(new Error("CONNECT timed out")));
      upstreamSocket.once("connect", () => {
        if (clientSocket.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        established = true;
        upstreamSocket.setTimeout(0);
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstreamSocket.write(head);
        clientSocket.resume();
        clientSocket.pipe(upstreamSocket).pipe(clientSocket);
      });
      upstreamSocket.once("error", (error) => {
        if (clientSocket.destroyed) return;
        if (established) clientSocket.destroy(error);
        else writeSocketFailure(clientSocket, error);
      });
    })().catch((error) => {
      auditProxyFailure("proxy-connect", error);
      writeSocketFailure(clientSocket, error);
    });
  });

  server.on("upgrade", (request, clientSocket, head) => {
    clientSocket.pause();
    let upstreamSocket = null;
    let established = false;
    clientSocket.once("error", () => upstreamSocket?.destroy());
    void (async () => {
      const target = parseAbsoluteProxyTarget(request.url, new Set(["http:", "ws:"]));
      const pinned = await resolvePinnedNetworkTarget(target.hostname, lookup);
      upstreamSocket = trackSocket(
        sockets,
        net.connect({
          host: pinned.address,
          family: pinned.family,
          port: targetPort(target, 80),
        }),
      );
      upstreamSocket.setTimeout(60_000, () => upstreamSocket.destroy(new Error("WebSocket timed out")));
      upstreamSocket.once("connect", () => {
        if (clientSocket.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        established = true;
        upstreamSocket.setTimeout(0);
        const headerLines = [];
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          const name = request.rawHeaders[index];
          if (["proxy-authorization", "proxy-connection"].includes(name.toLowerCase())) continue;
          headerLines.push(`${name}: ${request.rawHeaders[index + 1]}`);
        }
        upstreamSocket.write(
          `${request.method} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n${headerLines.join("\r\n")}\r\n\r\n`,
        );
        if (head.length) upstreamSocket.write(head);
        clientSocket.resume();
        clientSocket.pipe(upstreamSocket).pipe(clientSocket);
      });
      upstreamSocket.once("error", (error) => {
        if (clientSocket.destroyed) return;
        if (established) clientSocket.destroy(error);
        else writeSocketFailure(clientSocket, error);
      });
    })().catch((error) => {
      auditProxyFailure("proxy-websocket", error);
      writeSocketFailure(clientSocket, error);
    });
  });

  server.on("connection", (socket) => trackSocket(sockets, socket));
  server.on("clientError", (_error, socket) => writeSocketFailure(socket, new PinningProxyError("invalid proxy request")));

  return {
    server,
    get url() {
      return proxyUrl;
    },
    async listen() {
      if (proxyUrl) return proxyUrl;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        originalListen.call(server, { port: 0, host: bindHost }, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("pinning proxy has no TCP address");
      proxyUrl = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
      server.unref();
      return proxyUrl;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

let managedPinningProxy = null;
let managedPinningProxyPromise = null;

async function ensureManagedPinningProxy() {
  if (!managedPinningProxyPromise) {
    managedPinningProxy = createPinningProxy();
    managedPinningProxyPromise = managedPinningProxy.listen().then((url) => {
      reportProxyPolicy(`connection-pinning proxy active at ${url}`);
      return url;
    });
  }
  return managedPinningProxyPromise;
}

function stopManagedPinningProxy() {
  void managedPinningProxy?.close().catch(() => {});
}

process.once("SIGTERM", stopManagedPinningProxy);
process.once("SIGINT", stopManagedPinningProxy);

async function guardHttpRoute(route, options = {}) {
  const decision = await inspectNetworkTarget(route.request().url(), dns.lookup, options);
  if (decision.blocked) {
    reportBlockedNetworkTarget("request", decision);
    await route.abort("blockedbyclient");
  }
  else await route.continue();
}

async function guardWebSocketRoute(route, options = {}) {
  const decision = await inspectNetworkTarget(route.url(), dns.lookup, options);
  if (decision.blocked) {
    reportBlockedNetworkTarget("websocket", decision);
    route.close({ code: 1008, reason: "blocked network target" });
  }
  else route.connectToServer();
}

async function installContextNetworkGuard(context, options = {}) {
  if (!context || context[contextGuardInstalled]) return context;
  Object.defineProperty(context, contextGuardInstalled, { value: true });
  await context.route("**/*", (route) => guardHttpRoute(route, options));
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket("**/*", (route) => guardWebSocketRoute(route, options));
  }
  return context;
}

const reportedProxyPolicies = new Set();

function hasConfiguredProxy(options) {
  const proxy = options?.proxy;
  return Boolean(
    (typeof proxy === "string" && proxy.trim())
    || (proxy && typeof proxy === "object" && String(proxy.server || "").trim()),
  );
}

function reportProxyPolicyOnce(policy) {
  if (reportedProxyPolicies.has(policy)) return;
  reportedProxyPolicies.add(policy);
  reportProxyPolicy(policy);
}

async function managedContextOptions(options, inheritedPolicy) {
  const contextHasUpstreamProxy = hasConfiguredProxy(options);
  if (contextHasUpstreamProxy || inheritedPolicy.upstreamProxy) {
    // Remote-proxy DNS cannot be pinned without replacing or MITMing the
    // operator's proxy. Preserve it and retain the URL/literal/link-local
    // Playwright route guard. This limitation is explicit in the runtime log.
    reportProxyPolicyOnce(
      "upstream proxy preserved; URL and literal metadata guard active, remote proxy DNS remains operator-controlled",
    );
    return { ...options, serviceWorkers: "block" };
  }
  const proxyUrl = await ensureManagedPinningProxy();
  return {
    ...options,
    serviceWorkers: "block",
    proxy: { server: proxyUrl },
  };
}

async function guardCreatedContext(context) {
  try {
    // Hostname resolution is performed by either the connection-pinning proxy
    // or the operator's explicit upstream proxy. The route layer still blocks
    // known metadata hostnames and every literal metadata/link-local address.
    return await installContextNetworkGuard(context, { resolveDns: false });
  } catch (error) {
    await context?.close().catch(() => {});
    throw error;
  }
}

function patchBrowser(browser, policy = { upstreamProxy: true, source: "unknown" }) {
  if (!browser || browser[browserGuardInstalled]) return browser;
  Object.defineProperty(browser, browserGuardInstalled, { value: true });
  Object.defineProperty(browser, browserProxyPolicy, { value: policy });
  const originalNewContext = browser.newContext;
  browser.newContext = async function managedNewContext(options = {}) {
    const protectedOptions = await managedContextOptions(options, this[browserProxyPolicy] || policy);
    const context = await originalNewContext.call(this, protectedOptions);
    return guardCreatedContext(context);
  };
  for (const context of browser.contexts?.() || []) {
    reportProxyPolicyOnce(
      "pre-existing context received route guard only; proxy policy could not be changed after creation",
    );
    installContextNetworkGuard(context, { resolveDns: false }).catch(
      () => context.close().catch(() => {}),
    );
  }
  return browser;
}

function patchBrowserType(browserType) {
  if (!browserType || browserType[browserTypeGuardInstalled]) return;
  Object.defineProperty(browserType, browserTypeGuardInstalled, { value: true });
  for (const method of ["launch", "connect", "connectOverCDP"]) {
    if (typeof browserType[method] !== "function") continue;
    const original = browserType[method];
    browserType[method] = async function managedBrowserFactory(...args) {
      const policy = method === "launch"
        ? { upstreamProxy: hasConfiguredProxy(args[0]), source: "launch" }
        : { upstreamProxy: true, source: method };
      return patchBrowser(await original.apply(this, args), policy);
    };
  }
  if (typeof browserType.launchPersistentContext === "function") {
    const originalPersistent = browserType.launchPersistentContext;
    browserType.launchPersistentContext = async function managedPersistentContext(userDataDir, options = {}) {
      const protectedOptions = await managedContextOptions(
        options,
        { upstreamProxy: hasConfiguredProxy(options), source: "persistent" },
      );
      const context = await originalPersistent.call(
        this,
        userDataDir,
        protectedOptions,
      );
      return guardCreatedContext(context);
    };
  }
}

try {
  const playwright = require("playwright-core");
  for (const browserType of [playwright.chromium, playwright.firefox, playwright.webkit]) {
    patchBrowserType(browserType);
  }
} catch (error) {
  // Source-only unit tests load this preload before npm ci. Runtime validation
  // separately requires Playwright, so only tolerate that one missing module.
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
}

module.exports = {
  createPinningProxy,
  inspectNetworkTarget,
  installContextNetworkGuard,
  isBlockedMetadataHostname,
  isBlockedNetworkAddress,
  patchBrowser,
  resolvePinnedNetworkTarget,
};
