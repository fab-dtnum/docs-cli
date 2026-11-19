import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { zip } from '../zip.ts';
import { unzip } from './zip.ts';

test('zip : aller-retour, noms accentués, contenu compressé ou non', () => {
  const big = Buffer.from('abc '.repeat(5000));
  const archive = zip([
    { name: 'Étude/Résumé — v1.md', data: Buffer.from('# é\n') },
    { name: 'gros.txt', data: big },
    { name: 'media/x.png', data: Buffer.from([1, 2, 3, 255, 0]) },
    { name: 'vide.txt', data: Buffer.alloc(0) },
  ]);
  const files = unzip(archive);
  assert.deepEqual([...files.keys()], ['Étude/Résumé — v1.md', 'gros.txt', 'media/x.png', 'vide.txt']);
  assert.equal(files.get('Étude/Résumé — v1.md')!.toString(), '# é\n');
  assert.deepEqual(files.get('gros.txt'), big);
  assert.deepEqual(files.get('media/x.png'), Buffer.from([1, 2, 3, 255, 0]));
  assert.equal(files.get('vide.txt')!.length, 0);
  assert.ok(archive.length < big.length, 'le texte répétitif est compressé');
});

test('zip : refuse les noms dangereux et les doublons', () => {
  const data = Buffer.from('x');
  for (const name of ['/abs.txt', '../sortie.txt', 'a/../b.txt', 'a\\b.txt', '', 'a//b.txt']) {
    assert.throws(() => zip([{ name, data }]), /Nom d'entrée refusé/, name);
  }
  assert.throws(
    () =>
      zip([
        { name: 'A.md', data },
        { name: 'a.md', data },
      ]),
    /double/,
  );
});
