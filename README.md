# docs-cli

Piloter [Docs](https://docs.numerique.gouv.fr) (La Suite numérique) en ligne de commande, à
partir de l'id d'un document : pousser des fichiers Markdown comme sous-documents (avec
archive datée des versions précédentes), récupérer un arbre en Markdown, lister, déplacer,
renommer, supprimer.

Comportement détaillé et choix de conception : [SPEC.md](SPEC.md).

## Installation

Prérequis : Node ≥ 22.18 (24 recommandé, voir `.nvmrc`), [gitleaks](https://github.com/gitleaks/gitleaks) pour contribuer.

```bash
corepack enable
pnpm install
pnpm exec playwright install firefox
pnpm link --global
docs login
docs doctor
```

`docs` exécute directement `src/cli.ts` de ce clone : un `git pull` suffit pour mettre à jour.
Session, profil du navigateur et état des push vont dans `~/.config/docs-cli/`
(`DOCS_HOME` pour en changer), pas dans le dossier courant.

## Utilisation

```bash
docs ls <id>                                  # sous-documents directs
docs tree <id> --depth 2
docs pull <id> --out ./data                   # instantané Markdown daté, delta seulement
docs push ./notes --parent <id> --dry-run     # plan : ce qui sera archivé et créé
docs push ./notes --parent <id>               # confirmation, puis archive + création
docs push rapport.md --parent <id> --yes      # un fichier : seul l'homonyme est archivé
docs prune <id> --before 2026-01-01           # archives datées antérieures → corbeille
docs new cr --parent <id> --var sujet="Copil" # modèle (enfant de DOCS_TEMPLATES)
docs mv <id> --to <id> | docs rename <id> "Titre" | docs rm <id>
```

`<id>` : UUID ou URL complète du document.

### `push` en bref

```
Père (id fixe)
├── Archive
│   ├── 2026-10-15 09h12   ← anciens sous-documents, avec leurs enfants
│   └── 2026-10-16 14h30
├── a                      ← a.md
└── b                      ← b.md (contenu) + b/ (enfants)
```

- Titre : `title` du front matter, sinon `# …` en tête du fichier, sinon nom du fichier.
- Push identique au précédent (même empreinte) : rien n'est fait ; `--force` pour forcer.
- Toute écriture affiche son plan et demande confirmation ; `--dry-run` n'écrit rien,
  `--yes` ne demande rien. Suppression = corbeille Docs (30 jours).

## Configuration (`~/.config/docs-cli/.env`)

Voir [.env.example](.env.example). `DOCS_SESSIONID` et `DOCS_CSRFTOKEN` sont remplis par
`docs login`. `DOCS_TEMPLATES` : id du document dont les enfants sont les modèles de `docs new`.

## Dépannage

**Proxy d'entreprise** : `HTTPS_PROXY` / `NO_PROXY` dans le shell ou le `.env` (Node ≥ 24.14,
sinon `NODE_USE_ENV_PROXY=1`).

**Certificat HTTPS non reconnu** : le binaire lance Node avec `--use-system-ca` ; installez le
certificat racine de l'organisation, ou `NODE_EXTRA_CA_CERTS=/chemin/ca.pem`. Ne désactivez
jamais la vérification.

**Connexion impossible dans le navigateur de Playwright** : recopiez les cookies
`docs_sessionid` et `csrftoken` de votre navigateur dans le `.env`.

**Écriture refusée (CSRF)** : `docs login`.

**Document créé vide** : `DOCS_CREATE_MODE=move`.

## Développement

```bash
pnpm typecheck && pnpm test
```

Les tests tournent contre une fausse API Docs en mémoire (`src/test/fake-docs.ts`).
