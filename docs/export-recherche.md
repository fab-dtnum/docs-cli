# `docs export` — recherche et décisions (2026-11-19)

Notes de travail : ce qui a été vérifié, sur quoi, et ce qui reste à faire. Le comportement
visé de la commande est décrit dans le README (« `export` en bref »).

## 1. Décisions prises

**État : `docs export` est implémenté** (`src/export.ts`, `export-content.ts`, `export-pdf.ts`, `zip.ts`),
pour pdf, html et md. docx et odt ne le sont pas (voir section 7).

- Commande **`docs export`**, distincte de `pull` : `pull` est une copie fidèle (datée, delta,
  reprise, manifeste) pour travailler ou chercher dedans ; `export` produit un livrable, sans
  état et sans écriture dans Docs (donc ni plan ni confirmation).
- **Par défaut, le document seul**, comme l'export de l'interface de Docs (dont les sous-documents
  ne sont que des liens). `--merge` : un fichier avec les descendants (titres par profondeur) ;
  `--split` : un zip avec un fichier par document, arborescence de `pull` (un document avec enfants est
  un fichier ET un dossier du même nom). Décision du 2026-11-19 (« fais comme eux ») ; elle remplace
  « fusion par défaut ».
- `--depth N`, `--out <dossier>` (défaut `./export`), `--force`, `--dry-run` (arbre et nombre de
  documents, rien de téléchargé ni écrit).
- Source : HTML de l'API (`formatted-content`), PDF imprimé par Chromium via Playwright, JavaScript et
  réseau coupés. Aucune dépendance ajoutée ; le zip est écrit sans bibliothèque (`node:zlib`).
- L'export signale ce qu'il ne peut pas rendre (images hors Docs, introuvables, documents en erreur ;
  code de sortie 1) ; pour Mermaid et les formules, aucune trace n'existe côté API (section 8).

## 2. Ce que fait l'interface de Docs (lu dans le code source)

Dépôt `suitenumerique/docs`, licence MIT, commit `0f8e7b3` du 2026-11-18. Chemins sous
`src/frontend/apps/impress/src/features/docs/doc-export/` sauf mention.

- **Aucun endpoint serveur d'export.** Le serveur n'offre que
  `GET /documents/<id>/formatted-content/?content_format=json|markdown|html`
  (`src/backend/core/api/viewsets.py:2644`). Le contenu vient du serveur de collaboration
  (`y-provider`), converti en blocs BlockNote.
- **pdf, docx, odt sont produits dans le navigateur** (`hooks/useExportXL.tsx`) avec les
  exporteurs BlockNote 0.57.0 : `@blocknote/xl-pdf-exporter`, `xl-docx-exporter`,
  `xl-odt-exporter`. Docs y ajoute ses correspondances de blocs : `mappingPDF.ts`,
  `mappingDocx.tsx`, `mappingODT.ts`, `blocks-mapping/`, `inline-content-mapping/`.
- **Le PDF est composé avec Typst** (compilé en WebAssembly), pas avec react-pdf.
- **md (zip) et html (zip)** sont assemblés dans `components/ModalExport.tsx` avec JSZip,
  médias embarqués.
- **L'export natif n'inclut PAS le contenu des sous-documents** : `utils_doc_children.ts`
  (`expandDocChildrenBlocks`) remplace le bloc `docChildren` par un paragraphe de **liens**
  vers chaque sous-document. Le PDF de A contient donc les titres de B, pas leur contenu. La
  fusion de A, B, C1, C2 en un seul fichier est une fonction propre à `docs export`.
- Ce qui a besoin d'un navigateur (le reste tourne en Node) :
  - diagrammes Mermaid (`exporterPDF.ts` : mise en page et mesure des étiquettes dans le
    navigateur) et conversion des images SVG par un `canvas` (`utils.ts`) ;
  - avatars de mentions (`userMentionAvatar.ts`, canvas) : le code prévoit l'absence de
    canvas, les mentions sortent sans avatar ;
  - enregistrement des polices dans le navigateur (`typeof FontFace`), inutile en Node ;
  - `utils_print.ts` (impression) ne concerne pas pdf/docx/odt.
- `docsBlockNoteSchema` (schéma de Docs) : `y-provider/src/blockSpecs/index.ts`. Blocs en plus
  du schéma BlockNote par défaut : `callout`, `docChildren`, `pdf`, `uploadLoader`, et le
  contenu en ligne `interlinkingLinkInline` ; `diagram` et `mathBlock` viennent de
  `@blocknote/diagram-block` et `@blocknote/math-block`.

## 3. Ce que dit l'instance (docs.numerique.gouv.fr)

- `GET /api/v1.0/config/` (public) : aucun réglage d'export.
  `CONVERSION_FILE_EXTENSIONS_ALLOWED: [".docx", ".md"]` concerne l'**import** (`push`).
- Pas de schéma OpenAPI public (`/api/v1.0/swagger.json` : 404).
- Réponse réelle de `formatted-content?content_format=json` sur un document de test :
  ```json
  { "id": "…", "title": "…", "content": [ <blocs> ], "created_at": "…", "updated_at": "…" }
  ```
  Les blocs sont **complets** (`props` : `backgroundColor`, `textColor`, `textAlignment`,
  `level`, `isToggleable`, etc.), exactement ce que demandent les exporteurs. Types vus :
  `heading`, `paragraph`, `bulletListItem`, `toggleListItem` (avec enfants), `callout`,
  `codeBlock`.
- La session se crée avec `docs login` ; le cookie est `docs_sessionid`.

## 4. Prototype Node (PDF)

Installé dans un dossier temporaire : `nodejs-24` (apt, dépôt DHI), `npm` (apt), puis
`@blocknote/core`, `server-util`, `xl-docx-exporter`, `xl-odt-exporter`, `xl-pdf-exporter`
en **0.57.0** (la version épinglée par Docs).

Résultats sur un document d'essai (titres, gras/italique, lien, listes imbriquées, citation,
code, tableau) : **pdf, docx et odt** sont produits en Node, le texte relu dans chaque
fichier avec `pypdf`, `python-docx` et le `content.xml` de l'ODT. Le rendu visuel n'a pas été
contrôlé.

### Code PDF qui fonctionne (Node ESM natif, sans empaquetage)

```js
import { BlockNoteSchema } from '@blocknote/core';
import { PDFExporter, typstDefaultSchemaMappings } from '@blocknote/xl-pdf-exporter';
import { readFileSync, writeFileSync } from 'node:fs';

const wasm = readFileSync(
  new URL('./node_modules/@blocknote/xl-typst-compiler/pkg/blocknote_typst_wasm_bg.wasm', import.meta.url),
);
const r = await new PDFExporter(BlockNoteSchema.create(), typstDefaultSchemaMappings, { wasm }).toPDF(blocks, {
  title,
  lang: 'fr',
}); // 'fr' et non 'fr-FR' : Typst refuse la région
if (r.error) throw new Error(r.compileErrors.map((e) => e.message).join());
writeFileSync('sortie.pdf', r.bytes);
```

### Pièges rencontrés

1. **`wasm` à fournir explicitement.** Sans l'option, `fetch failed` : `fetch` de Node ne lit
   pas les URL `file://`. On passe les octets du fichier `.wasm` du paquet `xl-typst-compiler`.
   Les polices (Inter, Geist Mono, NewCM Math, Noto emoji) sont **embarquées** dans le paquet
   PDF : aucun téléchargement.
2. **docx ne se charge pas en ESM natif** : le paquet `buffer` est importé comme un dossier,
   refusé par Node (`Directory import … is not supported`). Contournement : empaquetage
   esbuild. Le CLI s'exécute sans empaquetage (`node src/cli.ts`) : **décision à prendre au
   moment de docx** (bundle précompilé ou résolveur de modules). Le **PDF n'est pas concerné**
   (testé en ESM natif).
3. **Blocs complets obligatoires** (`textAlignment`, `start`, cellules de tableau
   `{ type: 'tableCell', props: {…}, content: […] }` et `columnWidths`) : sinon
   `Cannot read properties of undefined`. L'API les fournit.
4. **Bloc inconnu = échec.** Avec le schéma par défaut, le bloc `callout` donne :
   `Exporter is missing a block mapping for block type "callout"`. Il faut le schéma et les
   mappings de Docs (voir ci-dessous). Les blocs standard, y compris `toggleListItem`, passent.
5. L'ODT émet des avertissements React (`key` manquantes, `xlink:*`) : sans effet sur le fichier.

## 5. Reste à faire pour le PDF

> **Abandonné** (voir section 7) : cette section décrivait la voie BlockNote XL (Typst), exclue pour
> cause de licence GPL. Les fichiers repris de Docs (`src/export/docs-upstream/`,
> `THIRD_PARTY_NOTICES.md`, `scripts/docs-upstream-diff.mjs`) ont été supprimés. Le prototype avait
> montré que le callout et les tableaux se rendaient correctement avec les mappings de Docs.

1. **Schéma et mappings de Docs** : reprendre `docsBlockNoteSchema` (ou une version réduite)
   et `getPdfDocsSchemaMappings` (`mappingPDF.ts`). Le `callout` se met en page par
   `blocks-mapping/calloutPDF.ts` (grille emoji + contenu). `docChildren` : sans objet pour
   nous (on traite les sous-documents nous-mêmes). `pdf` : correspondance du bloc `file`.
   Les mappings importent des alias du frontend (`@/cunningham`, couleurs du thème) : à
   recopier en constantes.
2. **Médias** : `resolveFileUrl` pour les images et pièces jointes (Docs passe par
   `exportCorsResolveFileUrl`) ; ici, téléchargement avec la session, comme `pull`.
3. **Fusion des sous-documents** : concaténer les blocs de A, B, C1, C2 dans l'ordre de
   l'arbre, titres décalés d'un niveau par profondeur ; gérer les interliens
   (`interlinkingLinkInline`, titres à résoudre).
4. **Export partiel** : lister, par document, les blocs non rendus (Mermaid/SVG, blocs sans
   mapping) ; rendu de ces blocs par Playwright (déjà requis) dans un second temps.
5. **`--dry-run`** : arbre et compteurs à partir de `listChildren` (aucun contenu téléchargé).
6. `md` et `html` s'appuient sur l'API existante (`content_format=markdown|html`) ; docx et
   odt viennent après le PDF.
7. Tests contre la fausse API (`src/test/fake-docs.ts`), à étendre avec `formatted-content`
   au format JSON.

## 6. Questions ouvertes

- Dépendances : les exporteurs BlockNote (et `typst`) sont lourds ; à ajouter en
  `dependencies` exactes, épinglées sur la version de Docs (0.57.0) pour garder le même rendu.
- Épingler la version de BlockNote : à resynchroniser quand Docs monte de version.
- Diagrammes Mermaid et SVG : navigateur headless (Playwright) ou dégradation signalée.

## 7. Licences des exporteurs BlockNote (bloquant, à trancher)

Constaté le 2026-11-19, avant d'ajouter les dépendances :

- `@blocknote/core` : **MPL-2.0** (copyleft au niveau du fichier, utilisable dans un projet MIT).
- `@blocknote/xl-pdf-exporter`, `xl-typst-exporter`, `xl-typst-compiler` (et `xl-docx-exporter`,
  `xl-odt-exporter`) : **GPL-3.0 OR PROPRIETARY**. Le fichier `LICENSE` du paquet précise :
  GPL-3.0, avec une licence commerciale disponible (<https://www.blocknotejs.org/pricing>).
- Le README de Docs le dit lui-même : ces paquets « ne sont **pas compatibles MIT** » ; Docs
  prévoit un mode `PUBLISH_AS_MIT=true` qui construit l'image sans l'export PDF.
- Ce dépôt est sous licence MIT. Dépendre d'un paquet GPL-3.0 pour produire le PDF pose donc une
  question de licence (distribution d'une œuvre combinée), à faire valider par l'organisation
  (DGFiP) avant d'aller plus loin. Le prototype des sections 4 et 5 repose sur ces paquets.
- Aucune dépendance n'a été ajoutée à `package.json` à cause de cela.

Pistes sans paquet GPL : PDF via le HTML du serveur (`content_format=html`) imprimé par
Playwright (déjà requis, Apache-2.0) ; docx/odt avec d'autres bibliothèques ou un outil externe.

### Décision (2026-11-19)

Le dépôt reste en MIT. **`docs export` passe par le HTML de l'API** (`formatted-content/?content_format=html`,
où le callout devient un `<aside>`), imprimé en PDF par **Playwright** (déjà requis). Mermaid et SVG sont
rendus par le navigateur. Aucune dépendance GPL, aucun code de Docs repris pour l'instant. Si du code de
Docs est repris plus tard, retracer ici la source, le commit amont et la licence (MIT, © 2023 DINUM).
Politique de dépendances : voir le gist cité dans `pnpm-workspace.yaml`.

## 8. Ce que renvoie réellement `formatted-content` (échantillon du 2026-11-19)

Document de test avec, sous des titres de repère : liste repliable, image SVG, diagramme Mermaid,
callout, code, formule. Réponses `content_format=html` et `json` comparées :

- **Présents** : titres, puces, listes repliables (`<details open>`), image SVG
  (`<img src="https://…/media/<id>/attachments/<uuid>.svg">`, URL absolue qui demande la session),
  callout (`<aside role="note" data-emoji data-background-color>`), code (`<pre data-language>`).
- **Absent : le diagramme Mermaid.** Le titre « Schéma mermaid » est suivi directement du titre suivant,
  sans aucun bloc entre les deux : le serveur l'a supprimé sans trace. Cohérent avec le schéma de
  `y-provider/src/blockSpecs/index.ts` (commit amont 0f8e7b3), qui ne déclare ni `diagram` ni `mathBlock`
  alors que l'éditeur les déclare (`BlockNoteEditor.tsx:106-108`).
- **Formule** : sous « Formule », seulement des paragraphes vides (dont un contenant une espace) ;
  non concluant (bloc supprimé ou formule en ligne ?).
- Pas de Y.js accessible : `GET /documents/<id>/` ne renvoie pas `content` ; le Y.js est tenu par le
  service yhub, qu'aucun endpoint REST ne rend. `formatted-content` est donc la seule source, et il ne
  peut pas restituer ce que le serveur supprime.
- Détails du HTML : fragment sans `<html>` ; paragraphes vides = `<p>￼</p>` (U+FFFC, à retirer) ;
  images en URL absolue authentifiée (à télécharger avec la session et intégrer en `data:`).
- Conséquence : **Mermaid (et probablement les formules) ne peuvent pas être exportés** tant que Docs
  ne les ajoute pas au schéma du serveur. L'export ne peut pas non plus signaler leur absence (aucune
  trace). Le SVG, lui, passe. À signaler en amont (suitenumerique/docs) et à documenter dans le README.
