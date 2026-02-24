import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActionSearchSchema, ActionCreateSchema, IdSchema } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatListResponse, formatDetailResponse } from "../services/boond-client.js";
import { buildJsonApiBody } from "./crud-factory.js";

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
        content: [{ type: "text" as const, text: formatListResponse(response, "action") }],
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
        content: [{
          type: "text" as const,
          text: `✅ Action créée avec succès.\nID: ${entity?.id}\n\n${formatDetailResponse(response)}`,
        }],
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
