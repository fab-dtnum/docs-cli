// Diagnostic : .env, session, jeton CSRF, modèles, instance.
import { existsSync, statSync } from 'node:fs';
import { getDoc, getInstanceConfig, getMe, listChildren } from './api.ts';
import { config, DOCS_HOME, ENV_FILE, isValidCsrfToken, parseDocId } from './config.ts';

type Status = 'ok' | 'warn' | 'fail';
const ICON: Record<Status, string> = { ok: '✔', warn: '⚠', fail: '✘' };

export async function doctor(): Promise<number> {
  let failures = 0;
  const check = async (label: string, fn: () => Promise<[Status, string]> | [Status, string]) => {
    let status: Status;
    let detail: string;
    try {
      [status, detail] = await fn();
    } catch (e) {
      [status, detail] = ['fail', (e as Error).message.split('\n').join('\n    ')];
    }
    if (status === 'fail') failures++;
    console.log(`${ICON[status]} ${label}${detail ? ` — ${detail}` : ''}`);
    return status !== 'fail';
  };

  await check('.env', () => {
    if (!existsSync(ENV_FILE)) return ['fail', `absent (${ENV_FILE}) : lancez docs login`];
    const mode = statSync(ENV_FILE).mode & 0o777;
    return mode & 0o077
      ? ['warn', `droits ${mode.toString(8)} : chmod 600 ${ENV_FILE}`]
      : ['ok', `${ENV_FILE}, droits 600`];
  });

  const session = await check('Session Docs', async () => {
    const me = await getMe();
    return ['ok', `${me.email} sur ${config.baseUrl}`];
  });

  await check('Jeton CSRF (écriture)', () =>
    !config.csrfToken
      ? ['fail', 'DOCS_CSRFTOKEN vide : relancez docs login']
      : isValidCsrfToken(config.csrfToken)
        ? ['ok', 'présent (vérifié à la première écriture)']
        : ['fail', 'format inattendu : relancez docs login'],
  );

  if (session) {
    await check('Instance', async () => {
      const c = await getInstanceConfig();
      const version = typeof c.RELEASE_VERSION === 'string' ? `version ${c.RELEASE_VERSION}` : 'version inconnue';
      return c.CONVERSION_UPLOAD_ENABLED === false
        ? ['fail', `${version} ; import de fichiers désactivé (CONVERSION_UPLOAD_ENABLED) : push et new impossibles`]
        : ['ok', `${version}, mode de création ${config.createMode}`];
    });
    await check('Modèles (docs new)', async () => {
      if (!config.templatesId) return ['warn', 'DOCS_TEMPLATES non défini'];
      const id = parseDocId(config.templatesId, 'DOCS_TEMPLATES');
      const doc = await getDoc(id);
      const names = (await listChildren(id)).map((c) => c.title?.trim() || 'Sans titre');
      return ['ok', `« ${doc.title} » : ${names.length ? names.join(', ') : '(aucun modèle)'}`];
    });
  }

  console.log(`\nDossier de l'utilisateur : ${DOCS_HOME}`);
  console.log(failures ? `${failures} problème(s) à corriger.` : 'Tout est prêt.');
  return failures ? 1 : 0;
}
