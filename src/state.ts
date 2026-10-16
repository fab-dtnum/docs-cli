// État des push (`$DOCS_HOME/state/push.json`) : empreinte du dernier push réussi sous
// chaque père, pour sauter un push inchangé. Rien d'autre n'en dépend : absent ou
// illisible, le push se fait normalement (SPEC.md §4.3).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

export interface PushTarget {
  hash: string;
  /** Titre du père au moment du push (affiché sans requête quand rien n'a changé). */
  parentTitle?: string;
  pushedAt: string;
  source: string;
  /** Document daté créé sous « Archive » à ce push. */
  archive?: string;
  /** Chemin relatif du fichier → id du document créé. */
  documents: Record<string, string>;
}

interface PushState {
  version: 1;
  targets: Record<string, PushTarget>;
}

const file = () => join(config.stateDir, 'push.json');

export function loadState(): PushState {
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as PushState;
    if (s?.version === 1 && s.targets && typeof s.targets === 'object') return s;
  } catch {}
  return { version: 1, targets: {} };
}

export function getTarget(key: string): PushTarget | undefined {
  return loadState().targets[key];
}

/** Relu juste avant l'écriture : deux push en parallèle sous des pères différents ne s'écrasent pas. */
export function saveTarget(key: string, target: PushTarget): void {
  const state = loadState();
  state.targets[key] = target;
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file());
  if (existsSync(file())) chmodSync(file(), 0o600);
}
