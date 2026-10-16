// `docs new <modèle>` : modèle = enfant du document DOCS_TEMPLATES ; variables `{{nom}}`.
// L'export Markdown de Docs peut échapper `_`, `{` ou `}` (`{{lien\_jalon}}`) : la lecture tolère ces échappements.
import { type DocMeta, getFormattedMarkdown, getMe, listChildren } from './api.ts';
import { config, docUrl, parseDocId, UserError } from './config.ts';
import { confirmPlan, type WriteOptions } from './confirm.ts';
import { parseMarkdown } from './local.ts';
import { label } from './ops.ts';
import { archiveStamp } from './push.ts';
import { cleanTitle, titleKey, Writer } from './writer.ts';

const VAR_RE = /\\?\{\\?\{\s*([A-Za-z0-9_\\.-]+?)\s*\\?\}\\?\}/g;
const clean = (name: string) => name.replace(/\\/g, '');

/** Noms des variables d'un texte, dans l'ordre d'apparition, sans doublon. */
export function variablesOf(...texts: string[]): string[] {
  return [...new Set(texts.flatMap((t) => [...t.matchAll(VAR_RE)].map((m) => clean(m[1]))))];
}

/** Remplace toutes les variables ; erreur listant les variables attendues s'il en manque. */
export function render(texts: string[], vars: Record<string, string>): string[] {
  const expected = variablesOf(...texts);
  const missing = expected.filter((v) => vars[v] === undefined);
  if (missing.length) {
    throw new UserError(
      `Variable(s) manquante(s) : ${missing.join(', ')}\n` +
        `Variables du modèle : ${expected.join(', ')}\n` +
        `Exemple : ${missing.map((v) => `--var ${v}=…`).join(' ')}`,
    );
  }
  return texts.map((t) => t.replace(VAR_RE, (_, name: string) => vars[clean(name)]));
}

/** `--var clé=valeur` (répétable). */
export function parseVars(list: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const i = item.indexOf('=');
    const key = item.slice(0, i).trim();
    if (i <= 0 || !/^[A-Za-z0-9_.-]+$/.test(key)) throw new UserError(`--var attend clé=valeur : ${item}`);
    out[key] = item.slice(i + 1);
  }
  return out;
}

export async function findTemplate(name: string): Promise<DocMeta> {
  if (!config.templatesId) {
    throw new UserError('DOCS_TEMPLATES n’est pas défini : indiquez dans .env l’id du document qui contient les modèles.');
  }
  const templatesId = parseDocId(config.templatesId, 'DOCS_TEMPLATES');
  const children = await listChildren(templatesId);
  const doc = children.find((c) => titleKey(c.title) === titleKey(name));
  if (!doc) {
    throw new UserError(
      `Modèle « ${name} » introuvable sous ${docUrl(templatesId)}.\n` +
        `Modèles présents : ${children.map((c) => c.title).join(', ') || '(aucun)'}`,
    );
  }
  return doc;
}

export interface NewOptions extends WriteOptions {
  title?: string;
  vars?: Record<string, string>;
  now?: Date;
}

export async function newDoc(name: string, parentId: string, opts: NewOptions = {}): Promise<DocMeta | undefined> {
  const body = await getFormattedMarkdown((await findTemplate(name)).id);
  const now = opts.now ?? new Date();
  const stamp = archiveStamp(now);
  const vars: Record<string, string> = { date: stamp.slice(0, 10), heure: stamp.slice(11), ...opts.vars };
  const texts = opts.title === undefined ? [body] : [body, opts.title];
  if (variablesOf(...texts).includes('auteur') && vars.auteur === undefined) {
    const me = await getMe();
    vars.auteur = me.full_name || me.email;
  }
  const [renderedBody, renderedTitle] = render(texts, vars);
  let title: string;
  let markdown = renderedBody;
  if (renderedTitle !== undefined) title = cleanTitle(renderedTitle);
  else {
    try {
      ({ title, markdown } = parseMarkdown(renderedBody, ''));
    } catch {
      throw new UserError(`Le modèle « ${name} » ne commence pas par un titre « # … » : précisez --title.`);
    }
  }

  const duplicate = (await listChildren(parentId)).find((c) => titleKey(c.title) === titleKey(title));
  if (duplicate) throw new UserError(`Refus : « ${title} » existe déjà sous ce parent : ${docUrl(duplicate.id)}`);

  const plan = [`Créer « ${title} » sous ${docUrl(parentId)}`];
  if (opts.dryRun) plan.push('--- Markdown ---', markdown, '--- fin ---');
  if (!(await confirmPlan(plan, opts))) return undefined;
  const doc = await new Writer().create({ parentId, title, markdown });
  console.log(`Créé : ${label(doc)} → ${docUrl(doc.id)}`);
  return doc;
}
