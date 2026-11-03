import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';
import { findLocalImages, liftQuoteLists, replaceImages } from '../prepare.ts';

test('citation contenant une liste : rendue en contenu ordinaire', () => {
  const md = 'Intro\n> **À retenir**\n> - un\n> - deux\nSuite';
  assert.equal(liftQuoteLists(md), 'Intro\n\n**À retenir**\n- un\n- deux\n\nSuite');
  assert.equal(liftQuoteLists('> 1. un\n>    suite'), '1. un\n   suite');
});

test('citation sans liste, ou dans un bloc de code : inchangée', () => {
  assert.equal(liftQuoteLists('> Une citation\n> sur deux lignes'), '> Une citation\n> sur deux lignes');
  const code = '```md\n> - pas touché\n```\n> - touché';
  assert.equal(liftQuoteLists(code), '```md\n> - pas touché\n```\n- touché');
});

test('images locales : retenues sous le dossier poussé, les autres signalées', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-cli-img-'));
  mkdirSync(join(root, 'doc', 'schemas'), { recursive: true });
  writeFileSync(join(root, 'doc', 'schemas', 'a b.png'), 'png');
  writeFileSync(join(root, 'secret.txt'), 'x');
  const file = join(root, 'doc', 'f.md');
  const md = [
    '![A](schemas/a%20b.png "titre")',
    '![A encore](<schemas/a b.png>)',
    '![absente](schemas/absente.png)',
    '![dehors](../../x.png)',
    '![texte](../secret.txt)',
    '![web](https://exemple.fr/x.png)',
    '```',
    '![code](schemas/code.png)',
    '```',
  ].join('\n');
  const { images, issues } = findLocalImages(md, file, join(root, 'doc'));
  assert.deepEqual(
    images.map((i) => i.ref),
    ['schemas/a%20b.png', 'schemas/a b.png'],
  );
  assert.equal(images[0].sha256, images[1].sha256);
  assert.deepEqual(issues, [
    'schemas/absente.png : fichier introuvable',
    '../../x.png : fichier introuvable',
    '../secret.txt : pas une image (png, jpg, gif, webp, svg)',
  ]);
  writeFileSync(join(root, 'x.png'), 'png');
  assert.deepEqual(findLocalImages('![d](../x.png)', file, join(root, 'doc')).issues, [
    '../x.png : hors du dossier poussé',
  ]);
});

test('replaceImages : cible remplacée, texte et titre conservés', () => {
  const urls = new Map([['schemas/a.png', 'https://docs/media/p/attachments/u.png']]);
  assert.equal(
    replaceImages('![Alt](schemas/a.png "T") ![x](autre.png)', urls),
    '![Alt](https://docs/media/p/attachments/u.png "T") ![x](autre.png)',
  );
});
