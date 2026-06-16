import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateCreateSchema, CandidateUpdateSchema, CandidateSearchSchema, IdSchema } from "../schemas/index.js";
import type { CandidateSearchInput, CandidateUpdateInput } from "../schemas/index.js";
import {
  registerGetToolMerged,
  registerCreateTool,
  registerDeleteTool,
  buildJsonApiBody,
  buildTabHandler,
} from "./crud-factory.js";
import { apiRequest, buildSearchQuery, formatListResponse, formatDetailResponse } from "../services/boond-client.js";
import { getStateMap } from "../services/dictionary.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";

const OPTS = {
  entityName: "candidat",
  entityNamePlural: "candidats",
  apiPath: "/candidates",
  prefix: "boond_candidates",
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

const CANDIDATE_TABS: TabDefinition[] = [
  {
    name: "information",
    tab: "information",
    title: "Informations générales d'un candidat",
    description: `Récupère les informations générales d'un candidat (coordonnées, adresse, état civil, photo, tags, source...).

Args:
  - id (string): ID du candidat

Returns: Données personnelles et administratives du candidat.`,
  },
  {
    name: "technical_data",
    tab: "technical-data",
    title: "Compétences techniques d'un candidat",
    description: `Récupère le profil technique d'un candidat (compétences, expériences, formations, certifications, langues, CV...).

Args:
  - id (string): ID du candidat

Returns: Données techniques et compétences du candidat.`,
  },
  {
    name: "administrative",
    tab: "administrative",
    title: "Données administratives d'un candidat",
    description: `Récupère les informations administratives d'un candidat.

Args:
  - id (string): ID du candidat

Returns: Données administratives du candidat.`,
  },
  {
    name: "actions",
    tab: "actions",
    title: "Actions liées à un candidat",
    description: `Récupère les actions (appels, emails, RDV, notes) associées à un candidat.

Args:
  - id (string): ID du candidat

Returns: Liste des actions liées au candidat.`,
  },
  {
    name: "positionings",
    tab: "positionings",
    title: "Positionnements d'un candidat",
    description: `Récupère les positionnements (placements sur des opportunités/projets) d'un candidat.

Args:
  - id (string): ID du candidat

Returns: Liste des positionnements du candidat.`,
  },
];

const CANDIDATE_SEARCH_DESCRIPTION = `Recherche des candidats dans BoondManager avec filtres serveur.

⚠️ Utilisez les filtres structurés plutôt que la pagination intégrale. Les noms de paramètres sont ceux exacts de l'API.

Cas d'usage courants :
• **Mes candidats** sans connaître son propre ID : \`perimeterDynamic: ["data"]\`. Pour "candidats de l'équipe X" : \`perimeterManagers: [<X_id>]\` (utiliser \`perimeterManagersType: "main"|"hr"\` pour cibler Main vs HR Manager).
• **États / types** : \`candidateStates: [<id>]\` (dictionnaire \`setting.state.candidate\`), \`candidateTypes\` (\`setting.typeOf.resource\`), \`contractTypes\`, \`availabilityTypes\`. IDs entiers issus du dictionnaire.
• **Périmètre orga** : \`perimeterAgencies\`, \`perimeterPoles\`, \`perimeterBusinessUnits\`. \`narrowPerimeter: true\` pour ET.
• **Profil technique** : \`tools: [<id>]\` (OU; pour ET: \`["#AND#", "1", "2"]\`), \`expertiseAreas\`, \`activityAreas\`, \`experiences\`, \`trainings\`, \`mobilityAreas\`, \`languages\` (format \`langueId|niveauId\`).
• **Sourcing** : \`sources: [<id>]\` (origine du candidat), \`evaluations\`.
• **Période** : \`period: "created"|"updated"|"available"|"withActions"|...\` + \`startDate\`/\`endDate\`.
• **Recherche par nom** : \`keywords: "Dupont"\` + \`keywordsType: "lastName"\` (ou firstName, fullName avec \`"NOM#PRENOM"\`, emails, phones, title, titleSkills…). Sans \`keywordsType\`, recherche par défaut dans le CV.
• **Géolocalisation** : \`coordinates: "lat,lon"\` ou \`location\` + \`geoDistance\` (km, 5-200).

Raccourcis :
• **\`stateLabel\`** — passer le libellé textuel ('Vivier chaud', 'Embauché'…) plutôt que l'ID. Résolu via le dictionnaire en cache.
• **\`fetchAll: true\`** — paginate automatiquement jusqu'à \`maxResults\` (défaut 500, max 1000) pour rapatrier l'intégralité d'un vivier filtré.

Pagination manuelle : \`page\`, \`pageSize\` (max 500). Tri : \`sort\` + \`order\`.

Returns : liste paginée des candidats. Utiliser \`boond_candidates_get\` ou les outils d'onglets pour le détail.`;

/** Hard ceiling on rows returned when `fetchAll: true`, matching the schema cap. */
const CANDIDATE_FETCH_ALL_DEFAULT = 500;
const CANDIDATE_FETCH_ALL_HARD_CAP = 1000;
const CANDIDATE_FETCH_ALL_PAGE_SIZE = 500;

/**
 * Custom search handler: resolves the textual `stateLabel` shortcut to an
 * integer `candidateStates[]` via the dictionary cache, and optionally
 * paginates automatically up to `maxResults` when `fetchAll: true`.
 */
async function handleCandidateSearch(params: CandidateSearchInput): Promise<{
  content: { type: "text"; text: string }[];
}> {
  const { stateLabel, fetchAll, maxResults, ...rest } = params;

  // 1. Resolve `stateLabel` → `candidateStates: [id]` when no explicit ID was given.
  //    Explicit IDs win — callers who already pass `candidateStates` aren't second-guessed.
  if (stateLabel && (!rest.candidateStates || rest.candidateStates.length === 0)) {
    try {
      const map = await getStateMap("candidate");
      const id = map.byLabel.get(stateLabel.toLowerCase().trim());
      if (id !== undefined) {
        rest.candidateStates = [id];
      }
      // If no match, fall through with no state filter rather than throwing —
      // the LLM can iterate. We log nothing here to keep stdio transport clean.
    } catch {
      // Dictionary unreachable: behave as if stateLabel wasn't passed.
    }
  }

  // 2. Single-page path (default, unchanged behavior).
  if (!fetchAll) {
    const query = buildSearchQuery(rest);
    const response = await apiRequest(OPTS.apiPath, "GET", undefined, query);
    return {
      content: [{ type: "text" as const, text: formatListResponse(response, OPTS.entityName) }],
    };
  }

  // 3. Auto-pagination path. Force a large pageSize and walk until the cap is hit.
  const cap = Math.min(maxResults ?? CANDIDATE_FETCH_ALL_DEFAULT, CANDIDATE_FETCH_ALL_HARD_CAP);
  const baseQuery = buildSearchQuery({ ...rest, page: 1, pageSize: CANDIDATE_FETCH_ALL_PAGE_SIZE });
  const allRows: JsonApiResource[] = [];
  let firstResponse: JsonApiResponse | null = null;
  for (let page = 1; allRows.length < cap; page++) {
    const response = await apiRequest(OPTS.apiPath, "GET", undefined, { ...baseQuery, page });
    if (firstResponse === null) firstResponse = response;
    const data = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
    allRows.push(...data);
    if (data.length < CANDIDATE_FETCH_ALL_PAGE_SIZE) break;
  }
  const truncated = allRows.slice(0, cap);
  // Surface the union as if it were a single response so the existing
  // formatter renders it identically to the per-page path.
  const merged: JsonApiResponse = {
    data: truncated,
    meta: firstResponse?.meta,
  };
  return {
    content: [{ type: "text" as const, text: formatListResponse(merged, OPTS.entityName) }],
  };
}

// ---- Candidate `information`-tab write (boond_candidates_update) -------------
//
// The generic CRUD update did `PATCH /candidates/{id}` → 405 (verified in prod,
// same as the administrative tab). The candidate is split into sub-resources and
// the editable identity/contact fields (incl. postcode, town, globalEvaluation)
// live on `information`, so the write goes to `PUT /candidates/{id}/information`
// with a POST fallback on 404/405 (the verb is instance-dependent on the
// external API — mirrors boond_candidates_administrative_update).

const CANDIDATE_UPDATE_DESCRIPTION = `Met à jour la fiche **information** d'un candidat (coordonnées + évaluation). Champs : \`firstName\`, \`lastName\`, \`title\`, \`email1\`/\`email2\`/\`email3\`, \`phone1\`/\`phone2\`/\`phone3\`, \`address\`, \`postcode\`, \`town\` (ville), \`country\`, \`globalEvaluation\` (note entière, -1 = non évaluée), \`informationComments\`.

Seuls les champs fournis sont modifiés. Pour la disponibilité, la mobilité, les salaires/TJM, le contrat souhaité ou la situation, utiliser \`boond_candidates_administrative_update\` ; pour le dossier technique, \`boond_candidates_technical_data_update\`.

Écriture : \`PUT /candidates/{id}/information\` (repli \`POST\` automatique).`;

/**
 * Write candidate `information`-tab fields. Only the provided keys are sent.
 * Targets the `information` sub-resource (the base `PATCH`/`PUT /candidates/{id}`
 * return 405); falls back to POST on a 404/405 verb/endpoint mismatch. Throws
 * when no field is provided (no empty write).
 */
export async function updateCandidateInformation(
  input: CandidateUpdateInput
): Promise<{ response: JsonApiResponse; applied: string[] }> {
  const { id, ...fields } = input;
  const attrs: Record<string, unknown> = {};
  const applied: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      attrs[key] = value;
      applied.push(key);
    }
  }
  if (applied.length === 0) {
    throw new Error(
      "Rien à mettre à jour : fournir au moins un champ (firstName, town, postcode, globalEvaluation, …)."
    );
  }

  const infoPath = `/candidates/${id}/information`;
  const body = buildJsonApiBody("candidate", attrs, id);
  let response: JsonApiResponse;
  try {
    response = await apiRequest(infoPath, "PUT", body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b40[45]\b/.test(msg)) {
      response = await apiRequest(infoPath, "POST", body);
    } else {
      throw err;
    }
  }
  return { response, applied };
}

export function registerCandidateTools(server: McpServer): void {
  server.registerTool(
    `${OPTS.prefix}_search`,
    {
      title: "Rechercher des candidats",
      description: CANDIDATE_SEARCH_DESCRIPTION,
      inputSchema: CandidateSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => handleCandidateSearch(params as CandidateSearchInput)
  );
  registerGetToolMerged(server, OPTS);

  registerCreateTool(server, OPTS, CandidateCreateSchema, (params) => {
    const { ...attrs } = params;
    return buildJsonApiBody("candidate", attrs);
  });

  server.registerTool(
    `${OPTS.prefix}_update`,
    {
      title: "Modifier la fiche information d'un candidat",
      description: CANDIDATE_UPDATE_DESCRIPTION,
      inputSchema: CandidateUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const input = params as CandidateUpdateInput;
      try {
        const { response, applied } = await updateCandidateInformation(input);
        const text = [
          `✅ Candidat #${input.id} mis à jour.`,
          `   Champs : ${applied.join(", ")}`,
          "",
          formatDetailResponse(response),
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }
  );

  registerDeleteTool(server, OPTS);

  // Register one tool per candidate tab via the shared `buildTabHandler`
  // (pagination + auto list/detail + enriched actions formatter — cf. 1.10.3).
  for (const tab of CANDIDATE_TABS) {
    server.registerTool(
      `boond_candidates_${tab.name}`,
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
