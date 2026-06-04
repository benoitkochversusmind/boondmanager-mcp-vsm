import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceCreateSchema, ResourceUpdateSchema, ResourceSearchSchema, IdSchema } from "../schemas/index.js";
import {
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
  buildJsonApiBody,
  buildTabHandler,
} from "./crud-factory.js";

const OPTS = {
  entityName: "ressource",
  entityNamePlural: "ressources",
  apiPath: "/resources",
  prefix: "boond_resources",
};

const TAB_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface TabDefinition {
  name: string;
  tab: string;
  title: string;
  description: string;
}

const RESOURCE_TABS: TabDefinition[] = [
  {
    name: "information",
    tab: "information",
    title: "Informations générales d'une ressource",
    description: `Récupère les informations générales d'une ressource (coordonnées, adresse, état civil, photo, tags, manager...).

Args:
  - id (string): ID de la ressource

Returns: Données personnelles et administratives de la ressource.`,
  },
  {
    name: "technical_data",
    tab: "technical-data",
    title: "Compétences techniques d'une ressource",
    description: `Récupère le profil technique d'une ressource (compétences, expériences, formations, certifications, langues, CV...).

Args:
  - id (string): ID de la ressource

Returns: Données techniques et compétences de la ressource.`,
  },
  {
    name: "administrative",
    tab: "administrative",
    title: "Données administratives d'une ressource",
    description: `Récupère les informations administratives d'une ressource (salaire, TJM, coût journalier, informations RH...).

Args:
  - id (string): ID de la ressource

Returns: Données administratives et RH de la ressource.`,
  },
  {
    name: "advantages",
    tab: "advantages",
    title: "Avantages d'une ressource",
    description: `Récupère les avantages associés à une ressource (tickets restaurant, mutuelle, véhicule, primes...).

Args:
  - id (string): ID de la ressource

Returns: Liste des avantages de la ressource.`,
  },
  {
    name: "actions",
    tab: "actions",
    title: "Actions liées à une ressource",
    description: `Récupère les actions (appels, emails, RDV, notes) associées à une ressource.

Args:
  - id (string): ID de la ressource

Returns: Liste des actions liées à la ressource.`,
  },
  {
    name: "positionings",
    tab: "positionings",
    title: "Positionnements d'une ressource",
    description: `Récupère les positionnements (placements sur des projets) d'une ressource.

Args:
  - id (string): ID de la ressource

Returns: Liste des positionnements de la ressource.`,
  },
  {
    name: "projects",
    tab: "projects",
    title: "Projets d'une ressource",
    description: `Récupère les projets auxquels une ressource participe ou a participé.

Args:
  - id (string): ID de la ressource

Returns: Liste des projets de la ressource.`,
  },
  {
    name: "times_reports",
    tab: "times-reports",
    title: "Feuilles de temps d'une ressource",
    description: `Récupère les feuilles de temps d'une ressource.

Args:
  - id (string): ID de la ressource

Returns: Liste des feuilles de temps de la ressource.`,
  },
  {
    name: "expenses_reports",
    tab: "expenses-reports",
    title: "Notes de frais d'une ressource",
    description: `Récupère les notes de frais d'une ressource.

Args:
  - id (string): ID de la ressource

Returns: Liste des notes de frais de la ressource.`,
  },
  {
    name: "absences_reports",
    tab: "absences-reports",
    title: "Demandes d'absences d'une ressource",
    description: `Récupère les demandes d'absences d'une ressource (congés, RTT, maladie...).

Args:
  - id (string): ID de la ressource

Returns: Liste des demandes d'absences de la ressource.`,
  },
];

const RESOURCE_SEARCH_DESCRIPTION = `Recherche des ressources (collaborateurs internes) dans BoondManager avec filtres serveur.

⚠️ Utilisez les filtres structurés plutôt que la pagination intégrale. Les noms de paramètres ci-dessous sont **ceux exacts** de l'API BoondManager — toute autre orthographe est silencieusement ignorée.

Cas d'usage courants :
• **Mes données / mon équipe / mon agence** sans connaître son propre ID : \`perimeterDynamic: ["data"]\` (mes ressources), \`["managers"]\` (mes N-1), \`["agencies"]\` (mes agences).
• **Équipe d'une personne X** : \`perimeterManagers: [<X_id>]\` (filtre les ressources dont X est le N+1).
• **Mon ID utilisateur** : appeler \`boond_application_current_user\` puis passer cet ID dans \`perimeterManagers\`.
• **États / types** : \`resourceStates: [<id>]\`, \`resourceTypes: [<id>]\`. IDs entiers issus du dictionnaire (voir \`boond_application_dictionary\` avec \`setting.state.resource\` ou \`setting.typeOf.resource\`). \`excludeResourceStates\` / \`excludeResourceTypes\` pour exclure.
• **Périmètre organisationnel** : \`perimeterAgencies\`, \`perimeterPoles\`, \`perimeterBusinessUnits\` (IDs entiers). Combiner avec \`narrowPerimeter: true\` pour ET au lieu de OU.
• **Compétences / outils** : \`tools: [<toolId>, ...]\` (OU par défaut ; pour ET: \`["#AND#", "1", "2"]\`). \`expertiseAreas\`, \`activityAreas\`, \`languages\` (format \`langueId|niveauId\`).
• **Disponibilité / activité** : \`period: "available"\` + \`startDate\`/\`endDate\`. Autres valeurs : \`working\`, \`hired\`, \`left\`, \`employed\`, \`birthday\`, \`seniority\`…
• **Recherche par nom** : \`keywords: "Dupont"\` + \`keywordsType: "lastName"\` (ou \`firstName\`, \`fullName\` avec \`keywords: "Dupont#Jean"\`).
• **Géolocalisation** : \`coordinates: "48.85,2.35"\` (ou \`location: "Paris"\`) + \`geoDistance: 50\` (km).

Pagination : \`page\` (1+), \`pageSize\` (1-500). Tri : \`sort: "lastName"\` (ou firstName/title/availability/state/updateDate/creationDate) + \`order: "asc"|"desc"\`.

Returns : liste paginée. Utiliser \`boond_resources_get\` ou les outils d'onglets pour le détail.`;

export function registerResourceTools(server: McpServer): void {
  registerSearchTool(server, OPTS, {
    schema: ResourceSearchSchema,
    description: RESOURCE_SEARCH_DESCRIPTION,
  });
  registerGetTool(server, OPTS);

  registerCreateTool(server, OPTS, ResourceCreateSchema, (params) => {
    const { ...attrs } = params;
    return buildJsonApiBody("resource", attrs);
  });

  registerUpdateTool(server, OPTS, ResourceUpdateSchema, (params) => {
    const { id, ...attrs } = params;
    return buildJsonApiBody("resource", attrs, id as string);
  });

  registerDeleteTool(server, OPTS);

  // Register one tool per resource tab. The shared `buildTabHandler` pagines
  // les onglets-collection (projects, positionings, times-reports, deliveries,
  // actions...) jusqu'à `meta.totals.rows` et rend la liste complète au lieu
  // du seul `data[0]` — cf. fix transverse 1.10.3.
  for (const tab of RESOURCE_TABS) {
    server.registerTool(
      `boond_resources_${tab.name}`,
      {
        title: tab.title,
        description: tab.description,
        inputSchema: IdSchema,
        annotations: TAB_TOOL_ANNOTATIONS,
      },
      buildTabHandler(OPTS.apiPath, OPTS.entityName, tab.tab)
    );
  }
}
