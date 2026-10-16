// Seul point d'écriture vers Docs. Docs n'expose pas d'écriture du contenu d'un document
// existant (il appartient au serveur de collaboration) : on crée par import d'un fichier .md.
// Chaque commande affiche son plan et le fait confirmer (confirm.ts) avant d'appeler ce module.
import { type DocMeta, getDoc, isDocMeta, rawWrite } from './api.ts';
import { config, type CreateMode, UserError } from './config.ts';

export interface CreateRequest {
  parentId: string;
  title: string;
  markdown: string;
}

/** Nom de fichier envoyé à l'import (Docs en fait le titre initial, corrigé ensuite). */
export function uploadName(title: string): string {
  const base = title
    .replace(/\p{Cf}/gu, '')
    // oxlint-disable-next-line no-control-regex -- on retire justement les caractères de contrôle
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${base || 'document'}.md`;
}

/** Titre envoyé à Docs : une ligne, sans caractère de contrôle ni invisible. */
export function cleanTitle(title: string): string {
  const t = title
    .replace(/\p{Cf}/gu, '')
    // oxlint-disable-next-line no-control-regex -- on retire justement les caractères de contrôle
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) throw new UserError('Titre vide.');
  return t.slice(0, 255);
}

/** Clé de comparaison de deux titres : sans casse ni espaces superflus. */
export const titleKey = (title: string | null | undefined) =>
  (title ?? '')
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export class Writer {
  private readonly mode: CreateMode;

  constructor(mode: CreateMode = config.createMode) {
    this.mode = mode;
  }

  /** Crée un document (contenu Markdown converti par Docs) comme dernier enfant de `parentId`. */
  async create({ parentId, title, markdown }: CreateRequest): Promise<DocMeta> {
    const finalTitle = cleanTitle(title);
    const form = new FormData();
    // Le contenu ne doit jamais être vide : le convertisseur de Docs le refuse.
    const body = markdown.trim() ? markdown : `# ${finalTitle}\n`;
    form.append('file', new Blob([body], { type: 'text/markdown' }), uploadName(finalTitle));

    const path = this.mode === 'children' ? `documents/${parentId}/children/` : 'documents/';
    const created = await rawWrite<{ id?: string }>('POST', path, form);
    const id = created?.id;
    if (typeof id !== 'string') throw new UserError(`Réponse inattendue de Docs à la création (${path}).`);

    if (this.mode === 'move') await this.move(id, parentId);
    // La réponse du PATCH décrit déjà le document : une lecture de moins.
    const renamed = await this.rename(id, finalTitle);
    return renamed && isDocMeta(renamed) && renamed.title === finalTitle ? renamed : getDoc(id);
  }

  async rename(id: string, title: string): Promise<DocMeta | null> {
    return rawWrite<DocMeta>('PATCH', `documents/${id}/`, { title: cleanTitle(title) });
  }

  /** Déplace en dernier enfant de `targetId` (descendants compris). */
  async move(id: string, targetId: string): Promise<void> {
    await rawWrite('POST', `documents/${id}/move/`, { target_document_id: targetId, position: 'last-child' });
  }

  /** Suppression douce (corbeille de Docs, restaurable pendant 30 jours). */
  async delete(id: string): Promise<void> {
    await rawWrite('DELETE', `documents/${id}/`);
  }
}
