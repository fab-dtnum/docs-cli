#!/usr/bin/env -S node --use-system-ca --disable-warning=ExperimentalWarning
import { resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { config, parseDocId, UserError } from './config.ts';
import { applyEnvProxyToFetch } from './proxy.ts';

const USAGE = `Usage : docs <commande> …   (<id> : UUID ou URL d'un document Docs)

  login [--browser firefox|chromium]      Connexion ProConnect, session enregistrée dans ~/.config/docs-cli/.env
  doctor                                  Vérifie session, jeton CSRF, instance, modèles
  ls <id>                                 Sous-documents directs
  tree <id> [--depth N]                   Arbre des sous-documents
  pull <id> [--out <dossier>] [--force]   Instantané Markdown daté (défaut : ./data), seul le delta est téléchargé
  push <fichier.md|dossier> --parent <id> [--force]
                                          Archive les sous-documents actuels sous Archive > date, puis crée les nouveaux
  prune <id> --before AAAA-MM-JJ          Met à la corbeille les archives datées antérieures à ce jour
  new <modèle> --parent <id> [--title <titre>] [--var clé=valeur]…
                                          Crée un document depuis un modèle (enfant de DOCS_TEMPLATES)
  mv <id> --to <id>                       Déplace (en dernier enfant)
  rename <id> <titre>                     Renomme
  rm <id>                                 Met à la corbeille (avec les sous-documents)

Toute commande qui écrit affiche son plan et demande confirmation :
  --dry-run   plan seulement, aucune écriture
  --yes, -y   sans confirmation (scripts)

Exemples :
  docs push ./notes --parent https://docs.numerique.gouv.fr/docs/<uuid>/ --dry-run
  docs prune <uuid> --before 2026-01-01
  docs new cr --parent <uuid> --var sujet="Comité de pilotage"`;

const WRITE_OPTIONS = { 'dry-run': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } } as const;

/** Options de la ligne de commande ; une erreur de saisie devient un message lisible. */
export function args(argv: string[], options: ParseArgsConfig['options'] = {}, positionals = 1) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UserError(`${(e as Error).message}\n\n${USAGE}`);
  }
  // Un mot en trop vient souvent d'une valeur avec espaces non protégée : on refuse plutôt que de l'ignorer.
  const extra = parsed.positionals.slice(positionals);
  if (extra.length) {
    throw new UserError(`Argument(s) inattendu(s) : ${extra.join(' ')}\nUne valeur avec des espaces se met entre guillemets : --var nom="Comité de pilotage"`);
  }
  if (parsed.positionals.length < positionals) throw new UserError(`Argument manquant.\n\n${USAGE}`);
  return parsed;
}

const writeOpts = (v: Record<string, unknown>) => ({ dryRun: Boolean(v['dry-run']), yes: Boolean(v.yes) });

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'login': {
      const { values } = args(rest, { browser: { type: 'string' } }, 0);
      const { login, parseBrowser } = await import('./login.ts');
      await login(parseBrowser(values.browser as string | undefined));
      return 0;
    }
    case 'doctor': {
      args(rest, {}, 0);
      const { doctor } = await import('./doctor.ts');
      return doctor();
    }
    case 'ls': {
      const { positionals } = args(rest);
      await (await import('./ops.ts')).ls(parseDocId(positionals[0]));
      return 0;
    }
    case 'tree': {
      const { values, positionals } = args(rest, { depth: { type: 'string' } });
      const depth = values.depth === undefined ? Infinity : Number(values.depth);
      if (!Number.isInteger(depth) && depth !== Infinity) throw new UserError(`--depth attend un entier : ${values.depth}`);
      await (await import('./ops.ts')).tree(parseDocId(positionals[0]), depth);
      return 0;
    }
    case 'pull': {
      const { values, positionals } = args(rest, { out: { type: 'string' }, force: { type: 'boolean' } });
      if (values.out) config.dataDir = resolve(values.out as string);
      const { pull } = await import('./pull.ts');
      await pull(parseDocId(positionals[0]), { force: Boolean(values.force) });
      return 0;
    }
    case 'push': {
      const { values, positionals } = args(rest, { parent: { type: 'string' }, force: { type: 'boolean' }, ...WRITE_OPTIONS });
      const { push } = await import('./push.ts');
      await push(positionals[0], parseDocId(values.parent as string | undefined, 'père (--parent)'), {
        force: Boolean(values.force),
        ...writeOpts(values),
      });
      return 0;
    }
    case 'prune': {
      const { values, positionals } = args(rest, { before: { type: 'string' }, ...WRITE_OPTIONS });
      const { prune, parseDay } = await import('./push.ts');
      await prune(parseDocId(positionals[0]), parseDay(values.before as string | undefined), writeOpts(values));
      return 0;
    }
    case 'new': {
      const { values, positionals } = args(rest, {
        parent: { type: 'string' },
        title: { type: 'string' },
        var: { type: 'string', multiple: true },
        ...WRITE_OPTIONS,
      });
      const { newDoc, parseVars } = await import('./new.ts');
      await newDoc(positionals[0], parseDocId(values.parent as string | undefined, 'parent (--parent)'), {
        title: values.title as string | undefined,
        vars: parseVars(values.var as string[] | undefined),
        ...writeOpts(values),
      });
      return 0;
    }
    case 'mv': {
      const { values, positionals } = args(rest, { to: { type: 'string' }, ...WRITE_OPTIONS });
      await (await import('./ops.ts')).mv(parseDocId(positionals[0]), parseDocId(values.to as string | undefined, 'cible (--to)'), writeOpts(values));
      return 0;
    }
    case 'rename': {
      const { values, positionals } = args(rest, WRITE_OPTIONS, 2);
      await (await import('./ops.ts')).rename(parseDocId(positionals[0]), positionals[1], writeOpts(values));
      return 0;
    }
    case 'rm': {
      const { values, positionals } = args(rest, WRITE_OPTIONS);
      await (await import('./ops.ts')).rm(parseDocId(positionals[0]), writeOpts(values));
      return 0;
    }
    default:
      console.log(USAGE);
      return command && !['-h', '--help', 'help'].includes(command) ? 1 : 0;
  }
}

applyEnvProxyToFetch();

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UserError) console.error(err.message);
    else console.error(err);
    process.exit(1);
  },
);
