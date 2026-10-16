# docs-cli

Piloter [Docs](https://docs.numerique.gouv.fr) (La Suite numérique) en ligne de commande, à
partir de l'id d'un document : pousser des fichiers Markdown comme sous-documents (avec
archive datée des versions précédentes), récupérer un arbre en Markdown, lister, déplacer,
renommer, supprimer.

Comportement détaillé et choix de conception : [SPEC.md](SPEC.md).

## Installation

Prérequis : [Vite+](https://viteplus.dev) (`brew install vite-plus`, ou
`curl -fsSL https://vite.plus | bash`), avec le mode géré activé (`vp env on`) : `vp`
choisit alors les versions exactes de Node et de pnpm épinglées dans `package.json`.
[gitleaks](https://github.com/gitleaks/gitleaks) pour contribuer.

```bash
vp install                          # dépendances (pnpm, version épinglée)
vp exec playwright install firefox  # navigateur de `docs login`
vp add -g "$PWD"                    # → commande `docs` (lien vers ce clone)
docs login
docs doctor
```

`docs` est un lien vers `src/cli.ts` de ce clone, exécuté par le Node épinglé : un `git pull`
suffit pour mettre à jour. Le dossier des binaires de Vite+ (`~/.local/share/vite-plus/bin`)
doit être dans le `PATH` (`vp env setup`). Désinstallation : `vp remove -g docs-cli`.
Session, profil du navigateur et état des push vont dans `~/.config/docs-cli/`
(`DOCS_HOME` pour en changer), pas dans le dossier courant.

### Pourquoi Playwright ?

Uniquement pour `docs login` ; toutes les autres commandes appellent l'API de Docs
directement depuis Node.

- Docs se connecte via ProConnect (redirections, double authentification éventuelle,
  formulaire du fournisseur d'identité) : pas de connexion par mot de passe depuis un script.
- `docs login` ouvre donc une vraie fenêtre de navigateur, vous vous connectez vous-même
  (le script ne voit pas vos identifiants), puis il récupère les cookies `docs_sessionid`
  et `csrftoken` et les écrit dans `~/.config/docs-cli/.env`.
- Le profil du navigateur est conservé (`~/.config/docs-cli/.auth/`) : quand la session
  (12 h) expire, la reconnexion est souvent immédiate.
- Sans Playwright : connectez-vous à Docs dans votre navigateur habituel, puis recopiez les
  deux cookies dans le `.env` (voir [Dépannage](#dépannage)).

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

**Certificat HTTPS non reconnu** : le binaire charge les certificats du système (comme `--use-system-ca`) ; installez le
certificat racine de l'organisation, ou `NODE_EXTRA_CA_CERTS=/chemin/ca.pem`. Ne désactivez
jamais la vérification.

**Connexion impossible dans le navigateur de Playwright** : recopiez les cookies
`docs_sessionid` et `csrftoken` de votre navigateur dans le `.env`.

**Écriture refusée (CSRF)** : `docs login`.

**Document créé vide** : `DOCS_CREATE_MODE=move`.

## Développement

```bash
vp check   # format, lint, types
vp test
vp run ready   # les deux, avant de livrer
```

Les tests tournent contre une fausse API Docs en mémoire (`src/test/fake-docs.ts`).
