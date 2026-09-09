'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');
process.env.AGENT_PLATFORM_TECHNICAL_PROFILE = 'agent-platform-v1';
process.env.AGENT_PLATFORM_CAMOFOX_BIND_HOST = '127.0.0.1';
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
