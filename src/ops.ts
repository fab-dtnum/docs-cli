// Commandes unitaires : ls, tree, mv, rename, rm.
import { type DocMeta, getDoc, isSameOrDescendant, listChildren } from './api.ts';
import { docUrl, UserError } from './config.ts';
import { confirmPlan, type WriteOptions } from './confirm.ts';
import { formatDate } from './snapshots.ts';
import { cleanTitle, Writer } from './writer.ts';

export const label = (d: Pick<DocMeta, 'title'>) => `« ${d.title?.trim() || 'Sans titre'} »`;

export async function ls(id: string): Promise<void> {
  const doc = await getDoc(id);
  console.log(`${label(doc)} — ${docUrl(doc.id)}`);
  const children = await listChildren(id);
  if (!children.length) return console.log('(aucun sous-document)');
  for (const c of children) {
    const n = c.numchild ? `, ${c.numchild} enfant(s)` : '';
    console.log(`  ${c.id}  ${formatDate(new Date(c.updated_at))}  ${c.title?.trim() || 'Sans titre'}${n}`);
  }
}

export async function tree(id: string, maxDepth = Infinity): Promise<void> {
  const root = await getDoc(id);
  console.log(`${root.title?.trim() || 'Sans titre'}  ${root.id}`);
  let count = 0;
  async function walk(parent: DocMeta, prefix: string, depth: number) {
    if (!parent.numchild || depth > maxDepth) return;
    const children = await listChildren(parent.id);
    for (const [i, c] of children.entries()) {
      const last = i === children.length - 1;
      count++;
      console.log(`${prefix}${last ? '└── ' : '├── '}${c.title?.trim() || 'Sans titre'}  ${c.id}`);
      await walk(c, prefix + (last ? '    ' : '│   '), depth + 1);
    }
  }
  await walk(root, '', 1);
  console.log(`\n${count} sous-document(s).`);
}

/** Nombre de descendants (pour annoncer ce qu'emporte une suppression). */
async function countDescendants(doc: DocMeta): Promise<number> {
  if (!doc.numchild) return 0;
  let n = 0;
  for (const c of await listChildren(doc.id)) n += 1 + (await countDescendants(c));
  return n;
}

export async function mv(id: string, targetId: string, opts: WriteOptions): Promise<void> {
  const [doc, target] = await Promise.all([getDoc(id), getDoc(targetId)]);
  if (isSameOrDescendant(target, doc)) {
    throw new UserError(
      `Refus : ${label(target)} est ${doc.id === target.id ? 'le document lui-même' : 'un descendant du document à déplacer'}.`,
    );
  }
  const plan = [
    `Déplacer ${label(doc)} (${docUrl(doc.id)})`,
    `  sous ${label(target)} (${docUrl(target.id)}), en dernier enfant`,
  ];
  if (doc.numchild) plan.push(`  avec ses sous-documents`);
  if (!(await confirmPlan(plan, opts))) return;
  await new Writer().move(id, targetId);
  console.log(`Déplacé : ${docUrl(id)}`);
}

export async function rename(id: string, title: string, opts: WriteOptions): Promise<void> {
  const doc = await getDoc(id);
  const finalTitle = cleanTitle(title);
  if (!(await confirmPlan([`Renommer ${label(doc)} en « ${finalTitle} » (${docUrl(id)})`], opts))) return;
  await new Writer().rename(id, finalTitle);
  console.log(`Renommé : ${docUrl(id)}`);
}

export async function rm(id: string, opts: WriteOptions): Promise<void> {
  const doc = await getDoc(id);
  const n = await countDescendants(doc);
  const plan = [
    `Mettre à la corbeille ${label(doc)} (${docUrl(id)})${n ? `, avec ${n} sous-document(s)` : ''}`,
    '  (restaurable 30 jours depuis la corbeille de Docs)',
  ];
  if (!(await confirmPlan(plan, opts))) return;
  await new Writer().delete(id);
  console.log(`Mis à la corbeille : ${label(doc)}`);
}
