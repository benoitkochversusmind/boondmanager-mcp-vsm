# BoondManager MCP Server

[![CI](https://github.com/fauguste/boondmanager-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/fauguste/boondmanager-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/boondmanager-mcp-server.svg)](https://www.npmjs.com/package/boondmanager-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Serveur MCP (Model Context Protocol) pour l'API BoondManager, permettant a Claude (Desktop, Cowork, Code) de rechercher, consulter, creer et modifier des enregistrements dans votre instance BoondManager.

**158 outils** couvrant **36 domaines** de l'API BoondManager.

## Domaines couverts

### CRM & Commercial

| Domaine | Outils | Operations |
|---------|--------|------------|
| **Candidats** | 10 | CRUD + information, technical-data, administrative, actions, positionings |
| **Ressources** | 15 | CRUD + information, technical-data, administrative, advantages, actions, positionings, projects, times-reports, expenses-reports, absences-reports |
| **Contacts** | 11 | CRUD + information, actions, opportunities, projects, orders, invoices |
| **Societes** | 14 | CRUD + information, contacts, actions, opportunities, projects, orders, invoices, purchases, provider-invoices |
| **Opportunites** | 10 | CRUD + information, actions, positionings, projects, simulation |

### Gestion de projets

| Domaine | Outils | Operations |
|---------|--------|------------|
| **Projets** | 12 | CRUD + information, actions, simulation, deliveries-groupments, orders, purchases, productivity |
| **Positionnements** | 4 | search, get, create, delete |
| **Livraisons / CRA** | 2 | search, get |
| **Achats / Sous-traitance** | 4 | search, get, create, delete |

### Facturation & Finance

| Domaine | Outils | Operations |
|---------|--------|------------|
| **Factures client** | 5 | CRUD complet |
| **Factures fournisseur** | 2 | search, get |
| **Bons de commande** | 5 | CRUD complet |
| **Paiements** | 2 | search, get |
| **Notes de frais** | 5 | CRUD complet |
| **Produits** | 5 | CRUD complet |

### RH & Temps

| Domaine | Outils | Operations |
|---------|--------|------------|
| **Absences** | 5 | CRUD complet |
| **Planning absences** | 1 | search (vue globale) |
| **Feuilles de temps** | 3 | search, get, resource timesheets |
| **Contrats** | 2 | get, create |
| **Avantages** | 2 | search, get |

### Suivi d'activite

| Domaine | Outils | Operations |
|---------|--------|------------|
| **Actions** | 4 | search, get, create, delete |
| **Validations** | 2 | search, get |
| **Todolists** | 2 | search, get |

### Reporting

| Domaine | Outils | Operations |
|---------|--------|------------|
| **Reporting societes** | 1 | search |
| **Reporting projets** | 1 | search |
| **Reporting ressources** | 1 | search |
| **Reporting synthese** | 1 | search |
| **Reporting plans de production** | 1 | search |

### Administration & Configuration

| Domaine | Outils | Operations |
|---------|--------|------------|
| **Comptes utilisateurs** | 2 | search, get |
| **Agences** | 2 | search, get |
| **Business Units** | 2 | search, get |
| **Poles** | 2 | search, get |
| **Roles** | 2 | search, get |
| **Calendriers** | 2 | search, get |
| **Drapeaux / Etiquettes** | 2 | search, get |
| **Webhooks** | 2 | search, get |
| **Logs d'audit** | 2 | search, get |
| **Notifications** | 2 | search, get |
| **Fils de discussion** | 2 | search, get |
| **Application** | 2 | dictionnaire, utilisateur courant |

### Detail des onglets par entite

Les entites principales disposent d'outils dedies par onglet pour un acces cible :

| Entite | Onglets disponibles |
|--------|-------------------|
| Candidats | information, technical-data, administrative, actions, positionings |
| Ressources | information, technical-data, administrative, advantages, actions, positionings, projects, times-reports, expenses-reports, absences-reports |
| Contacts | information, actions, opportunities, projects, orders, invoices |
| Societes | information, contacts, actions, opportunities, projects, orders, invoices, purchases, provider-invoices |
| Opportunites | information, actions, positionings, projects, simulation |
| Projets | information, actions, simulation, deliveries-groupments, orders, purchases, productivity |

## Prerequis

- Node.js >= 20
- Un compte BoondManager avec acces API active
- L'option "Allow API Rest calls using BasicAuth authentication" activee dans la configuration BoondManager (si BasicAuth)

## Installation

### Via npm (recommande)

```bash
npx boondmanager-mcp-server
```

Ou installation globale :

```bash
npm install -g boondmanager-mcp-server
boondmanager-mcp-server
```

### Depuis les sources

```bash
git clone https://github.com/fauguste/boondmanager-mcp-server.git
cd boondmanager-mcp-server
npm install
npm run build
```

## Configuration

### Variables d'environnement

**Option 1 : BasicAuth (recommande pour demarrer)**
```bash
export BOOND_USER="votre_login"
export BOOND_PASSWORD="votre_mot_de_passe"
```

**Option 2 : Token API (JWT)**
```bash
export BOOND_API_TOKEN="votre_token_jwt"
```

**Option 3 : URL personnalisee (si instance dediee)**
```bash
export BOOND_BASE_URL="https://votre-instance.boondmanager.com/api"
```

Par defaut, l'URL est `https://ui.boondmanager.com/api`.

### Configuration Claude Desktop / Cowork

Ajoutez dans votre fichier de configuration Claude :

**macOS** : `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows** : `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "boondmanager": {
      "command": "npx",
      "args": ["-y", "boondmanager-mcp-server"],
      "env": {
        "BOOND_USER": "votre_login",
        "BOOND_PASSWORD": "votre_mot_de_passe"
      }
    }
  }
}
```

Ou si installe depuis les sources :

```json
{
  "mcpServers": {
    "boondmanager": {
      "command": "node",
      "args": ["/chemin/absolu/vers/boondmanager-mcp-server/dist/index.js"],
      "env": {
        "BOOND_USER": "votre_login",
        "BOOND_PASSWORD": "votre_mot_de_passe"
      }
    }
  }
}
```

## Exemples d'utilisation

Une fois configure, vous pouvez demander a Claude :

**CRM & Commercial**
- *"Recherche les candidats avec des competences en React a Paris"*
- *"Montre-moi les details techniques de la ressource #12345"*
- *"Cree un nouveau contact Jean Dupont chez Acme Corp"*
- *"Liste toutes les opportunites en cours"*
- *"Quels sont les positionnements de l'opportunite #20 ?"*

**Gestion de projets**
- *"Cree un projet Mission Alpha pour la societe #42"*
- *"Affiche le planning du projet #33"*
- *"Quels sont les bons de commande du projet #55 ?"*
- *"Affiche la productivite du projet #12"*

**Facturation & Finance**
- *"Recherche les factures en attente de paiement"*
- *"Liste les factures fournisseur de la societe #100"*
- *"Affiche les achats du projet #55"*

**RH & Temps**
- *"Affiche les feuilles de temps de la ressource #100 pour mars 2025"*
- *"Liste les absences prevues ce mois-ci"*
- *"Affiche les notes de frais de la ressource #200"*
- *"Quels sont les avantages de la ressource #50 ?"*

**Suivi d'activite**
- *"Quelles sont les actions recentes sur le candidat #789 ?"*
- *"Affiche les validations en attente"*
- *"Liste les taches de ma todolist"*

**Reporting**
- *"Affiche le reporting de synthese globale"*
- *"Quel est le reporting de productivite des ressources ?"*

**Administration**
- *"Recupere le dictionnaire des types d'actions"*
- *"Liste les agences et business units"*
- *"Affiche les webhooks configures"*

## Architecture

```
boondmanager-mcp-server/
├── src/
│   ├── index.ts              # Point d'entree MCP (stdio)
│   ├── constants.ts          # Configuration, API paths, onglets
│   ├── types.ts              # Types TypeScript (JSON:API)
│   ├── services/
│   │   └── boond-client.ts   # Client HTTP API BoondManager
│   ├── schemas/
│   │   └── index.ts          # Schemas Zod (validation des entrees)
│   └── tools/
│       ├── index.ts          # Barrel export de tous les domaines
│       ├── crud-factory.ts   # Factory generique CRUD (DRY)
│       ├── candidates.ts     # 10 outils (CRUD + 5 onglets)
│       ├── resources.ts      # 15 outils (CRUD + 10 onglets)
│       ├── contacts.ts       # 11 outils (CRUD + 6 onglets)
│       ├── companies.ts      # 14 outils (CRUD + 9 onglets)
│       ├── opportunities.ts  # 10 outils (CRUD + 5 onglets)
│       ├── projects.ts       # 12 outils (CRUD + 7 onglets)
│       ├── actions.ts        # 4 outils
│       ├── timesheets.ts     # 3 outils
│       ├── invoices.ts       # 5 outils
│       ├── orders.ts         # 5 outils
│       ├── deliveries.ts     # 2 outils
│       ├── absences.ts       # 5 outils
│       ├── expenses.ts       # 5 outils
│       ├── products.ts       # 5 outils
│       ├── positionings.ts   # 4 outils
│       ├── payments.ts       # 2 outils
│       ├── advantages.ts     # 2 outils
│       ├── contracts.ts      # 2 outils
│       ├── purchases.ts      # 4 outils
│       ├── provider-invoices.ts # 2 outils
│       ├── accounts.ts       # 2 outils
│       ├── agencies.ts       # 2 outils
│       ├── business-units.ts # 2 outils
│       ├── poles.ts          # 2 outils
│       ├── roles.ts          # 2 outils
│       ├── calendars.ts      # 2 outils
│       ├── flags.ts          # 2 outils
│       ├── webhooks.ts       # 2 outils
│       ├── logs.ts           # 2 outils
│       ├── notifications.ts  # 2 outils
│       ├── threads.ts        # 2 outils
│       ├── todolists.ts      # 2 outils
│       ├── validations.ts    # 2 outils
│       ├── reporting.ts      # 5 outils
│       ├── planning-absences.ts # 1 outil
│       └── application.ts    # 2 outils
├── dist/                     # Build JavaScript
├── .github/                  # CI/CD, templates, Dependabot
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
└── README.md
```

## Securite

- Les credentials ne transitent jamais via le reseau MCP -- ils sont configures en variables d'environnement locales
- Le serveur tourne en local (stdio), pas de port reseau expose
- Compatible avec les exigences ISO 27001
- L'API BoondManager est hebergee en France et conforme RGPD
- Authentification par BasicAuth (base64) ou JWT Bearer token

## Developpement

```bash
# Mode watch pour le developpement
npm run dev

# Build
npm run build

# Lancer le serveur
npm start

# Tests
npm test               # 255 tests
npm run test:coverage  # Avec couverture

# Qualite
npm run lint
npm run typecheck
```

### Stack technique

- **Runtime** : Node.js >= 20 (ES2022)
- **Langage** : TypeScript 5.8+ (mode strict)
- **MCP SDK** : @modelcontextprotocol/sdk 1.12+
- **Validation** : Zod 4
- **Tests** : Vitest 4 + couverture V8
- **Lint** : ESLint 10 + typescript-eslint
- **Transport** : stdio (pas de port reseau)

## Ressources

- [Documentation API BoondManager](https://doc.boondmanager.com/api-externe/)
- [Collection Postman BoondManager](https://www.postman.com/boondmanager)
- [Specification MCP](https://modelcontextprotocol.io/)
- [pyboondmanager (reference Python)](https://github.com/tominardi/pyboondmanager)

## Licence

MIT - Silamir
