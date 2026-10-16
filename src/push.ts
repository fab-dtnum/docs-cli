// `docs push` : archive les sous-documents actuels du père sous « Archive > AAAA-MM-JJ HHhMM »,
// puis recrée l'arbre local sous le père, dont l'id ne change jamais (SPEC.md §3, push).
import { resolve } from 'node:path';
import { type DocMeta, getDoc, listChildren } from './api.ts';
import { docUrl, UserError } from './config.ts';
import { confirmPlan, type WriteOptions } from './confirm.ts';
import { countDocs, hashLocal, type LocalDoc, readLocal } from './local.ts';
import { label } from './ops.ts';
import { formatDate } from './snapshots.ts';
import { getTarget, saveTarget } from './state.ts';
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
    console.log(`Rien à pousser : identique au push du ${formatDate(new Date(previous.pushedAt))} sous ${docUrl(parentId)}.`);
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

  const plan = [`Père : ${label(parent)} — ${docUrl(parentId)}`];
  if (toArchive.length) {
    plan.push(`\nÀ archiver sous ${ARCHIVE_TITLE}${archive ? '' : ' (créé)'} > ${stamp} :`);
    for (const c of toArchive) plan.push(`  - ${label(c)}${c.numchild ? ` (+ ${c.numchild} enfant(s) direct(s))` : ''}`);
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
  if (!(await confirmPlan(plan, opts))) return;

  const writer = new Writer();
  const done: string[] = [];
  const documents: Record<string, string> = {};
  let archived: DocMeta | undefined;
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
        done.push(`créé ${label(created)} — ${docUrl(created.id)}`);
      }
      archived = await writer.create({
        parentId: archiveId,
        title: stamp,
        markdown: `Sous-documents de ${label(parent)} remplacés par \`docs push\` le ${formatDate(now)}.\n`,
      });
      done.push(`créé ${label(archived)} — ${docUrl(archived.id)}`);
      for (const c of toArchive) {
        await writer.move(c.id, archived.id);
        done.push(`archivé ${label(c)}`);
      }
    }
    const create = async (docs: LocalDoc[], under: string) => {
      for (const d of docs) {
        const created = await writer.create({ parentId: under, title: d.title, markdown: d.markdown });
        documents[d.rel] = created.id;
        done.push(`créé ${label(created)} — ${docUrl(created.id)}`);
        console.log(`Créé : ${label(created)} → ${docUrl(created.id)}`);
        await create(d.children, created.id);
      }
    };
    await create(source.docs, parentId);
  } catch (e) {
    console.error(`\nPush interrompu. Déjà fait :\n${done.map((l) => `  - ${l}`).join('\n') || '  (rien)'}`);
    console.error('Le prochain push refera un cycle complet (les documents déjà créés seront archivés).');
    throw e;
  }

  saveTarget(key, {
    hash,
    pushedAt: now.toISOString(),
    source: resolve(path),
    ...(archived && { archive: archived.id }),
    documents,
  });
  console.log(
    `\n${countDocs(source.docs)} document(s) créé(s) sous ${label(parent)}` +
      (archived ? `, ${toArchive.length} archivé(s) sous ${ARCHIVE_TITLE} > ${stamp} (${docUrl(archived.id)})` : '') +
      '.',
  );
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
    if (!archive) return console.log(`Aucun document « ${ARCHIVE_TITLE} » sous ${label(doc)} : rien à supprimer.`);
  }
  const entries = await listChildren(archive.id);
  const old = entries.filter((c) => {
    const day = c.title?.trim().match(STAMP_RE)?.[1];
    return day !== undefined && day < before;
  });
  const unknown = entries.filter((c) => !STAMP_RE.test(c.title?.trim() ?? ''));

  const plan = [`Archive : ${docUrl(archive.id)}`];
  if (unknown.length) plan.push(`Ignorés (titre sans date AAAA-MM-JJ HHhMM) : ${unknown.map(label).join(', ')}`);
  if (!old.length) {
    console.log([...plan, `Aucune archive antérieure au ${before}.`].join('\n'));
    return;
  }
  plan.push(`\nÀ mettre à la corbeille (antérieures au ${before}, restaurables 30 jours) :`);
  for (const c of old) plan.push(`  - ${label(c)}`);
  if (!(await confirmPlan(plan, opts))) return;
  const writer = new Writer();
  for (const c of old) await writer.delete(c.id);
  console.log(`${old.length} archive(s) mise(s) à la corbeille.`);
}
