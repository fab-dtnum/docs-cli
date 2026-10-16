// Plan d'écriture affiché, puis confirmé (ou --dry-run / --yes) avant toute requête d'écriture.
import { createInterface } from 'node:readline/promises';
import { UserError } from './config.ts';

export interface WriteOptions {
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * Affiche le plan ; renvoie `true` si l'on peut écrire. `--dry-run` : jamais.
 * Sans terminal et sans `--yes` : refus (un script ne doit pas rester bloqué sur la question).
 */
export async function confirmPlan(lines: string[], opts: WriteOptions): Promise<boolean> {
  console.log(lines.join('\n'));
  if (opts.dryRun) {
    console.log('\n--dry-run : rien n’a été écrit.');
    return false;
  }
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    throw new UserError(
      'Confirmation impossible sans terminal : relancez avec --yes (ou --dry-run pour voir le plan).',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('\nContinuer ? [o/N] ')).trim().toLowerCase();
    if (['o', 'oui', 'y', 'yes'].includes(answer)) return true;
    console.log('Abandon : rien n’a été écrit.');
    return false;
  } finally {
    rl.close();
  }
}
