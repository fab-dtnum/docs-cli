import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { cli } from './cli.ts';
import { type FakeServer, startFakeDocs, testEnv } from './fake-docs.ts';

let server: FakeServer;
let target: string;

before(async () => {
  server = await startFakeDocs();
  const tmp = mkdtempSync(join(tmpdir(), 'docs-cli-new-'));
  testEnv(server.url, { home: join(tmp, 'home'), data: join(tmp, 'data') });
  const templates = server.seed({
    title: 'Modèles',
    children: [
      { title: 'cr', markdown: '# CR {{sujet}} du {{date}}\n\nRédigé par {{auteur}}, nom\\_court {{nom\\_court}}' },
      { title: 'libre', markdown: 'Pas de titre {{x}}' },
    ],
  });
  process.env.DOCS_TEMPLATES = templates;
  target = server.seed({ title: 'Cible' });
});
after(() => server.close());

test('new : variables (échappées comprises), titre tiré du modèle, anti-doublon', async () => {
  const r = await cli(['new', 'CR', '--parent', target, '--var', 'sujet=Copil', '--var', 'nom_court=cp', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  const [doc] = server.childrenOf(target);
  assert.match(doc.title, /^CR Copil du \d{4}-\d{2}-\d{2}$/);
  assert.equal(doc.markdown, 'Rédigé par Camille Test, nom\\_court cp');

  const again = await cli(['new', 'cr', '--parent', target, '--var', 'sujet=Copil', '--var', 'nom_court=cp', '--yes']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /existe déjà/);
});

test('new : variable manquante, modèle sans titre, modèle inconnu', async () => {
  const missing = await cli(['new', 'cr', '--parent', target, '--yes']);
  assert.match(missing.stderr, /Variable\(s\) manquante\(s\) : sujet, nom_court/);
  const untitled = await cli(['new', 'libre', '--parent', target, '--var', 'x=1', '--yes']);
  assert.match(untitled.stderr, /précisez --title/);
  const ok = await cli(['new', 'libre', '--parent', target, '--var', 'x=1', '--title', 'Libre {{x}}', '--yes']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(server.findChild(target, 'Libre 1'));
  const unknown = await cli(['new', 'inconnu', '--parent', target, '--yes']);
  assert.match(unknown.stderr, /Modèles présents : cr, libre/);
});
