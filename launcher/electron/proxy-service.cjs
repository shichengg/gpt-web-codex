'use strict';

const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { execFile } = require('node:child_process');

const COMMON_LOCAL_PORTS = Object.freeze([10808, 10809, 7890, 7897, 8080]);
const CACHE_TTL_MS = 60_000;
let cache;

function normalizeProxyValue(value) {
  let text = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!text || /direct access|直接访问|无代理/i.test(text)) return '';
  if (text.includes(';')) {
    const entries = Object.fromEntries(text.split(';').map((part) => part.split('=', 2)).filter((part) => part.length === 2));
    text = entries.https ?? entries.http ?? '';
  }
  text = text.replace(/^https?=/i, '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return '';
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return '';
    if (!url.port) url.port = url.protocol === 'https:' ? '443' : '80';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function environmentProxyCandidates(environment = process.env) {
  return unique([environment.HTTPS_PROXY, environment.https_proxy, environment.HTTP_PROXY, environment.http_proxy].map(normalizeProxyValue));
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 1500 }, (error, stdout = '') => resolve({ code: error ? 1 : 0, stdout: String(stdout) }));
  });
}

async function systemProxyCandidates(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const run = options.run ?? runCommand;
  const values = [...environmentProxyCandidates(environment)];
  if (platform !== 'win32') return unique(values);
  const [registry, winHttp] = await Promise.all([
    run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']),
    run('netsh.exe', ['winhttp', 'show', 'proxy']),
  ]);
  if (registry.code === 0 && /ProxyEnable\s+REG_DWORD\s+0x1/i.test(registry.stdout)) {
    const match = registry.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (match) values.push(normalizeProxyValue(match[1]));
  }
  if (winHttp.code === 0) {
    const match = winHttp.stdout.split(/\r?\n/).map((line) => line.match(/(?:Proxy Server\(s\)|代理服务器)\s*:\s*(.+)/i)?.[1]).find(Boolean);
    if (match) values.push(normalizeProxyValue(match));
  }
  return unique(values);
}

async function commonLocalCandidates(options = {}) {
  const canConnect = options.canConnect ?? ((port) => new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(250, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  }));
  const results = await Promise.all(COMMON_LOCAL_PORTS.map(async (port) => (await canConnect(port) ? `http://127.0.0.1:${port}` : '')));
  return results.filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function probeDirect(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = https.request({ hostname: 'api.openai.com', port: 443, path: '/', method: 'HEAD', timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
    request.end();
  });
}

function probeHttpProxy(proxyUrl, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(proxyUrl); } catch { resolve(false); return; }
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    const socket = parsed.protocol === 'https:'
      ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname })
      : net.connect({ host: parsed.hostname, port });
    let response = '';
    let complete = false;
    const done = (value) => {
      if (complete) return;
      complete = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once(parsed.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      socket.write('CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\nConnection: close\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (response.includes('\r\n')) done(/^HTTP\/1\.[01] 2\d\d/i.test(response));
    });
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.once('end', () => done(/^HTTP\/1\.[01] 2\d\d/i.test(response)));
  });
}

async function resolveProxy(settings = {}, options = {}) {
  const mode = ['auto', 'system', 'manual', 'direct'].includes(settings.proxyMode) ? settings.proxyMode : 'auto';
  const key = JSON.stringify({ mode, proxyUrl: settings.proxyUrl ?? '' });
  if (!options.force && cache?.key === key && Date.now() - cache.time < CACHE_TTL_MS) return cache.value;
  const direct = options.probeDirect ?? probeDirect;
  const proxy = options.probeProxy ?? probeHttpProxy;
  const systemCandidates = options.systemCandidates ?? await systemProxyCandidates(options);
  const localCandidates = options.localCandidates ?? await commonLocalCandidates(options);
  let value;
  if (mode === 'direct') value = { mode, source: 'direct', reachable: await direct(), configured: false };
  else if (mode === 'manual') {
    const proxyUrl = normalizeProxyValue(settings.proxyUrl);
    value = proxyUrl && await proxy(proxyUrl)
      ? { mode, source: 'manual', reachable: true, configured: true, proxyUrl }
      : { mode, source: 'manual', reachable: false, configured: false };
  } else {
    const candidates = mode === 'system' ? systemCandidates : [...systemCandidates, ...localCandidates];
    if (mode === 'auto' && await direct()) value = { mode, source: 'auto-direct', reachable: true, configured: false };
    else {
      let proxyUrl = '';
      for (const candidate of unique(candidates.map(normalizeProxyValue))) {
        if (await proxy(candidate)) { proxyUrl = candidate; break; }
      }
      value = proxyUrl
        ? { mode, source: systemCandidates.map(normalizeProxyValue).includes(proxyUrl) ? (mode === 'system' ? 'system' : 'auto-system') : 'auto-local', reachable: true, configured: true, proxyUrl }
        : { mode, source: mode === 'system' ? 'system-direct' : 'auto-unavailable', reachable: mode === 'system' ? await direct() : false, configured: false };
    }
  }
  cache = { key, time: Date.now(), value: Object.freeze(value) };
  return cache.value;
}

function clearProxyCache() { cache = undefined; }

module.exports = { COMMON_LOCAL_PORTS, normalizeProxyValue, environmentProxyCandidates, systemProxyCandidates, commonLocalCandidates, probeDirect, probeHttpProxy, resolveProxy, clearProxyCache };
