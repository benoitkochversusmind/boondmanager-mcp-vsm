import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActionSearchSchema, ActionCreateSchema, IdSchema } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { getDictionary, resolveDictionaryPath } from "../services/dictionary.js";
import { logger } from "../services/logger.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";
import { buildJsonApiBody } from "./crud-factory.js";

// Per-action soft cap on the `text` field. Action notes can be paragraphs;
// the list view stays readable if we trim each one. Callers needing the full
// note can fall back to boond_actions_get.
const ACTION_TEXT_MAX = 300;

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

// ---- Action type label cache ----------------------------------------------
// The /actions list returns `typeOf` as a numeric id (e.g. 35). BoondManager
// exposes the label table at setting.action via the dictionary endpoint
// (confirmed by probing the live payload on 2026-05-20: data.setting.action
// is the right node — neither `actionTypes` nor `setting.typeOf.action`).
// We load it once per process the first time we need it and keep it in memory.
// On lookup failure we cache an empty map so a transient API issue doesn't
// cascade into a retry on every search.

let actionTypeLabels: Map<number, string> | null = null;
let actionTypeLabelsInFlight: Promise<Map<number, string>> | null = null;

// Candidate dictionary paths for action types. setting.action is the real
// path; the others are defensive fallbacks in case BoondManager renames it.
const ACTION_TYPE_DICT_PATHS = ["setting.action", "actionTypes", "setting.typeOf.action"] as const;

// Builds the id → label map from whatever shape the dictionary node has.
// Real BoondManager payloads use `{ id, value }`, but a few endpoints have
// drifted to `{ id, label }` or `{ id, name }`, and at least one ships as
// a plain record `{ "35": "Note", … }`. Be tolerant.
export function parseDictionaryNode(node: unknown): Map<number, string> {
  const out = new Map<number, string>();
  if (Array.isArray(node)) {
    for (const item of node) {
      if (!item || typeof item !== "object") continue;
      const i = item as { id?: unknown; value?: unknown; label?: unknown; name?: unknown };
      const numId = typeof i.id === "number" ? i.id : Number(i.id);
      const label = i.value ?? i.label ?? i.name;
      if (Number.isFinite(numId) && label !== undefined && label !== null) {
        out.set(numId, String(label));
      }
    }
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const numId = Number(k);
      if (Number.isFinite(numId) && v !== undefined && v !== null) {
        // Object value can itself be `{ value }`, `{ label }`, or a plain string.
        if (typeof v === "string") {
          out.set(numId, v);
        } else if (typeof v === "object") {
          const o = v as { value?: unknown; label?: unknown; name?: unknown };
          const label = o.value ?? o.label ?? o.name;
          if (label !== undefined && label !== null) out.set(numId, String(label));
        }
      }
    }
  }
  return out;
}

async function loadActionTypeLabels(): Promise<Map<number, string>> {
  if (actionTypeLabels) return actionTypeLabels;
  if (actionTypeLabelsInFlight) return actionTypeLabelsInFlight;
  actionTypeLabelsInFlight = (async () => {
    try {
      const { payload } = await getDictionary();
      logger.warn({ payloadKeys: Object.keys(payload as object) }, "Dictionary payload top-level keys");
      for (const path of ACTION_TYPE_DICT_PATHS) {
        const node = resolveDictionaryPath(payload, path);
        const map = parseDictionaryNode(node);
        if (map.size > 0) {
          logger.debug({ path, size: map.size }, "Loaded action type labels");
          actionTypeLabels = map;
          return map;
        }
      }
      logger.warn({ tried: ACTION_TYPE_DICT_PATHS }, "No usable action-type dictionary found; falling back to type#N");
      actionTypeLabels = new Map();
      return actionTypeLabels;
    } catch (err) {
      logger.warn({ err }, "Failed to load action-type dictionary; falling back to type#N");
      actionTypeLabels = new Map();
      return actionTypeLabels;
    } finally {
      actionTypeLabelsInFlight = null;
    }
  })();
  return actionTypeLabelsInFlight;
}

export function resetActionTypeLabelsForTests(): void {
  actionTypeLabels = null;
  actionTypeLabelsInFlight = null;
}

// ---- JSON:API included resolution -----------------------------------------
// /actions returns relationships (mainManager, dependsOn, company, ...) whose
// full attributes are in the top-level `included` array. We index that array
// once per response and resolve relationships via lookups.

type IncludedIndex = Map<string, JsonApiResource>;

function buildIncludedIndex(response: JsonApiResponse): IncludedIndex {
  const idx: IncludedIndex = new Map();
  for (const r of response.included ?? []) {
    idx.set(`${r.type}:${r.id}`, r);
  }
  return idx;
}

function lookupRelated(included: IncludedIndex, rel: unknown): JsonApiResource | undefined {
  if (!rel || typeof rel !== "object") return undefined;
  const data = (rel as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const ref = data as { id?: string; type?: string };
  if (!ref.id || !ref.type) return undefined;
  return included.get(`${ref.type}:${ref.id}`);
}

function formatPersonName(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return "";
  const fn = attrs.firstName ? String(attrs.firstName) : "";
  const ln = attrs.lastName ? String(attrs.lastName) : "";
  return [fn, ln].filter(Boolean).join(" ").trim();
}

function formatRelatedEntityLabel(entity: JsonApiResource): string {
  const attrs = entity.attributes ?? {};
  if (attrs.name) return String(attrs.name);
  const person = formatPersonName(attrs as Record<string, unknown>);
  return person || `#${entity.id}`;
}

// ---- Formatter ------------------------------------------------------------

export interface ActionFormatContext {
  included: IncludedIndex;
  typeLabels: Map<number, string>;
}

export function formatActionSummary(entity: unknown, ctx?: ActionFormatContext): string {
  const e = (entity ?? {}) as Record<string, unknown>;
  const id = e.id !== undefined ? String(e.id) : "?";
  const attrs = (e.attributes ?? {}) as Record<string, unknown>;
  const rels = (e.relationships ?? {}) as Record<string, unknown>;
  const parts: string[] = [`[action #${id}]`];

  if (attrs.startDate) parts.push(String(attrs.startDate));

  // typeOf — dictionary label when available, fallback to type#N.
  const typeOf = attrs.typeOf;
  if (typeOf !== undefined && typeOf !== null) {
    const numId = typeof typeOf === "number" ? typeOf : Number(typeOf);
    if (Number.isFinite(numId)) {
      const label = ctx?.typeLabels.get(numId);
      parts.push(label ?? `type#${numId}`);
    } else if (typeof typeOf === "string") {
      parts.push(`type#${typeOf}`);
    }
  }

  // Author — via JSON:API relationships.mainManager → included resource.
  if (ctx?.included) {
    const mgr = lookupRelated(ctx.included, rels.mainManager);
    if (mgr) {
      const name = formatPersonName(mgr.attributes as Record<string, unknown>);
      if (name) parts.push(`par ${name}`);
    }
  }

  // Linked entity — via relationships.dependsOn → included contact / candidate /
  // company / opportunity. Falls back gracefully to the raw {type, id} ref when
  // the include resolution misses (rare but possible if BoondManager omits the
  // include for some relationship).
  if (ctx?.included) {
    const dep = lookupRelated(ctx.included, rels.dependsOn);
    if (dep) {
      parts.push(`→ ${dep.type} ${formatRelatedEntityLabel(dep)} (#${dep.id})`);
    }
  }

  if (attrs.text) {
    const txt = stripHtml(String(attrs.text));
    if (txt) {
      parts.push(txt.length > ACTION_TEXT_MAX ? `${txt.slice(0, ACTION_TEXT_MAX)}…` : txt);
    }
  }

  return parts.join(" | ");
}

async function formatActionsList(response: JsonApiResponse): Promise<string> {
  const data = Array.isArray(response.data) ? response.data : [response.data];
  if (data.length === 0 || (data.length === 1 && !data[0])) {
    return "Aucun(e) action trouvé(e).";
  }
  const included = buildIncludedIndex(response);
  const typeLabels = await loadActionTypeLabels();
  const ctx: ActionFormatContext = { included, typeLabels };
  const total = response.meta?.totals?.rows;
  const lines = data.map((item) => formatActionSummary(item, ctx));
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
      description: `Recherche des actions (appels, emails, RDV, notes) dans BoondManager avec filtres optionnels par candidat, ressource, contact, société ou auteur.

Args:
  - keywords (string, optional): Termes de recherche
  - candidateId, resourceId, contactId, companyId (string, optional): Filtrer par entité liée
  - managerId (string, optional): Filtrer par auteur (ID de la ressource manager — mappé sur \`mainManagers[]\` côté API)
  - dateFrom, dateTo (YYYY-MM-DD, optional): Bornes de période
  - period ('started' | 'created' | 'updated', défaut 'started'): Champ date sur lequel s'appliquent dateFrom/dateTo
  - page, pageSize: Pagination

Returns: Liste des actions. Chaque ligne contient \`[action #id] | date | type | par auteur | → entité liée | extrait du texte\`. Le label de type est résolu via \`setting.typeOf.action\` (dictionnaire BoondManager, mis en cache). L'auteur et l'entité liée sont résolus via le tableau JSON:API \`included\` de la réponse.

ℹ️ Le filtre \`period: 'created'\` cible le champ \`started\` de l'action côté API BoondManager (et non la date de création réelle en base) — limitation côté API.`,
      inputSchema: ActionSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const { managerId, ...rest } = params;
      const query = buildSearchQuery(rest);
      if (managerId) {
        // BoondManager expects the array form mainManagers[]=<id>. We keep
        // the schema name singular (managerId) for ergonomic parity with the
        // existing candidateId / resourceId / contactId / companyId filters.
        query.mainManagers = [managerId];
      }
      const response = await apiRequest("/actions", "GET", undefined, query);
      return {
        content: [{ type: "text" as const, text: await formatActionsList(response) }],
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
