import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AbsenceSearchSchema, AbsenceCreateSchema, AbsenceUpdateSchema, IdSchema } from "../schemas/index.js";
import type { AbsenceSearchInput } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { buildJsonApiBody } from "./crud-factory.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";

// ---- Absences search + enrichment (v1.11.2) -------------------------------
//
// Goals — fix three bugs in the original `boond_absences_search`:
//   1. `startDate`/`endDate` were forwarded literally to `/absences` and
//      silently ignored — the endpoint accepted them as unknown filters,
//      returning the whole org (~17k rows). Reproduced in prod:
//        `boond_absences_search({startDate: "2026-04-21", endDate: "2026-05-20"})`
//        → 17 110 rows (identical to no filter).
//   2. The output only showed `[absence #id]` + an optional title — no name,
//      no period dates, no absence type. The agent had to drill each row
//      individually (N+1) to get anything usable.
//   3. `boond_absences_get` 404'd on IDs like #19336 / #18913. Root cause:
//      `/absences` returns a heterogeneous collection that includes IDs
//      that are NOT `/absences-reports/{id}`-resolvable (older legacy
//      records or sub-entities). Switching the search to the canonical
//      `/absences-reports` endpoint guarantees every returned ID is
//      `get`-able.
//
// Source of truth used in this version :
//   - Live API probing on the production tenant (ca-boondmcp-vsm) on
//     2026-06-05 (BoondManager API version v9.1.58.0). The official RAML
//     at https://doc.boondmanager.com/api-externe/raml-build/ is
//     auth-gated and could not be fetched directly.
//   - `/absences-reports/{id}` returns an entity of type `absencesreport`
//     with `attributes.absencesPeriods[] = [{startDate, endDate, duration,
//     title, workUnitType: {reference, name, activityType}}]` and
//     `relationships.resource.data.id` pointing at a resource.
//   - `/resources/{id}/absences-reports` returns the same shape (verified
//     on resource #20: 122 rows, all of type `absencesreport`).
//
// Strategy :
//   - Endpoint switched to `/absences-reports` (matches `get`, no more
//     orphan IDs).
//   - `include=resource` requested so the agency's first/last name lands
//     in `included[]` — single round-trip, no N+1.
//   - `startDate`/`endDate` are forwarded to the API as best-effort
//     server-side filters; behaviour with the complex `absencesPeriods[]`
//     sub-entity is not reliably documented, so we always re-filter
//     client-side on overlap to guarantee correctness.
//   - Output flattens by `absencesPeriods[]` (one line per period) and
//     includes : last name, first name, period start, period end,
//     duration, `workUnitType.name`, report state.

const ABSENCES_REPORTS_PATH = "/absences-reports";

interface AbsencePeriod {
  id?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  duration?: number;
  title?: string;
  workUnitType?: {
    reference?: number;
    name?: string;
    activityType?: string;
  };
}

interface EnrichedAbsenceRow {
  reportId: string;
  reportState: string | null;
  resourceId: string | null;
  firstName: string | null;
  lastName: string | null;
  startDate: string;
  endDate: string;
  duration: number | null;
  title: string | null;
  typeName: string | null;
}

function attrs(r: JsonApiResource): Record<string, unknown> {
  return (r.attributes ?? {}) as Record<string, unknown>;
}

function relId(r: JsonApiResource, key: string): string | null {
  const rels = (r.relationships ?? {}) as Record<string, { data?: { id?: string } | null }>;
  const data = rels[key]?.data;
  return data && typeof data.id === "string" ? data.id : null;
}

/**
 * Two date ranges overlap when `a.start <= b.end && a.end >= b.start`.
 * Strings are YYYY-MM-DD so a lexicographic compare works.
 */
export function periodOverlapsWindow(
  periodStart: string,
  periodEnd: string,
  windowStart?: string,
  windowEnd?: string
): boolean {
  if (!windowStart && !windowEnd) return true;
  if (windowEnd && periodStart > windowEnd) return false;
  if (windowStart && periodEnd < windowStart) return false;
  return true;
}

function buildResourceIndex(
  included: JsonApiResource[] | undefined
): Map<string, { firstName: string | null; lastName: string | null }> {
  const idx = new Map<string, { firstName: string | null; lastName: string | null }>();
  if (!included) return idx;
  for (const inc of included) {
    if (inc.type !== "resource") continue;
    const a = attrs(inc);
    idx.set(inc.id, {
      firstName: typeof a["firstName"] === "string" ? (a["firstName"] as string) : null,
      lastName: typeof a["lastName"] === "string" ? (a["lastName"] as string) : null,
    });
  }
  return idx;
}

/**
 * Search /absences-reports with optional period filter, enriched with
 * resource names. Server-side filter is best-effort ; the authoritative
 * filtering happens client-side on each `absencesPeriods[]` entry.
 */
export async function searchAbsencesEnriched(params: AbsenceSearchInput): Promise<{
  rows: EnrichedAbsenceRow[];
  totalReportsFetched: number;
  totalReportsApi: number | undefined;
  filtered: boolean;
}> {
  const { startDate, endDate, resourceId, fetchAll, maxScannedReports, ...rest } = params;
  const baseQuery: Record<string, unknown> = buildSearchQuery(rest);
  // Hydrate resource via JSON:API include — avoids N+1.
  baseQuery["include"] = "resource";
  // Best-effort server-side filter ; documented as potentially ignored.
  if (startDate) baseQuery["startDate"] = startDate;
  if (endDate) baseQuery["endDate"] = endDate;
  // Linked-resource filter (passed as keyword prefix following the same
  // pattern as `boond_actions_search` — the literal `resourceId=` is
  // silently ignored on most collection endpoints).
  if (resourceId) {
    const prefix = `COMP${resourceId}`;
    baseQuery["keywords"] =
      typeof baseQuery["keywords"] === "string" && baseQuery["keywords"]
        ? `${prefix} ${baseQuery["keywords"]}`
        : prefix;
  }

  const cap = Math.min(maxScannedReports ?? 1000, 5000);
  const wantsAll = fetchAll === true || (Boolean(startDate || endDate) && fetchAll !== false);

  const reports: JsonApiResource[] = [];
  const includedAll: JsonApiResource[] = [];
  let totalApi: number | undefined;
  let currentPage = typeof baseQuery["page"] === "number" ? (baseQuery["page"] as number) : 1;

  // Walk pages : either honour the caller's single-page request OR
  // auto-paginate up to `cap` when a date window is given (since the
  // server filter may not narrow at all and the caller wants every
  // overlapping period).
   
  while (true) {
    const pageQuery: Record<string, unknown> = { ...baseQuery, page: currentPage };
    if (wantsAll) {
      pageQuery["maxResults"] = 500;
    }
    const response: JsonApiResponse = await apiRequest(
      ABSENCES_REPORTS_PATH,
      "GET",
      undefined,
      pageQuery as Parameters<typeof apiRequest>[3]
    );
    const data = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
    reports.push(...data);
    if (response.included) includedAll.push(...response.included);
    if (totalApi === undefined && response.meta?.totals?.rows !== undefined) {
      totalApi = response.meta.totals.rows;
    }
    // Stop conditions.
    if (!wantsAll) break; // Single-page mode, respect caller's page.
    if (data.length === 0) break; // No more rows.
    if (reports.length >= cap) break; // Hit the scan budget.
    if (totalApi !== undefined && reports.length >= totalApi) break;
    currentPage += 1;
  }

  const resourceIdx = buildResourceIndex(includedAll);

  // Flatten by absencesPeriods, filter by overlap with the window.
  const rows: EnrichedAbsenceRow[] = [];
  for (const report of reports) {
    const a = attrs(report);
    const periods = (Array.isArray(a["absencesPeriods"]) ? (a["absencesPeriods"] as AbsencePeriod[]) : []) ?? [];
    const rid = relId(report, "resource");
    const r = rid ? resourceIdx.get(rid) : undefined;
    const reportState = typeof a["state"] === "string" ? (a["state"] as string) : null;
    for (const p of periods) {
      if (!p?.startDate || !p?.endDate) continue;
      if (!periodOverlapsWindow(p.startDate, p.endDate, startDate, endDate)) continue;
      rows.push({
        reportId: report.id,
        reportState,
        resourceId: rid,
        firstName: r?.firstName ?? null,
        lastName: r?.lastName ?? null,
        startDate: p.startDate,
        endDate: p.endDate,
        duration: typeof p.duration === "number" ? p.duration : null,
        title: typeof p.title === "string" && p.title ? p.title : null,
        typeName: p.workUnitType?.name ?? null,
      });
    }
  }

  // Sort by start date desc (newest first), then by lastName asc.
  rows.sort((a, b) => {
    const byDate = b.startDate.localeCompare(a.startDate);
    if (byDate !== 0) return byDate;
    return (a.lastName ?? "").localeCompare(b.lastName ?? "");
  });

  return {
    rows,
    totalReportsFetched: reports.length,
    totalReportsApi: totalApi,
    filtered: Boolean(startDate || endDate),
  };
}

function formatAbsencesOutput(result: Awaited<ReturnType<typeof searchAbsencesEnriched>>): string {
  if (result.rows.length === 0) {
    const reportsScope =
      result.totalReportsApi !== undefined
        ? `${result.totalReportsFetched} absences-reports scannés sur ${result.totalReportsApi} au total`
        : `${result.totalReportsFetched} absences-reports scannés`;
    return `Aucune période d'absence ne chevauche la fenêtre demandée.\n(${reportsScope}.)`;
  }
  const header = result.filtered
    ? `Total : ${result.rows.length} période(s) d'absence qui chevauche(nt) la fenêtre (${result.totalReportsFetched} absences-reports scannés).`
    : `Total : ${result.rows.length} période(s) d'absence (${result.totalReportsFetched} absences-reports scannés${result.totalReportsApi !== undefined ? ` sur ${result.totalReportsApi}` : ""}).`;

  const lines = result.rows.map((r) => {
    const name =
      r.lastName && r.firstName
        ? `${r.lastName} ${r.firstName}`
        : r.lastName || r.firstName || (r.resourceId ? `resource #${r.resourceId}` : "(ressource inconnue)");
    const window = r.startDate === r.endDate ? r.startDate : `${r.startDate} → ${r.endDate}`;
    const dur = r.duration !== null ? ` (${r.duration}j)` : "";
    const type = r.typeName ?? "(type inconnu)";
    const titleStr = r.title ? ` · ${r.title}` : "";
    const state = r.reportState ? ` · ${r.reportState}` : "";
    return `[absencesreport #${r.reportId}] ${name} | ${window}${dur} | ${type}${titleStr}${state}`;
  });

  return `${header}\n\n${lines.join("\n")}`;
}

const ABSENCES_SEARCH_DESCRIPTION = `Recherche des absences (congés, RTT, maladie, RDV...) dans BoondManager via \`/absences-reports\` — endpoint canonique aligné avec \`boond_absences_get\` (depuis v1.11.2, fix Bug 3 : la précédente version utilisait \`/absences\` qui renvoyait des IDs non résolvables en GET).

Args :
  - keywords (string, optional) : Termes de recherche
  - resourceId (string, optional) : Filtrer par ID ressource. Comme \`/absences-reports\` n'accepte pas un paramètre littéral \`resourceId=\`, le tool MCP injecte le préfixe \`COMP<id>\` dans \`keywords\` (même pattern que \`boond_actions_search\`).
  - startDate, endDate (YYYY-MM-DD, optional) : Fenêtre temporelle. Forwardés à l'API en best-effort + **filtrage côté serveur MCP** sur \`absencesPeriods[].startDate/endDate\` (overlap), source de vérité. Une absence est retenue si AU MOINS une de ses périodes chevauche la fenêtre.
  - fetchAll (boolean, optional) : Auto-pagination jusqu'à \`maxScannedReports\`. Forcé à true par défaut quand une fenêtre est précisée.
  - maxScannedReports (1-5000, default 1000) : Cap absolu de reports scannés en auto-pagination, garde-fou anti-runaway.
  - page, pageSize : Pagination manuelle (utilisée quand \`fetchAll: false\`).

Returns : une ligne par **période d'absence** (chaque absences-report peut en contenir plusieurs), enrichie avec : nom + prénom du collaborateur (résolus via JSON:API \`include=resource\`), bornes startDate/endDate, durée en jours, libellé du type (\`workUnitType.name\` ex: "RTT", "Congé payé"), titre éventuel (matin/après-midi), état du report (validated/waitingForValidation/rejected/...).`;

export function registerAbsenceTools(server: McpServer): void {
  server.registerTool(
    "boond_absences_search",
    {
      title: "Rechercher des absences",
      description: ABSENCES_SEARCH_DESCRIPTION,
      inputSchema: AbsenceSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const result = await searchAbsencesEnriched(params as AbsenceSearchInput);
      return {
        content: [{ type: "text" as const, text: formatAbsencesOutput(result) }],
      };
    }
  );

  server.registerTool(
    "boond_absences_get",
    {
      title: "Détails d'une absence",
      description: `Récupère les informations détaillées d'une absence (absences-report) par son ID, incluant le tableau des périodes (\`absencesPeriods[]\`) avec dates, durée et type.

⚠️ Pour les IDs anciens potentiellement issus d'une version précédente du tool \`boond_absences_search\` (qui pointait sur \`/absences\` au lieu de \`/absences-reports\`), un 404 peut indiquer un ID issu d'une autre entité que \`absences-reports\`. La v1.11.2 corrige ce mismatch côté search.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const response = await apiRequest(`/absences-reports/${params.id}`);
      return {
        content: [{ type: "text" as const, text: formatDetailResponse(response) }],
      };
    }
  );

  server.registerTool(
    "boond_absences_create",
    {
      title: "Créer une absence",
      description: `Crée une nouvelle demande d'absence dans BoondManager, liée à une ressource.`,
      inputSchema: AbsenceCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { resourceId, ...attrs } = params;
      const body = buildJsonApiBody("absence", attrs);
      if (resourceId) {
        (body as Record<string, Record<string, unknown>>).data.relationships = {
          resource: { data: { id: resourceId, type: "resource" } },
        };
      }
      const response = await apiRequest("/absences-reports", "POST", body);
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Absence créée avec succès.\nID: ${entity?.id}\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "boond_absences_update",
    {
      title: "Modifier une absence",
      description: `Met à jour une absence existante. Seuls les champs fournis sont modifiés.`,
      inputSchema: AbsenceUpdateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { id, ...attrs } = params;
      const body = buildJsonApiBody("absence", attrs, id);
      const response = await apiRequest(`/absences-reports/${id}`, "PUT", body);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Absence #${id} mise à jour.\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "boond_absences_delete",
    {
      title: "Supprimer une absence",
      description: `Supprime une absence de BoondManager. ⚠️ Action irréversible.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      await apiRequest(`/absences-reports/${params.id}`, "DELETE");
      return {
        content: [{ type: "text" as const, text: `🗑️ Absence #${params.id} supprimée.` }],
      };
    }
  );
}
