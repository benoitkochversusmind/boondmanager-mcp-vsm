import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActionSearchSchema, ActionCreateSchema, IdSchema } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { logger } from "../services/logger.js";
import { buildJsonApiBody } from "./crud-factory.js";

// Per-action soft cap on the `text` field. Action notes can be paragraphs;
// the list view stays readable if we trim each one. Callers needing the full
// note can fall back to boond_actions_get.
const ACTION_TEXT_MAX = 300;

// Action notes from BoondManager are stored as HTML (the web UI uses a rich
// text editor), so a raw dump leaks <p>, <br>, &nbsp; etc. into the MCP output.
// We strip tags and decode the handful of entities that actually appear in
// practice — full HTML entity decoding would need a library, but this covers
// the noise we see.
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&gt;": ">",
  "&lt;": "<",
  "&nbsp;": " ",
  "&#39;": "'",
};

export function stripHtml(input: string): string {
  // Replace tags with a space so adjacent block tags (e.g. </p><p>) don't
  // glue paragraphs together. The trailing whitespace collapse normalizes
  // the runs we introduce here back to single spaces.
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;|&gt;|&lt;|&nbsp;|&#39;/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

// Best-effort coercion of the action `typeOf` field — per the BoondManager RAML
// the list endpoint exposes `typeOf` (often a numeric ID) but not `typeLabel`,
// so we use whatever shape we get. A separate dictionary lookup (setting.typeOf.action
// via boond_application_dictionary) is needed to resolve IDs to human labels.
function formatActionType(attrs: Record<string, unknown>): string | undefined {
  if (attrs.typeLabel) return String(attrs.typeLabel);
  const t = attrs.typeOf;
  if (t === undefined || t === null) return undefined;
  if (typeof t === "string" || typeof t === "number") return `type#${t}`;
  if (typeof t === "object") {
    const o = t as Record<string, unknown>;
    if (o.label) return String(o.label);
    if (o.name) return String(o.name);
    if (o.id !== undefined) return `type#${String(o.id)}`;
  }
  return undefined;
}

export function formatActionSummary(entity: unknown): string {
  const e = (entity ?? {}) as Record<string, unknown>;
  const id = e.id !== undefined ? String(e.id) : "?";
  const attrs = (e.attributes ?? {}) as Record<string, unknown>;
  const parts: string[] = [`[action #${id}]`];

  if (attrs.startDate) parts.push(String(attrs.startDate));
  const type = formatActionType(attrs);
  if (type) parts.push(type);

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
    const txt = stripHtml(String(attrs.text));
    if (txt) {
      parts.push(txt.length > ACTION_TEXT_MAX ? `${txt.slice(0, ACTION_TEXT_MAX)}…` : txt);
    }
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

Returns: Liste des actions correspondantes.

⚠️ Limitations connues de l'endpoint /actions (liste) côté BoondManager :
  - Le label du type d'action n'est pas garanti. Seul \`typeOf\` (ID numérique) est exposé par défaut ; le rendu affiche alors \`type#<id>\`. Pour traduire en label, utiliser \`boond_application_dictionary\` avec \`type = setting.typeOf.action\`.
  - L'auteur (\`manager.nom\`) et l'entité liée (\`linkedTo\`) ne sont pas remontés dans le payload de liste par défaut. Pour ces champs, appeler \`boond_actions_get\` sur l'ID concerné.
  - Le filtre \`period: 'created'\` cible le champ \`started\` de l'action et non la date de création réelle en base — limitation côté API BoondManager elle-même.`,
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
      // One-shot shape inspection: emits a structured trace of the first item
      // when LOG_LEVEL=debug. Cheap to leave on (only the keys + a single
      // sample payload at debug level), and the only way to confirm what
      // BoondManager actually returns without re-deploying. Strip later if
      // it ever shows up in noise.
      if (logger.isLevelEnabled("debug")) {
        const data = Array.isArray(response.data) ? response.data : [response.data];
        const sample = data[0];
        logger.debug(
          {
            count: data.length,
            attributeKeys: sample?.attributes ? Object.keys(sample.attributes) : [],
            relationshipKeys: sample?.relationships ? Object.keys(sample.relationships) : [],
            includedTypes: Array.isArray(response.included)
              ? Array.from(new Set(response.included.map((r) => r.type)))
              : [],
            sample,
          },
          "boond_actions_search raw shape"
        );
      }
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
