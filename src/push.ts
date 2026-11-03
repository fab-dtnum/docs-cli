// `docs push` : archive les sous-documents actuels du père sous « Archive > AAAA-MM-JJ HHhMM »,
// puis recrée l'arbre local sous le père, dont l'id ne change jamais (SPEC.md §3, push).
import { resolve } from 'node:path';
import { type DocMeta, getDoc, listChildren } from './api.ts';
import { docLink, UserError } from './config.ts';
import { confirmPlan, type WriteOptions } from './confirm.ts';
import { countDocs, hashLocal, type LocalDoc, readLocal } from './local.ts';
import { label } from './ops.ts';
import { formatDate } from './snapshots.ts';
import { replaceImages } from './prepare.ts';
import { getTarget, loadState, saveTarget } from './state.ts';
import { titleKey, Writer } from './writer.ts';

export const ARCHIVE_TITLE = 'Archive';

const pad = (n: number) => String(n).padStart(2, '0');
/** Titre d'une archive datée, heure locale : `2026-10-16 14h30`. */
export const archiveStamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`;

/** Titre libre parmi des frères : suffixe « (2) », « (3) »… */
export function uniqueTitle(title: string, siblings: (string | null)[]): string {
  const used = new Set(siblings.map(titleKey));
  let candidate = title;
  for (let i = 2; used.has(titleKey(candidate)); i++) candidate = `${title} (${i})`;
  return candidate;
}

export interface PushOptions extends WriteOptions {
  force?: boolean;
  now?: Date;
}

export async function push(path: string, parentId: string, opts: PushOptions = {}): Promise<void> {
  const source = readLocal(path);
  if (source.kind === 'dir') {
    const reserved = source.docs.find((d) => titleKey(d.title) === titleKey(ARCHIVE_TITLE));
    if (reserved) throw new UserError(`« ${ARCHIVE_TITLE} » est réservé sous le père : renommez ${reserved.rel}.`);
  } else if (titleKey(source.docs[0].title) === titleKey(ARCHIVE_TITLE)) {
    throw new UserError(`« ${ARCHIVE_TITLE} » est réservé sous le père : changez le titre de ${path}.`);
  }

  // Un fichier seul est suivi par (père, titre) : pousser un autre fichier n'efface pas son empreinte.
  const key = source.kind === 'dir' ? parentId : `${parentId}#${titleKey(source.docs[0].title)}`;
  const hash = hashLocal(source);
  const previous = getTarget(key);
  if (previous?.hash === hash && !opts.force) {
    console.log(
      `Rien à pousser : identique au push du ${formatDate(new Date(previous.pushedAt))} sous ${docLink({ id: parentId, title: previous.parentTitle })}.`,
    );
    console.log('(--force pour pousser quand même)');
    return;
  }

  const parent = await getDoc(parentId);
  const children = await listChildren(parentId);
  const archive = children.find((c) => titleKey(c.title) === titleKey(ARCHIVE_TITLE));
  const toArchive = children.filter((c) =>
    source.kind === 'dir' ? c !== archive : c !== archive && titleKey(c.title) === titleKey(source.docs[0].title),
  );
  const now = opts.now ?? new Date();
  const existingStamps = archive && toArchive.length ? (await listChildren(archive.id)).map((c) => c.title) : [];
  const stamp = uniqueTitle(archiveStamp(now), existingStamps);

  const plan = [`Père : ${docLink(parent)}`];
  if (toArchive.length) {
    plan.push(`\nÀ archiver sous ${ARCHIVE_TITLE}${archive ? '' : ' (créé)'} > ${stamp} :`);
    for (const c of toArchive)
      plan.push(`  - ${docLink(c)}${c.numchild ? ` (+ ${c.numchild} enfant(s) direct(s))` : ''}`);
  } else {
    plan.push('\nRien à archiver.');
  }
  plan.push(`\nÀ créer (${countDocs(source.docs)} document(s)) :`);
  const describe = (docs: LocalDoc[], indent: string) => {
    for (const d of docs) {
      plan.push(`${indent}+ ${label(d)}  ← ${d.rel}`);
      describe(d.children, `${indent}  `);
    }
  };
  describe(source.docs, '  ');

  // Images locales : pièces jointes du père, dont l'id ne change pas ; une image déjà envoyée
  // sous ce père (même contenu) n'est pas renvoyée.
  const all = flatten(source.docs);
  const known = knownMedia(parentId);
  const toUpload = new Map<string, { path: string; rels: string[] }>();
  for (const d of all) {
    for (const img of d.images ?? []) {
      if (known[img.sha256]) continue;
      const entry = toUpload.get(img.sha256) ?? { path: img.path, rels: [] };
      entry.rels.push(`${d.rel} → ${img.ref}`);
      toUpload.set(img.sha256, entry);
    }
  }
  const reused = new Set(all.flatMap((d) => (d.images ?? []).filter((i) => known[i.sha256]).map((i) => i.sha256)));
  if (toUpload.size || reused.size) {
    plan.push(`\nImages, en pièces jointes de ${label(parent)} :`);
    for (const { rels } of toUpload.values()) plan.push(`  ↑ ${rels.join(', ')}`);
    if (reused.size) plan.push(`  (${reused.size} déjà envoyée(s) par un push précédent : réutilisée(s))`);
  }
  const issues = all.flatMap((d) => (d.imageIssues ?? []).map((i) => `  ! ${d.rel} : ${i}`));
  if (issues.length) plan.push('\nImages laissées telles quelles (absentes de Docs) :', ...issues);
  if (!(await confirmPlan(plan, opts))) return;

  const writer = new Writer();
  const done: string[] = [];
  const documents: Record<string, string> = {};
  let archived: DocMeta | undefined;
  let usedMedia: Record<string, string> = {};
  try {
    if (toArchive.length) {
      let archiveId = archive?.id;
      if (!archiveId) {
        const created = await writer.create({
          parentId,
          title: ARCHIVE_TITLE,
          markdown: `# ${ARCHIVE_TITLE}\n\nVersions précédentes des sous-documents, archivées par \`docs push\` avant chaque mise à jour.\n`,
        });
        archiveId = created.id;
        done.push(`créé ${docLink(created)}`);
      }
      archived = await writer.create({
        parentId: archiveId,
        title: stamp,
        markdown: `Sous-documents de ${label(parent)} remplacés par \`docs push\` le ${formatDate(now)}.\n`,
      });
      done.push(`créé ${docLink(archived)}`);
      for (const c of toArchive) {
        await writer.move(c.id, archived.id);
        done.push(`archivé ${label(c)}`);
      }
    }
    const media: Record<string, string> = {};
    for (const i of reused) media[i] = known[i];
    for (const [sha, { path: file, rels }] of toUpload) {
      media[sha] = await writer.uploadImage(parentId, file);
      done.push(`envoyé ${rels[0].split(' → ')[1]}`);
    }
    const create = async (docs: LocalDoc[], under: string) => {
      for (const d of docs) {
        const markdown = replaceImages(d.markdown, new Map((d.images ?? []).map((i) => [i.ref, media[i.sha256]])));
        const created = await writer.create({ parentId: under, title: d.title, markdown });
        documents[d.rel] = created.id;
        done.push(`créé ${docLink(created)}`);
        console.log(`Créé : ${docLink(created)}`);
        await create(d.children, created.id);
      }
    };
    await create(source.docs, parentId);
    usedMedia = media;
  } catch (e) {
    console.error(`\nPush interrompu. Déjà fait :\n${done.map((l) => `  - ${l}`).join('\n') || '  (rien)'}`);
    console.error('Le prochain push refera un cycle complet (les documents déjà créés seront archivés).');
    throw e;
  }

  saveTarget(key, {
    hash,
    parentTitle: parent.title ?? undefined,
    pushedAt: now.toISOString(),
    source: resolve(path),
    ...(archived && { archive: archived.id }),
    documents,
    ...(Object.keys(usedMedia).length && { media: usedMedia }),
  });
  console.log(
    `\n${countDocs(source.docs)} document(s) créé(s) sous ${docLink(parent)}` +
      (archived ? `, ${toArchive.length} archivé(s) sous ${ARCHIVE_TITLE} > ${stamp} : ${docLink(archived)}` : '') +
      '.',
  );
}

const flatten = (docs: LocalDoc[]): LocalDoc[] => docs.flatMap((d) => [d, ...flatten(d.children)]);

/** Images déjà envoyées sous ce père (push d'un dossier ou de fichiers seuls). */
function knownMedia(parentId: string): Record<string, string> {
  const known: Record<string, string> = {};
  for (const [key, target] of Object.entries(loadState().targets)) {
    if (key === parentId || key.startsWith(`${parentId}#`)) Object.assign(known, target.media);
  }
  return known;
}

const STAMP_RE = /^(\d{4}-\d{2}-\d{2}) \d{2}h\d{2}(?: \(\d+\))?$/;

/** `AAAA-MM-JJ` valide (date réelle). */
export function parseDay(raw: string | undefined): string {
  const m = raw?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new UserError(`Date attendue au format AAAA-MM-JJ : ${raw ?? '(manquante)'}`);
  }
  return raw!;
}

/** `docs prune` : corbeille pour les archives datées strictement antérieures à `before`. */
export async function prune(id: string, before: string, opts: WriteOptions = {}): Promise<void> {
  const doc = await getDoc(id);
  let archive: DocMeta | undefined = doc;
  if (titleKey(doc.title) !== titleKey(ARCHIVE_TITLE)) {
    archive = (await listChildren(id)).find((c) => titleKey(c.title) === titleKey(ARCHIVE_TITLE));
    if (!archive) return console.log(`Aucun document « ${ARCHIVE_TITLE} » sous ${docLink(doc)} : rien à supprimer.`);
  }
  const entries = await listChildren(archive.id);
  const old = entries.filter((c) => {
    const day = c.title?.trim().match(STAMP_RE)?.[1];
    return day !== undefined && day < before;
  });
  const unknown = entries.filter((c) => !STAMP_RE.test(c.title?.trim() ?? ''));

  const plan = [`Archive : ${docLink(archive)}`];
  if (unknown.length) plan.push(`Ignorés (titre sans date AAAA-MM-JJ HHhMM) : ${unknown.map(label).join(', ')}`);
  if (!old.length) {
    console.log([...plan, `Aucune archive antérieure au ${before}.`].join('\n'));
    return;
  }
  plan.push(`\nÀ mettre à la corbeille (antérieures au ${before}, restaurables 30 jours) :`);
  for (const c of old) plan.push(`  - ${docLink(c)}`);
  if (!(await confirmPlan(plan, opts))) return;
  const writer = new Writer();
  for (const c of old) await writer.delete(c.id);
  console.log(`${old.length} archive(s) mise(s) à la corbeille.`);
}
