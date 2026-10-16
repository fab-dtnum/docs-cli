import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll as after, beforeAll as before, test } from 'vite-plus/test';
import { cli } from './cli.ts';
import { type FakeServer, startFakeDocs, testEnv } from './fake-docs.ts';

let server: FakeServer;
let tmp: string;

before(async () => {
  server = await startFakeDocs();
  tmp = mkdtempSync(join(tmpdir(), 'docs-cli-ops-'));
  testEnv(server.url, { home: join(tmp, 'home'), data: join(tmp, 'data') });
});
after(() => server.close());

test('ls et tree', async () => {
  const root = server.seed({
    title: 'Racine',
    children: [{ title: 'A', children: [{ title: 'A1' }] }, { title: 'B' }],
  });
  const ls = await cli(['ls', `${server.url}/docs/${root}/`]);
  assert.equal(ls.status, 0, ls.stderr);
  assert.match(ls.stdout, /^« Racine » \([0-9a-f-]{36}\)\n/);
  assert.match(ls.stdout, /A, 1 enfant\(s\)/);
  const tree = await cli(['tree', root]);
  assert.match(tree.stdout, /├── A .*\n│   └── A1 .*\n└── B /);
  assert.match(tree.stdout, /3 sous-document\(s\)/);
  const shallow = await cli(['tree', root, '--depth', '1']);
  assert.doesNotMatch(shallow.stdout, /A1/);
});

test('mv, rename, rm ; déplacement sous un descendant refusé', async () => {
  const root = server.seed({ title: 'R', children: [{ title: 'A', children: [{ title: 'A1' }] }, { title: 'B' }] });
  const a = server.findChild(root, 'A')!.id;
  const a1 = server.findChild(a, 'A1')!.id;
  const b = server.findChild(root, 'B')!.id;

  const loop = await cli(['mv', a, '--to', a1, '--yes']);
  assert.equal(loop.status, 1);
  assert.match(loop.stderr, /descendant/);

  assert.equal((await cli(['mv', b, '--to', a, '--yes'])).status, 0);
  assert.deepEqual(
    server.childrenOf(a).map((d) => d.title),
    ['A1', 'B'],
  );

  assert.equal((await cli(['rename', b, 'Bis', '--yes'])).status, 0);
  assert.equal(server.docs.get(b)!.title, 'Bis');

  const rm = await cli(['rm', a, '--yes']);
  assert.match(rm.stdout, /avec 2 sous-document\(s\)/);
  assert.ok(!server.alive(a) && !server.alive(b));
});

test('pull : instantané, puis delta sans retéléchargement', async () => {
  const root = server.seed({ title: 'Projet', markdown: 'Racine', children: [{ title: 'Note', markdown: 'Texte' }] });
  const out = join(tmp, 'out');
  const first = await cli(['pull', root, '--out', out]);
  assert.equal(first.status, 0, first.stderr);
  const [snap] = readdirSync(out).filter((n) => !n.startsWith('.'));
  assert.match(readFileSync(join(out, snap, 'Projet/Note.md'), 'utf8'), /title: "Note"[\s\S]*Texte/);

  server.requests.length = 0;
  const second = await cli(['pull', root, '--out', out]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /2 inchangé\(s\)/);
  assert.deepEqual(
    server.requests.filter((r) => r.includes('formatted-content')),
    [],
  );
});
