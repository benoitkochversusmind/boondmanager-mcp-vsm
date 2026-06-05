import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActionSearchSchema, ActionCreateSchema, IdSchema } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { getDictionary, resolveDictionaryPath } from "../services/dictionary.js";
import { logger } from "../services/logger.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";

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
// The /actions list returns `typeOf` as a numeric id (e.g. 35). The label
// table lives at data.setting.action in the BoondManager dictionary, but its
// shape is not a flat array — it is an object scoped per linkable entity:
//
//   setting.action = {
//     forceMultiCreation: true,
//     sort: false,
//     contact:     [ { id: 35, value: "Prospection ...", ... }, ... ],
//     candidate:   [ ... ],
//     resource:    [ ... ],
//     opportunity: [ ... ],
//     project:     [ ... ],
//     order:       [ ... ],
//     invoice:     [ ... ],
//   }
//
// Action-type ids are unique across the whole org; the per-entity buckets
// are access-control views, not separate namespaces. We merge every array
// under setting.action into one id → label map, skipping non-array siblings
// (forceMultiCreation / sort). Confirmed empirically by probing prod on
// 2026-05-20 — see git history for the probes that led here.
//
// Loaded once per process, cached for its lifetime. On failure we cache an
// empty map so a transient API hiccup doesn't make every search retry.

let actionTypeLabels: Map<number, string> | null = null;
let actionTypeLabelsInFlight: Promise<Map<number, string>> | null = null;

// Defensive fallback paths in case the shape above shifts and the merge
// finds nothing. Both have been observed empty in current BoondManager
// versions but cost nothing to try.
const FALLBACK_DICT_PATHS = ["actionTypes", "setting.typeOf.action"] as const;

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

// Merges every array found under setting.action.* into a single id → label
// map. Non-array sibling values (forceMultiCreation, sort) are skipped.
// Exported for unit tests.
export function mergeActionDictionary(node: unknown): Map<number, string> {
  const map = new Map<number, string>();
  if (!node || typeof node !== "object" || Array.isArray(node)) return map;
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const [id, label] of parseDictionaryNode(value)) {
      map.set(id, label);
    }
  }
  return map;
}

async function loadActionTypeLabels(): Promise<Map<number, string>> {
  if (actionTypeLabels) return actionTypeLabels;
  if (actionTypeLabelsInFlight) return actionTypeLabelsInFlight;
  actionTypeLabelsInFlight = (async () => {
    try {
      const { payload } = await getDictionary();

      // Primary path — the per-entity scoped object at setting.action.
      const settingAction = resolveDictionaryPath(payload, "setting.action");
      const merged = mergeActionDictionary(settingAction);
      if (merged.size > 0) {
        logger.debug({ size: merged.size }, "Loaded action type labels from setting.action");
        actionTypeLabels = merged;
        return merged;
      }

      // Defensive fallbacks for future-proofing if the shape changes.
      for (const path of FALLBACK_DICT_PATHS) {
        const fallback = parseDictionaryNode(resolveDictionaryPath(payload, path));
        if (fallback.size > 0) {
          logger.debug({ path, size: fallback.size }, "Loaded action type labels (fallback path)");
          actionTypeLabels = fallback;
          return fallback;
        }
      }

      logger.warn("No usable action-type dictionary found; falling back to type#N");
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

// ---- Static fallback type labels ------------------------------------------
// Ported from the legacy local MCP server (boond-mcp-server/index.js lines
// 49-93). These are last-resort labels when the BoondManager dictionary is
// unreachable (network blip, transient auth failure) OR doesn't expose a
// type ID we encountered. The two scopes match how BoondManager itself
// segments the action dictionary (`setting.action.candidate`,
// `setting.action.contact`) — the same numeric ID can mean different things
// depending on which entity the action depends on, so we pick the bucket
// from `dependsOn.type`.

const STATIC_TYPE_LABELS_CANDIDATE: Record<number, string> = {
  44: "1 - Pré-qualification téléphonique",
  17: "1 bis - (Re)prise de contact",
  18: "2 - Relance",
  19: "3 - Entretien 1 - présentiel",
  12: "3 - Entretien 1 - visioconférence",
  22: "4 - Entretien 2 - présentiel avec le futur Manager",
  23: "5 - Entretien complémentaire",
  133: "5 bis - Entretien technique",
  130: "6 - Proposition d'embauche",
  6: "7 - Préparation de la Réunion de Qualification",
  0: "7 - Présentation Client - Klif",
  43: "8 - Signature du contrat de travail",
  13: "Note",
  1: "Rappel / To do",
  41: "Appel",
  42: "Email",
  131: "Lien vers dossier de compétences",
  132: "Résultats tests techniques",
  134: "Prise de références",
  14: "Réponse positive candidat",
  15: "Réponse négative candidat",
  26: "Infocom",
};

const STATIC_TYPE_LABELS_CONTACT: Record<number, string> = {
  61: "1 - Prospection Appel (tentative)",
  35: "1 bis - Prospection - autre prise de contact",
  28: "2 - Echange téléphonique (appel abouti)",
  29: "3 - Rendez-vous client",
  10: "4 - Réunion de qualification",
  11: "5 - Suivi de projet",
  24: "6 - Autre contact (RS, email, ...)",
  2: "Note",
  3: "Rappel / To do",
};

/**
 * Resolves a numeric action `typeOf` to a human label, picking the right
 * scope based on the linked entity:
 *   - "contact" → contact bucket (prospection, RDV client, etc.)
 *   - anything else → candidate/resource bucket (recrutement)
 *
 * Priority order:
 *   1. Live dictionary cache (most accurate, reflects the org's customizations).
 *   2. Scoped static fallback (last-known good shape for the VSM instance).
 *   3. `type#<id>` placeholder so the UI never shows raw numbers.
 */
export function resolveActionLabel(
  typeId: number,
  dependsOnType: string | undefined,
  liveLabels: Map<number, string> | undefined
): string {
  const live = liveLabels?.get(typeId);
  if (live) return live;
  const isContact = dependsOnType === "contact";
  const fallback = isContact ? STATIC_TYPE_LABELS_CONTACT[typeId] : STATIC_TYPE_LABELS_CANDIDATE[typeId];
  return fallback ?? `type#${typeId}`;
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

  // dependsOn.type is the dictionary scope: candidate-bucket vs contact-bucket.
  // We resolve it once and pass it to both the typeOf label resolution AND
  // the linked-entity rendering below.
  const dependsOnRef = (rels.dependsOn as { data?: { type?: string } } | undefined)?.data;
  const dependsOnType = dependsOnRef?.type;

  // typeOf — live dictionary first, then scoped static fallback, then type#N.
  const typeOf = attrs.typeOf;
  if (typeOf !== undefined && typeOf !== null) {
    const numId = typeof typeOf === "number" ? typeOf : Number(typeOf);
    if (Number.isFinite(numId)) {
      parts.push(resolveActionLabel(numId, dependsOnType, ctx?.typeLabels));
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

export async function formatActionsList(response: JsonApiResponse): Promise<string> {
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

/**
 * Textual shortcut → BoondManager `actionTypes[]` IDs.
 *
 * Ported from the legacy local MCP server (boond-mcp-server/index.js) where it
 * powered get_actions_log. The IDs are stable across the VSM instance; if a
 * sibling org has different IDs, callers should fall back to passing `typeOf`
 * (numeric array) directly — explicit IDs always win over this lookup.
 *
 * The mapping is intentionally generous: multiple aliases per intent
 * (e.g. "rdv" + "rendez-vous", "entretien" matches all variants), and
 * groups multiple IDs under the same keyword when several action types
 * share a semantic role (e.g. "entretien" → [19, 12, 22, 23, 133]
 * covers présentiel + visio + 2nd round + complémentaire + technique).
 */
const KEYWORD_TO_TYPES: Record<string, number[]> = {
  entretien: [19, 12, 22, 23, 133],
  "entretien 1": [19, 12],
  "entretien 2": [22],
  visio: [12],
  présentiel: [19, 22],
  technique: [133],
  qualification: [44],
  "pré-qualification": [44],
  relance: [18],
  reprise: [17],
  note: [13, 50, 2],
  rappel: [1, 51, 3],
  appel: [41, 53],
  email: [42],
  proposition: [130],
  embauche: [130],
  signature: [43],
  présentation: [52, 0],
  test: [132],
  résultats: [132],
  référence: [134],
  infocom: [26],
  prospection: [61, 35],
  "rendez-vous": [29, 55],
  rdv: [29, 55],
  soutenance: [54],
  revue: [56],
  recrutement: [34],
};

// ---- Action creation helpers ----------------------------------------------
// Bound by the actual API shape verified live on 2026-05-27 :
//   GET /actions/216050 returns
//     attributes.typeOf      : integer (not string)
//     attributes.title, text : the real attribute names (not subject/content)
//     attributes.startDate   : ISO 8601 with offset, e.g. "2026-05-11T14:00:00+0200"
//     relationships.dependsOn: { data: { id, type: <linked-entity-type> } } — REQUIRED, polymorphic
//     relationships.mainManager: { data: { id, type: "resource" } } — the responsible collaborator
//
// The previous create handler sent neither dependsOn nor mainManager (and used
// the wrong attribute names), so every POST /actions returned 422 Missing
// required attribute (parameter: /data/relationships/dependsOn).

const ACTION_DEPENDS_ON_PRIORITY = [
  { key: "contactId", type: "contact" },
  { key: "candidateId", type: "candidate" },
  { key: "companyId", type: "company" },
  { key: "opportunityId", type: "opportunity" },
  { key: "projectId", type: "project" },
  { key: "resourceId", type: "resource" },
] as const;

/**
 * Resolve the BoondManager resource ID corresponding to the current
 * authenticated user. /application/current-user returns the user record with
 * a `thumbnail` field of the form `resource_<id>_<hash>` — we parse the
 * numeric id out of that prefix.
 *
 * This is NOT hardcoded : in multi-user OAuth mode each request carries its
 * own JWT via AsyncLocalStorage, so the call always returns the right user
 * for the current context. Returns null if the thumbnail cannot be parsed.
 */
export async function resolveCurrentUserResourceId(): Promise<string | null> {
  const resp = await apiRequest("/application/current-user");
  const data = Array.isArray(resp.data) ? resp.data[0] : resp.data;
  if (!data) return null;
  const attrs = (data.attributes ?? {}) as Record<string, unknown>;
  const thumbnail = attrs["thumbnail"];
  if (typeof thumbnail === "string") {
    const m = thumbnail.match(/^resource_(\d+)_/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Normalise the user-supplied date into an ISO 8601 string with offset that
 * BoondManager accepts. Pass-through for already-formatted ISO inputs; we
 * only expand bare `YYYY-MM-DD` to midnight Europe/Paris.
 */
function normaliseActionDate(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    // Bare date — append midnight Europe/Paris. Boond stores startTimezone
    // separately, so the offset here is for clarity rather than DST safety.
    return `${input}T00:00:00+0200`;
  }
  return input;
}

interface ActionCreateInput {
  typeOf: number | string;
  title?: string;
  text?: string;
  subject?: string;
  content?: string;
  startDate?: string;
  endDate?: string;
  candidateId?: string;
  resourceId?: string;
  contactId?: string;
  companyId?: string;
  opportunityId?: string;
  projectId?: string;
  mainManagerId?: string;
}

export async function handleActionCreate(params: ActionCreateInput): Promise<string> {
  // ---- typeOf : accept number or numeric string, send as integer ----
  const typeOfNum = typeof params.typeOf === "number" ? params.typeOf : Number(params.typeOf);
  if (!Number.isFinite(typeOfNum) || typeOfNum < 0) {
    throw new Error(
      `Paramètre invalide : 'typeOf' doit être un ID numérique d'action (ex : 3, 17, 41). Reçu : ${JSON.stringify(params.typeOf)}.`
    );
  }

  // ---- dependsOn : pick the first provided linked entity (priority order) ----
  let dependsOn: { id: string; type: string } | null = null;
  const paramsBag = params as unknown as Record<string, unknown>;
  for (const { key, type } of ACTION_DEPENDS_ON_PRIORITY) {
    const id = paramsBag[key];
    if (typeof id === "string" && id.length > 0) {
      dependsOn = { id, type };
      break;
    }
  }
  if (!dependsOn) {
    throw new Error(
      "Paramètre manquant : précisez l'entité parente de l'action via UN parmi " +
        "contactId, candidateId, companyId, opportunityId, projectId, resourceId. " +
        "Sans cet identifiant, l'API BoondManager renvoie 422 (Missing required attribute dependsOn)."
    );
  }

  // ---- mainManager : explicit or resolved from current user ----
  let mainManagerId = params.mainManagerId;
  if (!mainManagerId) {
    const resolved = await resolveCurrentUserResourceId();
    if (!resolved) {
      throw new Error(
        "Impossible de résoudre la ressource du collaborateur courant (`/application/current-user.thumbnail` " +
          "non au format `resource_<id>_*`). Fournissez explicitement `mainManagerId` " +
          "(ID de la ressource responsable de l'action) pour contourner."
      );
    }
    mainManagerId = resolved;
  }

  // ---- Attributes ----
  const attributes: Record<string, unknown> = { typeOf: typeOfNum };
  // Real BoondManager attribute names are `title` and `text`. Accept the
  // legacy subject/content as back-compat aliases.
  const titleVal = params.title ?? params.subject;
  const textVal = params.text ?? params.content;
  if (titleVal) attributes.title = titleVal;
  if (textVal) attributes.text = textVal;
  const startDate = normaliseActionDate(params.startDate);
  const endDate = normaliseActionDate(params.endDate);
  if (startDate) attributes.startDate = startDate;
  if (endDate) attributes.endDate = endDate;

  // ---- JSON:API body ----
  const body = {
    data: {
      type: "action",
      attributes,
      relationships: {
        dependsOn: { data: { id: dependsOn.id, type: dependsOn.type } },
        mainManager: { data: { id: mainManagerId, type: "resource" } },
      },
    },
  };

  logger.debug({ body }, "POST /actions payload");

  const response = await apiRequest("/actions", "POST", body);
  const entity = Array.isArray(response.data) ? response.data[0] : response.data;
  return `✅ Action créée avec succès.\nID : ${entity?.id}\nType : ${typeOfNum}\nDépend de : ${dependsOn.type} #${dependsOn.id}\nResponsable : resource #${mainManagerId}\n\n${formatDetailResponse(response)}`;
}

export function registerActionTools(server: McpServer): void {
  // Search actions
  server.registerTool(
    "boond_actions_search",
    {
      title: "Rechercher des actions",
      description: `Recherche des actions (appels, emails, RDV, notes) dans BoondManager.

Args:
  - keywords (string, optional): Termes de recherche
  - candidateId, resourceId, contactId, companyId (string, optional): ⚠️ NON APPLIQUÉS par l'API \`/actions\` (filtres silencieusement ignorés → résultats à l'échelle de TOUTE l'org, non scopés). Vérifié en prod (v9.1.58.0) : \`contactId=796\` renvoie ~153 000 actions au lieu de 4. Pour les actions d'une entité précise, utiliser l'onglet dédié : \`boond_contacts_actions\` / \`boond_candidates_actions\` / \`boond_companies_actions\` / \`boond_resources_actions\`.
  - managerId (string, optional): Filtrer par auteur (créateur de l'action). Mappé sur \`perimeterManagers[]\` côté API.
  - dateFrom, dateTo (YYYY-MM-DD, optional): Bornes de période. Mappés sur \`startDate\` / \`endDate\` côté API.
  - period ('started' | 'created' | 'updated', défaut 'started'): Champ date filtré par dateFrom/dateTo
  - typeOf (int[], optional): IDs de types d'action. Mappé sur \`actionTypes[]\` côté API. Ex: 12=Entretien visio, 19=Entretien présentiel, 13=Note, 41=Appel, 42=Email. Liste complète via \`boond_application_dictionary\` avec \`dictionaryType = setting.action\`.
  - page, pageSize: Pagination

Returns: Liste des actions. Chaque ligne contient \`[action #id] | date | type | par auteur | → entité liée | extrait du texte\`. Le label de type est résolu via \`data.setting.action\` (dictionnaire BoondManager, scopé par entité linkable, fusionné et mis en cache). L'auteur et l'entité liée sont résolus via le tableau JSON:API \`included\` de la réponse.

ℹ️ Modes de \`period\` (vérifiés en prod sur l'API v9.1.58.0) : 'started' filtre \`startDate\`, 'created' filtre \`creationDate\`, 'updated' filtre \`updateDate\`. (Correction : la doc antérieure indiquait à tort que 'created' ciblait \`started\`.)`,
      inputSchema: ActionSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      // Several schema field names are ergonomic aliases that need translation
      // to the actual BoondManager query parameters before the API call:
      //   managerId   → perimeterManagers[]   (filter on action creator/responsible)
      //   dateFrom    → startDate
      //   dateTo      → endDate
      //   typeOf      → actionTypes[]
      //   actionType  → typeOf via KEYWORD_TO_TYPES → actionTypes[]
      //   candidateId → keywords += "CAND<id>" (BoondManager search prefix)
      //   resourceId  → keywords += "COMP<id>"
      //   contactId   → keywords += "CCON<id>"
      //   companyId   → keywords += "CSOC<id>"
      const {
        managerId,
        dateFrom,
        dateTo,
        typeOf,
        actionType,
        candidateId,
        resourceId,
        contactId,
        companyId,
        period,
        periodDynamic,
        ...rest
      } = params;

      // Linked-entity filters travel through the `keywords` prefix syntax —
      // the literal `candidateId=` style is silently ignored by /actions.
      // We compose a space-separated list so multiple linked filters can be
      // combined (rare but supported by BoondManager).
      const linkedPrefixes: string[] = [];
      if (candidateId) linkedPrefixes.push(`CAND${candidateId}`);
      if (resourceId) linkedPrefixes.push(`COMP${resourceId}`);
      if (contactId) linkedPrefixes.push(`CCON${contactId}`);
      if (companyId) linkedPrefixes.push(`CSOC${companyId}`);
      if (linkedPrefixes.length > 0) {
        rest.keywords = rest.keywords ? `${linkedPrefixes.join(" ")} ${rest.keywords}` : linkedPrefixes.join(" ");
      }

      // `period` and `periodDynamic` are destructured out so buildSearchQuery
      // does NOT forward them unconditionally.
      const query = buildSearchQuery(rest);
      if (managerId) query.perimeterManagers = [managerId];
      if (dateFrom) query.startDate = dateFrom;
      if (dateTo) query.endDate = dateTo;

      // CRITICAL: only send `period` when there is something for it to scope —
      // a date bound (dateFrom/dateTo) or a dynamic window (periodDynamic).
      // BoondManager interprets `period=started` WITHOUT any date window as an
      // empty range and returns 0 results, so sending it on an unscoped
      // candidateId-only search silently swallowed every action.
      if (periodDynamic) query.periodDynamic = periodDynamic;
      if (dateFrom || dateTo || periodDynamic) {
        query.period = period; // schema default 'started' or caller's value
      }

      // Explicit typeOf wins over actionType keyword lookup.
      let finalTypes = typeOf;
      if ((!finalTypes || finalTypes.length === 0) && actionType) {
        const key = actionType.toLowerCase().trim();
        finalTypes = KEYWORD_TO_TYPES[key];
        // Allow a stringified numeric ID as a one-shot shortcut.
        if (!finalTypes && /^\d+$/.test(key)) finalTypes = [Number(key)];
      }
      if (finalTypes && finalTypes.length > 0) query.actionTypes = finalTypes;

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
      description: `Crée une nouvelle action (appel, email, RDV, note, rappel...) dans BoondManager.

**Requis** : \`typeOf\` (ID numérique du type d'action) + UN identifiant d'entité liée parmi \`contactId\`, \`candidateId\`, \`companyId\`, \`opportunityId\`, \`projectId\`, \`resourceId\`. Cette entité construit la relation \`dependsOn\` (polymorphe) que l'API BoondManager exige.

**Responsable** : \`mainManagerId\` (ID de la ressource collaborateur). Si omis, le tool résout automatiquement la ressource de l'utilisateur courant via \`/application/current-user\` (parsing du \`thumbnail\` \`resource_<id>_*\`).

**Dates** : \`startDate\` accepte \`YYYY-MM-DD\` (normalisé à minuit Europe/Paris) ou ISO 8601 complet.

**Type d'action** : pour la liste exhaustive des IDs, voir \`boond_application_dictionary\` avec \`setting.action.<entity>\` (scopé par contact/candidate/resource/opportunity/project/order/invoice).

Erreurs claires : si aucune entité liée fournie OU si la ressource utilisateur ne peut être résolue.`,
      inputSchema: ActionCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const created = await handleActionCreate(params);
      return { content: [{ type: "text" as const, text: created }] };
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
