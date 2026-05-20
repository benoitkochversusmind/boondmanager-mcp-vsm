import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requestContext } from "./auth/context.js";
import { getBoondJwtForUser } from "./auth/keyvault.js";
import { registerCandidateTools } from "./tools/candidates.js";
import { registerResourceTools } from "./tools/resources.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerCompanyTools } from "./tools/companies.js";
import { registerOpportunityTools } from "./tools/opportunities.js";
import { registerActionTools } from "./tools/actions.js";
import { registerTimesheetTools } from "./tools/timesheets.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerDeliveryTools } from "./tools/deliveries.js";
import { registerAbsenceTools } from "./tools/absences.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerProductTools } from "./tools/products.js";
import { registerPositioningTools } from "./tools/positionings.js";
import { registerPaymentTools } from "./tools/payments.js";
import { registerAdvantageTools } from "./tools/advantages.js";
import { registerApplicationTools } from "./tools/application.js";
import { registerContractTools } from "./tools/contracts.js";
import { registerPurchaseTools } from "./tools/purchases.js";
import { registerProviderInvoiceTools } from "./tools/provider-invoices.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerAgencyTools } from "./tools/agencies.js";
import { registerBusinessUnitTools } from "./tools/business-units.js";
import { registerRoleTools } from "./tools/roles.js";
import { registerLogTools } from "./tools/logs.js";
import { registerNotificationTools } from "./tools/notifications.js";
import { registerThreadTools } from "./tools/threads.js";
import { registerTodolistTools } from "./tools/todolists.js";
import { registerFlagTools } from "./tools/flags.js";
import { registerCalendarTools } from "./tools/calendars.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import { registerValidationTools } from "./tools/validations.js";
import { registerPoleTools } from "./tools/poles.js";
import { registerReportingTools } from "./tools/reporting.js";
import { registerPlanningAbsenceTools } from "./tools/planning-absences.js";
import { registerWorkflowTools } from "./tools/workflows.js";

const REQUIRED_ENV = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_KEYVAULT_URL"];
REQUIRED_ENV.forEach((k) => {
  if (!process.env[k]) { console.error("Missing env var: " + k); process.exit(1); }
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ─────────────────────────────────────────────────────────────────────────────
// USER REGISTRY
// Maps MCP tokens to Boondmanager user emails.
// Convention: MCP_USER_n_TOKEN + MCP_USER_n_EMAIL (n = 1, 2, 3, ...)
// Example:
//   MCP_USER_1_TOKEN=vsm-mcp-abc123  MCP_USER_1_EMAIL=benoit.koch@versusmind.eu
//   MCP_USER_2_TOKEN=vsm-mcp-def456  MCP_USER_2_EMAIL=elie.dahan@versusmind.eu
// ─────────────────────────────────────────────────────────────────────────────
interface UserEntry {
  token: string;
  email: string;
  cachedJwt: string;
}

function buildUserRegistry(): Map<string, UserEntry> {
  const registry = new Map<string, UserEntry>();
  let n = 1;
  while (true) {
    const tokenKey = `MCP_USER_${n}_TOKEN`;
    const emailKey = `MCP_USER_${n}_EMAIL`;
    const token = process.env[tokenKey];
    const email = process.env[emailKey];
    if (!token || !email) break;
    registry.set(token, { token, email, cachedJwt: "" });
    n++;
  }
  return registry;
}

const _users = buildUserRegistry();

if (_users.size === 0) {
  console.error("No users configured. Set MCP_USER_1_TOKEN and MCP_USER_1_EMAIL.");
  process.exit(1);
}

// Pre-cache all users JWTs at startup
(async () => {
  for (const entry of _users.values()) {
    try {
      entry.cachedJwt = await getBoondJwtForUser(entry.email);
      console.log("[INIT] JWT pre-cached for:", entry.email);
    } catch (err) {
      console.warn("[INIT] JWT pre-cache failed for " + entry.email + ":", err);
    }
  }
})();

function registerAllTools(server: McpServer): void {
  registerCandidateTools(server);
  registerResourceTools(server);
  registerContactTools(server);
  registerCompanyTools(server);
  registerOpportunityTools(server);
  registerActionTools(server);
  registerTimesheetTools(server);
  registerProjectTools(server);
  registerInvoiceTools(server);
  registerOrderTools(server);
  registerDeliveryTools(server);
  registerAbsenceTools(server);
  registerExpenseTools(server);
  registerProductTools(server);
  registerPositioningTools(server);
  registerPaymentTools(server);
  registerAdvantageTools(server);
  registerApplicationTools(server);
  registerContractTools(server);
  registerPurchaseTools(server);
  registerProviderInvoiceTools(server);
  registerAccountTools(server);
  registerAgencyTools(server);
  registerBusinessUnitTools(server);
  registerRoleTools(server);
  registerLogTools(server);
  registerNotificationTools(server);
  registerThreadTools(server);
  registerTodolistTools(server);
  registerFlagTools(server);
  registerCalendarTools(server);
  registerWebhookTools(server);
  registerValidationTools(server);
  registerPoleTools(server);
  registerReportingTools(server);
  registerPlanningAbsenceTools(server);
  registerWorkflowTools(server);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — resolve user from token (Bearer header or ?token= query param)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveUser(
  req: express.Request,
  res: express.Response
): Promise<UserEntry | null> {
  const auth = req.headers["authorization"] ?? "";
  const fromHeader = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const fromQuery = (req.query.token as string) ?? "";
  const provided = fromHeader || fromQuery;

  if (!provided) {
    res.status(401).json({ error: "Unauthorized", detail: "Bearer token or ?token= required" });
    return null;
  }

  const entry = _users.get(provided);
  if (!entry) {
    console.warn("[AUTH] Unknown token:", provided.substring(0, 12) + "...");
    res.status(401).json({ error: "Unauthorized", detail: "Invalid token" });
    return null;
  }

  // Refresh JWT if not cached
  if (!entry.cachedJwt) {
    try {
      entry.cachedJwt = await Promise.race([
        getBoondJwtForUser(entry.email),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("JWT timeout")), 10_000)
        ),
      ]);
    } catch (err) {
      console.error("[AUTH] JWT unavailable for " + entry.email + ":", err);
      res.status(503).json({ error: "Boondmanager credentials unavailable for user" });
      return null;
    }
  }

  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP HANDLER — Streamable HTTP, stateless, multi-user
// ─────────────────────────────────────────────────────────────────────────────
async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  const user = await resolveUser(req, res);
  if (!user) return;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false,
  });
  const server = new McpServer({ name: "boondmanager-vsm", version: "1.0.0" });
  registerAllTools(server);

  res.on("close", () => { void transport.close(); void server.close(); });

  await requestContext.run({ userEmail: user.email, boondJwt: user.cachedJwt }, async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
}

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json());

app.get("/health", (_req, res) => {
  const users = Array.from(_users.values()).map(u => ({
    email: u.email,
    jwtReady: !!u.cachedJwt
  }));
  res.json({ status: "ok", version: "1.0.0-vsm", users });
});

app.all("/sse", handleMcp);
app.all("/mcp", handleMcp);

app.listen(PORT, () => {
  console.log("Boondmanager MCP Server (Versusmind) - Streamable HTTP - port " + PORT);
  console.log("  Users    : " + Array.from(_users.values()).map(u => u.email).join(", "));
  console.log("  Tenant   : " + process.env.AZURE_TENANT_ID);
  console.log("  KV URL   : " + process.env.AZURE_KEYVAULT_URL);
});
