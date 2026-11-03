// Lecture des fichiers Markdown locaux à pousser : un fichier, ou un dossier en miroir
// récursif (même structure que la sortie de `pull` : `x.md` + dossier `x/` pour ses enfants).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { UserError } from './config.ts';
import { findLocalImages, liftQuoteLists, type LocalImage } from './prepare.ts';
import { cleanTitle } from './writer.ts';

export interface LocalDoc {
  /** Chemin relatif au dossier poussé (fichier `.md`, ou dossier sans `.md` associé). */
  rel: string;
  title: string;
  markdown: string;
  children: LocalDoc[];
  /** Images locales du contenu, envoyées en pièces jointes au push. */
  images?: LocalImage[];
  /** Images locales laissées telles quelles (introuvables, hors du dossier…). */
  imageIssues?: string[];
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Titre et contenu d'un fichier : `title` du front matter YAML, sinon premier titre `#`
 * s'il ouvre le document (retiré du contenu), sinon `fallback`. Le front matter n'est pas envoyé.
 */
export function parseMarkdown(text: string, fallback: string): { title: string; markdown: string } {
  let body = text.replace(/^﻿/, '');
  let title: string | undefined;
  const fm = body.match(FRONT_MATTER_RE);
  if (fm) {
    try {
      const data = parseYaml(fm[1]);
      if (data && typeof data.title === 'string' && data.title.trim()) title = data.title;
    } catch {
      // Front matter illisible : traité comme du contenu ordinaire.
    }
    if (title !== undefined || isYamlObject(fm[1])) body = body.slice(fm[0].length);
  }
  if (title === undefined) {
    const h1 = body.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
    if (h1) {
      title = h1[1];
      body = body.slice(h1[0].length);
    }
  }
  return { title: cleanTitle(title ?? fallback), markdown: body.replace(/^\s*\n/, '') };
}

function isYamlObject(raw: string): boolean {
  try {
    const v = parseYaml(raw);
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const isHidden = (name: string) => name.startsWith('.');

function readFile(path: string, rel: string, root: string): LocalDoc {
  const parsed = parseMarkdown(readFileSync(path, 'utf8'), basename(path, '.md'));
  const markdown = liftQuoteLists(parsed.markdown);
  const { images, issues } = findLocalImages(markdown, path, root);
  return {
    rel,
    title: parsed.title,
    markdown,
    children: [],
    ...(images.length && { images }),
    ...(issues.length && { imageIssues: issues }),
  };
}

/** Contient-il au moins un `.md` (un dossier de pièces jointes seules est ignoré) ? */
function hasMarkdown(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some(
    (e) => !isHidden(e.name) && (e.isDirectory() ? hasMarkdown(join(dir, e.name)) : e.name.endsWith('.md')),
  );
}

function readDir(dir: string, rel: string, root = dir): LocalDoc[] {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !isHidden(e.name));
  const dirs = new Set(entries.filter((e) => e.isDirectory() && hasMarkdown(join(dir, e.name))).map((e) => e.name));
  const files = new Set(entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3)));
  const names = [...new Set([...files, ...dirs])].sort(collator.compare);
  return names.map((name) => {
    const fileRel = posix.join(rel, `${name}.md`);
    const dirRel = posix.join(rel, name);
    const doc = files.has(name)
      ? readFile(join(dir, `${name}.md`), fileRel, root)
      : { rel: dirRel, title: cleanTitle(name), markdown: '', children: [] };
    if (dirs.has(name)) doc.children = readDir(join(dir, name), dirRel, root);
    return doc;
  });
}

export interface LocalSource {
  kind: 'file' | 'dir';
  docs: LocalDoc[];
}

export function readLocal(path: string): LocalSource {
  if (!existsSync(path)) throw new UserError(`Introuvable : ${path}`);
  if (statSync(path).isDirectory()) {
    const docs = readDir(path, '');
    if (!docs.length) throw new UserError(`Aucun fichier .md dans ${path}`);
    return { kind: 'dir', docs };
  }
  if (!path.endsWith('.md')) throw new UserError(`Fichier Markdown attendu (.md) : ${path}`);
  return { kind: 'file', docs: [readFile(path, basename(path), dirname(path))] };
}

/** Empreinte de ce qui serait envoyé : chemin, titre, contenu et images de chaque document. */
export function hashLocal(source: LocalSource): string {
  const strip = (d: LocalDoc): unknown => [
    d.rel,
    d.title,
    d.markdown,
    d.children.map(strip),
    ...(d.images ? [d.images.map((i) => [i.ref, i.sha256])] : []),
  ];
  return createHash('sha256')
    .update(JSON.stringify([source.kind, source.docs.map(strip)]))
    .digest('hex');
}

export const countDocs = (docs: LocalDoc[]): number => docs.reduce((n, d) => n + 1 + countDocs(d.children), 0);
