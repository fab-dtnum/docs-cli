import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { parseMarkdown } from '../local.ts';
import { archiveStamp, parseDay, uniqueTitle } from '../push.ts';

test('titre : front matter, sinon # initial, sinon nom du fichier', () => {
  assert.deepEqual(parseMarkdown('---\ntitle: "Mon titre"\nid: x\n---\n# Autre\n\nCorps', 'f'), {
    title: 'Mon titre',
    markdown: '# Autre\n\nCorps',
  });
  assert.deepEqual(parseMarkdown('---\nid: x\n---\n# Titre H1\n\nCorps', 'f'), {
    title: 'Titre H1',
    markdown: 'Corps',
  });
  assert.deepEqual(parseMarkdown('﻿\n# Titre #\nCorps', 'f'), { title: 'Titre', markdown: 'Corps' });
  assert.deepEqual(parseMarkdown('Intro\n\n# Plus loin', 'fichier'), {
    title: 'fichier',
    markdown: 'Intro\n\n# Plus loin',
  });
  // Une règle horizontale en tête n'est pas un front matter.
  assert.deepEqual(parseMarkdown('---\n- liste\n---\nSuite', 'f'), {
    title: 'f',
    markdown: '---\n- liste\n---\nSuite',
  });
});

test('archives datées : format, unicité, date de prune', () => {
  assert.equal(archiveStamp(new Date(2026, 0, 5, 9, 7)), '2026-01-05 09h07');
  assert.equal(uniqueTitle('2026-01-05 09h07', ['2026-01-05 09h07', '2026-01-05 09h07 (2)']), '2026-01-05 09h07 (3)');
  assert.equal(parseDay('2026-01-01'), '2026-01-01');
  assert.throws(() => parseDay('2026-1-1'), /AAAA-MM-JJ/);
  assert.throws(() => parseDay('2026-02-29'), /AAAA-MM-JJ/);
  assert.throws(() => parseDay(undefined), /AAAA-MM-JJ/);
});
