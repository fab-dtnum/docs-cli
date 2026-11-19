// Contenu des exports : nettoyage du HTML de Docs, images intégrées, décalage des titres, mise en page.
import { config } from './config.ts';

/** Caractère de remplacement d'objet (U+FFFC) : Docs l'émet dans chaque paragraphe vide. */
const OBJECT_REPLACEMENT = '￼';

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Le HTML de `formatted-content` est un fragment : les paragraphes vides sont `<p>￼</p>` (marqués
 * `blank` pour la mise en page, ils gardent l'espacement de l'éditeur), le reste du caractère est retiré.
 */
export function cleanHtml(html: string): string {
  return html
    .replace(new RegExp(`<p([^>]*)>\\s*${OBJECT_REPLACEMENT}\\s*</p>`, 'g'), '<p class="blank"$1></p>')
    .replaceAll(OBJECT_REPLACEMENT, '');
}

/** Titres `<h1>`…`<h6>` décalés de `shift` niveaux (plafonnés à 6). */
export function shiftHeadings(html: string, shift: number): string {
  if (!shift) return html;
  return html.replace(
    /<(\/?)h([1-6])\b([^>]*)>/g,
    (_m, slash: string, n: string, rest: string) => `<${slash}h${Math.min(6, Number(n) + shift)}${rest}>`,
  );
}

/** Titres Markdown (`#`…) décalés de `shift` niveaux, hors blocs de code. */
export function shiftMarkdownHeadings(markdown: string, shift: number): string {
  if (!shift) return markdown;
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (f) {
        if (!fence) fence = f[0];
        else if (f[0] === fence) fence = undefined;
        return line;
      }
      if (fence) return line;
      const m = /^(#{1,6})(\s.*)$/.exec(line);
      return m ? `${'#'.repeat(Math.min(6, m[1].length + shift))}${m[2]}` : line;
    })
    .join('\n');
}

/** Ancre d'un document dans un fichier fusionné. */
export const docAnchor = (id: string) => `doc-${id}`;

const DOC_PATH = /^\/docs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** Id du document visé par un lien (`data-doc-id` d'un lien interne, sinon URL `…/docs/<id>/` de l'instance). */
function linkedDocId(tag: string, known: ReadonlySet<string>): string | undefined {
  const byAttr = attr(tag, 'data-doc-id');
  if (byAttr && known.has(byAttr)) return byAttr;
  const href = attr(tag, 'href');
  if (!href) return undefined;
  try {
    const url = new URL(href, config.baseUrl);
    const id = url.origin === config.baseUrl ? DOC_PATH.exec(url.pathname)?.[1]?.toLowerCase() : undefined;
    return id && known.has(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Liens vers un autre document de l'export → lien dans le fichier (`#doc-<id>`), au lieu de Docs. Les liens vers
 * un document absent de l'export, ou vers un autre site, ne changent pas. `known` : ids des documents exportés.
 */
export function relinkDocs(html: string, known: ReadonlySet<string>): { html: string; relinked: number } {
  let relinked = 0;
  const out = html.replace(/<a\b[^>]*>/gi, (tag) => {
    const id = linkedDocId(tag, known);
    if (!id) return tag;
    relinked++;
    return tag.replace(/\shref="[^"]*"/i, ` href="#${docAnchor(id)}"`);
  });
  return { html: out, relinked };
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

export const mimeOf = (path: string): string | undefined =>
  MIME[/\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(path)?.[1]?.toLowerCase() ?? ''];

/** Chemin `/media/…` d'une URL hébergée par Docs ; `undefined` pour toute autre origine. */
export function docsMediaPath(src: string): string | undefined {
  try {
    const url = new URL(src, config.baseUrl);
    return url.origin === config.baseUrl && url.pathname.startsWith('/media/') ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

export interface ImageIssue {
  /** Titre du document qui contient l'image (renseigné par l'appelant). */
  doc?: string;
  /** Description de l'image (nom, ou alt, ou URL). */
  image: string;
  reason: string;
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1]?.replaceAll('&amp;', '&');

const missing = (label: string, reason: string) =>
  `<span class="export-missing">[Image non exportée${label ? ` : ${escapeHtml(label)}` : ''} (${escapeHtml(reason)})]</span>`;

/**
 * Images du HTML : celles de Docs (`/media/…`, qui demandent la session) sont téléchargées et intégrées
 * en `data:` ; une image sans fichier est retirée ; toute autre image est remplacée par une mention, car
 * l'export ne charge jamais rien depuis un autre site.
 */
export async function inlineImages(
  html: string,
  fetchMedia: (mediaPath: string) => Promise<Buffer>,
  issues: ImageIssue[],
): Promise<string> {
  const tags = [...new Set(html.match(/<img\b[^>]*>/gi) ?? [])];
  const replacements = new Map<string, string>();
  for (const tag of tags) {
    const src = attr(tag, 'src');
    const label = attr(tag, 'data-name') || attr(tag, 'alt') || src || '';
    if (!src) {
      replacements.set(tag, '');
      continue;
    }
    const media = docsMediaPath(src);
    if (!media) {
      issues.push({ image: label, reason: 'hébergée hors de Docs' });
      replacements.set(tag, missing(label, 'hébergée hors de Docs'));
      continue;
    }
    const mime = mimeOf(media);
    if (!mime) {
      issues.push({ image: label, reason: 'format non pris en charge' });
      replacements.set(tag, missing(label, 'format non pris en charge'));
      continue;
    }
    try {
      const data = await fetchMedia(media);
      const uri = `data:${mime};base64,${data.toString('base64')}`;
      replacements.set(tag, tag.replace(/\ssrc="[^"]*"/i, ` src="${uri}"`).replace(/\sdata-url="[^"]*"/i, ''));
    } catch (e) {
      const reason = (e as Error).message.split('\n')[0];
      issues.push({ image: label, reason });
      replacements.set(tag, missing(label, 'téléchargement impossible'));
    }
  }
  return html.replace(/<img\b[^>]*>/gi, (tag) => replacements.get(tag) ?? tag);
}

/**
 * Contenu écrit par n'importe quel utilisateur de Docs : la page interdit tout script et tout chargement
 * réseau (`default-src 'none'`), seules les images `data:` et la feuille de style intégrée passent.
 */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const CALLOUT_COLORS: Record<string, string> = {
  gray: '#eeeeee',
  brown: '#efe3dc',
  red: '#fbe4e4',
  orange: '#fbecdd',
  yellow: '#fbf3db',
  green: '#ddedea',
  blue: '#ddebf1',
  purple: '#eae4f2',
  pink: '#f4dfeb',
};

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font: 11pt/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #1b1b1b; margin: 0; }
@media screen { body { max-width: 52em; margin: 2em auto; padding: 0 1.5em; } }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 .4em; break-after: avoid; }
h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4 { font-size: 1.1em; } h5, h6 { font-size: 1em; }
p { margin: .35em 0; }
p.blank { margin: 0; height: .7em; }
ul, ol { margin: .3em 0; padding-left: 1.6em; }
li > p { margin: .15em 0; }
details > summary { list-style: none; font-weight: 600; }
details > summary::-webkit-details-marker { display: none; }
details > :not(summary) { margin-left: 1.2em; }
a { color: #3a3a8c; }
img { max-width: 100%; height: auto; break-inside: avoid; }
blockquote { margin: .6em 0; padding: .1em 1em; border-left: 3px solid #bbb; color: #444; }
pre { background: #f4f4f4; border-radius: 4px; padding: .6em .8em; white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
:not(pre) > code { background: #f1f1f1; border-radius: 3px; padding: 0 .25em; }
table { border-collapse: collapse; margin: .6em 0; max-width: 100%; }
th, td { border: 1px solid #c8c8c8; padding: .3em .6em; vertical-align: top; }
th { background: #f4f4f4; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.2em 0; }
aside[role="note"] { background: #f3f3f3; border-radius: 4px; padding: .5em .8em; margin: .6em 0; break-inside: avoid; }
aside[role="note"] > p { margin: 0; }
${Object.entries(CALLOUT_COLORS)
  .map(([name, color]) => `aside[data-background-color="${name}"] { background: ${color}; }`)
  .join('\n')}
.export-missing { color: #8a1f11; font-style: italic; }
.export-error { color: #8a1f11; border: 1px solid #e0b4ae; padding: .4em .8em; border-radius: 4px; }
section.doc + section.doc { break-before: page; }
`;

export interface Section {
  title: string;
  /** Niveau dans l'arbre exporté (0 = racine). */
  depth: number;
  /** HTML du contenu, déjà nettoyé et images intégrées. */
  html: string;
  /** Id du document : ancre de sa section, cible des liens internes (mode fusionné). */
  id?: string;
}

/**
 * Page HTML autonome. Avec `headings`, chaque document est précédé de son titre (niveau selon la profondeur) et
 * ses propres titres sont décalés d'autant : les documents réunis se lisent comme un seul plan.
 */
export function renderPage(title: string, sections: Section[], { headings }: { headings: boolean }): string {
  const body = sections
    .map((s) => {
      const shift = headings ? s.depth + 1 : 0;
      const heading = headings
        ? `<h${Math.min(6, s.depth + 1)} class="doc-title">${escapeHtml(s.title)}</h${Math.min(6, s.depth + 1)}>\n`
        : '';
      const anchor = headings && s.id ? ` id="${docAnchor(s.id)}"` : '';
      return `<section class="doc"${anchor}>\n${heading}${shiftHeadings(s.html, shift)}\n</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}
