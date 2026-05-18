/**
 * index.ts — Versusmind fork de fauguste/boondmanager-mcp-server
 *
 * Remplace le transport stdio/HTTP de fauguste par :
 *   - Transport SSE (compatible Claude.ai Team remote MCP)
 *   - Middleware OAuth Entra ID
 *   - Résolution Key Vault par utilisateur
 *   - Injection JWT Boondmanager par requête via AsyncLocalStorage
 *
 * Les 158 outils fauguste (src/tools/) sont conservés intégralement.
 */

import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { requestContext } from "./auth/context.js";
import { validateEntraToken } from "./auth/entra.js";
import { getBoondJwtForUser } from "./auth/keyvault.js";
import { registerTools } from "./tools/index.js";

// ─────────────────────────────────────────
// VALIDATION AU DÉMARRAGE
// ─────────────────────────────────────────
const REQUIRED_ENV = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_KEYVAULT_URL",
];
REQUIRED_ENV.forEach((k) => {
  if (!process.env[k]) {
    console.error(`[ERREUR] Variable d'environnement manquante : ${k}`);
    process.exit(1);
  }
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ─────────────────────────────────────────
// TYPES EXPRESS
// ─────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      userEmail?: string;
      boondJwt?: string;
    }
  }
}

// ─────────────────────────────────────────
// MIDDLEWARE AUTH
// ─────────────────────────────────────────
async function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    const raw = req.headers.authorization ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
    if (!token) throw new Error("Authorization header manquant");

    const userEmail = await validateEntraToken(token);
    const boondJwt = await getBoondJwtForUser(userEmail);

    req.userEmail = userEmail;
    req.boondJwt = boondJwt;

    console.log(`[AUTH] Connexion : ${userEmail}`);
    next();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[AUTH] Refus : ${message}`);
    res.status(401).json({ error: "Non autorisé", detail: message });
  }
}

// ─────────────────────────────────────────
// SERVEUR EXPRESS
// ─────────────────────────────────────────
const app = express();
app.use(
  cors({ origin: "https://claude.ai", methods: ["GET", "POST", "OPTIONS"] })
);
app.use(express.json());

// Health check sans auth (pour Azure Container Apps)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0-vsm", tools: 158 });
});

// Métadonnées OAuth 2.0 pour Claude.ai
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  res.json({
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    authorization_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    token_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    scopes_supported: [
      "openid",
      "profile",
      "email",
      `api://${clientId}/boondmanager`,
    ],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// Store des transports SSE actifs
const activeTransports = new Map<string, SSEServerTransport>();

// ─────────────────────────────────────────
// ENDPOINT SSE
// ─────────────────────────────────────────
app.get("/sse", authMiddleware, async (req, res) => {
  const userEmail = req.userEmail!;
  const boondJwt = req.boondJwt!;

  const transport = new SSEServerTransport("/messages", res);
  activeTransports.set(transport.sessionId, transport);

  res.on("close", () => {
    activeTransports.delete(transport.sessionId);
    console.log(
      `[SSE] Déconnexion : ${userEmail} (session ${transport.sessionId})`
    );
  });

  const mcpServer = new Server(
    { name: "boondmanager-vsm", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  registerTools(mcpServer);

  await requestContext.run({ userEmail, boondJwt }, async () => {
    await mcpServer.connect(transport);
  });
});

// ─────────────────────────────────────────
// ENDPOINT POST — messages MCP entrants
// ─────────────────────────────────────────
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = activeTransports.get(sessionId);

  if (!transport) {
    return res.status(404).json({ error: `Session inconnue : ${sessionId}` });
  }

  try {
    const raw = req.headers.authorization ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Authorization manquant" });

    const userEmail = await validateEntraToken(token);
    const boondJwt = await getBoondJwtForUser(userEmail);

    await requestContext.run({ userEmail, boondJwt }, async () => {
      await transport.handlePostMessage(req, res);
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(401).json({ error: "Non autorisé", detail: message });
  }
});

// ─────────────────────────────────────────
// DÉMARRAGE
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Boondmanager MCP Server (Versusmind) — port ${PORT}`);
  console.log(`  Tenant  : ${process.env.AZURE_TENANT_ID}`);
  console.log(`  App ID  : ${process.env.AZURE_CLIENT_ID}`);
  console.log(`  KV URL  : ${process.env.AZURE_KEYVAULT_URL}`);
  console.log(`  Outils  : 158`);
});
