import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UserError } from './config.ts';

/** Proxy défini dans l'environnement (HTTPS_PROXY, puis HTTP_PROXY, en majuscules ou minuscules). */
export function envProxy(): { url: URL; noProxy?: string } | undefined {
  const env = process.env;
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) return undefined;
  try {
    return { url: new URL(raw), noProxy: env.NO_PROXY || env.no_proxy || undefined };
  } catch {
    console.error('Variable de proxy invalide (HTTPS_PROXY / HTTP_PROXY) : ignorée.');
    return undefined;
  }
}

/**
 * Le fetch de Node ignore HTTPS_PROXY par défaut : on l'active si un proxy est défini.
 * http.setGlobalProxyFromEnv existe depuis Node 24.14 / 25.4.
 */
export function applyEnvProxyToFetch(): void {
  if (!envProxy()) return;
  const setGlobal = (http as { setGlobalProxyFromEnv?: () => unknown }).setGlobalProxyFromEnv;
  if (typeof setGlobal === 'function') {
    setGlobal();
  } else if (process.env.NODE_USE_ENV_PROXY !== '1') {
    console.error(
      "Proxy détecté, mais cette version de Node ne sait pas l'appliquer d'elle-même.\n" +
        'Relancez avec NODE_USE_ENV_PROXY=1 (Node ≥ 22.21 ou 24.5), ou passez à Node 24.14+.',
    );
  }
}

/**
 * Fichier PAC du proxy d'entreprise (DOCS_PROXY_PAC) : URL http(s)/file, ou chemin local.
 * Seul le navigateur de `docs login` s'en sert ; le fetch de Node ne lit pas les PAC.
 */
export function envPac(): URL | undefined {
  const raw = process.env.DOCS_PROXY_PAC?.trim();
  if (!raw) return undefined;
  if (/^(https?|file):\/\//i.test(raw)) {
    try {
      return new URL(raw);
    } catch {
      console.error('DOCS_PROXY_PAC invalide : ignorée.');
      return undefined;
    }
  }
  return pathToFileURL(resolve(raw.replace(/^~(?=\/|$)/, homedir())));
}

/**
 * Options de lancement Playwright pour le proxy : le navigateur n'utilise ni HTTPS_PROXY ni le
 * PAC du système. Un PAC (DOCS_PROXY_PAC) prime sur HTTPS_PROXY : l'option `proxy` de
 * Playwright ne sait pas lire un PAC, on le passe donc au navigateur lui-même.
 */
export function playwrightLaunchProxy(browser: 'chromium' | 'firefox') {
  const pac = envPac();
  if (!pac) return { proxy: playwrightProxy() };
  if (pac.protocol === 'file:' && !existsSync(pac)) {
    throw new UserError(`Fichier PAC introuvable (DOCS_PROXY_PAC) : ${fileURLToPath(pac)}`);
  }
  if (browser === 'firefox') {
    // network.proxy.type 2 = « Adresse de configuration automatique du proxy ».
    return { firefoxUserPrefs: { 'network.proxy.type': 2, 'network.proxy.autoconfig_url': pac.href } };
  }
  // Chromium refuse les PAC en file:// : on lui passe le contenu en data:.
  const url =
    pac.protocol === 'file:'
      ? `data:application/x-ns-proxy-autoconfig;base64,${readFileSync(pac).toString('base64')}`
      : pac.href;
  return { args: [`--proxy-pac-url=${url}`] };
}

/** Option `proxy` de Playwright : le navigateur lancé par Playwright n'utilise pas HTTPS_PROXY. */
export function playwrightProxy() {
  const p = envProxy();
  if (!p) return undefined;
  return {
    server: `${p.url.protocol}//${p.url.host}`,
    bypass: p.noProxy,
    // Identifiants éventuels du proxy : transmis au navigateur, jamais affichés.
    username: p.url.username ? decodeURIComponent(p.url.username) : undefined,
    password: p.url.password ? decodeURIComponent(p.url.password) : undefined,
  };
}
