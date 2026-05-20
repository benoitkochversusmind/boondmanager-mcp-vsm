import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActionSearchSchema, ActionCreateSchema, IdSchema } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { buildJsonApiBody } from "./crud-factory.js";

// Per-action soft cap on the `text` field. Action notes can be paragraphs;
// the list view stays readable if we trim each one. Callers needing the full
// note can fall back to boond_actions_get.
const ACTION_TEXT_MAX = 300;

export function formatActionSummary(entity: unknown): string {
  const e = (entity ?? {}) as Record<string, unknown>;
  const id = e.id !== undefined ? String(e.id) : "?";
  const attrs = (e.attributes ?? {}) as Record<string, unknown>;
  const parts: string[] = [`[action #${id}]`];

  if (attrs.startDate) parts.push(String(attrs.startDate));
  if (attrs.typeLabel) parts.push(String(attrs.typeLabel));

  const manager = attrs.manager;
  if (manager && typeof manager === "object") {
    const mgr = manager as Record<string, unknown>;
    if (mgr.nom) parts.push(`par ${String(mgr.nom)}`);
  }

  const linked = attrs.linkedTo;
  if (linked && typeof linked === "object") {
    const lk = linked as Record<string, unknown>;
    const t = lk.type ? String(lk.type) : "";
    const n = lk.nom ? String(lk.nom) : "";
    const lid = lk.id !== undefined ? String(lk.id) : "";
    const label = [t, n].filter(Boolean).join(" ");
    const tail = lid ? `${label} (#${lid})`.trim() : label;
    if (tail) parts.push(`→ ${tail}`);
  }

  if (attrs.text) {
    const txt = String(attrs.text).replace(/\s+/g, " ").trim();
    parts.push(txt.length > ACTION_TEXT_MAX ? `${txt.slice(0, ACTION_TEXT_MAX)}…` : txt);
  }

  return parts.join(" | ");
}

function formatActionsList(response: { data: unknown; meta?: { totals?: { rows?: number } } }): string {
  const data = Array.isArray(response.data) ? response.data : [response.data];
  if (data.length === 0 || (data.length === 1 && !data[0])) {
    return "Aucun(e) action trouvé(e).";
  }
  const total = response.meta?.totals?.rows;
  const lines = data.map((item) => formatActionSummary(item));
  let result = lines.join("\n");
  if (total !== undefined) {
    result = `Total: ${total} action(s)\n\n${result}`;
  }
  if (result.length > CHARACTER_LIMIT) {
    result = result.substring(0, CHARACTER_LIMIT) + "\n\n[Résultats tronqués...]";
  }
  return result;
}

export function registerActionTools(server: McpServer): void {
  // Search actions
  server.registerTool(
    "boond_actions_search",
    {
      title: "Rechercher des actions",
      description: `Recherche des actions (appels, emails, RDV, notes) dans BoondManager avec filtres optionnels par candidat, ressource, contact ou société.

Args:
  - keywords (string, optional): Termes de recherche
  - candidateId, resourceId, contactId, companyId (string, optional): Filtrer par entité liée
  - dateFrom, dateTo (YYYY-MM-DD, optional): Bornes de période
  - period ('started' | 'created' | 'updated', défaut 'started'): Champ date sur lequel s'appliquent dateFrom/dateTo
  - page, pageSize: Pagination

Returns: Liste des actions correspondantes.`,
      inputSchema: ActionSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const query = buildSearchQuery(params);
      const response = await apiRequest("/actions", "GET", undefined, query);
      return {
        content: [{ type: "text" as const, text: formatActionsList(response) }],
      };
    }
  );

  // Get action details
  server.registerTool(
    "boond_actions_get",
    {
      title: "Détails d'une action",
      description: `Récupère les détails d'une action par son ID.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const response = await apiRequest(`/actions/${params.id}`);
      return {
        content: [{ type: "text" as const, text: formatDetailResponse(response) }],
      };
    }
  );

  // Create action
  server.registerTool(
    "boond_actions_create",
    {
      title: "Créer une action",
      description: `Crée une nouvelle action (appel, email, RDV, note) dans BoondManager, optionnellement liée à un candidat, ressource, contact ou société.`,
      inputSchema: ActionCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { candidateId, resourceId, contactId, companyId, ...attrs } = params;
      const body = buildJsonApiBody("action", attrs);
      const relationships: Record<string, unknown> = {};
      if (candidateId) relationships.candidate = { data: { id: candidateId, type: "candidate" } };
      if (resourceId) relationships.resource = { data: { id: resourceId, type: "resource" } };
      if (contactId) relationships.contact = { data: { id: contactId, type: "contact" } };
      if (companyId) relationships.company = { data: { id: companyId, type: "company" } };
      if (Object.keys(relationships).length > 0) {
        (body as Record<string, Record<string, unknown>>).data.relationships = relationships;
      }
      const response = await apiRequest("/actions", "POST", body);
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Action créée avec succès.\nID: ${entity?.id}\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  // Delete action
  server.registerTool(
    "boond_actions_delete",
    {
      title: "Supprimer une action",
      description: `Supprime une action de BoondManager. ⚠️ Action irréversible.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      await apiRequest(`/actions/${params.id}`, "DELETE");
      return {
        content: [{ type: "text" as const, text: `🗑️ Action #${params.id} supprimée.` }],
      };
    }
  );
}
