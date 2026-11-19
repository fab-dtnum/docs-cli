import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { config } from '../config.ts';
import { cleanHtml, relinkDocs, shiftHeadings, shiftMarkdownHeadings } from '../export-content.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OUT = '33333333-3333-4333-8333-333333333333';
const known = new Set([A, B]);
const url = (id: string) => `${config.baseUrl}/docs/${id}/`;

test('relinkDocs : lien interne (data-doc-id ou URL) vers un document de l’export → ancre', () => {
  const html =
    `<p><a href="${url(A)}" data-doc-id="${A}" title="A">A</a> ` + `<a href="${url(B)}#bloc-12" class="x">B</a></p>`;
  const r = relinkDocs(html, known);
  assert.equal(r.relinked, 2);
  assert.equal(
    r.html,
    `<p><a href="#doc-${A}" data-doc-id="${A}" title="A">A</a> <a href="#doc-${B}" class="x">B</a></p>`,
  );
});

test('relinkDocs : document hors export, autre site, ids forgés → liens inchangés', () => {
  const html = [
    `<a href="${url(OUT)}" data-doc-id="${OUT}">hors export</a>`,
    `<a href="https://autre.example/docs/${A}/">autre site</a>`,
    `<a href="https://example.org">externe</a>`,
    `<a href="/docs/${A}/x">chemin plus long</a>`,
    `<a href="${url(A)}" data-doc-id="${A}&quot; onclick=&quot;x">forgé</a>`,
    `<a>sans href</a>`,
  ].join('');
  const r = relinkDocs(html, known);
  // Le dernier lien est reconnu par son URL (id connu) mais son attribut forgé n'est jamais recopié dans une ancre.
  assert.equal(r.relinked, 1);
  assert.equal(r.html.match(/href="#doc-[0-9a-f-]+"/g)?.length, 1);
  for (const kept of [url(OUT), `https://autre.example/docs/${A}/`, 'https://example.org', `/docs/${A}/x`]) {
    assert.ok(r.html.includes(`href="${kept}"`), kept);
  }
  assert.doesNotMatch(r.html, /href="#doc-[^"]*[^0-9a-f"-]/);
});

test('cleanHtml : paragraphes vides marqués, U+FFFC retiré', () => {
  assert.equal(cleanHtml('<p>￼</p><p class="a">ok￼</p>'), '<p class="blank"></p><p class="a">ok</p>');
});

test('shiftHeadings et shiftMarkdownHeadings : décalage plafonné à 6, code ignoré', () => {
  assert.equal(shiftHeadings('<h1 data-level="1">a</h1><h5>b</h5>', 2), '<h3 data-level="1">a</h3><h6>b</h6>');
  assert.equal(shiftHeadings('<h1>a</h1>', 0), '<h1>a</h1>');
  const md = '# Titre\n\n```sh\n# commentaire\n```\n\n###### six\ntexte # pas titre\n';
  assert.equal(
    shiftMarkdownHeadings(md, 1),
    '## Titre\n\n```sh\n# commentaire\n```\n\n###### six\ntexte # pas titre\n',
  );
});
