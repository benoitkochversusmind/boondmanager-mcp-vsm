import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

const TENANT_ID = process.env.AZURE_TENANT_ID!;
const CLIENT_ID = process.env.AZURE_CLIENT_ID!;

const jwksUri =
  "https://login.microsoftonline.com/" + TENANT_ID + "/discovery/v2.0/keys";

const jwks = jwksClient({
  jwksUri: jwksUri,
  cache: true,
  cacheMaxEntries: 5,
  rateLimit: true,
});

export async function validateEntraToken(bearerToken: string): Promise<string> {
  if (!bearerToken) throw new Error("Authorization header missing");

  const decoded = jwt.decode(bearerToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw new Error("Invalid token: no kid");
  }

  const signingKey = await jwks.getSigningKey(decoded.header.kid);
  const publicKey = signingKey.getPublicKey();

  const issuer1 =
    "https://login.microsoftonline.com/" + TENANT_ID + "/v2.0";
  const issuer2 =
    "https://sts.windows.net/" + TENANT_ID + "/";

  const verified = jwt.verify(bearerToken, publicKey, {
    audience: CLIENT_ID,
    issuer: [issuer1, issuer2],
    algorithms: ["RS256"],
  }) as jwt.JwtPayload;

  const email =
    verified.preferred_username ||
    verified.upn ||
    verified.email ||
    null;

  if (!email) {
    throw new Error("Cannot identify user from Microsoft token");
  }

  return (email as string).toLowerCase();
}
