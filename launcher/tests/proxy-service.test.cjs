'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { clearProxyCache, normalizeProxyValue, resolveProxy, systemProxyCandidates } = require('../electron/proxy-service.cjs');

test('normalizes proxy addresses but rejects credentials and unsupported schemes', () => {
  assert.equal(normalizeProxyValue('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyValue('https=proxy.example.test:8443'), 'http://proxy.example.test:8443');
  assert.equal(normalizeProxyValue('http://user:secret@proxy.example.test:7890'), '');
  assert.equal(normalizeProxyValue('socks5://127.0.0.1:1080'), '');
});

test('uses a reachable manual proxy and keeps direct mode proxy-free', async () => {
  clearProxyCache();
  const manual = await resolveProxy(
    { proxyMode: 'manual', proxyUrl: '127.0.0.1:7890' },
    { probeProxy: async () => true },
  );
  assert.deepEqual(manual, {
    mode: 'manual', source: 'manual', reachable: true, configured: true, proxyUrl: 'http://127.0.0.1:7890',
  });

  const direct = await resolveProxy(
    { proxyMode: 'direct', proxyUrl: '' },
    { probeDirect: async () => true },
  );
  assert.deepEqual(direct, { mode: 'direct', source: 'direct', reachable: true, configured: false });
});

test('invalid manual proxy reports an unreachable route without retaining its value', async () => {
  clearProxyCache();
  const result = await resolveProxy(
    { proxyMode: 'manual', proxyUrl: 'http://user:secret@127.0.0.1:7890' },
    { probeProxy: async () => true },
  );
  assert.deepEqual(result, { mode: 'manual', source: 'manual', reachable: false, configured: false });
});

test('combines Windows Internet Settings, WinHTTP, environment, and local candidates in auto mode', async () => {
  const commands = [];
  const candidates = await systemProxyCandidates({
    platform: 'win32',
    environment: { HTTPS_PROXY: 'env.proxy.test:8888' },
    run: async (command) => {
      commands.push(command);
      return command === 'reg.exe'
        ? { code: 0, stdout: 'ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    registry.proxy.test:7890' }
        : { code: 0, stdout: 'Proxy Server(s) : winhttp.proxy.test:8080' };
    },
  });
  assert.deepEqual(candidates, [
    'http://env.proxy.test:8888', 'http://registry.proxy.test:7890', 'http://winhttp.proxy.test:8080',
  ]);
  assert.deepEqual(commands, ['reg.exe', 'netsh.exe']);

  clearProxyCache();
  const resolution = await resolveProxy(
    { proxyMode: 'auto', proxyUrl: '' },
    { probeDirect: async () => false, probeProxy: async (url) => url.endsWith(':7890'), systemCandidates: candidates, localCandidates: ['http://127.0.0.1:7897'] },
  );
  assert.equal(resolution.source, 'auto-system');
  assert.equal(resolution.proxyUrl, 'http://registry.proxy.test:7890');
});
