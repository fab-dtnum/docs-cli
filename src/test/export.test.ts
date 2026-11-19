import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll as after, beforeAll as before, test } from 'vite-plus/test';
import { cli } from './cli.ts';
import { type FakeServer, startFakeDocs, testEnv } from './fake-docs.ts';
import { unzip } from './zip.ts';

let server: FakeServer;
let tmp: string;
let root: string;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

before(async () => {
  server = await startFakeDocs();
  tmp = mkdtempSync(join(tmpdir(), 'docs-cli-export-'));
  testEnv(server.url, { home: join(tmp, 'home'), data: join(tmp, 'data') });
  root = server.seed({
    title: 'Dossier',
    children: [
      {
        title: 'Étude',
        markdown: '# Étude\n\nTexte',
        html: '<h1>Étude</h1><p>texte étude</p>',
        children: [{ title: 'Annexe', html: '<p>annexe</p>' }],
      },
      { title: 'Notes', markdown: 'Notes\n', html: '<p>notes</p>' },
    ],
  });
  const media = `/media/${root}/attachments/logo.png`;
  const doc = server.docs.get(root)!;
  doc.markdown = `# Titre\n\n![logo](${media})\n`;
  doc.html =
    `<h1>Titre</h1><p>￼</p><img src="${server.url}${media}" alt="logo" data-name="logo.png" data-url="${server.url}${media}">` +
    `<img><img src="https://evil.example/x.png" alt="externe"><p>fin</p>`;
  server.media.set(media, { type: 'image/png', data: PNG });
});
after(() => server.close());

const out = (name: string) => join(tmp, name);
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

test('--dry-run : arbre et nombre de documents, aucun contenu demandé, aucun fichier', async () => {
  const before = server.requests.length;
  const r = await cli(['export', root, '--merge', '--format', 'html', '--out', out('dry'), '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dossier .*\n├── Étude .*\n│   └── Annexe .*\n└── Notes /);
  assert.match(r.stdout, /4 document\(s\) seraient téléchargés/);
  assert.equal(existsSync(out('dry')), false);
  assert.equal(server.requests.slice(before).filter((q) => q.includes('formatted-content')).length, 0);
  const single = await cli(['export', root, '--dry-run']);
  assert.match(single.stdout, /1 document\(s\) seraient téléchargés/);
  assert.match(single.stdout, /2 sous-document\(s\), non inclus : --merge/);
});

test('html, document seul : image intégrée, vide et externe écartées, page sans script ni réseau', async () => {
  const r = await cli(['export', root, '--format', 'html', '--out', out('single')]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out('single')), ['Dossier.html']);
  const html = read(out('single'), 'Dossier.html');
  assert.match(html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="logo" data-name="logo.png">/);
  assert.doesNotMatch(html, /￼/);
  assert.match(html, /<p class="blank"><\/p>/);
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /export-missing">\[Image non exportée : externe \(hébergée hors de Docs\)\]/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  assert.doesNotMatch(html, /Étude/, 'les sous-documents ne sont pas inclus');
  assert.match(r.stdout, /1 image\(s\) non exportée\(s\)/);
  assert.match(r.stdout, /2 sous-document\(s\), non inclus/);
  assert.match(r.stdout, /ni les formules/);
  assert.equal(statSync(join(out('single'), 'Dossier.html')).mode & 0o777, 0o600);
});

test('html --merge : titres par profondeur, titres des documents décalés', async () => {
  const r = await cli(['export', root, '--merge', '--format', 'html', '--out', out('merge')]);
  assert.equal(r.status, 0, r.stderr);
  const html = read(out('merge'), 'Dossier.html');
  assert.match(html, /<h1 class="doc-title">Dossier<\/h1>/);
  assert.match(html, /<h2 class="doc-title">Étude<\/h2>/);
  assert.match(html, /<h3 class="doc-title">Annexe<\/h3>/);
  assert.match(html, /<h2>Titre<\/h2>/);
  assert.match(html, /<h3>Étude<\/h3>/);
  assert.ok(html.indexOf('Annexe') < html.indexOf('>Notes<'), 'ordre de l’arbre');
  assert.match(r.stdout, /4 document\(s\) exporté\(s\) : 1 document \+ 3 sous-document\(s\)/);
});

test('html --split : un zip, un fichier par document, arborescence comme pull', async () => {
  const r = await cli(['export', root, '--split', '--format', 'html', '--out', out('split')]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out('split')), ['Dossier.zip']);
  const files = unzip(readFileSync(join(out('split'), 'Dossier.zip')));
  assert.deepEqual(
    [...files.keys()],
    ['Dossier.html', 'Dossier/Étude.html', 'Dossier/Étude/Annexe.html', 'Dossier/Notes.html'],
  );
  const etude = files.get('Dossier/Étude.html')!.toString();
  assert.match(etude, /texte étude/);
  assert.doesNotMatch(etude, /doc-title/, 'chaque fichier est un document autonome, sans titre ajouté');
});

test('--depth limite les sous-documents', async () => {
  const r = await cli(['export', root, '--merge', '--depth', '1', '--format', 'html', '--out', out('depth')]);
  assert.equal(r.status, 0, r.stderr);
  const html = read(out('depth'), 'Dossier.html');
  assert.match(html, /Étude/);
  assert.doesNotMatch(html, /Annexe/);
});

test('md : document seul avec pièce jointe → zip ; sans pièce jointe → fichier .md', async () => {
  const r = await cli(['export', root, '--format', 'md', '--out', out('md')]);
  assert.equal(r.status, 0, r.stderr);
  const files = unzip(readFileSync(join(out('md'), 'Dossier.zip')));
  assert.deepEqual([...files.keys()], ['Dossier.md', 'media/logo.png']);
  assert.match(files.get('Dossier.md')!.toString(), /!\[logo\]\(<media\/logo\.png>\)/);
  assert.deepEqual(files.get('media/logo.png'), PNG);

  const notes = server.findChild(root, 'Notes')!.id;
  const plain = await cli(['export', notes, '--format', 'md', '--out', out('md')]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(read(out('md'), 'Notes.md'), 'Notes\n');
});

test('md --merge : titres de document et décalage des titres', async () => {
  const etude = server.findChild(root, 'Étude')!.id;
  const r = await cli(['export', etude, '--merge', '--format', 'md', '--out', out('mdmerge')]);
  assert.equal(r.status, 0, r.stderr);
  const md = read(out('mdmerge'), 'Étude.md');
  assert.match(md, /^# Étude\n\n## Étude\n\nTexte\n/);
  assert.match(md, /\n## Annexe\n/);
});

test('md --split : les liens vers les pièces jointes restent relatifs au fichier', async () => {
  const doc = server.docs.get(server.findChild(root, 'Étude')!.id)!;
  doc.markdown = `# Étude\n\n![logo](/media/${root}/attachments/logo.png)\n`;
  const r = await cli(['export', doc.id, '--split', '--format', 'md', '--out', out('mdsplit')]);
  assert.equal(r.status, 0, r.stderr);
  const files = unzip(readFileSync(join(out('mdsplit'), 'Étude.zip')));
  assert.deepEqual([...files.keys()].sort(), ['media/logo.png', 'Étude.md', 'Étude/Annexe.md']);
  assert.match(files.get('Étude.md')!.toString(), /\(<media\/logo\.png>\)/);
});

test('fichier existant : nouvelle version numérotée, options invalides', async () => {
  const again = await cli(['export', root, '--format', 'html', '--out', out('single')]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /\(1\)\.html/);
  const third = await cli(['export', root, '--format', 'html', '--out', out('single')]);
  assert.match(third.stdout, /\(2\)\.html/);

  assert.match(
    (await cli(['export', root, '--depth', '1'])).stderr,
    /--depth ne s'applique qu'avec --merge ou --split/,
  );
  assert.match((await cli(['export', root, '--merge', '--split'])).stderr, /incompatibles/);
  assert.match((await cli(['export', root, '--format', 'docx'])).stderr, /Format inconnu : docx/);
  assert.match((await cli(['export', root, '--merge', '--depth', 'x'])).stderr, /--depth attend un entier/);
});

test('--merge : un lien vers un document de l’export mène à sa section ; --split et seul : inchangé', async () => {
  const etude = server.findChild(root, 'Étude')!;
  const notes = server.findChild(root, 'Notes')!;
  const link = (id: string) => `<a href="${server.url}/docs/${id}/" data-doc-id="${id}" title="x">vers</a>`;
  const outside = '99999999-9999-4999-8999-999999999999';
  etude.html = `<h1>Étude</h1><p>${link(notes.id)} et ${link(outside)}</p>`;

  const merged = await cli(['export', root, '--merge', '--format', 'html', '--out', out('links')]);
  assert.equal(merged.status, 0, merged.stderr);
  const html = read(out('links'), 'Dossier.html');
  assert.match(html, new RegExp(`<section class="doc" id="doc-${notes.id}">`));
  assert.match(html, new RegExp(`<a href="#doc-${notes.id}" data-doc-id="${notes.id}"`));
  assert.ok(html.includes(`href="${server.url}/docs/${outside}/"`), 'document absent de l’export : lien vers Docs');
  assert.match(merged.stdout, /1 lien\(s\) vers un autre document de l'export relié\(s\) dans le fichier/);

  const split = await cli(['export', root, '--split', '--format', 'html', '--out', out('links')]);
  assert.equal(split.status, 0, split.stderr);
  const page = unzip(readFileSync(join(out('links'), 'Dossier.zip')))
    .get('Dossier/Étude.html')!
    .toString();
  assert.ok(page.includes(`href="${server.url}/docs/${notes.id}/"`), '--split : le lien mène toujours à Docs');
  assert.doesNotMatch(split.stdout, /relié/);
});

const hasChromium = Boolean(process.env.DOCS_CHROME_PATH) || existsSync(chromium.executablePath());

test.skipIf(!hasChromium)('pdf : document seul, fusionné, et zip de PDF', async () => {
  const single = await cli(['export', root, '--out', out('pdf')]);
  assert.equal(single.status, 0, single.stderr);
  assert.equal(
    readFileSync(join(out('pdf'), 'Dossier.pdf'))
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );

  const merged = await cli(['export', root, '--merge', '--out', out('pdfmerge')]);
  assert.equal(merged.status, 0, merged.stderr);
  assert.ok(statSync(join(out('pdfmerge'), 'Dossier.pdf')).size > 1000);

  const split = await cli(['export', root, '--split', '--out', out('pdfsplit')]);
  assert.equal(split.status, 0, split.stderr);
  const files = unzip(readFileSync(join(out('pdfsplit'), 'Dossier.zip')));
  assert.deepEqual(
    [...files.keys()],
    ['Dossier.pdf', 'Dossier/Étude.pdf', 'Dossier/Étude/Annexe.pdf', 'Dossier/Notes.pdf'],
  );
  for (const data of files.values()) assert.equal(data.subarray(0, 5).toString(), '%PDF-');
});
