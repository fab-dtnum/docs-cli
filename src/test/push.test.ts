import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll as after, beforeAll as before, test } from 'vite-plus/test';
import { cli } from './cli.ts';
import { type FakeServer, startFakeDocs, testEnv } from './fake-docs.ts';

let server: FakeServer;
let tmp: string;
let home: string;

before(async () => {
  server = await startFakeDocs();
  tmp = mkdtempSync(join(tmpdir(), 'docs-cli-push-'));
  home = join(tmp, 'home');
  testEnv(server.url, { home, data: join(tmp, 'data') });
});
after(() => server.close());

/** Arborescence locale : `{ 'a.md': '…', 'b/c.md': '…' }`. */
function localTree(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const titles = (parent: string) => server.childrenOf(parent).map((d) => d.title);

test('push dossier : arbre récursif, titres, front matter, sans archive au premier push', async () => {
  const parent = server.seed({ title: 'Père' });
  const dir = localTree('p1', {
    'b.md': '# Bêta\n\nContenu B',
    'a.md': '---\ntitle: Alpha\nauteur: x\n---\nContenu A',
    'c.md': 'Sans titre explicite',
    'c/d.md': 'Enfant de c',
    'e/f.md': 'Enfant de e',
    'e/image.png': 'png',
    'images/logo.png': 'pas de .md : ignoré',
    '.cache/x.md': 'caché : ignoré',
  });
  const r = await cli(['push', dir, '--parent', parent, '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(titles(parent), ['Alpha', 'Bêta', 'c', 'e']);
  const a = server.findChild(parent, 'Alpha')!;
  assert.equal(a.markdown, 'Contenu A');
  assert.equal(server.findChild(parent, 'Bêta')!.markdown, 'Contenu B');
  assert.deepEqual(titles(server.findChild(parent, 'c')!.id), ['d']);
  assert.equal(server.findChild(parent, 'e')!.markdown, '# e\n');
  assert.deepEqual(titles(server.findChild(parent, 'e')!.id), ['f']);

  const state = JSON.parse(readFileSync(join(home, 'state/push.json'), 'utf8'));
  assert.equal(state.targets[parent].documents['a.md'], a.id);
  assert.equal(state.targets[parent].archive, undefined);
});

test('push inchangé : aucune écriture ; --force : nouveau cycle', async () => {
  const parent = server.seed({ title: 'Père', children: [{ title: 'Ancien' }] });
  const dir = localTree('p2', { 'x.md': 'X' });
  assert.equal((await cli(['push', dir, '--parent', parent, '--yes'])).status, 0);

  server.requests.length = 0;
  const same = await cli(['push', dir, '--parent', parent, '--yes']);
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /Rien à pousser/);
  assert.deepEqual(server.writes(), []);

  const forced = await cli(['push', dir, '--parent', parent, '--yes', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(server.writes().length > 0);
});

test('push modifié : tout archivé sous Archive > date, id du père inchangé', async () => {
  const parent = server.seed({ title: 'Père', children: [{ title: 'Manuel', children: [{ title: 'Petit' }] }] });
  const dir = localTree('p3', { 'x.md': 'v1' });
  assert.equal((await cli(['push', dir, '--parent', parent, '--yes'])).status, 0);
  assert.deepEqual(titles(parent), ['Archive', 'x']);
  const archive = server.findChild(parent, 'Archive')!;
  const [first] = server.childrenOf(archive.id);
  assert.match(first.title, /^\d{4}-\d{2}-\d{2} \d{2}h\d{2}$/);
  assert.deepEqual(titles(first.id), ['Manuel']);
  assert.deepEqual(
    titles(server.findChild(first.id, 'Manuel')!.id),
    ['Petit'],
    'descendants déplacés avec leur parent',
  );

  writeFileSync(join(dir, 'x.md'), 'v2');
  writeFileSync(join(dir, 'y.md'), 'nouveau');
  const r = await cli(['push', dir, '--parent', parent, '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(titles(parent), ['Archive', 'x', 'y']);
  assert.equal(server.findChild(parent, 'x')!.markdown, 'v2');
  const stamps = titles(archive.id);
  assert.equal(stamps.length, 2);
  assert.match(stamps[1], /^\d{4}-\d{2}-\d{2} \d{2}h\d{2}( \(2\))?$/, 'même minute : suffixe (2)');
  assert.deepEqual(titles(server.childrenOf(archive.id)[1].id), ['x']);
});

test('push fichier seul : seul l’homonyme est archivé', async () => {
  const parent = server.seed({ title: 'Père', children: [{ title: 'Rapport' }, { title: 'Autre' }] });
  const file = join(localTree('p4', { 'rapport.md': '# rapport\n\nNouveau' }), 'rapport.md');
  const r = await cli(['push', file, '--parent', parent, '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(titles(parent), ['Autre', 'Archive', 'rapport']);
  const archive = server.findChild(parent, 'Archive')!;
  assert.deepEqual(titles(server.childrenOf(archive.id)[0].id), ['Rapport']);
});

test('--dry-run : plan sans écriture ; sans --yes hors terminal : refus', async () => {
  const parent = server.seed({ title: 'Père', children: [{ title: 'Existant' }] });
  const dir = localTree('p5', { 'n.md': 'N' });
  server.requests.length = 0;
  const dry = await cli(['push', dir, '--parent', parent, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /À archiver sous Archive \(créé\)/);
  assert.match(dry.stdout, /- « Existant » \([0-9a-f-]{36}\)/);
  assert.match(dry.stdout, /Père : « Père » \([0-9a-f-]{36}\)\n/);
  assert.match(dry.stdout, /\+ « n »  ← n\.md/);
  const noYes = await cli(['push', dir, '--parent', parent]);
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /--yes/);
  assert.deepEqual(server.writes(), []);
});

test('« Archive » réservé au premier niveau', async () => {
  const parent = server.seed({ title: 'Père' });
  const dir = localTree('p6', { 'Archive.md': 'non' });
  const r = await cli(['push', dir, '--parent', parent, '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /réservé/);
});

test('prune --before : archives datées antérieures à la corbeille, le reste intact', async () => {
  const parent = server.seed({
    title: 'Père',
    children: [
      {
        title: 'Archive',
        children: [
          { title: '2025-12-31 23h59' },
          { title: '2025-06-01 10h00 (2)' },
          { title: '2026-01-01 00h00' },
          { title: 'Notes à garder' },
        ],
      },
    ],
  });
  const archive = server.findChild(parent, 'Archive')!.id;
  const dry = await cli(['prune', parent, '--before', '2026-01-01', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Ignorés.*Notes à garder/);
  assert.equal(titles(archive).length, 4);

  const r = await cli(['prune', parent, '--before', '2026-01-01', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(titles(archive), ['2026-01-01 00h00', 'Notes à garder']);

  const bad = await cli(['prune', parent, '--before', '2026-02-30']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /AAAA-MM-JJ/);
});
