# docs-cli — spécification

CLI générique pour piloter [Docs](https://docs.numerique.gouv.fr) (La Suite numérique)
à partir de l'**id d'un document** : pousser des fichiers Markdown comme sous-documents,
récupérer un arbre en Markdown, lister, déplacer, renommer, supprimer.

Successeur de [fab-dtnum/docs-search](https://github.com/fab-dtnum/docs-search) (lecture,
instantanés) et de [fab-dtnum/docs-update](https://github.com/fab-dtnum/docs-update)
(écriture). Tout ce qui était propre à un espace Diataxis disparaît : `docs.config.yaml`,
alias, `lint`, `generate`, `sprint`, `cr`, `init`, `link`, `probe`, GitLab, LLM.

## 1. Installation et lancement

Binaire `docs`, installé depuis un clone :

```bash
git clone … docs-cli && cd docs-cli
corepack enable && pnpm install
pnpm exec playwright install firefox
pnpm link --global          # → commande `docs` disponible partout
```

Le TypeScript est exécuté directement par Node (≥ 22.18, sans compilation). Le binaire
pointe vers `src/cli.ts` du clone (et non vers `node_modules`, où Node refuse le TypeScript).

### Fichiers de l'utilisateur

Le binaire est lancé depuis n'importe quel dossier : la configuration et l'état ne
dépendent pas du dossier courant.

| Chemin | Contenu | Droits |
| --- | --- | --- |
| `$DOCS_HOME/.env` | session, jeton CSRF, réglages | 600 |
| `$DOCS_HOME/.auth/` | profil du navigateur de `docs login` | 700 |
| `$DOCS_HOME/state/push.json` | état des push (§4.3) | 600 |

`DOCS_HOME` vaut par défaut `$XDG_CONFIG_HOME/docs-cli`, sinon `~/.config/docs-cli`.
Les variables d'environnement du shell priment sur celles du `.env`.

## 2. Conventions communes

- `<id>` : UUID d'un document, ou son URL Docs complète.
- **Toute commande qui écrit** (`push`, `new`, `mv`, `rename`, `rm`, `prune`) :
  1. calcule puis affiche le **plan** (documents créés, archivés, déplacés, supprimés) ;
  2. avec `--dry-run`, s'arrête là, sans aucune requête d'écriture ;
  3. sinon, demande `Continuer ? [o/N]` ; `--yes` (`-y`) répond oui (scripts, CI). Sans
     terminal (stdin non interactif) et sans `--yes` : refus.
- **Suppression = corbeille** de Docs uniquement (restaurable 30 jours). Aucune purge définitive.
- Chaque document créé est affiché avec son URL.
- Débit : 60 requêtes/min par défaut (Docs en autorise 80 par utilisateur, interface web
  comprise), une seule pause sur `429`, puis arrêt.
- Sécurité réseau reprise telle quelle : HTTPS obligatoire (HTTP seulement vers
  `localhost`), redirections jamais suivies, pagination vers un autre domaine refusée,
  cookie et jeton jamais affichés, proxy d'entreprise (`HTTPS_PROXY`, `NO_PROXY`) et
  certificats du système (`--use-system-ca`).

## 3. Commandes

```
docs login [--browser firefox|chromium]
docs doctor
docs ls <id>
docs tree <id> [--depth N]
docs pull <id> [--out <dossier>] [--force]
docs push <fichier.md|dossier> --parent <id> [--force] [--dry-run] [--yes]
docs prune <id> --before <AAAA-MM-JJ> [--dry-run] [--yes]
docs new <modèle> --parent <id> [--title <titre>] [--var clé=valeur]… [--dry-run] [--yes]
docs mv <id> --to <id-parent> [--dry-run] [--yes]
docs rename <id> <titre> [--dry-run] [--yes]
docs rm <id> [--dry-run] [--yes]
```

### `login`, `doctor`

Reprises de docs-update. `login` ouvre un navigateur Playwright, l'utilisateur se connecte
via ProConnect, le cookie `docs_sessionid` et le jeton `csrftoken` sont écrits dans
`$DOCS_HOME/.env`. `doctor` vérifie le `.env` (droits), la session, le jeton CSRF, le
modèle de documents (`DOCS_TEMPLATES`, s'il est défini) et la version de l'instance.

### `ls`, `tree`

- `ls <id>` : enfants directs (titre, id, date de modification, nombre d'enfants).
- `tree <id>` : arbre complet (ou jusqu'à `--depth`), indenté, avec les ids.

### `pull`

Reprise de `docs-search sync` : instantané Markdown daté de `<id>` et de tous ses
descendants dans `<out>/<id>-AAAA-MM-JJ-HHhMM/` (`--out` par défaut : `./data`).

- **Delta** : un document dont `updated_at` n'a pas changé depuis l'instantané précédent
  (`.docs-cli/manifest.json`) est recopié au lieu d'être retéléchargé ; `--force` retélécharge tout.
- **Reprise** après interruption (journal `.<id>.partial/`).
- Pièces jointes téléchargées, liens internes réécrits en chemins relatifs (coffre Obsidian).
- Contenu lu depuis le Y.js du document quand l'API le fournit, sinon `formatted-content`.

### `push`

Pousse du Markdown sous un document **père** dont l'id ne change jamais.

#### Correspondance fichiers → documents

- `fichier.md` → un sous-document. Titre : champ `title` du front matter YAML s'il existe,
  sinon titre `# …` en tête du fichier (retiré du contenu), sinon nom du fichier sans `.md`.
  Le front matter n'est pas envoyé.
- Les liens relatifs et images locales ne sont pas transférés (Docs ne reçoit que le
  Markdown) : un dossier sans `.md` (pièces jointes d'un `pull`) est ignoré.
- `dossier/` → miroir récursif : chaque `x.md` devient un sous-document ; chaque
  sous-dossier `x/` devient un sous-document `x` dont les enfants sont son contenu,
  avec `x.md` comme contenu s'il existe à côté (même structure que la sortie de `pull`).
  Ordre : alphabétique (tri naturel), dossiers et fichiers mêlés.
- Ignorés : fichiers et dossiers cachés (`.…`), tout ce qui n'est pas `.md`.
- Le titre `Archive` est réservé au premier niveau sous le père : un fichier qui le
  produirait est refusé.
- Un document vide est créé avec `# <titre>` (le convertisseur de Docs refuse un fichier vide).

#### Déroulé

Pour `docs push dossier/ --parent P` :

1. Lecture locale de l'arbre et calcul de son empreinte (§4.3). Si elle est identique à
   celle du dernier push réussi sous `P` et que `--force` est absent : « Rien à pousser », fin.
2. Lecture des enfants de `P`. **Tous** les enfants, sauf `Archive`, seront archivés.
3. Plan affiché, confirmation (§2).
4. Archive : trouver l'enfant `Archive` de `P` ou le créer, puis créer dessous un document
   daté `AAAA-MM-JJ HHhMM` (heure locale ; suffixe ` (2)` si le nom existe déjà).
5. Déplacer chaque enfant à archiver sous ce document daté (`move`, `last-child` : ses
   descendants suivent). Ordre conservé.
6. Créer l'arbre local sous `P`, parents avant enfants.
7. Enregistrer l'empreinte et les ids créés dans l'état (§4.3).

Si `P` n'a aucun enfant hors `Archive`, les étapes 4 et 5 sont sautées (pas d'archive vide).

Pour `docs push fichier.md --parent P` : seul l'enfant de `P` portant **le même titre**
(comparaison sans casse ni espaces superflus) est archivé, de la même façon ; les autres
enfants ne bougent pas. L'empreinte est suivie par couple (père, titre).

#### Échec en cours de route

Les opérations ne sont pas transactionnelles. En cas d'erreur, le CLI s'arrête et
affiche ce qui a été fait (archive créée, documents déplacés, documents créés) avec les
URL ; l'état n'est pas mis à jour, si bien que le push suivant refera un cycle complet
(les documents déjà créés seront archivés comme les autres).

### `prune`

`docs prune <P> --before 2026-01-01` : met à la corbeille, sous `P > Archive`, chaque
archive datée dont la date (lue dans le titre `AAAA-MM-JJ HHhMM`) est **strictement
antérieure** au jour donné. Les documents de `Archive` dont le titre n'a pas ce format ne
sont jamais touchés (ils sont signalés). `<P>` peut aussi être directement le document
`Archive`.

### `new`

Crée un document à partir d'un **modèle** : un enfant du document désigné par
`DOCS_TEMPLATES` (id dans `.env`), dont le titre est le nom du modèle.

- Variables `{{nom}}` dans le titre et le contenu ; `--var clé=valeur` répétable.
  Automatiques : `date` (AAAA-MM-JJ), `heure` (HHhMM), `auteur` (nom de l'utilisateur
  connecté, demandé seulement si utilisé). Erreur listant les variables manquantes.
- Titre : `--title` (variables permises), sinon le premier `# …` du modèle rendu
  (retiré du contenu), sinon erreur.
- Anti-doublon : refus si un enfant du même titre existe sous le parent.
- L'export Markdown de Docs peut échapper `_`, `{`, `}` : la lecture des variables le tolère.

### `mv`, `rename`, `rm`

- `mv <id> --to <parent>` : déplace en dernier enfant (descendants compris). Refus si la
  cible est le document lui-même ou un de ses descendants.
- `rename <id> <titre>`.
- `rm <id>` : corbeille ; le plan indique le nombre de descendants emportés.

## 4. Choix et contraintes

### 4.1 Pas de remplacement du contenu en place

L'API REST de Docs n'accepte pas d'écrire le contenu d'un document existant (il
appartient au serveur de collaboration Y.js) : le contenu n'est fourni qu'à la création,
par import d'un fichier `.md`. D'où l'archivage puis la recréation : l'id du père reste
stable, ceux des sous-documents changent à chaque push.

### 4.2 Création

`POST documents/<parent>/children/` en multipart (`file=<titre>.md`), puis `PATCH` du
titre (Docs prend le nom du fichier comme titre). `DOCS_CREATE_MODE=move` : création à la
racine puis déplacement, pour une instance où le fichier joint à `children/` est ignoré.

### 4.3 État des push

`$DOCS_HOME/state/push.json`, propre au poste, non versionné :

```json
{
  "version": 1,
  "targets": {
    "<id-père>": {
      "hash": "sha256 de l'arbre poussé",
      "pushedAt": "2026-10-16T14:30:00.000Z",
      "source": "/chemin/absolu/du/dossier",
      "archive": "<id du document daté créé à ce push, s'il y en a un>",
      "documents": { "chemin/relatif.md": "<id créé>" }
    },
    "<id-père>#<titre normalisé>": { "…": "push d'un fichier seul" }
  }
}
```

- L'empreinte couvre, pour chaque document, son chemin relatif, son titre et son
  contenu envoyé : renommer, ajouter, supprimer ou modifier un fichier change l'empreinte.
- Seul usage : **sauter un push inchangé**. Elle ne garantit pas que Docs n'a pas été
  modifié entre-temps à la main (un enfant ajouté dans Docs ne déclenche pas de push) ;
  `--force` pousse quand même.
- Absent ou illisible : le push se fait normalement. Aucune commande ne dépend de cet
  état pour décider quoi écrire dans Docs.
- `documents` sert au diagnostic (retrouver l'id d'un fichier poussé), pas à l'écriture.

### 4.4 Ce qui n'est plus là

- Garde d'écriture par liste blanche (`state/ledger.json`) : remplacée par le plan
  affiché, la confirmation, `--dry-run` et la corbeille.
- Recherche plein texte (`docs-search search`) : un `rg` sur le dossier de `pull` suffit.

## 5. Variables d'environnement (`$DOCS_HOME/.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `DOCS_SESSIONID`, `DOCS_CSRFTOKEN` | — | écrits par `docs login` |
| `DOCS_BASE_URL` | `https://docs.numerique.gouv.fr` | instance |
| `DOCS_TEMPLATES` | — | id du document qui contient les modèles (`new`) |
| `DOCS_CREATE_MODE` | `children` | `children` ou `move` (§4.2) |
| `DOCS_RATE_PER_MINUTE` | `60` | débit maximal |
| `DOCS_CONCURRENCY` | `4` | lectures en parallèle (`pull`) |
| `DOCS_BROWSER` | `firefox` | navigateur de `docs login` |
| `HTTPS_PROXY`, `NO_PROXY` | — | proxy d'entreprise |

## 6. Tests

`node --test` contre une fausse API Docs en mémoire (lecture, écriture, déplacement,
corbeille, CSRF, 429), y compris de bout en bout par le binaire : push d'un dossier
(création, archive datée, empreinte inchangée → aucune requête d'écriture, `--force`),
push d'un fichier seul, `prune --before`, `--dry-run` sans écriture, refus sans `--yes`
hors terminal, `new` avec variables, `mv` vers un descendant refusé.
