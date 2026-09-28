import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExpenseSearchSchema, ExpenseCreateSchema, ExpenseUpdateSchema, IdSchema } from "../schemas/index.js";
import { apiRequest, buildSearchQuery } from "../services/boond-client.js";
import { buildJsonApiBody } from "./crud-factory.js";
import type { JsonApiResponse, JsonApiResource } from "../types.js";

// ---- Expense-report formatters ---------------------------------------------
//
// BoondManager expense reports (`expensesreport`) carry NO top-level amount:
// the money only lives inside the per-line arrays (`actualExpenses`,
// `fixedExpenses`, `projectsExpenses`), each line exposing `amountIncludingTax`
// + `tax` (and, for kilometric lines, `number` × `ratePerKilometerType.amount`).
// The generic `formatEntitySummary` / `formatDetailResponse` therefore surfaced
// neither the total nor a readable line breakdown — a bare `[expense #id]` on
// search and a raw JSON dump on get. These dedicated formatters compute the
// total (TTC / TVA / HT) and render one line per expense, mirroring the
// `formatActionsList` / `formatPositioningsList` pattern. Used by
// `boond_expenses_search`, `boond_expenses_get` and the
// `boond_resources_expenses_reports` tab tool (via `buildTabHandler`).

// Expense-report `state` is a textual enum (not an integer dictionary id), so
// it is mapped statically rather than through `getStateMap`.
const EXPENSE_STATE_LABELS: Record<string, string> = {
  saved: "Enregistrée",
  savedAndNoValidation: "Enregistrée (sans validation)",
  waitingForValidation: "En attente de validation",
  validated: "Validée",
  rejected: "Rejetée",
  canceled: "Annulée",
  cancelled: "Annulée",
};

function expenseStateLabel(state: unknown): string | null {
  if (state === undefined || state === null || state === "") return null;
  const key = String(state);
  return EXPENSE_STATE_LABELS[key] ?? key;
}

function asAttrs(r: JsonApiResource): Record<string, unknown> {
  return (r.attributes ?? {}) as Record<string, unknown>;
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** "123.4" → "123.40 €". */
function money(n: number): string {
  return `${n.toFixed(2)} €`;
}

type ExpenseLine = Record<string, unknown>;

function isLineArray(v: unknown): v is ExpenseLine[] {
  return Array.isArray(v);
}

/** Effective TTC amount of a single line (kilometric lines are computed). */
function lineAmountTTC(line: ExpenseLine, kmRate: number): number {
  const ttc = toNumber(line["amountIncludingTax"]);
  if (ttc !== 0) return ttc;
  if (line["isKilometricExpense"] === true) return toNumber(line["number"]) * kmRate;
  return 0;
}

interface ReportTotals {
  ttc: number;
  tva: number;
  lineCount: number;
  /** true when at least one expense line array was present in the payload. */
  hasLines: boolean;
}

function computeReportTotals(a: Record<string, unknown>): ReportTotals {
  const kmRate = toNumber((a["ratePerKilometerType"] as Record<string, unknown> | undefined)?.["amount"]);
  const buckets = ["actualExpenses", "fixedExpenses", "projectsExpenses"];
  let ttc = 0;
  let tva = 0;
  let lineCount = 0;
  let hasLines = false;
  for (const key of buckets) {
    const arr = a[key];
    if (!isLineArray(arr)) continue;
    hasLines = true;
    for (const line of arr) {
      ttc += lineAmountTTC(line, kmRate);
      tva += toNumber(line["tax"]);
      lineCount++;
    }
  }
  return { ttc, tva, lineCount, hasLines };
}

function relId(r: JsonApiResource, key: string): string | null {
  const rels = (r.relationships ?? {}) as Record<string, { data?: { id?: string } | null }>;
  const id = rels[key]?.data?.id;
  return id ?? null;
}

/** Renders one expense line: "2023-03-23 · Train · 31.25 € TTC · TVA 0.00 € · Projet Inter Projet (#1313) · production". */
function formatExpenseLine(line: ExpenseLine, kmRate: number, index: number): string {
  const parts: string[] = [`${index}.`];
  const date = typeof line["startDate"] === "string" && line["startDate"] ? (line["startDate"] as string) : null;
  if (date) parts.push(date);

  const type = (line["expenseType"] as Record<string, unknown> | undefined)?.["name"];
  if (type) parts.push(String(type));

  const ttc = lineAmountTTC(line, kmRate);
  if (line["isKilometricExpense"] === true) {
    const km = toNumber(line["number"]);
    parts.push(`${km} km × ${kmRate} = ${money(ttc)} TTC`);
  } else {
    parts.push(`${money(ttc)} TTC`);
  }

  const tva = toNumber(line["tax"]);
  if (tva !== 0) parts.push(`TVA ${money(tva)}`);

  const project = (line["project"] as Record<string, unknown> | undefined) ?? undefined;
  if (project) {
    const ref = project["reference"] ?? project["id"];
    if (ref) parts.push(`Projet ${ref}${project["id"] ? ` (#${project["id"]})` : ""}`);
  }

  if (line["activityType"]) parts.push(String(line["activityType"]));
  if (line["reinvoiced"] === true) parts.push("refacturable");

  const title = line["title"];
  if (typeof title === "string" && title.trim()) parts.push(`« ${title.trim()} »`);

  return parts.join(" · ");
}

/** Full, human-readable detail of a single expense report, with computed total + line breakdown. */
export function formatExpensesReportDetail(response: JsonApiResponse): string {
  const entity = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!entity) return "Note de frais non trouvée.";
  const a = asAttrs(entity);

  const head = `Note de frais #${entity.id}${a["term"] ? ` — Période ${a["term"]}` : ""}`;

  const meta: string[] = [];
  const resource = relId(entity, "resource");
  const agency = relId(entity, "agency");
  if (resource) meta.push(`Ressource: #${resource}`);
  if (agency) meta.push(`Agence: #${agency}`);

  const flags: string[] = [];
  const state = expenseStateLabel(a["state"]);
  if (state) flags.push(`État: ${state}`);
  if (a["closed"] !== undefined) flags.push(`Clôturée: ${a["closed"] ? "oui" : "non"}`);
  if (a["paid"] !== undefined) flags.push(`Payée: ${a["paid"] ? "oui" : "non"}`);
  if (toNumber(a["advance"]) !== 0) flags.push(`Avance: ${money(toNumber(a["advance"]))}`);

  const km = a["ratePerKilometerType"] as Record<string, unknown> | undefined;
  const kmRate = toNumber(km?.["amount"]);
  const kmLine = km && km["name"] ? `Barème kilométrique: ${km["name"]} (${kmRate} €/km)` : null;

  const totals = computeReportTotals(a);
  const ht = totals.ttc - totals.tva;
  const totalLine = totals.hasLines
    ? `TOTAL: ${money(totals.ttc)} TTC (dont ${money(totals.tva)} TVA · ${money(ht)} HT) — ${totals.lineCount} ligne(s)`
    : "TOTAL: (aucune ligne de frais dans ce justificatif)";

  const kmRateForLines = kmRate;
  const lineSections: string[] = [];
  for (const key of ["actualExpenses", "fixedExpenses", "projectsExpenses"] as const) {
    const arr = a[key];
    if (!isLineArray(arr) || arr.length === 0) continue;
    const labelMap: Record<string, string> = {
      actualExpenses: "Frais réels",
      fixedExpenses: "Frais forfaitaires",
      projectsExpenses: "Frais de projet",
    };
    const rendered = arr.map((line, i) => formatExpenseLine(line, kmRateForLines, i + 1));
    lineSections.push(`${labelMap[key]} :\n${rendered.join("\n")}`);
  }

  const comments =
    typeof a["informationComments"] === "string" && a["informationComments"].trim()
      ? `Commentaire: ${a["informationComments"].trim()}`
      : null;

  const blocks: string[] = [head];
  if (meta.length) blocks.push(meta.join(" · "));
  if (flags.length) blocks.push(flags.join(" · "));
  if (kmLine) blocks.push(kmLine);
  if (comments) blocks.push(comments);
  blocks.push("");
  blocks.push(totalLine);
  if (lineSections.length) {
    blocks.push("");
    blocks.push(lineSections.join("\n\n"));
  }
  return blocks.join("\n");
}

/** One line per expense report, with term/state/paid + computed total when line arrays are present. */
export function formatExpensesReportsList(response: JsonApiResponse): string {
  const all = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
  if (all.length === 0) return "Aucune note de frais trouvée.";

  const lines: string[] = [];
  for (const r of all) {
    const a = asAttrs(r);
    const parts: string[] = [`[note de frais #${r.id}]`];

    const state = expenseStateLabel(a["state"]);
    if (state) parts.push(`État: ${state}`);
    if (a["term"]) parts.push(`Période ${a["term"]}`);
    if (a["paid"] !== undefined) parts.push(`Payée: ${a["paid"] ? "oui" : "non"}`);

    const totals = computeReportTotals(a);
    if (totals.hasLines) parts.push(`Total ${money(totals.ttc)} TTC (${totals.lineCount} ligne(s))`);

    const resource = relId(r, "resource");
    if (resource) parts.push(`Ressource #${resource}`);

    lines.push(parts.join(" · "));
  }

  const total = (response as { meta?: { totals?: { rows?: number } } }).meta?.totals?.rows;
  const header = total !== undefined ? `Total: ${total} note(s) de frais` : `${all.length} note(s) de frais`;
  return [header, ...lines].join("\n");
}

export function registerExpenseTools(server: McpServer): void {
  // Search expenses
  server.registerTool(
    "boond_expenses_search",
    {
      title: "Rechercher des notes de frais",
      description: `Recherche des notes de frais dans BoondManager avec filtres par ressource, projet et période.

Args:
  - keywords (string, optional): Termes de recherche
  - resourceId, projectId (string, optional): Filtrer par entité liée
  - startDate, endDate (string, optional): Période (YYYY-MM-DD)
  - page, pageSize: Pagination

Returns: Une ligne par note de frais (état, période, payée, ressource, et **total TTC quand les lignes sont incluses**). Utiliser \`boond_expenses_get\` pour le détail complet (montant + lignes).`,
      inputSchema: ExpenseSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const query = buildSearchQuery(params);
      const response = await apiRequest("/expenses", "GET", undefined, query);
      return {
        content: [{ type: "text" as const, text: formatExpensesReportsList(response) }],
      };
    }
  );

  // Get expense details
  server.registerTool(
    "boond_expenses_get",
    {
      title: "Détails d'une note de frais",
      description: `Récupère le détail d'une note de frais par son ID : **montant total TTC / TVA / HT calculé** à partir des lignes, plus le **détail ligne par ligne** (date, type de frais, montant, TVA, projet, activité, frais kilométriques). Inclut l'état, la période, le statut de paiement et la ressource.

Args:
  - id (string): ID de la note de frais`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const response = await apiRequest(`/expenses-reports/${params.id}`);
      return {
        content: [{ type: "text" as const, text: formatExpensesReportDetail(response) }],
      };
    }
  );

  // Create expense
  server.registerTool(
    "boond_expenses_create",
    {
      title: "Créer une note de frais",
      description: `Crée une nouvelle note de frais dans BoondManager, liée à une ressource et optionnellement un projet.`,
      inputSchema: ExpenseCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { resourceId, projectId, ...attrs } = params;
      const body = buildJsonApiBody("expense", attrs);
      const relationships: Record<string, unknown> = {};
      if (resourceId) relationships.resource = { data: { id: resourceId, type: "resource" } };
      if (projectId) relationships.project = { data: { id: projectId, type: "project" } };
      if (Object.keys(relationships).length > 0) {
        (body as Record<string, Record<string, unknown>>).data.relationships = relationships;
      }
      const response = await apiRequest("/expenses-reports", "POST", body);
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Note de frais créée avec succès.\nID: ${entity?.id}\n\n${formatExpensesReportDetail(response)}`,
          },
        ],
      };
    }
  );

  // Update expense
  server.registerTool(
    "boond_expenses_update",
    {
      title: "Modifier une note de frais",
      description: `Met à jour une note de frais existante. Seuls les champs fournis sont modifiés.`,
      inputSchema: ExpenseUpdateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { id, ...attrs } = params;
      const body = buildJsonApiBody("expense", attrs, id);
      const response = await apiRequest(`/expenses-reports/${id}`, "PUT", body);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Note de frais #${id} mise à jour.\n\n${formatExpensesReportDetail(response)}`,
          },
        ],
      };
    }
  );

  // Delete expense
  server.registerTool(
    "boond_expenses_delete",
    {
      title: "Supprimer une note de frais",
      description: `Supprime une note de frais de BoondManager. ⚠️ Action irréversible.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      await apiRequest(`/expenses-reports/${params.id}`, "DELETE");
      return {
        content: [{ type: "text" as const, text: `🗑️ Note de frais #${params.id} supprimée.` }],
      };
    }
  );
}
