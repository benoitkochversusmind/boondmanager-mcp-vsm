import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ResourceCreateSchema,
  ResourceUpdateSchema,
  ResourceSearchSchema,
  ResourceMissionsHistorySchema,
  IdSchema,
} from "../schemas/index.js";
import type { ResourceMissionsHistoryInput } from "../schemas/index.js";
import {
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
  buildJsonApiBody,
  buildTabHandler,
} from "./crud-factory.js";
import { apiRequest, fetchTabResponse } from "../services/boond-client.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";

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

// ---- Composite tool: resource missions history ----------------------------
//
// Goal : answer "all the missions/clients a consultant has worked on" in one
// call instead of orchestrating /resources/{id}/projects + N x /companies/{id}
// + N x /projects/{id} from the agent side.
//
// Pipeline (uses the v1.10.3 paginated tab fetcher under the hood) :
//   1. Get every project assigned to the resource via
//      `/resources/{id}/projects` (paginated, all rows).
//   2. Deduplicate the `relationships.company.data.id`s and fetch the company
//      name via `/companies/{id}` for each unique client (parallel, capped).
//   3. If `withProjectDates` (default true), fetch each project via
//      `/projects/{id}` to get `attributes.startDate` (the `/resources/projects`
//      endpoint omits dates from its summary view).
//   4. Group by client (default) or render flat sorted by recency.

const PROJECT_TYPE_LABELS: Record<number, string> = {
  // Common Boondmanager project types — kept defensive (resolve later if needed).
  // 1: "TJM forfaité", 2: "Régie", 3: "Forfait", 4: "Abonnement", 5: "Interne / formation"
  1: "TJM forfaité",
  2: "Régie",
  3: "Forfait",
  4: "Abonnement",
  5: "Interne / formation",
};

interface MissionRow {
  projectId: string;
  reference: string;
  companyId: string | null;
  companyName: string | null;
  startDate: string | null; // YYYY-MM-DD when resolved
  typeOf: number | null;
  typeLabel: string | null;
}

function attrs(r: JsonApiResource): Record<string, unknown> {
  return (r.attributes ?? {}) as Record<string, unknown>;
}

function relId(r: JsonApiResource, key: string): string | null {
  const rels = (r.relationships ?? {}) as Record<string, { data?: { id?: string } | null }>;
  const data = rels[key]?.data;
  return data && typeof data.id === "string" ? data.id : null;
}

// ---- Resource identifier resolution (v1.11.1) -----------------------------
//
// Accept either a numeric ID (`"20"`) or a name (`"Damien BLAISE"`, `"BLAISE"`).
// Names are resolved via the `/resources` search endpoint :
//   - 1 match  → use that ID, surface the displayName in the output header.
//   - 0 match  → throw a clear error mentioning the input.
//   - N match  → throw with the first 10 candidates (id + name) so the
//                caller can disambiguate without firing another tool.
//
// Search strategy : at most 2 calls (cheap).
//   1. Tokens of the input that are ALL-CAPS are treated as the last name
//      (Versusmind convention). Search via `keywordsType=lastName` first —
//      it's the most discriminating field on /resources.
//   2. If 0 results and the input has multiple tokens, retry with the same
//      keywords but `keywordsType=fullName` (matches "lastname firstname"
//      ordering loosely).
// Exported for unit tests.

export interface ResolvedResource {
  id: string;
  displayName: string | null;
}

function buildDisplayName(r: JsonApiResource): string | null {
  const a = attrs(r);
  const first = typeof a["firstName"] === "string" ? (a["firstName"] as string) : "";
  const last = typeof a["lastName"] === "string" ? (a["lastName"] as string) : "";
  const composed = [first, last].filter(Boolean).join(" ").trim();
  if (composed) return composed;
  return typeof a["title"] === "string" ? (a["title"] as string) : null;
}

async function searchResourcesByKeywords(
  keywords: string,
  keywordsType: "lastName" | "firstName" | "fullName"
): Promise<JsonApiResource[]> {
  const qs = new URLSearchParams({
    keywords,
    keywordsType,
    maxResults: "20",
  });
  const r: JsonApiResponse = await apiRequest(`/resources?${qs.toString()}`);
  return Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
}

export async function resolveResourceIdentifier(input: string): Promise<ResolvedResource> {
  const trimmed = input.trim();
  // Fast path : numeric ID, no extra call.
  if (/^\d+$/.test(trimmed)) {
    return { id: trimmed, displayName: null };
  }

  // First attempt : lastName lookup. Most discriminating, single field.
  let matches = await searchResourcesByKeywords(trimmed, "lastName");

  // Fallback : fullName for multi-token inputs that lastName missed.
  if (matches.length === 0 && /\s/.test(trimmed)) {
    matches = await searchResourcesByKeywords(trimmed, "fullName");
  }

  if (matches.length === 0) {
    throw new Error(
      `Aucune ressource trouvée pour "${trimmed}". Vérifiez l'orthographe ou utilisez \`boond_resources_search\` pour explorer.`
    );
  }
  if (matches.length === 1) {
    const r = matches[0];
    return { id: r.id, displayName: buildDisplayName(r) };
  }
  // Ambiguous : surface the first 10 candidates with id + name.
  const sample = matches.slice(0, 10).map((r) => {
    const name = buildDisplayName(r) ?? "(sans nom)";
    return `  - #${r.id} : ${name}`;
  });
  const more = matches.length > 10 ? `\n  - … et ${matches.length - 10} autre(s).` : "";
  throw new Error(
    `${matches.length} ressources correspondent à "${trimmed}". Précisez l'ID ou le nom complet :\n${sample.join("\n")}${more}`
  );
}

async function batchedLookup<T>(
  ids: string[],
  cap: number,
  fetcher: (id: string) => Promise<T | null>
): Promise<Map<string, T>> {
  const cache = new Map<string, T>();
  const unique = Array.from(new Set(ids)).slice(0, cap);
  const results = await Promise.allSettled(
    unique.map(async (id) => {
      const out = await fetcher(id).catch(() => null);
      return [id, out] as const;
    })
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value[1] !== null) {
      cache.set(r.value[0], r.value[1] as T);
    }
  }
  return cache;
}

export async function fetchResourceMissionsHistory(params: ResourceMissionsHistoryInput): Promise<{
  resourceId: string;
  displayName: string | null;
  rows: MissionRow[];
  unresolvedAfterCap: number;
}> {
  // 0. Accept either a numeric ID or a name. Name → resolve via /resources search.
  const resolved = await resolveResourceIdentifier(params.resourceId);
  const resourceId = resolved.id;
  const cap = params.maxEnrichments ?? 100;
  const withDates = params.withProjectDates ?? true;

  // 1. Paginated projects for this resource (already covered by v1.10.3).
  const resp = await fetchTabResponse(`/resources/${resourceId}/projects`);
  const rawProjects: JsonApiResource[] = Array.isArray(resp.data) ? resp.data : resp.data ? [resp.data] : [];

  // 2. Resolve company names — dedup + parallel + capped.
  const companyIds = rawProjects.map((p) => relId(p, "company")).filter((x): x is string => x !== null);
  const companyNames = await batchedLookup(companyIds, cap, async (id) => {
    const r: JsonApiResponse = await apiRequest(`/companies/${id}`);
    const entity = Array.isArray(r.data) ? r.data[0] : r.data;
    const a = entity ? attrs(entity) : {};
    return typeof a["name"] === "string" ? (a["name"] as string) : null;
  });

  // 3. Optionally enrich each project with its startDate.
  const projectDates = withDates
    ? await batchedLookup(
        rawProjects.map((p) => p.id),
        cap,
        async (id) => {
          const r: JsonApiResponse = await apiRequest(`/projects/${id}`);
          const entity = Array.isArray(r.data) ? r.data[0] : r.data;
          const a = entity ? attrs(entity) : {};
          return typeof a["startDate"] === "string" ? (a["startDate"] as string) : null;
        }
      )
    : new Map<string, string>();

  // 4. Build rows.
  const rows: MissionRow[] = rawProjects.map((p) => {
    const cid = relId(p, "company");
    const a = attrs(p);
    const typeOfRaw = a["typeOf"];
    const typeOfNum = typeof typeOfRaw === "number" ? typeOfRaw : Number(typeOfRaw);
    const typeOfFinal = Number.isFinite(typeOfNum) ? typeOfNum : null;
    return {
      projectId: p.id,
      reference: typeof a["reference"] === "string" ? (a["reference"] as string) : "(sans réf)",
      companyId: cid,
      companyName: cid ? (companyNames.get(cid) ?? null) : null,
      startDate: projectDates.get(p.id) ?? null,
      typeOf: typeOfFinal,
      typeLabel: typeOfFinal !== null ? (PROJECT_TYPE_LABELS[typeOfFinal] ?? null) : null,
    };
  });

  // Sort by startDate desc (missing dates at the bottom).
  rows.sort((a, b) => {
    if (a.startDate && b.startDate) return b.startDate.localeCompare(a.startDate);
    if (a.startDate) return -1;
    if (b.startDate) return 1;
    return a.projectId.localeCompare(b.projectId);
  });

  const unresolvedAfterCap = Math.max(0, new Set(companyIds).size - cap) + Math.max(0, rawProjects.length - cap);

  return { resourceId, displayName: resolved.displayName, rows, unresolvedAfterCap };
}

function formatMissionsHistoryOutput(
  resourceId: string,
  displayName: string | null,
  rows: MissionRow[],
  groupByCompany: boolean,
  unresolvedAfterCap: number
): string {
  const who = displayName ? `${displayName} (ressource #${resourceId})` : `ressource #${resourceId}`;
  if (rows.length === 0) {
    return `Aucune mission trouvée pour ${who}.`;
  }

  const uniqueClients = new Set(rows.map((r) => r.companyId ?? `?${r.projectId}`));
  const oldest = rows.reduce<string | null>(
    (acc, r) => (r.startDate && (!acc || r.startDate < acc) ? r.startDate : acc),
    null
  );
  const newest = rows.reduce<string | null>(
    (acc, r) => (r.startDate && (!acc || r.startDate > acc) ? r.startDate : acc),
    null
  );
  const periodHint = oldest && newest ? ` · période ${oldest} → ${newest}` : "";

  const header = [
    `📋 Historique des missions — ${who}`,
    `Total : ${rows.length} mission(s) sur ${uniqueClients.size} société(s) cliente(s)${periodHint}`,
  ].join("\n");

  let capNote = "";
  if (unresolvedAfterCap > 0) {
    capNote = `\n\nℹ️ ${unresolvedAfterCap} enrichissement(s) sautés (cap ${unresolvedAfterCap > 100 ? "augmenté requis" : "atteint"}). Drill via \`boond_projects_get\` / \`boond_companies_get\`.`;
  }

  if (groupByCompany) {
    const groups = new Map<string, { name: string; rows: MissionRow[] }>();
    for (const r of rows) {
      const key = r.companyId ?? "?unknown";
      const name = r.companyName ?? (r.companyId ? `Société #${r.companyId}` : "Société inconnue");
      const g = groups.get(key) ?? { name, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
    // Sort groups : most missions first, then most recent within ties.
    const sorted = [...groups.values()].sort((a, b) => {
      if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
      const aMax = a.rows[0]?.startDate ?? "";
      const bMax = b.rows[0]?.startDate ?? "";
      return bMax.localeCompare(aMax);
    });
    const sections = sorted.map((g) => {
      const lines = g.rows.map((r) => {
        const dateStr = r.startDate ? ` · depuis ${r.startDate}` : "";
        const typeStr = r.typeLabel ? ` (${r.typeLabel})` : r.typeOf !== null ? ` (type #${r.typeOf})` : "";
        return `  - [project #${r.projectId}] ${r.reference}${typeStr}${dateStr}`;
      });
      return `${g.name} — ${g.rows.length} mission(s)\n${lines.join("\n")}`;
    });
    return `${header}\n\n${sections.join("\n\n")}${capNote}`;
  }

  // Flat list, sorted by recency (already sorted).
  const lines = rows.map((r) => {
    const companyDisplay = r.companyName ?? (r.companyId ? `société #${r.companyId}` : "société inconnue");
    const dateStr = r.startDate ? ` · ${r.startDate}` : "";
    const typeStr = r.typeLabel ? ` (${r.typeLabel})` : "";
    return `[project #${r.projectId}] ${r.reference}${typeStr} | ${companyDisplay}${dateStr}`;
  });
  return `${header}\n\n${lines.join("\n")}${capNote}`;
}

const MISSIONS_HISTORY_DESCRIPTION = `Historique complet des missions d'un consultant — réponse à « toutes les missions et tous les clients sur lesquels un consultant a travaillé ».

Pipeline orchestré côté serveur (1 seul appel pour l'agent au lieu de N) :
1. \`/resources/{resourceId}/projects\` paginé (toutes les missions assignées, fix v1.10.3).
2. Résolution du nom de chaque société cliente via \`/companies/{id}\` (dédup + parallèle, cap \`maxEnrichments\`).
3. Si \`withProjectDates: true\` (défaut), résolution de \`startDate\` de chaque projet via \`/projects/{id}\` (parallèle).
4. Tri par date de mission décroissante + groupement par client (par défaut).

Paramètres :
- \`resourceId\` (string, requis) : **ID numérique** (\`"20"\`) **ou nom** (\`"Damien BLAISE"\`, \`"BLAISE"\`). Si nom, résolution serveur via \`/resources?keywords=…\` ; 0 match → erreur, plusieurs matches → erreur avec la liste des candidats.
- \`withProjectDates\` (boolean, défaut true) : enrichit chaque projet avec sa date de début. Mettre \`false\` pour gagner ~N appels si seul le nom client compte.
- \`groupByCompany\` (boolean, défaut true) : sortie regroupée par société (top clients en premier) ou liste plate triée par récence.
- \`maxEnrichments\` (1-200, défaut 100) : cap sur les GET parallèles. Au-delà, les enrichissements excédentaires sont sautés et signalés.

Returns : tableau structuré avec total, fenêtre de période, et par client/mission : référence projet, type, date de début. Idéal pour générer un CV interne, audit d'expérience, ou cartographie clients d'un consultant.`;

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

  // Composite : historique missions + clients d'un consultant (1 appel agent).
  server.registerTool(
    "boond_resources_missions_history",
    {
      title: "Historique des missions d'un consultant",
      description: MISSIONS_HISTORY_DESCRIPTION,
      inputSchema: ResourceMissionsHistorySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const { resourceId, displayName, rows, unresolvedAfterCap } = await fetchResourceMissionsHistory(
          params as ResourceMissionsHistoryInput
        );
        const text = formatMissionsHistoryOutput(
          resourceId,
          displayName,
          rows,
          params.groupByCompany ?? true,
          unresolvedAfterCap
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        // Resolution errors (0 match, ambiguous) come back as readable messages.
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }
  );
}
