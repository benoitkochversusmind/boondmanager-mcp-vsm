import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InvoiceSearchSchema,
  InvoiceCreateSchema,
  InvoiceUpdateSchema,
  InvoiceOverdueSchema,
  IdSchema,
} from "../schemas/index.js";
import type { InvoiceOverdueInput } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { getDictionary, resolveDictionaryPath } from "../services/dictionary.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";
import { buildJsonApiBody } from "./crud-factory.js";

/**
 * ⚠️ Date pivot pour le recouvrement BoondManager
 * ------------------------------------------------
 * `expectedPaymentDate` (« Date de règlement prévu », saisie comptable) est le
 * champ opérationnel à utiliser pour identifier les factures en retard. Le
 * champ `dueDate` (« Échéance », parfois calculé automatiquement) n'est pas
 * toujours renseigné dans BoondManager et ne reflète pas l'engagement réel
 * du client. Les outils de cette catégorie filtrent et trient **uniquement**
 * sur `expectedPaymentDate`.
 */

// ---- JSON:API include resolution (shared with the actions module pattern) --

type IncludedIndex = Map<string, JsonApiResource>;

function buildIncludedIndex(response: JsonApiResponse): IncludedIndex {
  const idx: IncludedIndex = new Map();
  for (const r of response.included ?? []) {
    idx.set(`${r.type}:${r.id}`, r);
  }
  return idx;
}

function relRef(rel: unknown): { id: string; type: string } | null {
  if (!rel || typeof rel !== "object") return null;
  const data = (rel as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const ref = data as { id?: string; type?: string };
  if (!ref.id || !ref.type) return null;
  return { id: ref.id, type: ref.type };
}

// ---- Defensive field resolution -------------------------------------------
// BoondManager's invoice payload varies between instances and API versions.
// We probe a known set of attribute / relationship names and pick the first
// hit, so the tool keeps working even if Boond renames a field.

// Confirmed from a live diagnostic on the VSM instance: `/invoices` exposes
// the amounts as `turnoverInvoicedExcludingTax` / `turnoverInvoicedIncludingTax`
// (i.e. the "facturé" variant, distinct from the generic `turnover*` used on
// orders or opportunities). The other names are kept as a defensive fallback
// for other instances / future API changes.
const AMOUNT_EXCLUDING_TAX_FIELDS = [
  "turnoverInvoicedExcludingTax",
  "turnoverExcludingTax",
  "amountExcludingTax",
  "totalExcludingTax",
  "turnover",
  "amount",
] as const;

const AMOUNT_INCLUDING_TAX_FIELDS = [
  "turnoverInvoicedIncludingTax",
  "turnoverIncludingTax",
  "amountIncludingTax",
  "totalIncludingTax",
] as const;

// On /invoices, the company is NOT exposed via a direct relationship on the
// invoice itself — the canonical chain is invoice.order → order.company.
// We still probe several names defensively in case BoondManager links the
// company directly on some endpoints (e.g. tabs).
const COMPANY_REL_NAMES = ["company", "mainCompany", "invoicedCompany", "society"] as const;

function readNumber(attrs: Record<string, unknown>, candidates: ReadonlyArray<string>): number | null {
  for (const k of candidates) {
    const v = attrs[k];
    if (v === undefined || v === null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readString(attrs: Record<string, unknown>, candidates: ReadonlyArray<string>): string | null {
  for (const k of candidates) {
    const v = attrs[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * First-pass company resolution from a single JSON:API response.
 *
 * BoondManager's `/invoices` doesn't expose a direct `company` relationship —
 * the canonical link is via `order`. We also probe direct names defensively
 * for other endpoints (tabs, /invoices/{id}/company in some instances).
 *
 * Returns `orderId` whenever the chain goes through an order, so the caller
 * can run a second pass with `resolveCompaniesViaOrders` to fetch the missing
 * name via `GET /orders/{id}` when the nested include didn't expand.
 */
function resolveCompany(
  resource: JsonApiResource,
  included: IncludedIndex
): { id: string | null; name: string | null; orderId: string | null } {
  const rels = (resource.relationships ?? {}) as Record<string, unknown>;
  for (const name of COMPANY_REL_NAMES) {
    const ref = relRef(rels[name]);
    if (!ref) continue;
    const full = included.get(`${ref.type}:${ref.id}`);
    const companyName = full ? readString((full.attributes ?? {}) as Record<string, unknown>, ["name", "title"]) : null;
    return { id: ref.id, name: companyName, orderId: null };
  }
  const orderRef = relRef(rels["order"]);
  if (orderRef) {
    const order = included.get(`order:${orderRef.id}`);
    if (order) {
      const orderRels = (order.relationships ?? {}) as Record<string, unknown>;
      for (const name of COMPANY_REL_NAMES) {
        const cref = relRef(orderRels[name]);
        if (!cref) continue;
        const cfull = included.get(`${cref.type}:${cref.id}`);
        const cname = cfull ? readString((cfull.attributes ?? {}) as Record<string, unknown>, ["name", "title"]) : null;
        return { id: cref.id, name: cname, orderId: orderRef.id };
      }
    }
    // Order ref present but neither order nor company is in `included[]`.
    return { id: null, name: null, orderId: orderRef.id };
  }
  return { id: null, name: null, orderId: null };
}

/**
 * Second-pass company resolution: walks the **invoice → order → project →
 * company** chain to find the client name for each unique orderId.
 *
 * Why a chain: on the VSM BoondManager instance (verified 2026-05-21 via
 * direct probing of `/orders/2325`), the order resource has NO `company`
 * relationship — only `mainManager` (the commercial) and `project`. The
 * company is actually linked to the project. So we do:
 *
 *   1. `GET /orders/{orderId}` → read `relationships.project.data.id`
 *      (deduped per unique orderId)
 *   2. `GET /projects/{projectId}?include=company` → read
 *      `relationships.company.data.id` and the company's name from
 *      `included[]` (deduped per unique projectId; many invoices can share
 *      the same project)
 *
 * Defensive: if any step finds the company name inline (some instances
 * expose it on order/project attributes, or as a direct relationship),
 * we short-circuit rather than chain further. Nested includes are NOT
 * used because BoondManager doesn't honor them on these endpoints.
 *
 * Cap: `maxLookups` bounds the number of unique orders we will probe; the
 * project step then dedupes orders that share a project, so the actual
 * number of HTTP calls is closer to `unique_orders + unique_projects`.
 *
 * Parallelism is bounded by the BoondManager rate limiter
 * (`src/services/rate-limiter.ts`). `Promise.allSettled` tolerates per-row
 * failures.
 */
export async function resolveCompaniesViaOrders(
  orderIds: ReadonlyArray<string>,
  maxLookups = 100
): Promise<Map<string, { id: string | null; name: string | null }>> {
  const cache = new Map<string, { id: string | null; name: string | null }>();
  const uniqueOrderIds = Array.from(new Set(orderIds)).slice(0, maxLookups);
  if (uniqueOrderIds.length === 0) return cache;

  // Step 1: fetch each unique order. Two outcomes per order:
  //   - direct company resolved on the order itself (rare/defensive, e.g. via
  //     attributes.companyName or a `company` relationship in other instances)
  //   - otherwise, the order's `project` relationship gives us a projectId
  //     to follow in step 2.
  type Step1Info =
    | { kind: "direct"; companyId: string | null; companyName: string | null }
    | { kind: "viaProject"; projectId: string };
  const step1: Map<string, Step1Info> = new Map();
  const step1Results = await Promise.allSettled(
    uniqueOrderIds.map(async (orderId) => {
      const resp = await apiRequest(`/orders/${orderId}`);
      const entity = Array.isArray(resp.data) ? resp.data[0] : resp.data;
      if (!entity) return [orderId, null] as const;
      const rels = (entity.relationships ?? {}) as Record<string, unknown>;
      const attrs = (entity.attributes ?? {}) as Record<string, unknown>;

      // Defensive: direct company on order (other instances may have it).
      for (const name of COMPANY_REL_NAMES) {
        const ref = relRef(rels[name]);
        if (ref) {
          const inlineName = readString(attrs, ["companyName", "company"]);
          return [orderId, { kind: "direct", companyId: ref.id, companyName: inlineName }] as const;
        }
      }
      // Inline-only fallback: company name on order attrs without relationship.
      const inlineName = readString(attrs, ["companyName"]);
      if (inlineName) {
        return [orderId, { kind: "direct", companyId: null, companyName: inlineName }] as const;
      }
      // Canonical chain: go through project.
      const projectRef = relRef(rels["project"]);
      if (projectRef) {
        return [orderId, { kind: "viaProject", projectId: projectRef.id }] as const;
      }
      return [orderId, null] as const;
    })
  );
  for (const r of step1Results) {
    if (r.status !== "fulfilled") continue;
    const [orderId, info] = r.value;
    if (info) step1.set(orderId, info);
  }

  // Step 2: for every distinct projectId surfaced in step 1, fetch the project
  // with `include=company` to retrieve the company id + name in one call.
  const uniqueProjectIds = Array.from(
    new Set(
      Array.from(step1.values())
        .filter((i): i is { kind: "viaProject"; projectId: string } => i.kind === "viaProject")
        .map((i) => i.projectId)
    )
  );
  const projectToCompany = new Map<string, { id: string | null; name: string | null }>();
  if (uniqueProjectIds.length > 0) {
    const step2Results = await Promise.allSettled(
      uniqueProjectIds.map(async (projectId) => {
        const resp = await apiRequest(`/projects/${projectId}`, "GET", undefined, { include: "company" });
        const entity = Array.isArray(resp.data) ? resp.data[0] : resp.data;
        if (!entity) return [projectId, null] as const;
        const projRels = (entity.relationships ?? {}) as Record<string, unknown>;
        let companyId: string | null = null;
        for (const name of COMPANY_REL_NAMES) {
          const ref = relRef(projRels[name]);
          if (ref) {
            companyId = ref.id;
            break;
          }
        }
        if (!companyId) {
          const inlineName = readString((entity.attributes ?? {}) as Record<string, unknown>, ["companyName"]);
          if (inlineName) return [projectId, { id: null, name: inlineName }] as const;
          return [projectId, null] as const;
        }
        const idx = buildIncludedIndex(resp);
        const full = idx.get(`company:${companyId}`);
        const name = full ? readString((full.attributes ?? {}) as Record<string, unknown>, ["name", "title"]) : null;
        return [projectId, { id: companyId, name }] as const;
      })
    );
    for (const r of step2Results) {
      if (r.status !== "fulfilled") continue;
      const [projectId, info] = r.value;
      if (info) projectToCompany.set(projectId, info);
    }
  }

  // Assemble the orderId → company cache from both code paths.
  for (const [orderId, info] of step1) {
    if (info.kind === "direct") {
      cache.set(orderId, { id: info.companyId, name: info.companyName });
    } else {
      const company = projectToCompany.get(info.projectId);
      if (company) cache.set(orderId, company);
    }
  }
  return cache;
}

// ---- Tool descriptions ----------------------------------------------------

const INVOICE_SEARCH_DESCRIPTION = `Recherche des factures dans BoondManager.

**Champs retournés** : id, référence, état (libellé), \`expectedPaymentDate\` (date de règlement prévu — pivot du recouvrement), montant HT (et TTC si présent), nom de la société cliente.

Filtres principaux :
• **Périmètre** — \`perimeterDynamic: ["data"]\` (mes factures), \`perimeterManagers: [<id>]\` (équipe d'un manager), \`perimeterPoles\`, \`perimeterAgencies\`, \`perimeterBusinessUnits\`. \`narrowPerimeter: true\` pour AND.
• **États** — \`states: [<id>]\` (IDs depuis dictionnaire \`setting.state.invoice\` via \`boond_application_dictionary\`).
• **Période** — \`period: "created" | "updated" | "expectedPayment" | "performedPayment" | "period"\` + \`startDate\`/\`endDate\` (YYYY-MM-DD).
• **Société / projet** — \`companyId\`, \`projectId\`.
• **Tri** — \`sort\` (ex: \`expectedPaymentDate\`, \`date\`) + \`order\` (\`asc\`/\`desc\`).

Pour les **factures en retard de paiement** spécifiquement, utiliser plutôt \`boond_invoices_overdue\` qui fait l'exclusion des états payés/avoirés/proforma + filtre \`expectedPaymentDate < today\` + filtre montant en un seul appel.

Pagination : \`page\`, \`pageSize\` (max 500). Returns : liste paginée enrichie des factures.`;

const INVOICE_GET_DESCRIPTION = `Récupère les informations détaillées d'une facture par son ID. La sortie inclut : référence, dates (création, facturation, règlement prévu, échéance contractuelle), montant HT et TTC, état (libellé), société cliente, et la structure JSON:API brute (avec relationships) pour les usages avancés.`;

// ---- Custom formatters for invoice list/detail (Bug 4) --------------------

interface InvoiceView {
  id: string;
  reference: string | null;
  date: string | null;
  expectedPaymentDate: string | null;
  dueDate: string | null;
  amountExcludingTax: number | null;
  amountIncludingTax: number | null;
  stateId: number | null;
  stateLabel: string | null;
  companyId: string | null;
  companyName: string | null;
  orderId: string | null;
  raw?: JsonApiResource;
}

function buildInvoiceView(
  resource: JsonApiResource,
  included: IncludedIndex,
  stateLabelById: Map<number, string>
): InvoiceView {
  const a = (resource.attributes ?? {}) as Record<string, unknown>;
  const stateRaw = a["state"];
  const stateId = typeof stateRaw === "number" ? stateRaw : Number(stateRaw);
  const stateIdFinal = Number.isFinite(stateId) ? stateId : null;
  const company = resolveCompany(resource, included);
  return {
    id: resource.id,
    reference: readString(a, ["reference"]),
    date: readString(a, ["date"]),
    expectedPaymentDate: readString(a, ["expectedPaymentDate"]),
    dueDate: readString(a, ["dueDate"]),
    amountExcludingTax: readNumber(a, [...AMOUNT_EXCLUDING_TAX_FIELDS]),
    amountIncludingTax: readNumber(a, [...AMOUNT_INCLUDING_TAX_FIELDS]),
    stateId: stateIdFinal,
    stateLabel: stateIdFinal !== null ? (stateLabelById.get(stateIdFinal) ?? null) : null,
    companyId: company.id,
    companyName: company.name,
    orderId: company.orderId,
    raw: resource,
  };
}

function formatInvoiceLine(v: InvoiceView): string {
  const parts = [`[invoice #${v.id}]`];
  if (v.reference) parts.push(v.reference);
  if (v.companyName) parts.push(v.companyName);
  else if (v.companyId) parts.push(`société #${v.companyId}`);
  else if (v.orderId) parts.push(`order #${v.orderId}`); // drill via boond_orders_get
  if (v.expectedPaymentDate) parts.push(`règlement prévu ${v.expectedPaymentDate}`);
  else if (v.dueDate) parts.push(`échéance ${v.dueDate}`);
  else if (v.date) parts.push(`date ${v.date}`);
  if (v.amountExcludingTax !== null) {
    let amt = `${v.amountExcludingTax.toFixed(2)} € HT`;
    if (v.amountIncludingTax !== null) amt += ` / ${v.amountIncludingTax.toFixed(2)} € TTC`;
    parts.push(amt);
  }
  if (v.stateLabel) parts.push(v.stateLabel);
  else if (v.stateId !== null) parts.push(`état #${v.stateId}`);
  return parts.join(" | ");
}

/**
 * For every view whose company is unresolved (but whose `orderId` is known),
 * fetch the order via `GET /orders/{id}` to retrieve the company. Mutates
 * the views in place. Capped to avoid runaway latency.
 */
async function resolveUnresolvedCompanies(views: InvoiceView[], maxLookups = 100): Promise<void> {
  const unresolvedOrderIds = views
    .filter((v) => v.companyName === null && v.orderId !== null)
    .map((v) => v.orderId as string);
  if (unresolvedOrderIds.length === 0) return;
  const cache = await resolveCompaniesViaOrders(unresolvedOrderIds, maxLookups);
  for (const v of views) {
    if (v.companyName !== null || !v.orderId) continue;
    const info = cache.get(v.orderId);
    if (!info) continue;
    if (info.id && !v.companyId) v.companyId = info.id;
    if (info.name) v.companyName = info.name;
  }
}

async function formatInvoiceList(response: JsonApiResponse): Promise<string> {
  const data = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
  const total = response.meta?.totals?.rows;
  if (data.length === 0) return "Aucune facture trouvée.";

  const included = buildIncludedIndex(response);
  const dict = await getDictionary().catch(() => null);
  const stateLabelById = new Map<number, string>();
  if (dict) {
    for (const s of extractInvoiceStates(dict.payload)) stateLabelById.set(s.id, s.value);
  }

  const views = data.map((r) => buildInvoiceView(r, included, stateLabelById));
  // Second pass: resolve missing companies via GET /orders/{id}.
  await resolveUnresolvedCompanies(views);

  const lines = views.map(formatInvoiceLine);
  let result = lines.join("\n");
  if (total !== undefined) result = `Total: ${total} facture(s)\n\n${result}`;
  if (result.length > CHARACTER_LIMIT) {
    result = result.substring(0, CHARACTER_LIMIT) + "\n\n[Résultats tronqués...]";
  }
  return result;
}

async function formatInvoiceDetail(response: JsonApiResponse): Promise<string> {
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!data) return "Facture non trouvée.";
  const included = buildIncludedIndex(response);
  const dict = await getDictionary().catch(() => null);
  const stateLabelById = new Map<number, string>();
  if (dict) {
    for (const s of extractInvoiceStates(dict.payload)) stateLabelById.set(s.id, s.value);
  }
  const v = buildInvoiceView(data, included, stateLabelById);
  // Single-row second pass: cheap and always worth it on a detail view.
  await resolveUnresolvedCompanies([v]);
  // Enriched human-readable summary + the raw JSON:API payload for completeness.
  const summary = [
    `# Facture #${v.id}`,
    v.reference ? `Référence : ${v.reference}` : null,
    v.companyName ? `Société : ${v.companyName}` : v.companyId ? `Société : #${v.companyId}` : null,
    v.stateLabel ? `État : ${v.stateLabel} (id ${v.stateId})` : v.stateId !== null ? `État : #${v.stateId}` : null,
    v.date ? `Date facture : ${v.date}` : null,
    v.expectedPaymentDate ? `Date de règlement prévu : ${v.expectedPaymentDate}` : null,
    v.dueDate ? `Échéance contractuelle : ${v.dueDate}` : null,
    v.amountExcludingTax !== null ? `Montant HT : ${v.amountExcludingTax.toFixed(2)} €` : null,
    v.amountIncludingTax !== null ? `Montant TTC : ${v.amountIncludingTax.toFixed(2)} €` : null,
    v.orderId ? `Bon de commande lié : #${v.orderId}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `${summary}\n\n---\nPayload JSON:API brut :\n${formatDetailResponse(response)}`;
}

// ---- Tool registration ----------------------------------------------------

export function registerInvoiceTools(server: McpServer): void {
  server.registerTool(
    "boond_invoices_search",
    {
      title: "Rechercher des factures",
      description: INVOICE_SEARCH_DESCRIPTION,
      inputSchema: InvoiceSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const query = buildSearchQuery(params);
      if (params.startDate) query["startDate"] = params.startDate;
      if (params.endDate) query["endDate"] = params.endDate;
      if (params.period) query["period"] = params.period;
      // Ask BoondManager to embed the linked company/order/project in `included[]`
      // so we can surface the company name without an extra round-trip.
      // Nested include: ask BoondManager to embed the order *and* its linked
      // company in `included[]`. The invoice itself doesn't expose a direct
      // `company` relationship — the chain is invoice → order → company.
      query["include"] = "order,company,project";
      const response = await apiRequest("/invoices", "GET", undefined, query);
      const text = await formatInvoiceList(response);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  registerInvoiceOverdueTool(server);

  server.registerTool(
    "boond_invoices_get",
    {
      title: "Détails d'une facture",
      description: INVOICE_GET_DESCRIPTION,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const response = await apiRequest(`/invoices/${params.id}`, "GET", undefined, {
        include: "order,company,project",
      });
      const text = await formatInvoiceDetail(response);
      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.registerTool(
    "boond_invoices_create",
    {
      title: "Créer une facture",
      description: `Crée une nouvelle facture dans BoondManager, optionnellement liée à une société et un projet.`,
      inputSchema: InvoiceCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { companyId, projectId, ...attrs } = params;
      const body = buildJsonApiBody("invoice", attrs);
      const relationships: Record<string, unknown> = {};
      if (companyId) relationships.company = { data: { id: companyId, type: "company" } };
      if (projectId) relationships.project = { data: { id: projectId, type: "project" } };
      if (Object.keys(relationships).length > 0) {
        (body as Record<string, Record<string, unknown>>).data.relationships = relationships;
      }
      const response = await apiRequest("/invoices", "POST", body);
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Facture créée avec succès.\nID: ${entity?.id}\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "boond_invoices_update",
    {
      title: "Modifier une facture",
      description: `Met à jour une facture existante. Seuls les champs fournis sont modifiés.`,
      inputSchema: InvoiceUpdateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { id, ...attrs } = params;
      const body = buildJsonApiBody("invoice", attrs, id);
      const response = await apiRequest(`/invoices/${id}`, "PATCH", body);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Facture #${id} mise à jour.\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "boond_invoices_delete",
    {
      title: "Supprimer une facture",
      description: `Supprime une facture de BoondManager. ⚠️ Action irréversible.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      await apiRequest(`/invoices/${params.id}`, "DELETE");
      return {
        content: [{ type: "text" as const, text: `🗑️ Facture #${params.id} supprimée.` }],
      };
    }
  );
}

// ---- Composite tool: overdue invoices -------------------------------------

const OVERDUE_DESCRIPTION = `Liste les factures en retard de paiement, filtrables par pôle, manager, agence, BU, société et fourchette de montant HT.

**Date pivot** : filtrage strict sur \`expectedPaymentDate\` (« Date de règlement prévu », saisie comptable). \`dueDate\` n'est pas utilisé — il n'est pas systématiquement rempli dans BoondManager. Les factures sans \`expectedPaymentDate\` sont ignorées.

Pipeline :
1. Dictionnaire \`setting.state.invoice\` → exclusion (Payée, Payée groupe, Avoiré, ProForma, Création, Annulée).
2. Recherche \`/invoices\` paginée + filtres périmètre + \`states\` restants.
3. Filtre serveur : \`expectedPaymentDate < asOfDate\` + bornes montant.
4. **Résolution société (chaîne invoice → order → project → company)** : la société n'étant ni sur l'invoice ni sur l'order, on fait (a) \`GET /orders/{id}\` pour le projectId, puis (b) \`GET /projects/{id}?include=company\` pour le nom. Dédup à chaque niveau, cap 100 ordres uniques. Au-delà : \`order #<id>\` affiché pour drill manuel.
5. Sortie triée par jours de retard décroissants (ou groupée par société via \`groupByCompany: true\`).

Paramètres clés :
- \`asOfDate\` (YYYY-MM-DD, défaut aujourd'hui)
- \`perimeterPoles\`, \`perimeterManagers\`, \`perimeterAgencies\`, \`perimeterBusinessUnits\`, \`perimeterDynamic\`
- \`companyId\`, \`amountMin/MaxExcludingTax\`, \`groupByCompany\`

Returns : tableau enrichi (référence, société, expectedPaymentDate, montant HT/TTC, état) + en-tête statistique.`;

interface InvoiceStateRef {
  id: number;
  value: string;
  isExcludedFromSentState?: boolean;
}

interface OverdueRow {
  invoiceId: string;
  reference: string;
  companyId: string | null;
  companyName: string | null;
  orderId: string | null;
  expectedPaymentDate: string;
  daysOverdue: number;
  amountExcludingTax: number;
  amountIncludingTax: number | null;
  stateId: number | null;
  stateLabel: string | null;
}

function extractInvoiceStates(payload: JsonApiResponse): InvoiceStateRef[] {
  const raw = resolveDictionaryPath(payload, "setting.state.invoice");
  if (!Array.isArray(raw)) return [];
  const out: InvoiceStateRef[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = Number(e.id);
    const value = e.value;
    if (!Number.isFinite(id) || typeof value !== "string") continue;
    const flag = e.isExcludedFromSentState;
    out.push({
      id,
      value,
      isExcludedFromSentState: typeof flag === "boolean" ? flag : undefined,
    });
  }
  return out;
}

/**
 * States that must NOT appear in an overdue / relance listing.
 *
 * - `isExcludedFromSentState: true` → BoondManager itself marks these as
 *   non-real-sent invoices (Création, ProForma). Trusting Boond's own flag
 *   keeps us aligned with the UI's invoice screens.
 * - Regex matches:
 *   - "Payée" + "Payée groupe" → fully paid (id 3, 15 in our instance) — but
 *     NOT "Payée partiellement" (id 7), which still has an outstanding balance.
 *   - "Avoir"/"Avoiré" → credit notes (id 8) — not a real receivable.
 *   - "Annul..." → cancelled (defensive; may not exist in all instances).
 */
export function isExcludedFromOverdue(state: InvoiceStateRef): boolean {
  if (state.isExcludedFromSentState === true) return true;
  const v = state.value.toLowerCase().trim();
  if (/^pay[ée]e/.test(v) && !/partiel/.test(v)) return true;
  if (/avoir/.test(v)) return true;
  if (/annul/.test(v)) return true;
  return false;
}

/** IDs of invoice states that count as "still owing". */
function pickUnpaidStateIds(states: InvoiceStateRef[]): number[] {
  return states.filter((s) => !isExcludedFromOverdue(s)).map((s) => s.id);
}

function diffDays(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / (1000 * 60 * 60 * 24));
}

export async function fetchOverdueInvoices(params: InvoiceOverdueInput): Promise<{
  rows: OverdueRow[];
  scanned: number;
  asOfDate: string;
  /** Diagnostic snapshot of the first invoice's attribute & relationship keys. */
  firstInvoiceKeys: { attributes: string[]; relationships: string[] } | null;
  /** Number of unique orderIds that needed lookup but were dropped past the cap. */
  unresolvedOrdersAfterCap: number;
}> {
  const asOfDate = params.asOfDate ?? new Date().toISOString().slice(0, 10);
  const asOfMs = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(asOfMs)) {
    throw new Error(`asOfDate invalide: "${asOfDate}". Format attendu YYYY-MM-DD.`);
  }

  const dict = await getDictionary();
  const invoiceStates = extractInvoiceStates(dict.payload);
  const unpaidStateIds = pickUnpaidStateIds(invoiceStates);
  const stateLabelById = new Map(invoiceStates.map((s) => [s.id, s.value]));

  const baseQuery: Record<string, unknown> = {
    maxResults: params.pageSize,
    // We only ask for `order` (the canonical relationship on /invoices); the
    // nested `order.company` syntax isn't honored by BoondManager on this
    // endpoint, so we resolve company in a second pass via GET /orders/{id}.
    include: "order,company,project",
  };
  if (unpaidStateIds.length) baseQuery["states"] = unpaidStateIds;
  if (params.companyId) baseQuery["companyId"] = params.companyId;
  if (params.perimeterManagers?.length) baseQuery["perimeterManagers"] = params.perimeterManagers;
  if (params.perimeterManagersType) baseQuery["perimeterManagersType"] = params.perimeterManagersType;
  if (params.perimeterAgencies?.length) baseQuery["perimeterAgencies"] = params.perimeterAgencies;
  if (params.perimeterPoles?.length) baseQuery["perimeterPoles"] = params.perimeterPoles;
  if (params.perimeterBusinessUnits?.length) baseQuery["perimeterBusinessUnits"] = params.perimeterBusinessUnits;
  if (params.perimeterDynamic?.length) baseQuery["perimeterDynamic"] = params.perimeterDynamic;
  if (params.narrowPerimeter !== undefined) baseQuery["narrowPerimeter"] = params.narrowPerimeter;

  const rows: OverdueRow[] = [];
  let scanned = 0;
  let firstInvoiceKeys: { attributes: string[]; relationships: string[] } | null = null;

  for (let page = 1; page <= params.maxPages; page++) {
    const response = await apiRequest("/invoices", "GET", undefined, { ...baseQuery, page });
    const data = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
    scanned += data.length;
    const included = buildIncludedIndex(response);

    for (const inv of data) {
      if (firstInvoiceKeys === null) {
        firstInvoiceKeys = {
          attributes: Object.keys(inv.attributes ?? {}),
          relationships: Object.keys(inv.relationships ?? {}),
        };
      }

      const a = (inv.attributes ?? {}) as Record<string, unknown>;
      const expectedPaymentDate = readString(a, ["expectedPaymentDate"]);
      if (!expectedPaymentDate) continue;
      const expMs = Date.parse(`${expectedPaymentDate}T00:00:00Z`);
      if (!Number.isFinite(expMs) || expMs >= asOfMs) continue;

      const amountHT = readNumber(a, [...AMOUNT_EXCLUDING_TAX_FIELDS]);
      const amountTTC = readNumber(a, [...AMOUNT_INCLUDING_TAX_FIELDS]);
      const amountForFilter = amountHT ?? 0;
      if (params.amountMinExcludingTax !== undefined && amountForFilter < params.amountMinExcludingTax) continue;
      if (params.amountMaxExcludingTax !== undefined && amountForFilter > params.amountMaxExcludingTax) continue;

      const company = resolveCompany(inv, included);
      const stateRaw = a["state"];
      const stateId = typeof stateRaw === "number" ? stateRaw : Number(stateRaw);
      const stateIdFinal = Number.isFinite(stateId) ? stateId : null;
      rows.push({
        invoiceId: inv.id,
        reference: readString(a, ["reference"]) ?? "(sans réf)",
        companyId: company.id,
        companyName: company.name,
        orderId: company.orderId,
        expectedPaymentDate,
        daysOverdue: diffDays(expMs, asOfMs),
        amountExcludingTax: amountHT ?? 0,
        amountIncludingTax: amountTTC,
        stateId: stateIdFinal,
        stateLabel: stateIdFinal !== null ? (stateLabelById.get(stateIdFinal) ?? null) : null,
      });
    }

    if (data.length < params.pageSize) break;
  }

  // Second pass — BoondManager's nested `include=order.company` isn't honored
  // on /invoices, so the company name is missing for rows resolved via the
  // order chain. Collect unique orderIds for unresolved rows and fetch each
  // order separately (capped at 100 to bound latency).
  const unresolvedOrderIds = Array.from(
    new Set(rows.filter((r) => r.companyName === null && r.orderId !== null).map((r) => r.orderId as string))
  );
  let unresolvedOrdersAfterCap = 0;
  if (unresolvedOrderIds.length > 0) {
    const cap = 100;
    unresolvedOrdersAfterCap = Math.max(0, unresolvedOrderIds.length - cap);
    const cache = await resolveCompaniesViaOrders(unresolvedOrderIds, cap);
    for (const row of rows) {
      if (row.companyName !== null || !row.orderId) continue;
      const info = cache.get(row.orderId);
      if (!info) continue;
      if (info.id && !row.companyId) row.companyId = info.id;
      if (info.name) row.companyName = info.name;
    }
  }

  rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return { rows, scanned, asOfDate, firstInvoiceKeys, unresolvedOrdersAfterCap };
}

function formatOverdueOutput(
  rows: OverdueRow[],
  scanned: number,
  asOfDate: string,
  groupByCompany: boolean,
  firstInvoiceKeys: { attributes: string[]; relationships: string[] } | null,
  unresolvedOrdersAfterCap: number
): string {
  if (rows.length === 0) {
    let msg = `Aucune facture en retard au ${asOfDate} (${scanned} factures scannées dans le périmètre).`;
    if (firstInvoiceKeys && scanned > 0) {
      msg += `\n\nDiagnostic — champs vus sur la 1re facture scannée :\n  attributes: [${firstInvoiceKeys.attributes.join(", ")}]\n  relationships: [${firstInvoiceKeys.relationships.join(", ")}]`;
    }
    return msg;
  }

  const totalAmount = rows.reduce((sum, r) => sum + r.amountExcludingTax, 0);
  const header = [
    `📋 Factures en retard de paiement au ${asOfDate}`,
    `Total : ${rows.length} factures · ${totalAmount.toFixed(2)} € HT impayés · ${scanned} scannées`,
  ].join("\n");

  // Diagnostic footer: only when amount AND company resolution failed across
  // the whole batch — that's the signal that we're missing field names.
  const allAmountsZero = rows.every((r) => r.amountExcludingTax === 0);
  const allCompaniesUnknown = rows.every((r) => r.companyName === null);
  let diagnostic = "";
  if ((allAmountsZero || allCompaniesUnknown) && firstInvoiceKeys) {
    const issues: string[] = [];
    if (allAmountsZero) issues.push(`montant HT non résolu (essayé : ${AMOUNT_EXCLUDING_TAX_FIELDS.join(", ")})`);
    if (allCompaniesUnknown) issues.push(`société non résolue (essayé relations : ${COMPANY_REL_NAMES.join(", ")})`);
    diagnostic =
      `\n\n⚠️ Diagnostic : ${issues.join(" + ")}.` +
      `\nChamps vus sur la 1re facture : attributes=[${firstInvoiceKeys.attributes.join(", ")}], relationships=[${firstInvoiceKeys.relationships.join(", ")}].` +
      `\nSignale ces noms à l'équipe MCP pour étendre les listes de probing.`;
  }

  if (groupByCompany) {
    const groups = new Map<string, { name: string; count: number; total: number; oldestDays: number }>();
    for (const r of rows) {
      const key = r.companyId ?? "unknown";
      const name = r.companyName ?? (r.companyId ? `Société #${r.companyId}` : "Société inconnue");
      const g = groups.get(key) ?? { name, count: 0, total: 0, oldestDays: 0 };
      g.count += 1;
      g.total += r.amountExcludingTax;
      if (r.daysOverdue > g.oldestDays) g.oldestDays = r.daysOverdue;
      groups.set(key, g);
    }
    const lines = [...groups.values()]
      .sort((a, b) => b.total - a.total)
      .map(
        (g) =>
          `- ${g.name} : ${g.count} facture(s) · ${g.total.toFixed(2)} € HT · plus ancienne : ${g.oldestDays}j de retard`
      );
    return `${header}\n\nGroupé par société (trié par total HT impayé décroissant) :\n${lines.join("\n")}${diagnostic}`;
  }

  const lines = rows.map((r) => {
    const companyDisplay =
      r.companyName ??
      (r.companyId ? `société #${r.companyId}` : r.orderId ? `order #${r.orderId} (driller)` : "société inconnue");
    const stateDisplay = r.stateLabel ?? (r.stateId !== null ? `état #${r.stateId}` : "état ?");
    const ttcSuffix = r.amountIncludingTax !== null ? ` / ${r.amountIncludingTax.toFixed(2)} € TTC` : "";
    return `[invoice #${r.invoiceId}] ${r.reference} | ${companyDisplay} | règlement prévu ${r.expectedPaymentDate} (${r.daysOverdue}j retard) | ${r.amountExcludingTax.toFixed(2)} € HT${ttcSuffix} | ${stateDisplay}`;
  });

  let capNote = "";
  if (unresolvedOrdersAfterCap > 0) {
    capNote = `\n\nℹ️ ${unresolvedOrdersAfterCap} ordre(s) supplémentaire(s) non résolu(s) (cap de 100 lookups atteint). Réduis le périmètre pour résoudre toutes les sociétés, ou drill manuellement via \`boond_orders_get\` sur les \`order #<id>\` affichés.`;
  }

  return `${header}\n\n${lines.join("\n")}${capNote}${diagnostic}`;
}

function registerInvoiceOverdueTool(server: McpServer): void {
  server.registerTool(
    "boond_invoices_overdue",
    {
      title: "Factures en retard de paiement",
      description: OVERDUE_DESCRIPTION,
      inputSchema: InvoiceOverdueSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const { rows, scanned, asOfDate, firstInvoiceKeys, unresolvedOrdersAfterCap } =
        await fetchOverdueInvoices(params);
      const text = formatOverdueOutput(
        rows,
        scanned,
        asOfDate,
        params.groupByCompany ?? false,
        firstInvoiceKeys,
        unresolvedOrdersAfterCap
      );
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
