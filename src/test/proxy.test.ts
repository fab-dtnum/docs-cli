import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vite-plus/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playwrightLaunchProxy, playwrightProxy } from '../proxy.ts';

const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'DOCS_PROXY_PAC'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const setEnv = (vars: Record<string, string>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
};

test('sans variable de proxy : aucun proxy pour Chromium', () => {
  setEnv({});
  assert.equal(playwrightProxy(), undefined);
});

test('HTTPS_PROXY avec identifiants et NO_PROXY : transmis à Chromium', () => {
  setEnv({ https_proxy: 'http://p%40ole:s%3Acret@proxy.interne:3128', NO_PROXY: 'localhost,.interne' });
  assert.deepEqual(playwrightProxy(), {
    server: 'http://proxy.interne:3128',
    bypass: 'localhost,.interne',
    username: 'p@ole',
    password: 's:cret',
  });
});

test('HTTPS_PROXY prioritaire sur HTTP_PROXY ; valeur invalide ignorée', () => {
  setEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' });
  assert.equal(playwrightProxy()?.server, 'http://a:1');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setEnv({ HTTPS_PROXY: 'pas une url' });
  assert.equal(playwrightProxy(), undefined);
});

test('DOCS_PROXY_PAC : passé à Firefox par ses préférences, prioritaire sur HTTPS_PROXY', () => {
  setEnv({ HTTPS_PROXY: 'http://a:1', DOCS_PROXY_PAC: 'http://wpad.interne/proxy.pac' });
  assert.deepEqual(playwrightLaunchProxy('firefox'), {
    firefoxUserPrefs: { 'network.proxy.type': 2, 'network.proxy.autoconfig_url': 'http://wpad.interne/proxy.pac' },
  });
  assert.deepEqual(playwrightLaunchProxy('chromium'), { args: ['--proxy-pac-url=http://wpad.interne/proxy.pac'] });
});

test('DOCS_PROXY_PAC en chemin local : file:// pour Firefox, data: pour Chromium', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pac-'));
  const file = join(dir, 'proxy.pac');
  writeFileSync(file, 'function FindProxyForURL(url, host) { return "DIRECT"; }');
  setEnv({ DOCS_PROXY_PAC: file });
  assert.equal(
    playwrightLaunchProxy('firefox').firefoxUserPrefs?.['network.proxy.autoconfig_url'],
    pathToFileURL(file).href,
  );
  assert.match(
    playwrightLaunchProxy('chromium').args?.[0] ?? '',
    /^--proxy-pac-url=data:application\/x-ns-proxy-autoconfig;base64,/,
  );
  setEnv({ DOCS_PROXY_PAC: join(dir, 'absent.pac') });
  assert.throws(() => playwrightLaunchProxy('firefox'), /Fichier PAC introuvable/);
});

test('sans DOCS_PROXY_PAC : option proxy de Playwright', () => {
  setEnv({ HTTPS_PROXY: 'http://a:1' });
  assert.equal(playwrightLaunchProxy('firefox').proxy?.server, 'http://a:1');
});
