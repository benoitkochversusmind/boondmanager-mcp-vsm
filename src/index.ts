import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { requestContext } from "./auth/context.js";
import { validateEntraToken } from "./auth/entra.js";
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

declare global {
  namespace Express {
    interface Request {
      userEmail?: string;
      boondJwt?: string;
    }
  }
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
// JWT PRE-CACHE
// Fetched once at startup so the first SSE request never blocks on Key Vault.
// Errors here are non-fatal: the first SSE request will retry with a timeout.
// ─────────────────────────────────────────────────────────────────────────────
const _defaultUser = process.env.MCP_DEFAULT_USER ?? "benoit.koch@versusmind.eu";
let _cachedBoondJwt: string = "";

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

// ─────────────────────────────────────────────────────────────────────────────
// SESSION STORE
// Keeps transport + credentials together so /messages never needs to
// re-authenticate: the session inherits the identity established at /sse.
// ─────────────────────────────────────────────────────────────────────────────
interface SessionData {
  transport: SSEServerTransport;
  userEmail: string;
  boondJwt: string;
}
const activeSessions = new Map<string, SessionData>();

// ─────────────────────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE (kept for future routes that require Entra auth)
// ─────────────────────────────────────────────────────────────────────────────
async function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    const raw = req.headers.authorization ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
    if (!token) throw new Error("Authorization header missing");

    const apiKey = process.env.MCP_API_KEY;
    if (apiKey && token === apiKey) {
      const userEmail = _defaultUser;
      req.userEmail = userEmail;
      req.boondJwt = await getBoondJwtCached(userEmail);
      console.log("[AUTH] API key accepted for:", userEmail);
      next();
      return;
    }

    const userEmail = await validateEntraToken(token);
    const boondJwt = await getBoondJwtForUser(userEmail);
    req.userEmail = userEmail;
    req.boondJwt = boondJwt;
    console.log("[AUTH] Connected:", userEmail);
    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[AUTH] Refused:", message);
    res.setHeader("WWW-Authenticate", "Bearer realm=\"Boondmanager MCP\"");
    res.status(401).json({ error: "Unauthorized", detail: message });
  }
}

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0-vsm",
    jwtReady: !!_cachedBoondJwt,
  });
});

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  res.json({
    issuer: "https://login.microsoftonline.com/" + tenantId + "/v2.0",
    authorization_endpoint:
      "https://login.microsoftonline.com/" + tenantId + "/oauth2/v2.0/authorize",
    token_endpoint:
      "https://login.microsoftonline.com/" + tenantId + "/oauth2/v2.0/token",
    scopes_supported: ["openid", "profile", "email", "api://" + clientId + "/boondmanager"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE ENDPOINT
// Fix: JWT is fetched from cache (pre-loaded at startup) so the transport is
// created immediately. If cache is empty, we wait at most 10 s before returning
// 503 — never hanging indefinitely.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/sse", async (req, res) => {
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
      console.error("[SSE] JWT unavailable:", err);
      res.status(503).json({ error: "Boondmanager credentials unavailable, retry shortly" });
      return;
    }
  }

  const transport = new SSEServerTransport("/messages", res);
  activeSessions.set(transport.sessionId, { transport, userEmail, boondJwt });
  console.log("[SSE] New session:", transport.sessionId, "for", userEmail);

  res.on("close", () => {
    activeSessions.delete(transport.sessionId);
    console.log("[SSE] Disconnected:", transport.sessionId);
  });

  const mcpServer = new McpServer({
    name: "boondmanager-vsm",
    version: "1.0.0",
  });
  registerAllTools(mcpServer);

  await requestContext.run({ userEmail, boondJwt }, async () => {
    await mcpServer.connect(transport);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES ENDPOINT
// Fix: reuses the JWT stored in the session established at /sse.
// No re-authentication needed — Claude.ai does not send Bearer tokens here.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const session = activeSessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Unknown session: " + sessionId });
  }
  const { transport, userEmail, boondJwt } = session;
  try {
    await requestContext.run({ userEmail, boondJwt }, async () => {
      await transport.handlePostMessage(req, res);
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MESSAGES] Error:", message);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log("Boondmanager MCP Server (Versusmind) - port " + PORT);
  console.log("  Tenant : " + process.env.AZURE_TENANT_ID);
  console.log("  App ID : " + process.env.AZURE_CLIENT_ID);
  console.log("  KV URL : " + process.env.AZURE_KEYVAULT_URL);
});
