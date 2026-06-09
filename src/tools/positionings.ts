import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PositioningSearchSchema, PositioningCreateSchema, IdSchema } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { buildJsonApiBody } from "./crud-factory.js";
import { getStateMap } from "../services/dictionary.js";
import type { JsonApiResponse, JsonApiResource } from "../types.js";

// ---- Positioning list formatter --------------------------------------------
//
// The generic `formatEntitySummary` only surfaces name/state/title, so the
// creationDate / updateDate that the BoondManager `/positionings` payload
// actually carries (verified live) were invisible on search + tab outputs.
// `formatPositioningsList` renders one line per positioning WITH those dates,
// the (label-resolved) state, the period, and the linked entities — mirroring
// the `formatActionsList` / `formatInvoiceList` pattern. Used by
// `boond_positionings_search`, `boond_positionings_get`, and the
// `boond_{candidates,resources,opportunities}_positionings` tab tools.

const POSITIONING_INCLUDE = "candidate,resource,project,opportunity";

function asAttrs(r: JsonApiResource): Record<string, unknown> {
  return (r.attributes ?? {}) as Record<string, unknown>;
}

/** "2026-06-09T18:53:13+0200" → "2026-06-09 18:53" ; "" / non-string → null. */
function fmtStamp(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 10) return null;
  const date = v.slice(0, 10);
  const time = v.length >= 16 ? v.slice(11, 16) : "";
  return time ? `${date} ${time}` : date;
}

function indexIncluded(resp: JsonApiResponse): Map<string, JsonApiResource> {
  const m = new Map<string, JsonApiResource>();
  const inc = (resp as { included?: JsonApiResource[] }).included;
  if (Array.isArray(inc)) {
    for (const it of inc) if (it && it.id && it.type) m.set(`${it.type}:${it.id}`, it);
  }
  return m;
}

function relRef(r: JsonApiResource, key: string): { type: string; id: string } | null {
  const rels = (r.relationships ?? {}) as Record<string, { data?: { type?: string; id?: string } | null }>;
  const d = rels[key]?.data;
  return d && d.id && d.type ? { type: d.type, id: d.id } : null;
}

function displayEntity(ref: { type: string; id: string } | null, inc: Map<string, JsonApiResource>): string | null {
  if (!ref) return null;
  const e = inc.get(`${ref.type}:${ref.id}`);
  if (e) {
    const a = asAttrs(e);
    const name =
      [a["firstName"], a["lastName"]].filter(Boolean).join(" ").trim() ||
      (a["title"] as string) ||
      (a["reference"] as string) ||
      (a["name"] as string);
    if (name) return `${name} (${ref.type} #${ref.id})`;
  }
  return `${ref.type} #${ref.id}`;
}

export async function formatPositioningsList(response: JsonApiResponse): Promise<string> {
  const data = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
  if (data.length === 0) return "Aucun positionnement trouvé.";

  let stateById: Map<number, string> | undefined;
  try {
    stateById = (await getStateMap("positioning")).byId;
  } catch {
    // Best effort — fall back to the numeric state if the dictionary is down.
  }
  const inc = indexIncluded(response);

  const lines = data.map((p) => {
    const a = asAttrs(p);
    const who = displayEntity(relRef(p, "candidate") ?? relRef(p, "resource"), inc);
    const what = displayEntity(relRef(p, "project") ?? relRef(p, "opportunity"), inc);

    const parts: string[] = [`[positioning #${p.id}]`];
    // Combine the two linked entities into one segment so the "→" only ever
    // sits between them — avoids a stray "· →" when one side is missing.
    const link = [who, what].filter(Boolean).join(" → ");
    if (link) parts.push(link);

    const stateNum = Number(a["state"]);
    if (Number.isFinite(stateNum)) parts.push(stateById?.get(stateNum) ?? `état ${stateNum}`);

    const start = typeof a["startDate"] === "string" && a["startDate"] ? (a["startDate"] as string) : null;
    const end = typeof a["endDate"] === "string" && a["endDate"] ? (a["endDate"] as string) : null;
    if (start || end) parts.push(`${start ?? "?"} → ${end ?? "?"}`);

    const created = fmtStamp(a["creationDate"]);
    const updated = fmtStamp(a["updateDate"]);
    if (created) parts.push(`créé ${created}`);
    if (updated) parts.push(`MàJ ${updated}`);

    return parts.join(" · ");
  });

  const total = (response as { meta?: { totals?: { rows?: number } } }).meta?.totals?.rows;
  const header = total !== undefined ? `Total: ${total} positionnement(s)` : `${data.length} positionnement(s)`;
  return [header, ...lines].join("\n");
}

export function registerPositioningTools(server: McpServer): void {
  // Search positionings
  server.registerTool(
    "boond_positionings_search",
    {
      title: "Rechercher des positionnements",
      description: `Recherche des positionnements (placement de candidats/ressources sur des projets/opportunités) dans BoondManager.

Args:
  - keywords (string, optional): Termes de recherche
  - candidateId, resourceId, projectId, opportunityId (string, optional): Filtrer par entité liée
  - page, pageSize: Pagination

Returns: Une ligne par positionnement avec entité(s) liée(s), état (libellé), période, et **date de création + date de mise à jour**.`,
      inputSchema: PositioningSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const query = buildSearchQuery(params);
      query["include"] = POSITIONING_INCLUDE;
      const response = await apiRequest("/positionings", "GET", undefined, query);
      return {
        content: [{ type: "text" as const, text: await formatPositioningsList(response) }],
      };
    }
  );

  // Get positioning details
  server.registerTool(
    "boond_positionings_get",
    {
      title: "Détails d'un positionnement",
      description: `Récupère les informations détaillées d'un positionnement par son ID (état, période, date de création, date de mise à jour, simulation, entités liées).`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const response = await apiRequest(`/positionings/${params.id}`, "GET", undefined, {
        include: POSITIONING_INCLUDE,
      });
      // Clean one-line summary (with the dates) on top of the full JSON:API payload.
      const summary = await formatPositioningsList(response);
      return {
        content: [{ type: "text" as const, text: `${summary}\n\n${formatDetailResponse(response)}` }],
      };
    }
  );

  // Create positioning
  server.registerTool(
    "boond_positionings_create",
    {
      title: "Créer un positionnement",
      description: `Crée un nouveau positionnement pour placer un candidat ou une ressource sur un projet ou une opportunité.`,
      inputSchema: PositioningCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { candidateId, resourceId, projectId, opportunityId, ...attrs } = params;
      const body = buildJsonApiBody("positioning", attrs);
      const relationships: Record<string, unknown> = {};
      if (candidateId) relationships.candidate = { data: { id: candidateId, type: "candidate" } };
      if (resourceId) relationships.resource = { data: { id: resourceId, type: "resource" } };
      if (projectId) relationships.project = { data: { id: projectId, type: "project" } };
      if (opportunityId) relationships.opportunity = { data: { id: opportunityId, type: "opportunity" } };
      if (Object.keys(relationships).length > 0) {
        (body as Record<string, Record<string, unknown>>).data.relationships = relationships;
      }
      const response = await apiRequest("/positionings", "POST", body);
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Positionnement créé avec succès.\nID: ${entity?.id}\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  // Delete positioning
  server.registerTool(
    "boond_positionings_delete",
    {
      title: "Supprimer un positionnement",
      description: `Supprime un positionnement de BoondManager. ⚠️ Action irréversible.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      await apiRequest(`/positionings/${params.id}`, "DELETE");
      return {
        content: [{ type: "text" as const, text: `🗑️ Positionnement #${params.id} supprimé.` }],
      };
    }
  );
}
