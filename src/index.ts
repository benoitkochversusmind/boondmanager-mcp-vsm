import express from "express";
import cors from "cors";
import { createHash, randomBytes } from "node:crypto";
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

const PORT           = parseInt(process.env.PORT ?? "3000", 10);
const AZURE_TENANT   = process.env.AZURE_TENANT_ID!;
const AZURE_CLIENT   = process.env.AZURE_CLIENT_ID!;
const MCP_BASE_URL   = process.env.MCP_BASE_URL ??
  "https://ca-boondmcp-vsm.grayglacier-c341f9e8.francecentral.azurecontainerapps.io";
const OAUTH_CALLBACK = `${MCP_BASE_URL}/oauth/callback`;

// ─────────────────────────────────────────────────────────────────────────────
// USER REGISTRY — per-user token → email mapping
// MCP_USER_n_TOKEN + MCP_USER_n_EMAIL (n = 1, 2, 3, ...)
// ─────────────────────────────────────────────────────────────────────────────
interface UserEntry { token: string; email: string; cachedJwt: string; }
function buildUserRegistry(): Map<string, UserEntry> {
  const registry = new Map<string, UserEntry>();
  let n = 1;
  while (true) {
    const tok = process.env[`MCP_USER_${n}_TOKEN`];
    const email = process.env[`MCP_USER_${n}_EMAIL`];
    if (!tok || !email) break;
    registry.set(tok, { token: tok, email, cachedJwt: "" });
    n++;
  }
  return registry;
}
const _users = buildUserRegistry();
if (_users.size === 0) {
  console.warn("[WARN] No MCP_USER_n_TOKEN/EMAIL configured — only OAuth will work.");
}

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
// OAUTH — authorization server proxying Microsoft Entra
// ─────────────────────────────────────────────────────────────────────────────
interface PendingFlow {
  clientRedirectUri: string;  // Claude.ai callback URL
  clientState: string;        // state sent by Claude.ai
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
}
interface OAuthCode {
  email: string;
  clientRedirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
}
interface OAuthSession {
  email: string;
  boondJwt: string;
  expiresAt: number;
}

const pendingFlows  = new Map<string, PendingFlow>();   // our state → flow
const oauthCodes    = new Map<string, OAuthCode>();     // our code → info
const oauthSessions = new Map<string, OAuthSession>();  // Bearer token → session

// Cleanup every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingFlows)  if (v.expiresAt < now) pendingFlows.delete(k);
  for (const [k, v] of oauthCodes)    if (v.expiresAt < now) oauthCodes.delete(k);
  for (const [k, v] of oauthSessions) if (v.expiresAt < now) oauthSessions.delete(k);
}, 5 * 60_000).unref();

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function verifyPKCE(verifier: string, challenge: string, method: string): boolean {
  if (method === "S256") return b64url(createHash("sha256").update(verifier).digest()) === challenge;
  if (method === "plain") return verifier === challenge;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH RESOLVER — checks OAuth sessions and per-user tokens
// ─────────────────────────────────────────────────────────────────────────────
async function resolveUser(
  req: express.Request,
  res: express.Response
): Promise<{ email: string; boondJwt: string } | null> {
  const auth     = (req.headers["authorization"] ?? "") as string;
  const fromHdr  = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const fromQs   = (req.query.token as string) ?? "";
  const provided = fromHdr || fromQs;

  if (!provided) {
    res.setHeader("WWW-Authenticate",
      `Bearer realm="${MCP_BASE_URL}", resource_metadata="${MCP_BASE_URL}/.well-known/oauth-authorization-server"`);
    res.status(401).json({ error: "unauthorized", error_description: "Authentication required" });
    return null;
  }

  // 1. OAuth session (from /oauth/token flow)
  const session = oauthSessions.get(provided);
  if (session && session.expiresAt > Date.now()) {
    // Refresh Boondmanager JWT if expired (5 min cache in keyvault.ts)
    return { email: session.email, boondJwt: session.boondJwt };
  }

  // 2. Per-user static token
  const entry = _users.get(provided);
  if (!entry) {
    res.status(401).json({ error: "Unauthorized", detail: "Invalid token" });
    return null;
  }
  if (!entry.cachedJwt) {
    try {
      entry.cachedJwt = await getBoondJwtForUser(entry.email);
    } catch {
      res.status(503).json({ error: "Boondmanager credentials unavailable" });
      return null;
    }
  }
  return { email: entry.email, boondJwt: entry.cachedJwt };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/health", (_req, res) => {
  const users = Array.from(_users.values()).map(u => ({ email: u.email, jwtReady: !!u.cachedJwt }));
  res.json({ status: "ok", version: "1.0.0-vsm", users, oauthSessions: oauthSessions.size });
});

// ── OAuth metadata ────────────────────────────────────────────────────────────
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: MCP_BASE_URL,
    authorization_endpoint: `${MCP_BASE_URL}/oauth/authorize`,
    token_endpoint: `${MCP_BASE_URL}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "email", "profile"],
  });
});

// ── Authorization endpoint ───────────────────────────────────────────────────
app.get("/oauth/authorize", (req, res) => {
  const {
    redirect_uri,
    state = "",
    code_challenge,
    code_challenge_method = "S256",
  } = req.query as Record<string, string>;

  if (!redirect_uri || !code_challenge) {
    res.status(400).json({ error: "invalid_request", detail: "redirect_uri and code_challenge required" });
    return;
  }

  // Validate client_id if provided
  const configuredClientId = process.env.OAUTH_CLIENT_ID;
  const incomingClientId = req.query.client_id as string;
  if (configuredClientId && incomingClientId && incomingClientId !== configuredClientId) {
    res.status(400).json({ error: "unauthorized_client", detail: "Unknown client_id" });
    return;
  }

  const ourState = randomBytes(20).toString("hex");
  pendingFlows.set(ourState, {
    clientRedirectUri: redirect_uri,
    clientState: state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    expiresAt: Date.now() + 15 * 60_000, // 15 min
  });

  const params = new URLSearchParams({
    client_id: AZURE_CLIENT,
    response_type: "code",
    redirect_uri: OAUTH_CALLBACK,
    scope: "openid email profile",
    state: ourState,
    prompt: "select_account",
  });

  res.redirect(`https://login.microsoftonline.com/${AZURE_TENANT}/oauth2/v2.0/authorize?${params}`);
});

// ── Entra callback ───────────────────────────────────────────────────────────
app.get("/oauth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    console.error("[OAUTH] Entra error:", error, error_description);
    res.status(400).send(`Authentication failed: ${error}`);
    return;
  }

  const flow = pendingFlows.get(state);
  if (!flow) {
    res.status(400).send("Invalid or expired state. Please retry.");
    return;
  }
  pendingFlows.delete(state);

  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  if (!clientSecret) {
    console.error("[OAUTH] ENTRA_CLIENT_SECRET not set");
    res.status(500).send("Server misconfiguration");
    return;
  }

  try {
    // Exchange code with Entra
    const tokenResp = await fetch(
      `https://login.microsoftonline.com/${AZURE_TENANT}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: AZURE_CLIENT,
          client_secret: clientSecret,
          code,
          redirect_uri: OAUTH_CALLBACK,
          grant_type: "authorization_code",
          scope: "openid email profile",
        }),
      }
    );
    const tokenData = (await tokenResp.json()) as {
      access_token?: string; id_token?: string; error?: string; error_description?: string;
    };

    if (tokenData.error || !tokenData.id_token) {
      console.error("[OAUTH] Token exchange failed:", tokenData.error, tokenData.error_description);
      res.status(400).send(`Token exchange failed: ${tokenData.error}`);
      return;
    }

    // Extract email from id_token payload
    const payload = JSON.parse(Buffer.from(tokenData.id_token.split(".")[1], "base64url").toString());
    const email = (payload.email ?? payload.preferred_username ?? "").toLowerCase();

    if (!email || !email.includes("@")) {
      res.status(403).send("Could not retrieve email from Microsoft account.");
      return;
    }
    if (!email.endsWith("@versusmind.eu")) {
      res.status(403).send(`Access restricted to @versusmind.eu accounts. Got: ${email}`);
      return;
    }

    // Verify Boondmanager credentials exist for this user
    let boondJwt: string;
    try {
      boondJwt = await getBoondJwtForUser(email);
    } catch (err) {
      console.error("[OAUTH] No Boondmanager credentials for:", email, err);
      res.status(403).send(
        `No Boondmanager credentials configured for ${email}. Ask your administrator to run: add_user.py ${email} TOKEN`
      );
      return;
    }

    // Issue our auth code
    const ourCode = randomBytes(32).toString("hex");
    oauthCodes.set(ourCode, {
      email,
      clientRedirectUri: flow.clientRedirectUri,
      codeChallenge: flow.codeChallenge,
      codeChallengeMethod: flow.codeChallengeMethod,
      expiresAt: Date.now() + 5 * 60_000, // 5 min
    });

    console.log("[OAUTH] Auth code issued for:", email);

    // Redirect back to Claude.ai
    const redirectParams = new URLSearchParams({ code: ourCode });
    if (flow.clientState) redirectParams.set("state", flow.clientState);
    res.redirect(`${flow.clientRedirectUri}?${redirectParams}`);
  } catch (err) {
    console.error("[OAUTH] Callback error:", err);
    res.status(500).send("Internal error during authentication.");
  }
});

// ── Token endpoint ───────────────────────────────────────────────────────────
app.post("/oauth/token", async (req, res) => {
  const { code, code_verifier, grant_type } = req.body as Record<string, string>;

  // Validate client credentials if provided
  const configuredClientId = process.env.OAUTH_CLIENT_ID;
  const configuredClientSecret = process.env.OAUTH_CLIENT_SECRET;
  const { client_id: incomingClientId, client_secret: incomingClientSecret } = req.body as Record<string, string>;
  if (configuredClientId && incomingClientId) {
    if (incomingClientId !== configuredClientId ||
        (configuredClientSecret && incomingClientSecret !== configuredClientSecret)) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
  }

  // client_credentials: org-level access (maps to first configured user)
  if (grant_type === "client_credentials") {
    const orgEmail = process.env.MCP_USER_1_EMAIL ?? "benoit.koch@versusmind.eu";
    let boondJwt: string;
    try { boondJwt = await getBoondJwtForUser(orgEmail); }
    catch { res.status(503).json({ error: "temporarily_unavailable" }); return; }
    const accessToken = `org-${randomBytes(32).toString("hex")}`;
    oauthSessions.set(accessToken, { email: orgEmail, boondJwt, expiresAt: Date.now() + 24 * 3600_000 });
    console.log("[OAUTH] client_credentials token issued for org user:", orgEmail);
    res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 86400, scope: "openid email" });
    return;
  }

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }
  if (!code || !code_verifier) {
    res.status(400).json({ error: "invalid_request", detail: "code and code_verifier required" });
    return;
  }

  const authCode = oauthCodes.get(code);
  if (!authCode || authCode.expiresAt < Date.now()) {
    oauthCodes.delete(code);
    res.status(400).json({ error: "invalid_grant", detail: "Code expired or invalid" });
    return;
  }

  if (!verifyPKCE(code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
    res.status(400).json({ error: "invalid_grant", detail: "PKCE verification failed" });
    return;
  }
  oauthCodes.delete(code);

  // Fetch fresh Boondmanager JWT
  let boondJwt: string;
  try {
    boondJwt = await getBoondJwtForUser(authCode.email);
  } catch (err) {
    console.error("[OAUTH] JWT fetch failed for", authCode.email, err);
    res.status(503).json({ error: "temporarily_unavailable" });
    return;
  }

  const accessToken = `oauth-${randomBytes(32).toString("hex")}`;
  const expiresIn   = 8 * 3600; // 8 hours
  oauthSessions.set(accessToken, {
    email:     authCode.email,
    boondJwt,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  console.log("[OAUTH] Session created for:", authCode.email);
  res.json({ access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, scope: "openid email" });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP HANDLER — Streamable HTTP, stateless, multi-user
// ─────────────────────────────────────────────────────────────────────────────
async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  const user = await resolveUser(req, res);
  if (!user) return;

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
  const server = new McpServer({ name: "boondmanager-vsm", version: "1.0.0" });
  registerAllTools(server);

  res.on("close", () => { void transport.close(); void server.close(); });

  await requestContext.run({ userEmail: user.email, boondJwt: user.boondJwt }, async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
}

app.all("/sse", handleMcp);
app.all("/mcp", handleMcp);

app.listen(PORT, () => {
  console.log("Boondmanager MCP Server (Versusmind) - port " + PORT);
  console.log("  OAuth    : " + MCP_BASE_URL + "/oauth/authorize");
  console.log("  Users    : " + (_users.size > 0 ? Array.from(_users.values()).map(u => u.email).join(", ") : "none (OAuth only)"));
  console.log("  Tenant   : " + AZURE_TENANT);
  console.log("  KV URL   : " + process.env.AZURE_KEYVAULT_URL);
});
