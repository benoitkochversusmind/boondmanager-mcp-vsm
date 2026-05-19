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
  if (!process.env[k]) {
    console.error("Missing env var: " + k);
    process.exit(1);
  }
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const _defaultUser = process.env.MCP_DEFAULT_USER ?? "benoit.koch@versusmind.eu";
let _cachedBoondJwt: string = "";

// ─────────────────────────────────────────────────────────────────────────────
// JWT PRE-CACHE — fetched once at startup via system-assigned managed identity
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    _cachedBoondJwt = await getBoondJwtForUser(_defaultUser);
    console.log("[INIT] Boond JWT pre-cached for:", _defaultUser);
  } catch (err) {
    console.warn("[INIT] Boond JWT pre-cache failed (will retry on first request):", err);
  }
})();

async function getBoondJwtCached(userEmail: string): Promise<string> {
  if (_cachedBoondJwt) return _cachedBoondJwt;
  _cachedBoondJwt = await getBoondJwtForUser(userEmail);
  return _cachedBoondJwt;
}

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
// MCP HANDLER — Streamable HTTP, stateless
// Claude.ai sends POST requests; each is a fully independent JSON-RPC exchange.
// ─────────────────────────────────────────────────────────────────────────────
async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  const userEmail = _defaultUser;

  let boondJwt = _cachedBoondJwt;
  if (!boondJwt) {
    try {
      boondJwt = await Promise.race([
        getBoondJwtCached(userEmail),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("JWT fetch timeout after 10 s")), 10_000)
        ),
      ]);
    } catch (err) {
      console.error("[MCP] JWT unavailable:", err);
      res.status(503).json({ error: "Boondmanager credentials unavailable, retry shortly" });
      return;
    }
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session persistence
    enableJsonResponse: false,
  });

  const server = new McpServer({ name: "boondmanager-vsm", version: "1.0.0" });
  registerAllTools(server);

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await requestContext.run({ userEmail, boondJwt }, async () => {
    await server.connect(transport);
    // Pass req.body (already parsed by express.json) as third arg
    await transport.handleRequest(req, res, req.body);
  });
}

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0-vsm", jwtReady: !!_cachedBoondJwt });
});

// Support both /sse (existing Claude.ai URL) and /mcp (MCP standard path)
app.all("/sse", handleMcp);
app.all("/mcp", handleMcp);

app.listen(PORT, () => {
  console.log("Boondmanager MCP Server (Versusmind) - Streamable HTTP - port " + PORT);
  console.log("  Endpoint : /sse  and  /mcp");
  console.log("  Tenant   : " + process.env.AZURE_TENANT_ID);
  console.log("  KV URL   : " + process.env.AZURE_KEYVAULT_URL);
});
