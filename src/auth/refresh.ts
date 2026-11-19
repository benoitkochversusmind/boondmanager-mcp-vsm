import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// OAuth refresh tokens (stateless, signed JWT)
//
// The wrapper is its own OAuth authorization server. Before this, it issued only
// an 8h access token with NO refresh token, so Claude.ai had to re-run the full
// interactive login every time the token expired (~once a day) — and every
// container restart/deploy wiped the in-memory sessions too.
//
// A refresh token here is a **signed JWT** (HS256) carrying the user email. It is
// stateless: it survives restarts and redeploys without any datastore, because
// the only state needed is the signing secret. On refresh we re-mint a short
// access session and rotate the refresh token.
//
// Revocation: there is no per-token denylist (kept simple). To cut access,
// rotate the signing secret (invalidates every refresh token) or remove the
// user's Boond token secret from Key Vault (breaks their JWT fetch).
// ─────────────────────────────────────────────────────────────────────────────

export const REFRESH_TTL_SECONDS = 30 * 24 * 3600; // 30 days

let cachedSecret: string | null = null;

/**
 * Resolve the HMAC signing secret, memoized for the process lifetime so the
 * ephemeral fallback stays stable across calls. Precedence:
 *   OAUTH_REFRESH_SIGNING_SECRET → OAUTH_CLIENT_SECRET → ephemeral random.
 * The ephemeral fallback keeps the server functional but does NOT survive a
 * restart (refresh tokens would then be rejected after a restart), so a stable
 * secret must be configured in production.
 */
function signingSecret(): string {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.OAUTH_REFRESH_SIGNING_SECRET || process.env.OAUTH_CLIENT_SECRET;
  if (!configured) {
    console.warn(
      "[OAUTH] No OAUTH_REFRESH_SIGNING_SECRET (nor OAUTH_CLIENT_SECRET) set — refresh tokens will NOT survive a restart. Set one in production."
    );
  }
  cachedSecret = configured || randomBytes(32).toString("hex");
  return cachedSecret;
}

/** For tests: forget the memoized secret so a freshly-set env var is picked up. */
export function resetRefreshSecretForTests(): void {
  cachedSecret = null;
}

/** Mint a signed refresh token for a user email (30-day TTL, unique jti). */
export function issueRefreshToken(email: string): string {
  return jwt.sign({ typ: "refresh" }, signingSecret(), {
    subject: email.toLowerCase(),
    expiresIn: REFRESH_TTL_SECONDS,
    jwtid: randomBytes(12).toString("hex"),
  });
}

/**
 * Verify a refresh token and return the user email, or null if it is invalid,
 * expired, tampered, or not a refresh token.
 */
export function verifyRefreshToken(token: string | undefined | null): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, signingSecret()) as jwt.JwtPayload;
    if (payload.typ !== "refresh" || !payload.sub) return null;
    return String(payload.sub).toLowerCase();
  } catch {
    return null;
  }
}
