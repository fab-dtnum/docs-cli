import { config, requireCsrfToken, requireSession, UserError } from './config.ts';

export class AuthError extends UserError {
  constructor() {
    super('Session expirée ou invalide. Lancez `docs login` pour vous reconnecter.');
  }
}

export class CsrfError extends UserError {
  constructor() {
    super(
      'Écriture refusée par Docs (contrôle CSRF). Le jeton DOCS_CSRFTOKEN ne correspond plus à la session :\n' +
        'relancez `docs login`.',
    );
  }
}

export class RateLimitError extends UserError {
  constructor(retryAfter: number) {
    super(
      `Docs limite le débit des requêtes (HTTP 429, disponible dans ${retryAfter} s). ` +
        'Opération interrompue pour ne pas insister. ' +
        'Relancez dans une minute, ou baissez DOCS_RATE_PER_MINUTE.',
    );
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, path: string, detail = '') {
    super(`HTTP ${status} sur ${path}${detail ? ` : ${detail}` : ''}`);
    this.status = status;
    this.detail = detail;
  }
}

export interface DocMeta {
  id: string;
  title: string | null;
  updated_at: string;
  numchild: number;
  depth: number;
  /** Chemin matérialisé de l'arbre (django-treebeard) : préfixe commun avec chaque ancêtre. */
  path: string;
  /** Y.js encodé en base64 (absent sur les versions récentes de Docs). */
  content?: string | null;
  /** Renseigné quand le document est dans la corbeille (suppression douce). */
  deleted_at?: string | null;
}

interface Page<T> {
  next: string | null;
  results: T[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = 30_000;
/** Pièces jointes : un PDF volumineux peut être long à télécharger. */
const MEDIA_TIMEOUT_MS = 300_000;
/** Import d'un fichier : conversion Markdown → Y.js côté serveur. */
const WRITE_TIMEOUT_MS = 120_000;
const MAX_RETRY_AFTER_S = 120;
/** Marge ajoutée au `Retry-After` du serveur, pour ne pas revenir pile à la limite. */
const RETRY_MARGIN_S = 5;

/**
 * Espacement des requêtes, partagé par tous les appels en parallèle : au plus
 * `config.ratePerMinute` requêtes par minute. Une réponse 429 repousse le prochain
 * créneau de tous les appels de la durée indiquée par `Retry-After`, plus une marge.
 */
let nextSlot = 0;
/** Après un 429 persistant, plus aucune requête avant la fin du blocage : les appels en attente échouent aussitôt. */
let blockedUntil = 0;
async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 60_000 / config.ratePerMinute;
  if (slot > now) await sleep(slot - now);
}

/** `Retry-After` en secondes ou en date HTTP ; 60 s si absent ou illisible. */
export function retryAfterSeconds(res: Response): number {
  const raw = res.headers.get('retry-after');
  if (raw === null) return 60;
  const s = /^\d+$/.test(raw.trim()) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(s) ? Math.max(1, Math.ceil(s)) : 60;
}

/**
 * URL absolue d'un appel API. Les liens `next` de pagination viennent du serveur :
 * on refuse tout autre domaine, pour ne jamais y envoyer le cookie de session.
 */
export function apiUrl(path: string, baseUrl = config.baseUrl): string {
  const url = new URL(path, `${baseUrl}/api/v1.0/`);
  if (url.origin !== baseUrl || !url.pathname.startsWith('/api/v1.0/')) {
    throw new UserError(`URL hors de l'API Docs refusée : ${url.origin}${url.pathname}`);
  }
  return url.href;
}

export const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/;

/** Code utile d'une erreur de fetch (« fetch failed » seul ne dit rien). */
export function networkErrorCode(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === 'TimeoutError') return 'délai dépassé';
  return err.cause?.code ?? err.cause?.message ?? err.message;
}

export function networkErrorMessage(service: string, url: string, code: string): string {
  const lines = [`${service} injoignable (${url}) : ${code}`];
  if (CERT_ERRORS.test(code)) {
    lines.push(
      'Certificat HTTPS non reconnu : le proxy inspecte probablement le trafic HTTPS.',
      'Node utilise déjà les certificats du système (--use-system-ca) : demandez le certificat racine de',
      'votre organisation et installez-le sur le poste, ou pointez NODE_EXTRA_CA_CERTS vers ce fichier .pem.',
      'Ne désactivez pas la vérification des certificats : vos jetons seraient exposés.',
    );
  } else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/.test(code)) {
    lines.push('Derrière un proxy ? Définissez HTTPS_PROXY (et NO_PROXY), dans le shell ou dans .env.');
  }
  return lines.join('\n');
}

/**
 * URL absolue d'une pièce jointe (image, PDF…) : uniquement sous `/media/` sur le domaine
 * de Docs, pour ne jamais envoyer le cookie de session ailleurs.
 */
export function mediaUrl(path: string, baseUrl = config.baseUrl): string {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl || !url.pathname.startsWith('/media/')) {
    throw new UserError(`URL hors des pièces jointes Docs refusée : ${url.origin}${url.pathname}`);
  }
  return url.href;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface SendOptions {
  method?: Method;
  accept?: string;
  timeoutMs?: number;
  sessionId?: string;
  body?: FormData | object;
}

/** Message d'erreur du serveur (DRF : `{"detail": …}` ou `{"champ": ["…"]}`), tronqué. */
async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Requête authentifiée, avec espacement et gestion du 429.
 * Lectures : nouvelles tentatives sur erreur réseau ou 5xx. Écritures : jamais (une
 * création rejouée créerait un doublon), sauf après un 429, refusé avant tout traitement.
 */
async function send(url: string, path: string, opts: SendOptions = {}): Promise<Response> {
  const method = opts.method ?? 'GET';
  const write = method !== 'GET';
  const sessionId = opts.sessionId ?? requireSession();
  const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json' };
  if (write) {
    // Django (SessionAuthentication) : cookie csrftoken + en-tête X-CSRFToken identiques,
    // et Referer/Origin du même site en HTTPS.
    const csrf = requireCsrfToken();
    headers.Cookie = `docs_sessionid=${sessionId}; csrftoken=${csrf}`;
    headers['X-CSRFToken'] = csrf;
    headers.Referer = `${config.baseUrl}/`;
    headers.Origin = config.baseUrl;
  } else {
    headers.Cookie = `docs_sessionid=${sessionId}`;
  }
  let body: FormData | string | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }

  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    if (Date.now() < blockedUntil) throw new RateLimitError(Math.ceil((blockedUntil - Date.now()) / 1000));
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        // Pas de redirection suivie : le cookie ne doit pas partir ailleurs.
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? (write ? WRITE_TIMEOUT_MS : TIMEOUT_MS)),
      });
    } catch (e) {
      const code = networkErrorCode(e);
      // Une erreur de certificat ne se corrige pas en réessayant.
      if (!write && !CERT_ERRORS.test(code) && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new UserError(networkErrorMessage('Docs', config.baseUrl, code));
    }
    if (res.status === 401) throw new AuthError();
    if (res.status === 403) {
      const detail = await errorDetail(res);
      if (write && /CSRF/i.test(detail)) throw new CsrfError();
      if (!write) throw new AuthError();
      throw new UserError(
        `Docs refuse l'écriture (HTTP 403 sur ${path}) : droits insuffisants sur ce document. ${detail}`,
      );
    }
    if (res.status === 429) {
      const retryAfter = retryAfterSeconds(res);
      const wait = retryAfter + RETRY_MARGIN_S;
      // Une seule nouvelle tentative, après le délai demandé : insister aggraverait le blocage.
      if (attempt > 0 || retryAfter > MAX_RETRY_AFTER_S) {
        blockedUntil = Date.now() + wait * 1000;
        throw new RateLimitError(retryAfter);
      }
      if (process.stderr.isTTY) process.stderr.write(`\nDocs limite le débit : pause de ${wait} s…\n`);
      nextSlot = Math.max(nextSlot, Date.now() + wait * 1000);
      continue;
    }
    if (!write && res.status >= 500 && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, `${method} ${path}`, await errorDetail(res));
    return res;
  }
}

async function request<T>(path: string, sessionId?: string): Promise<T> {
  const res = await send(apiUrl(path), path, { sessionId });
  return (await res.json()) as T;
}

/**
 * Écriture brute. N'appeler que depuis `writer.ts`, qui vérifie la garde d'écriture
 * (plan affiché et confirmé) avant toute requête.
 */
export async function rawWrite<T = unknown>(
  method: Exclude<Method, 'GET'>,
  path: string,
  body?: FormData | object,
): Promise<T | null> {
  const res = await send(apiUrl(path), path, { method, body });
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

/** Réponse qui n'a pas la forme attendue : on s'arrête plutôt que de produire un résultat faux. */
export function expect<T>(ok: boolean, value: T, what: string): T {
  if (!ok) throw new UserError(`Réponse inattendue de l'API Docs (${what}). Vérifiez DOCS_BASE_URL.`);
  return value;
}

export const isDocMeta = (d: DocMeta) =>
  typeof d?.id === 'string' &&
  typeof d.updated_at === 'string' &&
  !Number.isNaN(Date.parse(d.updated_at)) &&
  typeof d.numchild === 'number' &&
  typeof d.path === 'string';

export async function getMe(sessionId?: string) {
  const me = await request<{ id?: string; email: string; full_name?: string; short_name?: string }>(
    'users/me/',
    sessionId,
  );
  return expect(typeof me?.email === 'string', me, 'utilisateur');
}

export async function getDoc(id: string): Promise<DocMeta> {
  const doc = await request<DocMeta>(`documents/${id}/`);
  return expect(isDocMeta(doc), doc, `document ${id}`);
}

export async function* iterChildren(id: string): AsyncGenerator<DocMeta> {
  let next: string | null = `documents/${id}/children/?page_size=200`;
  while (next) {
    const page: Page<DocMeta> = await request<Page<DocMeta>>(next);
    expect(Array.isArray(page?.results) && page.results.every(isDocMeta), page, `enfants de ${id}`);
    yield* page.results;
    next = page.next;
  }
}

export async function listChildren(id: string): Promise<DocMeta[]> {
  const list: DocMeta[] = [];
  for await (const c of iterChildren(id)) list.push(c);
  return list;
}

export async function getFormattedMarkdown(id: string): Promise<string> {
  const r = await request<{ content: string | null }>(`documents/${id}/formatted-content/?content_format=markdown`);
  return r.content ?? '';
}

/** Contenu d'une pièce jointe (`/media/…`). */
export async function getMedia(path: string): Promise<Buffer> {
  const res = await send(mediaUrl(path), path, { accept: '*/*', timeoutMs: MEDIA_TIMEOUT_MS });
  return Buffer.from(await res.arrayBuffer());
}

/** Configuration publique de l'instance (`/api/v1.0/config/`), pour le diagnostic. */
export async function getInstanceConfig(): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('config/');
}

/** `a` est-il `b` ou un descendant de `b` ? (chemin matérialisé de treebeard). */
export const isSameOrDescendant = (a: DocMeta, b: DocMeta) => a.path.startsWith(b.path);
