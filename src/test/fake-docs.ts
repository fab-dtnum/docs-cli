// Fausse API Docs pour les tests : arbre en mémoire (chemins matérialisés comme
// django-treebeard), contenu Markdown, pagination des enfants, cookie de session exigé,
// contrôle CSRF sur les écritures (cookie csrftoken = en-tête X-CSRFToken, Referer du site).
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const SESSION = 'goodsession123';
export const CSRF = 'c'.repeat(32);

export interface FakeDoc {
  id: string;
  title: string;
  parent: string | null;
  path: string;
  markdown: string;
  updated_at: string;
  children: string[];
  /** Suppression douce : toujours lisible par GET, absent des listes d'enfants. */
  deleted_at?: string;
}

export interface Seed {
  title: string;
  markdown?: string;
  children?: Seed[];
}

export interface FakeServer {
  url: string;
  docs: Map<string, FakeDoc>;
  /** `MÉTHODE /chemin?requête` de chaque requête reçue. */
  requests: string[];
  /** Requêtes d'écriture uniquement. */
  writes(): string[];
  /** Enfants renvoyés par page. */
  pageSize: number;
  /** Lien `next` de pagination vers un autre domaine. */
  nextOrigin?: string;
  /** Comme une instance sans le correctif upstream : le fichier joint à …/children/ est ignoré. */
  childFileIgnored?: boolean;
  /** Nombre de réponses 429 à renvoyer avant de répondre normalement (`Infinity` : toujours). */
  throttle?: number;
  add(parent: string | null, title: string, markdown?: string): string;
  seed(tree: Seed, parent?: string | null): string;
  childrenOf(id: string): FakeDoc[];
  /** Document actif (ni supprimé, ni dans un sous-arbre supprimé). */
  alive(id: string): boolean;
  findChild(parent: string, title: string): FakeDoc | undefined;
  close(): Promise<void>;
}

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

export async function startFakeDocs(): Promise<FakeServer> {
  const docs = new Map<string, FakeDoc>();
  const roots: string[] = [];
  const stamp = () => new Date(Date.now() + counter).toISOString();

  const step = (n: number) => String(n).padStart(4, '0');
  // Rang suivant par parent : jamais réutilisé, comme les chemins de treebeard.
  const nextStep = new Map<string | null, number>();
  const takeStep = (parent: string | null) => {
    const n = (nextStep.get(parent) ?? 0) + 1;
    nextStep.set(parent, n);
    return step(n);
  };
  const repath = (id: string, path: string) => {
    const d = docs.get(id)!;
    d.path = path;
    nextStep.set(id, 0);
    for (const c of d.children) repath(c, path + takeStep(id));
  };
  const add = (parent: string | null, title: string, markdown = '') => {
    const id = newId();
    const siblings = parent ? docs.get(parent)!.children : roots;
    const path = (parent ? docs.get(parent)!.path : '') + takeStep(parent);
    docs.set(id, { id, title, parent, path, markdown, updated_at: stamp(), children: [] });
    siblings.push(id);
    return id;
  };
  const meta = (d: FakeDoc) => ({
    id: d.id,
    title: d.title,
    updated_at: d.updated_at,
    numchild: d.children.length,
    depth: d.path.length / 4,
    path: d.path,
    deleted_at: d.deleted_at ?? null,
  });

  const state: FakeServer = {
    url: '',
    docs,
    requests: [],
    writes: () => state.requests.filter((r) => !r.startsWith('GET ')),
    pageSize: 2,
    add,
    seed(tree, parent = null) {
      const id = add(parent, tree.title, tree.markdown ?? '');
      for (const c of tree.children ?? []) state.seed(c, id);
      return id;
    },
    childrenOf: (id) => docs.get(id)!.children.map((c) => docs.get(c)!),
    alive: (id) => {
      const d = docs.get(id);
      return !!d && !d.deleted_at && (d.parent === null || state.alive(d.parent));
    },
    findChild: (parent, title) => state.childrenOf(parent).find((d) => d.title === title),
    close: async () => {},
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  /** Corps JSON ou multipart (champ `file`, comme l'import de Docs). */
  async function parseBody(
    req: http.IncomingMessage,
  ): Promise<{ json?: Record<string, unknown>; file?: { name: string; text: string } }> {
    const raw = await readBody(req);
    const type = req.headers['content-type'] ?? '';
    if (type.startsWith('multipart/form-data')) {
      const form = await new Response(new Uint8Array(raw), { headers: { 'content-type': type } }).formData();
      const f = form.get('file');
      if (f && typeof f !== 'string') return { file: { name: f.name, text: await f.text() } };
      return { json: Object.fromEntries(form) };
    }
    return { json: raw.length ? JSON.parse(raw.toString('utf8')) : {} };
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    state.requests.push(`${method} ${req.url}`);
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const cookies = Object.fromEntries(
      (req.headers.cookie ?? '')
        .split(/;\s*/)
        .filter(Boolean)
        .map((c) => c.split('=') as [string, string]),
    );
    if (cookies.docs_sessionid !== SESSION)
      return send(401, { detail: 'Authentication credentials were not provided.' });
    if (method !== 'GET') {
      const okCsrf = cookies.csrftoken === CSRF && req.headers['x-csrftoken'] === CSRF;
      const okReferer = typeof req.headers.referer === 'string' && req.headers.referer.startsWith(`${state.url}/`);
      if (!okCsrf) return send(403, { detail: 'CSRF Failed: CSRF token missing.' });
      if (!okReferer) return send(403, { detail: 'CSRF Failed: Referer checking failed - no Referer.' });
    }
    if (state.throttle) {
      state.throttle--;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end(JSON.stringify({ detail: 'Request was throttled.' }));
    }
    const u = new URL(req.url ?? '/', state.url);
    const p = u.pathname;
    if (method === 'GET' && p === '/api/v1.0/users/me/')
      return send(200, { id: 'u1', email: 'test@example.org', full_name: 'Camille Test' });
    if (method === 'GET' && p === '/api/v1.0/config/')
      return send(200, { ENVIRONMENT: 'test', CONVERSION_UPLOAD_ENABLED: true });

    let m: RegExpMatchArray | null;
    if ((m = p.match(/^\/api\/v1.0\/documents\/([^/]+)\/children\/$/))) {
      const parent = docs.get(m[1]);
      if (!parent) return send(404, { detail: 'Not found.' });
      if (method === 'GET') {
        const page = Number(u.searchParams.get('page') ?? 1);
        const all = state.childrenOf(parent.id);
        const size = state.pageSize;
        const origin = state.nextOrigin ?? state.url;
        return send(200, {
          count: all.length,
          next:
            page * size < all.length ? `${origin}/api/v1.0/documents/${parent.id}/children/?page=${page + 1}` : null,
          results: all.slice((page - 1) * size, page * size).map(meta),
        });
      }
      if (method === 'POST') {
        const { json, file } = await parseBody(req);
        const title = file ? file.name : typeof json?.title === 'string' ? json.title : '';
        const id = add(parent.id, title, file && !state.childFileIgnored ? file.text : '');
        return send(201, meta(docs.get(id)!));
      }
    }
    if (method === 'POST' && p === '/api/v1.0/documents/') {
      const { json, file } = await parseBody(req);
      const id = add(null, file ? file.name : typeof json?.title === 'string' ? json.title : '', file?.text ?? '');
      return send(201, meta(docs.get(id)!));
    }
    if ((m = p.match(/^\/api\/v1.0\/documents\/([^/]+)\/move\/$/)) && method === 'POST') {
      const d = docs.get(m[1]);
      const { json } = await parseBody(req);
      const target = docs.get(String(json?.target_document_id));
      if (!d || !target) return send(400, { target_document_id: 'Target parent document does not exist.' });
      const from = d.parent ? docs.get(d.parent)!.children : roots;
      from.splice(from.indexOf(d.id), 1);
      target.children.push(d.id);
      d.parent = target.id;
      repath(target.id, target.path);
      return send(200, { message: 'Document moved successfully.' });
    }
    if ((m = p.match(/^\/api\/v1.0\/documents\/([^/]+)\/formatted-content\/$/)) && method === 'GET') {
      const d = docs.get(m[1]);
      if (!d) return send(404, { detail: 'Not found.' });
      return send(200, { id: d.id, title: d.title, content: d.markdown || null });
    }
    if ((m = p.match(/^\/api\/v1.0\/documents\/([^/]+)\/$/))) {
      const d = docs.get(m[1]);
      if (!d) return send(404, { detail: 'Not found.' });
      if (method === 'GET') return send(200, meta(d));
      if (method === 'PATCH') {
        const { json } = await parseBody(req);
        if (typeof json?.title === 'string') d.title = json.title;
        d.updated_at = stamp();
        return send(200, meta(d));
      }
      if (method === 'DELETE') {
        // Comme Docs : corbeille, le document reste lisible par son propriétaire.
        const from = d.parent ? docs.get(d.parent)!.children : roots;
        from.splice(from.indexOf(d.id), 1);
        d.deleted_at = stamp();
        return send(204);
      }
    }
    send(404, { detail: 'Not found.' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}

/** Environnement commun aux tests (à poser avant d'importer config.ts). */
export function testEnv(url: string, dirs: { home: string; data: string }) {
  Object.assign(process.env, {
    DOCS_BASE_URL: url,
    DOCS_SESSIONID: SESSION,
    DOCS_CSRFTOKEN: CSRF,
    DOCS_RATE_PER_MINUTE: '100000',
    DOCS_HOME: dirs.home,
    DOCS_DATA_DIR: dirs.data,
  });
}
