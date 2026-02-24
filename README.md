# BoondManager MCP Server

Serveur MCP (Model Context Protocol) pour l'API BoondManager, permettant à Claude (Desktop, Cowork, Code) de rechercher, consulter, créer et modifier des enregistrements dans votre instance BoondManager.

## 🎯 Domaines couverts

| Domaine | Outils | Description |
|---------|--------|-------------|
| **Candidats** | search, get, create, update, delete | Gestion du vivier de candidats |
| **Ressources** | search, get, create, update, delete | Gestion des collaborateurs/consultants |
| **Contacts** | search, get, create, update, delete | Contacts clients et partenaires |
| **Sociétés** | search, get, create, update, delete | Entreprises clientes et prospects |
| **Opportunités** | search, get, create, update, delete | Pipeline commercial |
| **Actions** | search, get, create, delete | Suivi d'activité (appels, emails, RDV) |

**Total : 28 outils**

## 📋 Prérequis

- Node.js >= 18
- Un compte BoondManager avec accès API activé
- L'option "Allow API Rest calls using BasicAuth authentication" activée dans la configuration BoondManager (si BasicAuth)

## 🚀 Installation

```bash
git clone <votre-repo>/boondmanager-mcp-server
cd boondmanager-mcp-server
npm install
npm run build
```

## ⚙️ Configuration

### Variables d'environnement

**Option 1 : BasicAuth (recommandé pour démarrer)**
```bash
export BOOND_USER="votre_login"
export BOOND_PASSWORD="votre_mot_de_passe"
```

**Option 2 : Token API (JWT)**
```bash
export BOOND_API_TOKEN="votre_token_jwt"
```

**Option 3 : URL personnalisée (si instance dédiée)**
```bash
export BOOND_BASE_URL="https://votre-instance.boondmanager.com/api"
```

### Configuration Claude Desktop / Cowork

Ajoutez dans votre fichier de configuration Claude :

**macOS** : `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows** : `%APPDATA%\Claude\claude_desktop_config.json`

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

## 💬 Exemples d'utilisation

Une fois configuré, vous pouvez demander à Claude :

- *"Recherche les candidats avec des compétences en React à Paris"*
- *"Montre-moi les détails de la ressource #12345"*
- *"Crée un nouveau contact Jean Dupont chez Acme Corp"*
- *"Liste toutes les opportunités en cours"*
- *"Quelles sont les actions récentes sur le candidat #789 ?"*
- *"Mets à jour l'email du contact #456"*

## 🏗️ Architecture

```
boondmanager-mcp-server/
├── src/
│   ├── index.ts              # Point d'entrée MCP (stdio)
│   ├── constants.ts          # Configuration et constantes
│   ├── types.ts              # Types TypeScript (JSON:API)
│   ├── services/
│   │   └── boond-client.ts   # Client HTTP API BoondManager
│   ├── schemas/
│   │   └── index.ts          # Schémas Zod (validation)
│   └── tools/
│       ├── index.ts          # Export barrel
│       ├── crud-factory.ts   # Factory générique CRUD (DRY)
│       ├── candidates.ts     # Outils candidats
│       ├── resources.ts      # Outils ressources
│       ├── contacts.ts       # Outils contacts
│       ├── companies.ts      # Outils sociétés
│       ├── opportunities.ts  # Outils opportunités
│       └── actions.ts        # Outils actions
├── dist/                     # Build JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

## 🔒 Sécurité

- Les credentials ne transitent jamais via le réseau MCP — ils sont configurés en variables d'environnement locales
- Le serveur tourne en local (stdio), pas de port réseau exposé
- Compatible avec les exigences ISO 27001
- L'API BoondManager est hébergée en France et conforme RGPD

## 🔧 Développement

```bash
# Mode watch pour le développement
npm run dev

# Build
npm run build

# Lancer le serveur
npm start
```

## 📚 Ressources

- [Documentation API BoondManager](https://doc.boondmanager.com/api-externe/)
- [Collection Postman BoondManager](https://www.postman.com/boondmanager)
- [Spécification MCP](https://modelcontextprotocol.io/)
- [pyboondmanager (référence Python)](https://github.com/tominardi/pyboondmanager)

## 📄 Licence

MIT - Silamir
