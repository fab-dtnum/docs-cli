import { execFile } from 'node:child_process';

/**
 * Lance le CLI dans un sous-processus. Asynchrone : un appel bloquant figerait aussi
 * la fausse API, qui tourne dans le processus de test.
 */
export function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'src/cli.ts', ...args],
      { env },
      (err, stdout, stderr) => resolve({ status: err ? Number(err.code) : 0, stdout, stderr }),
    );
    child.stdin?.end(); // entrée standard qui n'est pas un terminal
  });
}
