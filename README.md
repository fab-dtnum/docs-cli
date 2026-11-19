# docs-cli

Piloter [Docs](https://docs.numerique.gouv.fr) (La Suite numérique) en ligne de commande, à
partir de l'id d'un document : pousser des fichiers Markdown comme sous-documents (avec
archive datée des versions précédentes), récupérer un arbre en Markdown, lister, déplacer,
renommer, supprimer.

> [!WARNING]
> Outil **non officiel**, qui utilise l'API interne de l'interface web de Docs, non garantie par
> la DINUM. À lire avant usage : [Usage responsable](#usage-responsable).

Comportement détaillé et choix de conception : [SPEC.md](SPEC.md).

## Installation

Prérequis : [Vite+](https://viteplus.dev) (`brew install vite-plus`, ou
`curl -fsSL https://vite.plus | bash`), avec le mode géré activé (`vp env on`) : `vp`
choisit alors les versions exactes de Node et de pnpm épinglées dans `package.json`.
[gitleaks](https://github.com/gitleaks/gitleaks) pour contribuer.

```bash
vp install                          # dépendances (pnpm, version épinglée)
vp exec playwright install firefox  # navigateur de `docs login`
vp exec playwright install chromium # seulement pour `docs export` en PDF
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

Pour `docs login` et pour le PDF de `docs export` (Chromium imprime la page HTML) ; toutes
les autres commandes appellent l'API de Docs directement depuis Node.

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
docs export <id>                              # PDF du document seul, dans ./export
docs export <id> --merge --format pdf         # un PDF avec ses sous-documents
docs export <id> --split --format html        # un zip : un fichier par document
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
- Images locales (`![…](schemas/x.png)`, sous le dossier poussé) : envoyées en pièces
  jointes du père, puis référencées depuis le document ; une image inchangée n'est pas
  renvoyée. png, jpg, gif, webp, svg ; 10 Mo au plus.
- Citation contenant une liste (`> - …`) : rendue en contenu ordinaire, car une citation de
  Docs ne contient que du texte (les puces y seraient fusionnées).
- Push identique au précédent (même empreinte) : rien n'est fait ; `--force` pour forcer.
- Toute écriture affiche son plan et demande confirmation ; `--dry-run` n'écrit rien,
  `--yes` ne demande rien. Suppression = corbeille Docs (30 jours).

### `export` en bref

`docs export <id> [--format pdf|html|md]` exporte un document hors de Docs (lecture seule :
aucun état gardé, rien n'est écrit dans Docs, donc ni plan ni confirmation). À la différence de
`pull` (copie Markdown fidèle, datée, avec delta, pour travailler ou chercher dedans), c'est un
livrable. Format par défaut : `pdf`.

Comme l'export de l'interface de Docs, **le document est exporté seul** : ses sous-documents n'y
figurent pas. Deux options les ajoutent :

- `--merge` : un seul fichier réunit le document et ses descendants, dans l'ordre de l'arbre.
  Chaque document est précédé de son titre (niveau selon la profondeur) et ses propres titres
  sont décalés d'autant, pour que l'ensemble se lise comme un seul plan. Un lien vers un autre
  document **de l'export** (lien interne de Docs ou son URL) mène à sa section dans le fichier
  (pdf et html), pas à Docs ; un lien vers un document absent de l'export reste un lien vers Docs.
  Le nombre de liens reliés est indiqué en fin d'export. Pas en `--split`, ni en `md`.
- `--split` : un fichier par document, **dans un zip**. Un document qui a des enfants est à la
  fois un fichier et un dossier du même nom (son contenu reste dans `B.pdf`, `B/` ne contient
  que ses enfants), comme dans l'arborescence de `pull`. Pour A → B → (C1, C2), où B a du
  contenu, `Titre de A.zip` contient :

```
A.pdf
A/
├── B.pdf        ← contenu propre de B
└── B/
    ├── C1.pdf
    └── C2.pdf
```

Autres options : `--depth N` (niveaux de sous-documents inclus, avec `--merge` ou `--split`),
`--out <dossier>` (défaut `./export` ; un fichier existant n'est jamais écrasé, la nouvelle version
est numérotée : `nom(1).pdf`) et `--dry-run` : affiche l'arbre et le nombre de documents qui seraient téléchargés, sans rien
télécharger ni écrire.

| Format | Document seul ou `--merge`                                   | `--split`                        |
| ------ | ------------------------------------------------------------ | -------------------------------- |
| `pdf`  | `Titre.pdf`                                                  | zip de PDF                       |
| `html` | `Titre.html`, page autonome (images intégrées)               | zip de pages HTML autonomes      |
| `md`   | `Titre.md`, ou zip avec `media/` s'il y a des pièces jointes | zip de fichiers `.md` + `media/` |

Le contenu vient de l'API de Docs (`formatted-content`, en HTML pour `pdf` et `html`, en
Markdown pour `md`). Le PDF est imprimé par Chromium via Playwright (`vp exec playwright install
chromium` ; ou `DOCS_CHROME_PATH` pour un Chrome déjà installé). Le contenu étant écrit par les
utilisateurs de Docs, la page ne lance aucun script et ne charge rien par le réseau.

**Limites connues.**

- Les **diagrammes Mermaid et les formules** n'existent pas pour l'API : son serveur supprime les
  blocs qu'il ne connaît pas. Ils manquent donc aussi de `pull`, et l'export ne peut pas
  signaler leur absence. À corriger côté Docs.
- Une image hébergée hors de Docs, introuvable ou d'un format non pris en charge est remplacée
  par une mention dans le document, et listée en fin d'export. Un document en erreur laisse
  une mention à sa place : l'export est alors « partiel » et la commande se termine avec le
  code 1.
- docx et odt ne sont pas pris en charge : les bibliothèques d'export de BlockNote sont sous
  GPL, incompatible avec la licence MIT de ce dépôt.

## Usage responsable

> [!WARNING]
> `docs-cli` n'est **pas un outil officiel** de Docs ni de la DINUM. Il est **toléré de fait, pas
> autorisé** : les modalités d'utilisation de Docs ne l'interdisent pas, mais ne le prévoient pas
> non plus. À utiliser en connaissance de cause.

- **Il passe par l'API interne de l'interface web**, avec la session de la personne connectée
  (le cookie obtenu par ProConnect). La documentation de Docs indique ne proposer ni API publique
  ni MCP, et recommande, pour intégrer un service, le _resource server_ après enregistrement
  auprès de ProConnect, autorisé au cas par cas (page « Accéder à l'API de Docs » de la
  documentation utilisateur). Ce n'est pas la voie suivie ici.
- **Rien ne garantit sa stabilité.** Cette API peut changer ou se fermer sans préavis, comme le
  service lui-même (modalités d'utilisation de Docs). Un usage jugé anormal peut conduire la
  DINUM à suspendre un compte.
- **Usage raisonnable** : son propre compte, ses propres documents, au débit par défaut
  (60 requêtes par minute, alors que Docs en accepte 80 par utilisateur ; arrêt sur `429`).
  Ne pas contourner ces limites (`DOCS_RATE_PER_MINUTE`) ni lancer l'outil en masse.
- **Les données restent en clair sur le poste** : la session dans `~/.config/docs-cli/.env`,
  les copies de `pull` (`./data`) et les exports (`./export`) peuvent contenir des données
  personnelles ou sensibles. Les protéger relève de chacun et des règles de son organisation.
- **Avant de le proposer à d'autres personnes** ou de s'en servir à grande échelle, écrire à
  l'équipe Docs (`docs@numerique.gouv.fr`) pour savoir si c'est toléré.

## Configuration (`~/.config/docs-cli/.env`)

Voir [.env.example](.env.example). `DOCS_SESSIONID` et `DOCS_CSRFTOKEN` sont remplis par
`docs login`. `DOCS_TEMPLATES` : id du document dont les enfants sont les modèles de `docs new`.

## Dépannage

**Proxy d'entreprise** : `HTTPS_PROXY` / `NO_PROXY` dans le shell ou le `.env` (Node ≥ 24.14,
sinon `NODE_USE_ENV_PROXY=1`). Si le proxy est décrit par un fichier `.pac`, ajoutez
`DOCS_PROXY_PAC` (URL ou chemin local) : le navigateur de `docs login` l'utilise à la place
de `HTTPS_PROXY`. Les autres commandes ne lisent pas les PAC : gardez `HTTPS_PROXY` pour elles.

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

## Licence

[MIT](LICENSE) — Copyright (c) 2026 Direction générale des Finances publiques (DGFiP).
Conçu et développé par Pierre-Olivier Mauguet.
