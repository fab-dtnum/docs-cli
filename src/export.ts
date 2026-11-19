// `docs export` : un document (ou son arbre) en pdf, html ou md, à partir du contenu de l'API (lecture seule).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, posix, resolve } from 'node:path';
import {
  AuthError,
  type DocMeta,
  RateLimitError,
  getDoc,
  getFormattedHtml,
  getFormattedMarkdown,
  getMedia,
  listChildren,
} from './api.ts';
import { docLink, UserError } from './config.ts';
import {
  cleanHtml,
  escapeHtml,
  type ImageIssue,
  inlineImages,
  relinkDocs,
  renderPage,
  type Section,
  shiftMarkdownHeadings,
} from './export-content.ts';
import { renderPdfs } from './export-pdf.ts';
import { findAttachments, rewriteAttachmentLinks, sanitize, uniqueName } from './pull.ts';
import { zip, type ZipEntry } from './zip.ts';

export const FORMATS = ['pdf', 'html', 'md'] as const;
export type ExportFormat = (typeof FORMATS)[number];

export interface ExportOptions {
  format: ExportFormat;
  out: string;
  /** Niveaux de sous-documents à inclure (avec `merge` ou `split`) ; sans limite par défaut. */
  depth?: number;
  merge: boolean;
  split: boolean;
  dryRun: boolean;
}

type Mode = 'single' | 'merge' | 'split';

interface TreeNode {
  meta: DocMeta;
  /** 0 pour la racine. */
  depth: number;
  children: TreeNode[];
  /** Chemin dans l'arbre exporté (mode `split`) : `A.pdf`, `A/B.pdf`… */
  file: string;
}

const titleOf = (d: Pick<DocMeta, 'title'>) => d.title?.trim() || 'Sans titre';

export function parseFormat(value = 'pdf'): ExportFormat {
  if (!(FORMATS as readonly string[]).includes(value)) {
    throw new UserError(`Format inconnu : ${value} (attendu : ${FORMATS.join(', ')})`);
  }
  return value as ExportFormat;
}

/** Document racine puis ses descendants, dans l'ordre de l'arbre (parent avant enfants). */
async function collect(root: DocMeta, maxDepth: number): Promise<TreeNode[]> {
  const rootNode: TreeNode = { meta: root, depth: 0, children: [], file: '' };
  const all = [rootNode];
  async function walk(node: TreeNode) {
    if (!node.meta.numchild || node.depth >= maxDepth) return;
    for (const c of await listChildren(node.meta.id)) {
      const child: TreeNode = { meta: c, depth: node.depth + 1, children: [], file: '' };
      node.children.push(child);
      all.push(child);
      await walk(child);
    }
  }
  await walk(rootNode);
  return all;
}

/** Noms de fichiers du mode `split` : comme `pull`, un document avec enfants est un fichier et un dossier. */
function assignFiles(node: TreeNode, dir: string, ext: string, used: Map<string, Set<string>>): void {
  const name = uniqueName(used, dir, sanitize(titleOf(node.meta)));
  const base = posix.join(dir, name);
  node.file = `${base}.${ext}`;
  for (const c of node.children) assignFiles(c, base, ext, used);
}

function printTree(node: TreeNode, prefix: string, last: boolean, isRoot: boolean): void {
  const line = `${titleOf(node.meta)}  ${node.meta.id}`;
  console.log(isRoot ? line : `${prefix}${last ? '└── ' : '├── '}${line}`);
  const next = isRoot ? '' : prefix + (last ? '    ' : '│   ');
  node.children.forEach((c, i) => printTree(c, next, i === node.children.length - 1, false));
}

interface Output {
  name: string;
  data: Buffer;
}

interface Result {
  output: Output;
  issues: ImageIssue[];
  errors: { doc: string; error: string }[];
  /** Liens vers un autre document de l'export, reliés dans le fichier (mode fusionné). */
  relinked?: number;
}

/** Une pièce jointe liée depuis plusieurs documents n'est téléchargée qu'une fois. */
function cachedMedia(): (path: string) => Promise<Buffer> {
  const cache = new Map<string, Promise<Buffer>>();
  return (path) => {
    let p = cache.get(path);
    if (!p) cache.set(path, (p = getMedia(path)));
    return p;
  };
}

/** Nom d'une pièce jointe dans `media/` : celui du serveur (UUID) ; un homonyme venu d'ailleurs reçoit un préfixe. */
function mediaFile(media: string, taken: Map<string, string>): string {
  const base = (posix.basename(media).replace(/[^A-Za-z0-9._-]/g, '_') || 'fichier').slice(-80);
  let name = base;
  if (taken.has(name) && taken.get(name) !== media) {
    name = `${createHash('sha256').update(media).digest('hex').slice(0, 8)}-${base}`;
  }
  taken.set(name, media);
  return `media/${name}`;
}

export async function exportDoc(rootId: string, opts: ExportOptions): Promise<number> {
  if (opts.merge && opts.split) throw new UserError('--merge et --split sont incompatibles : choisissez-en un.');
  const mode: Mode = opts.merge ? 'merge' : opts.split ? 'split' : 'single';
  if (opts.depth !== undefined && mode === 'single') {
    throw new UserError("--depth ne s'applique qu'avec --merge ou --split (sans eux, seul le document est exporté).");
  }

  const root = await getDoc(rootId);
  const nodes =
    mode === 'single'
      ? [{ meta: root, depth: 0, children: [], file: '' } as TreeNode]
      : await collect(root, opts.depth ?? Infinity);
  const rootName = sanitize(titleOf(root));
  const ext = opts.format;

  console.log(
    `Export ${opts.format} de ${docLink(root)} : ` +
      {
        single: 'document seul',
        merge: 'sous-documents fusionnés en un fichier',
        split: 'un fichier par document, en zip',
      }[mode],
  );
  if (opts.dryRun) {
    printTree(nodes[0], '', true, true);
    console.log(`\n${nodes.length} document(s) seraient téléchargés.`);
    if (mode === 'single' && root.numchild) {
      console.log(
        `Ce document a ${root.numchild} sous-document(s), non inclus : --merge (un fichier) ou --split (zip).`,
      );
    }
    console.log('Aucun fichier écrit (--dry-run).');
    return 0;
  }

  if (mode === 'split') assignFiles(nodes[0], '', ext, new Map());

  const result =
    opts.format === 'md'
      ? await buildMarkdown(nodes, mode, rootName)
      : await buildHtmlBased(nodes, mode, rootName, opts.format);

  const dir = resolve(opts.out);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Documents privés : lisibles par l'utilisateur seul. Un fichier existant n'est jamais écrasé :
  // la nouvelle version prend un numéro (`nom(1).pdf`, `nom(2).pdf`…).
  const suffix = extname(result.output.name);
  const stem = result.output.name.slice(0, result.output.name.length - suffix.length);
  let target = join(dir, result.output.name);
  for (let n = 1; ; n++) {
    try {
      writeFileSync(target, result.output.data, { mode: 0o600, flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      target = join(dir, `${stem}(${n})${suffix}`);
    }
  }

  printSummary(nodes, mode, target, result);
  return result.errors.length ? 1 : 0;
}

async function buildHtmlBased(
  nodes: TreeNode[],
  mode: Mode,
  rootName: string,
  format: 'pdf' | 'html',
): Promise<Result> {
  const issues: ImageIssue[] = [];
  const errors: Result['errors'] = [];
  const fetchMedia = cachedMedia();

  const sections: Section[] = [];
  for (const node of nodes) {
    const title = titleOf(node.meta);
    let html: string;
    try {
      const before = issues.length;
      html = await inlineImages(cleanHtml(await getFormattedHtml(node.meta.id)), fetchMedia, issues);
      for (const issue of issues.slice(before)) issue.doc = title;
    } catch (e) {
      if (e instanceof AuthError || e instanceof RateLimitError) throw e;
      const error = (e as Error).message.split('\n')[0];
      errors.push({ doc: title, error });
      html = `<p class="export-error">Contenu indisponible : ${escapeHtml(error)}</p>`;
    }
    sections.push({ title, depth: node.depth, html, id: node.meta.id });
  }

  // Fusionné : un lien vers un document exporté mène à sa section du fichier, pas à Docs.
  let relinked = 0;
  if (mode === 'merge') {
    const known = new Set(nodes.map((n) => n.meta.id));
    for (const section of sections) {
      const r = relinkDocs(section.html, known);
      section.html = r.html;
      relinked += r.relinked;
    }
  }

  const rootTitle = sections[0].title;
  const toFile = (pages: string[]) =>
    format === 'pdf' ? renderPdfs(pages) : Promise.resolve(pages.map((p) => Buffer.from(p, 'utf8')));

  if (mode === 'split') {
    const pages = nodes.map((_n, i) =>
      renderPage(sections[i].title, [{ ...sections[i], depth: 0 }], { headings: false }),
    );
    const files = await toFile(pages);
    const entries: ZipEntry[] = nodes.map((n, i) => ({ name: n.file, data: files[i] }));
    return { output: { name: `${rootName}.zip`, data: zip(entries) }, issues, errors };
  }
  const page = renderPage(rootTitle, sections, { headings: mode === 'merge' });
  const [file] = await toFile([page]);
  return { output: { name: `${rootName}.${format}`, data: file }, issues, errors, relinked };
}

async function buildMarkdown(nodes: TreeNode[], mode: Mode, rootName: string): Promise<Result> {
  const issues: ImageIssue[] = [];
  const errors: Result['errors'] = [];
  const fetchMedia = cachedMedia();
  const taken = new Map<string, string>();
  const fileByMedia = new Map<string, string>();
  const media: ZipEntry[] = [];

  const bodies: { node: TreeNode; text: string }[] = [];
  for (const node of nodes) {
    const title = titleOf(node.meta);
    // En mode `split` les liens sont relatifs au fichier du document ; sinon au fichier unique.
    const from = mode === 'split' ? node.file : `${rootName}.md`;
    let text: string;
    try {
      text = await getFormattedMarkdown(node.meta.id);
      for (const path of new Set(findAttachments(text).map((a) => a.media))) {
        if (fileByMedia.has(path)) continue;
        try {
          const data = await fetchMedia(path);
          const file = mediaFile(path, taken);
          fileByMedia.set(path, file);
          media.push({ name: file, data });
        } catch (e) {
          if (e instanceof AuthError || e instanceof RateLimitError) throw e;
          issues.push({ doc: title, image: path, reason: (e as Error).message.split('\n')[0] });
        }
      }
      text = rewriteAttachmentLinks(text, from, fileByMedia);
    } catch (e) {
      if (e instanceof AuthError || e instanceof RateLimitError) throw e;
      const error = (e as Error).message.split('\n')[0];
      errors.push({ doc: title, error });
      text = `> Contenu indisponible : ${error}\n`;
    }
    bodies.push({ node, text });
  }

  if (mode === 'split') {
    const entries: ZipEntry[] = [
      ...bodies.map(({ node, text }) => ({ name: node.file, data: Buffer.from(text, 'utf8') })),
      ...media,
    ];
    return { output: { name: `${rootName}.zip`, data: zip(entries) }, issues, errors };
  }
  const text =
    mode === 'merge'
      ? bodies
          .map(
            ({ node, text: t }) =>
              `${'#'.repeat(Math.min(6, node.depth + 1))} ${titleOf(node.meta)}\n\n${shiftMarkdownHeadings(t, node.depth + 1).trim()}\n`,
          )
          .join('\n')
      : bodies[0].text;
  if (!media.length) return { output: { name: `${rootName}.md`, data: Buffer.from(text, 'utf8') }, issues, errors };
  const entries: ZipEntry[] = [{ name: `${rootName}.md`, data: Buffer.from(text, 'utf8') }, ...media];
  return { output: { name: `${rootName}.zip`, data: zip(entries) }, issues, errors };
}

function printSummary(nodes: TreeNode[], mode: Mode, target: string, { issues, errors, relinked }: Result): void {
  const subs = nodes.length - 1;
  console.log(`\n${nodes.length} document(s) exporté(s)${subs ? ` : 1 document + ${subs} sous-document(s)` : ''}.`);
  if (mode === 'single' && nodes[0].meta.numchild) {
    console.log(`Ce document a ${nodes[0].meta.numchild} sous-document(s), non inclus : --merge ou --split.`);
  }
  if (relinked) console.log(`${relinked} lien(s) vers un autre document de l'export relié(s) dans le fichier.`);
  if (errors.length) {
    console.log(`Export partiel : ${errors.length} document(s) en erreur :`);
    for (const e of errors) console.log(`  - ${e.doc} : ${e.error}`);
  }
  if (issues.length) {
    console.log(`${issues.length} image(s) non exportée(s) :`);
    for (const i of issues) console.log(`  - ${i.doc} : ${i.image} (${i.reason})`);
  }
  console.log(
    "Note : l'API de Docs ne fournit pas les diagrammes Mermaid ni les formules : ils sont absents de l'export.",
  );
  console.log(`Fichier : ${target}`);
}
