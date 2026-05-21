import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  InvoiceSearchSchema,
  InvoiceCreateSchema,
  InvoiceUpdateSchema,
  InvoiceOverdueSchema,
  IdSchema,
} from "../schemas/index.js";
import type { InvoiceOverdueInput } from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatListResponse, formatDetailResponse } from "../services/boond-client.js";
import { getDictionary, resolveDictionaryPath } from "../services/dictionary.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";
import { buildJsonApiBody } from "./crud-factory.js";

const INVOICE_SEARCH_DESCRIPTION = `Recherche des factures dans BoondManager.

Filtres principaux :
• **Périmètre** — \`perimeterDynamic: ["data"]\` (mes factures), \`perimeterManagers: [<id>]\` (équipe d'un manager), \`perimeterPoles\`, \`perimeterAgencies\`, \`perimeterBusinessUnits\`. \`narrowPerimeter: true\` pour AND.
• **États** — \`states: [<id>]\` (IDs depuis dictionnaire \`setting.state.invoice\` via \`boond_application_dictionary\`).
• **Période** — \`period: "created" | "updated" | "expectedPayment" | "performedPayment" | "period"\` + \`startDate\`/\`endDate\` (YYYY-MM-DD). \`expectedPayment\` cible la \`dueDate\`.
• **Société / projet** — \`companyId\`, \`projectId\`.
• **Tri** — \`sort\` (ex: \`dueDate\`) + \`order\` (\`asc\`/\`desc\`).

Pour les **factures en retard de paiement** spécifiquement, utiliser plutôt \`boond_invoices_overdue\` qui fait la logique d'exclusion des états payés + filtre \`dueDate < today\` + filtre montant en un seul appel.

Pagination : \`page\`, \`pageSize\` (max 500).

Returns : liste paginée des factures.`;

export function registerInvoiceTools(server: McpServer): void {
  // Search invoices
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
      const response = await apiRequest("/invoices", "GET", undefined, query);
      return {
        content: [{ type: "text" as const, text: formatListResponse(response, "facture") }],
      };
    }
  );

  // Composite tool: list overdue (unpaid + dueDate passed) invoices
  registerInvoiceOverdueTool(server);

  // Get invoice details
  server.registerTool(
    "boond_invoices_get",
    {
      title: "Détails d'une facture",
      description: `Récupère les informations détaillées d'une facture par son ID.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const response = await apiRequest(`/invoices/${params.id}`);
      return {
        content: [{ type: "text" as const, text: formatDetailResponse(response) }],
      };
    }
  );

  // Create invoice
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

  // Update invoice
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

  // Delete invoice
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

// ---- Composite tool: overdue invoices ----

const OVERDUE_DESCRIPTION = `Liste les factures en retard de paiement (impayées + date d'échéance dépassée), filtrables par pôle, manager, agence, BU, société et fourchette de montant HT.

**Date pivot** : on prend \`expectedPaymentDate\` (date de règlement prévu) si elle est renseignée, sinon \`dueDate\` (échéance contractuelle). Ces deux champs ne sont pas synonymes dans BoondManager — selon les usages comptables, l'un OU l'autre est rempli. Le tool fait le fallback automatiquement et indique dans la sortie quel champ a été utilisé pour chaque ligne.

Un seul appel orchestre :
1. Récupération du dictionnaire \`setting.state.invoice\` pour identifier les états « payée / annulée » à exclure.
2. Recherche \`/invoices\` avec les filtres de périmètre + \`states\` (exclusion des payées/annulées).
3. Pagination jusqu'à \`maxPages\` (défaut 5 × \`pageSize\` 500 = 2500 factures scannées).
4. Filtre côté serveur : effectiveDate (= \`expectedPaymentDate ?? dueDate\`) strictement antérieure à \`asOfDate\` (défaut = aujourd'hui) + bornes \`amountMin/MaxExcludingTax\`.
5. Sortie triée par jours de retard décroissants (ou groupée par société si \`groupByCompany: true\`).

Paramètres clés :
- \`asOfDate\` (YYYY-MM-DD, défaut aujourd'hui) — date pivot du retard
- \`perimeterPoles\`, \`perimeterManagers\`, \`perimeterAgencies\`, \`perimeterBusinessUnits\`, \`perimeterDynamic\` — restreindre le périmètre (cf. \`boond_application_current_user\` pour son propre ID)
- \`companyId\` — limiter à un client
- \`amountMinExcludingTax\`, \`amountMaxExcludingTax\` — bornes en € HT
- \`groupByCompany: true\` — regroupe et affiche le total impayé par client

Returns : tableau lisible par le LLM, plus un en-tête statistique (nb factures, total HT impayé, période d'analyse).`;

interface InvoiceStateRef {
  id: number;
  value: string;
}

type DateField = "expectedPaymentDate" | "dueDate";

interface OverdueRow {
  invoiceId: string;
  reference: string;
  companyId: string | null;
  companyName: string | null;
  effectiveDate: string;
  dateField: DateField;
  daysOverdue: number;
  amountExcludingTax: number;
  stateId: number | null;
  stateLabel: string | null;
}

function extractInvoiceStates(payload: JsonApiResponse): InvoiceStateRef[] {
  const raw = resolveDictionaryPath(payload, "setting.state.invoice");
  if (!Array.isArray(raw)) return [];
  const out: InvoiceStateRef[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const id = Number((entry as Record<string, unknown>).id);
    const value = (entry as Record<string, unknown>).value;
    if (!Number.isFinite(id) || typeof value !== "string") continue;
    out.push({ id, value });
  }
  return out;
}

/**
 * Returns the IDs of invoice states that count as "still owing" — i.e. everything
 * except fully paid and cancelled. "Partiellement payée" is intentionally kept
 * because there is still an outstanding balance to chase.
 */
function pickUnpaidStateIds(states: InvoiceStateRef[]): number[] {
  return states
    .filter((s) => {
      const v = s.value.toLowerCase().trim();
      if (/^pay[ée]e?$/.test(v)) return false; // "payée" / "paye" / "paid"
      if (/^facture\s+pay/i.test(v)) return false; // "facture payée"
      if (/annul/.test(v)) return false; // "annulée"
      return true;
    })
    .map((s) => s.id);
}

function buildCompanyLookup(included: JsonApiResource[] | undefined): Map<string, string> {
  const lookup = new Map<string, string>();
  if (!included) return lookup;
  for (const resource of included) {
    if (resource.type !== "company" && resource.type !== "society") continue;
    const name = resource.attributes?.["name"];
    if (typeof name === "string") lookup.set(resource.id, name);
  }
  return lookup;
}

function getCompanyRef(resource: JsonApiResource): string | null {
  const rel = resource.relationships?.["company"] ?? resource.relationships?.["society"];
  const data = rel?.data;
  if (!data || Array.isArray(data)) return null;
  return data.id;
}

function diffDays(fromMs: number, toMs: number): number {
  return Math.floor((toMs - fromMs) / (1000 * 60 * 60 * 24));
}

export async function fetchOverdueInvoices(params: InvoiceOverdueInput): Promise<{
  rows: OverdueRow[];
  scanned: number;
  asOfDate: string;
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

  // No explicit sort: BoondManager's default ordering covers both expectedPaymentDate
  // and dueDate populations, and we post-sort client-side by daysOverdue anyway.
  // Forcing `sort: "dueDate"` previously caused records with only expectedPaymentDate
  // populated to land at the end of the result set and risk being cut off by maxPages.
  const baseQuery: Record<string, unknown> = {
    maxResults: params.pageSize,
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
  const companyNames = new Map<string, string>();

  for (let page = 1; page <= params.maxPages; page++) {
    const response = await apiRequest("/invoices", "GET", undefined, { ...baseQuery, page });
    const data = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
    scanned += data.length;

    for (const [id, name] of buildCompanyLookup(response.included)) {
      companyNames.set(id, name);
    }

    for (const inv of data) {
      const a = (inv.attributes ?? {}) as Record<string, unknown>;
      // `expectedPaymentDate` (date de règlement prévu, saisie comptable) prend le pas
      // sur `dueDate` (échéance contractuelle, parfois calculée automatiquement) parce
      // qu'en pratique chez les ESN françaises seule l'une des deux est renseignée par
      // facture, et c'est expectedPaymentDate qui sert à piloter le recouvrement.
      const expectedPaymentRaw = a["expectedPaymentDate"];
      const dueDateRaw = a["dueDate"];
      const expectedPaymentDate = typeof expectedPaymentRaw === "string" ? expectedPaymentRaw : null;
      const dueDate = typeof dueDateRaw === "string" ? dueDateRaw : null;
      const effectiveDate = expectedPaymentDate ?? dueDate;
      if (!effectiveDate) continue;
      const dateField: DateField = expectedPaymentDate ? "expectedPaymentDate" : "dueDate";
      const effectiveMs = Date.parse(`${effectiveDate}T00:00:00Z`);
      if (!Number.isFinite(effectiveMs) || effectiveMs >= asOfMs) continue;

      const amount = Number(a["amountExcludingTax"] ?? a["turnover"] ?? 0);
      if (params.amountMinExcludingTax !== undefined && amount < params.amountMinExcludingTax) continue;
      if (params.amountMaxExcludingTax !== undefined && amount > params.amountMaxExcludingTax) continue;

      const companyId = getCompanyRef(inv);
      const stateRaw = a["state"];
      const stateId = typeof stateRaw === "number" ? stateRaw : Number(stateRaw);
      rows.push({
        invoiceId: inv.id,
        reference: typeof a["reference"] === "string" ? (a["reference"] as string) : "(sans réf)",
        companyId,
        companyName: companyId ? (companyNames.get(companyId) ?? null) : null,
        effectiveDate,
        dateField,
        daysOverdue: diffDays(effectiveMs, asOfMs),
        amountExcludingTax: amount,
        stateId: Number.isFinite(stateId) ? stateId : null,
        stateLabel: Number.isFinite(stateId) ? (stateLabelById.get(stateId) ?? null) : null,
      });
    }

    if (data.length < params.pageSize) break;
  }

  rows.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return { rows, scanned, asOfDate };
}

function formatOverdueOutput(rows: OverdueRow[], scanned: number, asOfDate: string, groupByCompany: boolean): string {
  if (rows.length === 0) {
    return `Aucune facture en retard au ${asOfDate} (${scanned} factures scannées dans le périmètre).`;
  }

  const totalAmount = rows.reduce((sum, r) => sum + r.amountExcludingTax, 0);
  const header = [
    `📋 Factures en retard de paiement au ${asOfDate}`,
    `Total : ${rows.length} factures · ${totalAmount.toFixed(2)} € HT impayés · ${scanned} scannées`,
  ].join("\n");

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
    return `${header}\n\nGroupé par société (trié par total HT impayé décroissant) :\n${lines.join("\n")}`;
  }

  const lines = rows.map((r) => {
    const companyDisplay = r.companyName ?? (r.companyId ? `société #${r.companyId}` : "société inconnue");
    const stateDisplay = r.stateLabel ?? (r.stateId !== null ? `état #${r.stateId}` : "état ?");
    const dateLabel = r.dateField === "expectedPaymentDate" ? "règlement prévu" : "échéance";
    return `[invoice #${r.invoiceId}] ${r.reference} | ${companyDisplay} | ${dateLabel} ${r.effectiveDate} (${r.daysOverdue}j retard) | ${r.amountExcludingTax.toFixed(2)} € HT | ${stateDisplay}`;
  });

  return `${header}\n\n${lines.join("\n")}`;
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
      const { rows, scanned, asOfDate } = await fetchOverdueInvoices(params);
      const text = formatOverdueOutput(rows, scanned, asOfDate, params.groupByCompany ?? false);
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
