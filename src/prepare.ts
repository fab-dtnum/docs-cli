// Préparation du Markdown avant l'import par Docs, dont le convertisseur (BlockNote) perd
// certaines constructions : listes dans une citation, images locales (SPEC.md §3, push).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';

/** Taille maximale d'une pièce jointe (DOCUMENT_IMAGE_MAX_SIZE de Docs par défaut). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Applique `fn` aux morceaux de Markdown hors blocs de code délimités (``` ou ~~~). */
function outsideFences(markdown: string, fn: (text: string) => string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let chunk: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (chunk.length) out.push(fn(chunk.join('\n')));
    chunk = [];
  };
  for (const line of lines) {
    const m = line.match(FENCE_RE);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = undefined;
    } else if (m) {
      flush();
      out.push(line);
      fence = m[1];
    } else {
      chunk.push(line);
    }
  }
  flush();
  return out.join('\n');
}

const QUOTE_RE = /^ {0,3}> ?/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;

/**
 * Une citation de Docs ne contient que du texte : ses listes y seraient fusionnées en un
 * paragraphe. Une citation qui contient une liste est donc rendue comme du contenu ordinaire.
 */
export function liftQuoteLists(markdown: string): string {
  return outsideFences(markdown, (text) => {
    const lines = text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length;) {
      if (!QUOTE_RE.test(lines[i])) {
        out.push(lines[i++]);
        continue;
      }
      const start = i;
      while (i < lines.length && QUOTE_RE.test(lines[i])) i++;
      const quote = lines.slice(start, i);
      const inner = quote.map((l) => l.replace(QUOTE_RE, ''));
      if (!inner.some((l) => LIST_ITEM_RE.test(l))) {
        out.push(...quote);
        continue;
      }
      if (out.length && out.at(-1)!.trim()) out.push('');
      out.push(...inner);
      if (i < lines.length && lines[i].trim()) out.push('');
    }
    return out.join('\n');
  });
}

export interface LocalImage {
  /** Cible telle qu'écrite dans le Markdown (`schemas/x.png`). */
  ref: string;
  path: string;
  sha256: string;
}

const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?\s*)\)/g;
const isLocalRef = (ref: string) => !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('/') && !ref.startsWith('#');
const unwrap = (target: string) => (target.startsWith('<') ? target.slice(1, -1) : target);

function decode(ref: string): string {
  try {
    return decodeURI(ref);
  } catch {
    return ref;
  }
}

/**
 * Images locales de `markdown` (fichier `file`), à envoyer en pièces jointes. Seules les
 * images (par extension) situées sous `root`, le dossier poussé, sont retenues : un lien
 * vers `../../.ssh/…` ne part pas chez Docs. Les autres sont signalées dans `issues`.
 */
export function findLocalImages(
  markdown: string,
  file: string,
  root: string,
): { images: LocalImage[]; issues: string[] } {
  const images = new Map<string, LocalImage>();
  const issues: string[] = [];
  const realRoot = realpathSync(root);
  outsideFences(markdown, (text) => {
    for (const m of text.matchAll(IMAGE_RE)) {
      const ref = unwrap(m[2]);
      if (!isLocalRef(ref) || images.has(ref)) continue;
      const path = resolve(dirname(file), decode(ref.replace(/[?#].*$/, '')));
      const problem = imageProblem(path, realRoot);
      if (problem) {
        issues.push(`${ref} : ${problem}`);
        continue;
      }
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      images.set(ref, { ref, path, sha256 });
    }
    return text;
  });
  return { images: [...images.values()], issues: [...new Set(issues)] };
}

function imageProblem(path: string, realRoot: string): string | undefined {
  if (!IMAGE_TYPES[extname(path).toLowerCase()]) return 'pas une image (png, jpg, gif, webp, svg)';
  if (!existsSync(path)) return 'fichier introuvable';
  const real = realpathSync(path);
  const rel = relative(realRoot, real);
  if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(realRoot, rel) !== real) return 'hors du dossier poussé';
  if (!statSync(real).isFile()) return "n'est pas un fichier";
  if (statSync(real).size > MAX_IMAGE_BYTES) return 'plus de 10 Mo';
  return undefined;
}

/** Remplace la cible des images locales par l'URL de leur pièce jointe dans Docs. */
export function replaceImages(markdown: string, urlByRef: Map<string, string>): string {
  if (!urlByRef.size) return markdown;
  return outsideFences(markdown, (text) =>
    text.replace(IMAGE_RE, (match, alt: string, target: string, title: string) => {
      const url = urlByRef.get(unwrap(target));
      return url ? `![${alt}](${url}${title})` : match;
    }),
  );
}
