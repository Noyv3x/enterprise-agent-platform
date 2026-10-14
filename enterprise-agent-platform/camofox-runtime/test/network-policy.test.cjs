'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
process.env.AGENT_PLATFORM_TECHNICAL_PROFILE = 'agent-platform-v1';
process.env.AGENT_PLATFORM_CAMOFOX_BIND_HOST = '127.0.0.1';
// The renderer may reach this exact host; web-fetch identities must not inherit it.
process.env.AGENT_PLATFORM_CAMOFOX_RENDER_ALLOWED_HOSTS = 'localhost:8765';
const { inspectNetworkTarget, resolvePinnedNetworkTarget, createPinningProxy } = require('../loopback-preload.cjs');

for (const address of ['127.0.0.1', '10.2.3.4', '172.16.2.3', '192.168.2.3', '::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.2.3.4']) {
  test(`ordinary loopback/private target remains allowed: ${address}`, async () => {
    const host = net.isIP(address) === 6 ? `[${address}]` : address;
    assert.equal((await inspectNetworkTarget(`http://${host}/`)).blocked, false);
    assert.equal((await resolvePinnedNetworkTarget(address)).address, address);
  });
}

// No sockets are opened for these addresses; both public validation seams run.
for (const address of ['0.0.0.0', '224.0.0.1', '240.0.0.1', '::', 'ff02::1', '100::1', '::ffff:0.0.0.0', '::ffff:224.0.0.1', '::ffff:240.0.0.1']) {
  test(`special-use destination is rejected literally and through DNS: ${address}`, async () => {
    const host = net.isIP(address) === 6 ? `[${address}]` : address;
    const lookup = async () => [{ address, family: net.isIP(address) }];
    const direct = await inspectNetworkTarget(`http://${host}/`);
    const resolved = await inspectNetworkTarget('http://fixture.invalid/', lookup);
    const literalPinned = await resolvePinnedNetworkTarget(address).then(() => false, error => error.blocked === true);
    const dnsPinned = await resolvePinnedNetworkTarget('fixture.invalid', lookup).then(() => false, error => error.blocked === true);
    assert.deepEqual({ direct: direct.blocked, resolved: resolved.blocked, literalPinned, dnsPinned },
      { direct: true, resolved: true, literalPinned: true, dnsPinned: true });
  });
}

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

test('canceling a streamed HTTP response closes the upstream socket', { timeout: 8000 }, async () => {
  const sockets = new Set();
  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 2 });
  let observeUpstreamClose;
  const upstreamClosed = new Promise(resolve => { observeUpstreamClose = resolve; });
  const origin = http.createServer((request, response) => {
    if (request.url === '/complete') {
      response.end('complete');
      return;
    }
    request.socket.once('close', observeUpstreamClose);
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.write('stream-start\n'); // Intentionally stays open until consumer cancellation.
  });
  origin.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const proxy = createPinningProxy();
  let client;
  let incoming;
  try {
    await new Promise((resolve, reject) => {
      origin.once('error', reject);
      origin.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const proxyUrl = new URL(await proxy.listen());
    const completed = () => bounded(new Promise((resolve, reject) => {
      http.get({ hostname: proxyUrl.hostname, port: proxyUrl.port, agent: keepAlive,
        path: `http://127.0.0.1:${origin.address().port}/complete` }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('error', reject);
        response.once('end', () => resolve({ body, socket: response.req.socket }));
      }).once('error', reject);
    }), 2500, 'normal response did not finish');
    const first = await completed();
    assert.equal(first.body, 'complete');
    const second = await completed();
    assert.equal(second.body, 'complete');
    assert.equal(second.socket, first.socket, 'successful responses preserve the client connection');
    await bounded(new Promise((resolve, reject) => {
      client = http.get({ hostname: proxyUrl.hostname, port: proxyUrl.port, agent: false,
        path: `http://127.0.0.1:${origin.address().port}/stream` }, response => {
        incoming = response;
        response.once('error', reject);
        response.once('data', chunk => {
          try {
            assert.equal(chunk.toString(), 'stream-start\n');
            response.destroy();
            resolve();
          } catch (error) { reject(error); }
        });
      });
      client.once('error', reject);
    }), 2500, 'client never received origin stream');
    const concurrent = completed();
    // This is the real origin-side TCP close, observed before any fixture cleanup.
    await bounded(upstreamClosed, 1500, 'upstream socket survived client response cancellation');
    const unaffected = await concurrent;
    assert.equal(unaffected.body, 'complete');
    assert.equal(unaffected.socket, first.socket, 'canceling another response preserves keep-alive');
  } finally {
    keepAlive.destroy();
    incoming?.destroy();
    client?.destroy();
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => origin.close(resolve));
  }
});

// -- strict egress for artifact renderer contexts ------------------------------------------------------------------
const strictPreload = require('../loopback-preload.cjs');
const strictPolicy = { allowed: strictPreload.parseAllowedHosts('platform:8765, render.internal') };

for (const address of ['127.0.0.1', '127.8.8.8', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255',
  '169.254.169.254', '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', 'fd12::1', 'fe80::1', 'fec0::1', '::ffff:10.1.2.3', '::ffff:127.0.0.1',
  '2002:0a00:0001::1', '2001:db8::1', '64:ff9b::a00:1']) {
  test(`strict renderer egress denies non-public address: ${address}`, async () => {
    const host = net.isIP(address) === 6 ? `[${address}]` : address;
    assert.equal(strictPreload.isStrictlyPublicAddress(address), false);
    assert.equal((await strictPreload.inspectStrictTarget(`http://${host}:8080/`, undefined, strictPolicy)).blocked, true);
    const lookup = async () => [{ address, family: net.isIP(address) }];
    assert.equal((await strictPreload.inspectStrictTarget('http://evil.example/', lookup, strictPolicy)).blocked, true);
    await assert.rejects(resolvePinnedNetworkTarget(address, undefined, { strict: strictPolicy, port: 80 }), error => error.blocked === true);
    await assert.rejects(resolvePinnedNetworkTarget('evil.example', lookup, { strict: strictPolicy, port: 80 }), error => error.blocked === true);
  });
}

for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
  test(`strict renderer egress allows a public address: ${address}`, async () => {
    const host = net.isIP(address) === 6 ? `[${address}]` : address;
    assert.equal(strictPreload.isStrictlyPublicAddress(address), true);
    assert.equal((await strictPreload.inspectStrictTarget(`https://${host}/`, undefined, strictPolicy)).blocked, false);
    const lookup = async () => [{ address, family: net.isIP(address) }];
    assert.equal((await resolvePinnedNetworkTarget('cdn.example', lookup, { strict: strictPolicy, port: 443 })).address, address);
  });
}

test('strict renderer egress reaches only the exact render base host, by name and port', async () => {
  const lookup = async () => [{ address: '172.18.0.7', family: 4 }];
  assert.equal((await strictPreload.inspectStrictTarget('http://platform:8765/artifact-view/t/x', lookup, strictPolicy)).blocked, false);
  assert.equal((await strictPreload.inspectStrictTarget('http://PLATFORM.:8765/x', lookup, strictPolicy)).blocked, false);
  assert.equal((await strictPreload.inspectStrictTarget('http://render.internal/x', lookup, strictPolicy)).blocked, false);
  // Another port, another service name and the resolved address itself are all refused.
  assert.equal((await strictPreload.inspectStrictTarget('http://platform:9999/x', lookup, strictPolicy)).blocked, true);
  for (const name of ['agent-runtime', 'camofox', 'searxng', 'manager', 'platform.evil.example', 'localhost']) {
    assert.equal((await strictPreload.inspectStrictTarget(`http://${name}:8765/`, lookup, strictPolicy)).blocked, true, name);
  }
  assert.equal((await strictPreload.inspectStrictTarget('http://172.18.0.7:8765/', undefined, strictPolicy)).blocked, true);
  const pinned = await resolvePinnedNetworkTarget('platform', lookup, { strict: strictPolicy, port: 8765 });
  assert.equal(pinned.address, '172.18.0.7');
  await assert.rejects(resolvePinnedNetworkTarget('platform', lookup, { strict: strictPolicy, port: 22 }), error => error.blocked === true);
  // No allowed host configured: nothing private is reachable at all.
  await assert.rejects(resolvePinnedNetworkTarget('platform', lookup, { strict: { allowed: [] }, port: 8765 }), error => error.blocked === true);
  assert.equal((await strictPreload.inspectStrictTarget('http://platform:8765/', lookup, { allowed: [] })).blocked, true);
});

test('strict renderer egress refuses unresolvable names and metadata hosts, and ignores non-network schemes', async () => {
  const failing = async () => { throw new Error('nxdomain'); };
  assert.equal((await strictPreload.inspectStrictTarget('http://nx.example/', failing, strictPolicy)).blocked, true);
  assert.equal((await strictPreload.inspectStrictTarget('http://metadata.google.internal/', undefined, strictPolicy)).blocked, true);
  assert.equal((await strictPreload.inspectStrictTarget('data:text/html,hi', undefined, strictPolicy)).blocked, false);
  assert.equal((await strictPreload.inspectStrictTarget('blob:null/1', undefined, strictPolicy)).blocked, false);
  // A name with one public and one private answer is refused entirely.
  const mixed = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.9', family: 4 }];
  assert.equal((await strictPreload.inspectStrictTarget('http://mixed.example/', mixed, strictPolicy)).blocked, true);
});

test('the strict pinning proxy refuses a loopback origin that the default proxy serves', async () => {
  const origin = http.createServer((request, response) => response.end('inside'));
  await new Promise(resolve => origin.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const target = `http://127.0.0.1:${origin.address().port}/`;
  const ask = async (proxy) => {
    const proxyUrl = new URL(await proxy.listen());
    return bounded(new Promise((resolve, reject) => {
      http.get({ hostname: proxyUrl.hostname, port: proxyUrl.port, path: target, agent: false }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolve({ status: response.statusCode, body }));
      }).once('error', reject);
    }), 3000, 'proxy request timed out');
  };
  const plain = createPinningProxy();
  const strict = createPinningProxy({ strict: strictPolicy });
  try {
    assert.deepEqual(await ask(plain), { status: 200, body: 'inside' });
    assert.equal((await ask(strict)).status, 403);
  } finally {
    await plain.close();
    await strict.close();
    origin.close();
  }
});

test('web-fetch identities get strict public-only egress with no allowlisted host', async () => {
  const fetchPolicy = strictPreload.strictPolicyFor('web-fetch:6f1c');
  const renderPolicy = strictPreload.strictPolicyFor('artifact-render:6f1c');
  assert.ok(fetchPolicy);
  assert.deepEqual(fetchPolicy.allowed, []);
  for (const id of ['private:1', 'web-fetch', 'x-web-fetch:1', '', undefined]) assert.equal(strictPreload.strictPolicyFor(id), null, String(id));
  const loopback = async () => [{ address: '127.0.0.1', family: 4 }];
  // The render base host stays reachable for renderers only.
  assert.equal((await strictPreload.inspectStrictTarget('http://localhost:8765/', loopback, renderPolicy)).blocked, false);
  assert.equal((await strictPreload.inspectStrictTarget('http://localhost:8765/', loopback, fetchPolicy)).blocked, true);
  await assert.rejects(resolvePinnedNetworkTarget('localhost', loopback, { strict: fetchPolicy, port: 8765 }), error => error.blocked === true);
  for (const address of ['10.0.0.5', '169.254.169.254', '::1', 'fd12::1']) {
    const lookup = async () => [{ address, family: net.isIP(address) }];
    assert.equal((await strictPreload.inspectStrictTarget('https://news.example/', lookup, fetchPolicy)).blocked, true, address);
    await assert.rejects(resolvePinnedNetworkTarget('news.example', lookup, { strict: fetchPolicy, port: 443 }), error => error.blocked === true);
  }
  const pub = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal((await resolvePinnedNetworkTarget('news.example', pub, { strict: fetchPolicy, port: 443 })).address, '93.184.216.34');

  // The strict proxy built for web-fetch refuses a loopback origin.
  const origin = http.createServer((request, response) => response.end('inside'));
  await new Promise(resolve => origin.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const proxy = createPinningProxy({ strict: fetchPolicy });
  try {
    const proxyUrl = new URL(await proxy.listen());
    const status = await bounded(new Promise((resolve, reject) => {
      http.get({ hostname: proxyUrl.hostname, port: proxyUrl.port, path: `http://127.0.0.1:${origin.address().port}/`, agent: false },
        response => { response.resume(); resolve(response.statusCode); }).once('error', reject);
    }), 3000, 'proxy request timed out');
    assert.equal(status, 403);
  } finally {
    await proxy.close();
    origin.close();
  }

  // Context creation: a web-fetch context gets its own strict proxy and a route guard that aborts private targets.
  const created = [];
  const routes = [];
  const browser = {
    contexts: () => [],
    async newContext(options) {
      created.push(options);
      return { route: async (pattern, handler) => routes.push(handler), close: async () => {} };
    },
  };
  strictPreload.patchBrowser(browser, { upstreamProxy: false, source: 'test' });
  await browser.newContext({}, { agentPlatformUserId: 'private:1' });
  await browser.newContext({}, { agentPlatformUserId: 'artifact-render:abc' });
  await browser.newContext({}, { agentPlatformUserId: 'web-fetch:abc' });
  await browser.newContext({}, { agentPlatformUserId: 'web-fetch:def' });
  assert.equal(new Set(created.slice(0, 3).map(options => options.proxy.server)).size, 3);
  assert.equal(created[2].proxy.server, created[3].proxy.server);
  assert.equal(created[2].serviceWorkers, 'block');
  const decide = async (handler, url) => {
    let outcome = 'continue';
    await handler({ request: () => ({ url: () => url }), abort: async () => { outcome = 'abort'; }, continue: async () => { outcome = 'continue'; } });
    return outcome;
  };
  assert.equal(await decide(routes[2], 'http://10.0.0.5/'), 'abort');
  assert.equal(await decide(routes[2], 'http://localhost:8765/'), 'abort');
  assert.equal(await decide(routes[2], 'http://8.8.8.8/'), 'continue');
  assert.equal(await decide(routes[1], 'http://localhost:8765/'), 'continue');
});

test('only artifact-render identities get the strict proxy and route guard', async () => {
  assert.equal(strictPreload.isRenderIdentity('artifact-render:1234'), true);
  for (const id of ['private:1', 'artifact-render', 'x-artifact-render:1', '', undefined]) assert.equal(strictPreload.isRenderIdentity(id), false, String(id));
  const created = [];
  const routes = [];
  const browser = {
    contexts: () => [],
    async newContext(options) {
      created.push(options);
      return { route: async (pattern, handler) => routes.push(handler), close: async () => {} };
    },
  };
  strictPreload.patchBrowser(browser, { upstreamProxy: false, source: 'test' });
  try {
    await browser.newContext({}, { agentPlatformUserId: 'private:1' });
    await browser.newContext({}, { agentPlatformUserId: 'artifact-render:abc' });
    await browser.newContext({});
    assert.equal(created.length, 3);
    assert.notEqual(created[0].proxy.server, created[1].proxy.server);
    assert.equal(created[0].proxy.server, created[2].proxy.server);
    assert.equal(created[0].serviceWorkers, 'block');
    assert.equal(created[1].serviceWorkers, 'block');
    // The renderer's route guard aborts private literals; the ordinary one lets them pass.
    const decide = async (handler, url) => {
      let outcome = 'continue';
      await handler({ request: () => ({ url: () => url }), abort: async () => { outcome = 'abort'; }, continue: async () => { outcome = 'continue'; } });
      return outcome;
    };
    assert.equal(await decide(routes[0], 'http://10.0.0.5/'), 'continue');
    assert.equal(await decide(routes[1], 'http://10.0.0.5/'), 'abort');
    assert.equal(await decide(routes[1], 'http://169.254.169.254/'), 'abort');
    assert.equal(await decide(routes[1], 'http://8.8.8.8/'), 'continue');
  } finally {
    process.emit('SIGTERM');
  }
});

test('the browser launch disables WebRTC, keeping the caller\'s other preferences', async () => {
  const merged = strictPreload.withoutWebRtc({ headless: true, firefoxUserPrefs: { 'gfx.bundled-fonts.activate': 0 } });
  assert.deepEqual(merged, { headless: true, firefoxUserPrefs: { 'gfx.bundled-fonts.activate': 0, 'media.peerconnection.enabled': false } });
  assert.equal(strictPreload.withoutWebRtc(undefined).firefoxUserPrefs['media.peerconnection.enabled'], false);
  // A page cannot turn it back on through the caller either: the platform value wins over a caller's true.
  assert.equal(strictPreload.withoutWebRtc({ firefoxUserPrefs: { 'media.peerconnection.enabled': true } }).firefoxUserPrefs['media.peerconnection.enabled'], false);
});

test('behind an upstream proxy web-fetch contexts are refused, other identities keep the operator proxy', async () => {
  const proxied = { upstreamProxy: true, source: 'test' };
  await assert.rejects(strictPreload.managedContextOptions({}, proxied, strictPreload.strictPolicyFor('web-fetch:1')), /upstream proxy/);
  await assert.rejects(strictPreload.managedContextOptions({ proxy: { server: 'http://corp:3128' } }, { upstreamProxy: false }, strictPreload.strictPolicyFor('web-fetch:1')), /upstream proxy/);
  assert.deepEqual(await strictPreload.managedContextOptions({}, proxied, null), { serviceWorkers: 'block' });
  assert.deepEqual(await strictPreload.managedContextOptions({}, proxied, strictPreload.strictPolicyFor('artifact-render:1')), { serviceWorkers: 'block' });
});
