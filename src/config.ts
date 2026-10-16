import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Dossier de l'utilisateur (session, profil du navigateur, état des push) : le binaire est
 * lancé depuis n'importe quel dossier, rien ne dépend du dossier courant.
 */
export const DOCS_HOME = resolve(
  process.env.DOCS_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'docs-cli'),
);
export const ENV_FILE = join(DOCS_HOME, '.env');

// Les variables déjà définies dans le shell priment sur celles du fichier.
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export class UserError extends Error {}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** HTTPS obligatoire (cookie, jetons y transitent), sauf en local pour les tests. */
export function parseBaseUrl(raw: string, name = 'DOCS_BASE_URL'): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`${name} invalide : ${raw}`);
  }
  const local = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new UserError(`${name} doit être en https : ${raw}`);
  }
  return url.origin;
}

function loadBaseUrl(): string {
  try {
    return parseBaseUrl(process.env.DOCS_BASE_URL || 'https://docs.numerique.gouv.fr');
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

export type CreateMode = 'children' | 'move';

export const config = {
  baseUrl: loadBaseUrl(),
  sessionId: process.env.DOCS_SESSIONID ?? '',
  csrfToken: process.env.DOCS_CSRFTOKEN ?? '',
  stateDir: join(DOCS_HOME, 'state'),
  authDir: join(DOCS_HOME, '.auth'),
  /** Dossier des instantanés de `pull` (`--out`). */
  dataDir: resolve(process.env.DOCS_DATA_DIR || 'data'),
  templatesId: process.env.DOCS_TEMPLATES ?? '',
  concurrency: Math.max(1, Number(process.env.DOCS_CONCURRENCY ?? 4) || 4),
  // Docs limite l'API documents à 80 requêtes/minute par utilisateur (API_DOCUMENT_THROTTLE_RATE),
  // budget partagé avec l'interface web ouverte en parallèle : on reste en dessous.
  ratePerMinute: Math.max(1, Number(process.env.DOCS_RATE_PER_MINUTE ?? 60) || 60),
  createMode: (process.env.DOCS_CREATE_MODE === 'move' ? 'move' : 'children') as CreateMode,
};

/** Format d'un identifiant de session Django : empêche toute injection d'en-tête ou de ligne dans .env. */
const SESSION_RE = /^[A-Za-z0-9]{1,256}$/;
export const isValidSessionId = (v: string) => SESSION_RE.test(v);
/** Jeton CSRF Django : 32 (secret) ou 64 (masqué) caractères alphanumériques. */
const CSRF_RE = /^[A-Za-z0-9]{32}([A-Za-z0-9]{32})?$/;
export const isValidCsrfToken = (v: string) => CSRF_RE.test(v);

export function requireSession(): string {
  if (!config.sessionId) {
    throw new UserError(
      `Aucune session : DOCS_SESSIONID est vide (${ENV_FILE}).\nLancez \`docs login\` pour vous connecter via ProConnect.`,
    );
  }
  if (!isValidSessionId(config.sessionId)) {
    throw new UserError('DOCS_SESSIONID a un format inattendu. Relancez `docs login`.');
  }
  return config.sessionId;
}

/** Jeton CSRF exigé par Django pour toute écriture (POST, PATCH, DELETE) en session. */
export function requireCsrfToken(): string {
  if (!config.csrfToken) {
    throw new UserError(
      `Aucun jeton CSRF : DOCS_CSRFTOKEN est vide (${ENV_FILE}), nécessaire pour écrire dans Docs.\n` +
        'Relancez `docs login`, ou recopiez le cookie csrftoken depuis votre navigateur.',
    );
  }
  if (!isValidCsrfToken(config.csrfToken)) {
    throw new UserError('DOCS_CSRFTOKEN a un format inattendu. Relancez `docs login`.');
  }
  return config.csrfToken;
}

/** Crée le dossier de l'utilisateur, lisible par lui seul. */
export function ensureHome(): void {
  mkdirSync(DOCS_HOME, { recursive: true, mode: 0o700 });
  chmodSync(DOCS_HOME, 0o700);
}

/** Écrit (ou remplace) une variable dans .env sans toucher aux autres lignes. */
export function setEnvVar(key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new UserError(`Valeur invalide pour ${key}`);
  ensureHome();
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const line = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
  writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600); // mode ignoré si le fichier existait déjà
  process.env[key] = value;
  if (key === 'DOCS_SESSIONID') config.sessionId = value;
  if (key === 'DOCS_CSRFTOKEN') config.csrfToken = value;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const isUuid = (v: string) => new RegExp(`^${UUID_RE.source}$`, 'i').test(v);

/** Accepte un UUID ou une URL Docs complète. */
export function parseDocId(input: string | undefined, what = 'document'): string {
  const m = input?.match(UUID_RE);
  if (!m) throw new UserError(`Identifiant de ${what} invalide : ${input ?? '(manquant)'}`);
  return m[0].toLowerCase();
}

export const docUrl = (id: string) => `${config.baseUrl}/docs/${id}/`;

/**
 * Liens cliquables dans le terminal (OSC 8, compris par iTerm2, Terminal.app récent, VS Code,
 * GNOME Terminal…) : seulement vers un terminal, jamais dans un fichier ou un tube.
 * `DOCS_HYPERLINKS=0` ou `1` force le choix.
 */
function hyperlinksEnabled(): boolean {
  const forced = process.env.DOCS_HYPERLINKS;
  if (forced === '0' || forced === '1') return forced === '1';
  return Boolean(process.stdout.isTTY && process.stderr.isTTY) && process.env.TERM !== 'dumb';
}

/** `texte` cliquable vers `url` si le terminal le permet, sinon `texte` seul. */
export const hyperlink = (url: string, text: string) =>
  hyperlinksEnabled() ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;

/** Titre et id, l'id cliquable vers le document : `« Titre » (588a1afd-…)`. */
export const docLink = (d: { id: string; title?: string | null }) =>
  `« ${d.title?.trim() || 'Sans titre'} » (${hyperlink(docUrl(d.id), d.id)})`;
