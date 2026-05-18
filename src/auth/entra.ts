## Fichier 2 — `src/auth/entra.ts`

Va sur :
`https://github.com/benoitkochversusmind/boondmanager-mcp-vsm/new/main/src/auth`

Dans **"Name your file..."** : `entra.ts`

Colle :

```typescript
/**
 * entra.ts
 * Valide le Bearer token Microsoft (Entra ID) et retourne l'email de l'utilisateur.
 */
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

const TENANT_ID = process.env.AZURE_TENANT_ID!;
const CLIENT_ID = process.env.AZURE_CLIENT_ID!;

const jwks = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  rateLimit: true,
});

export async function validateEntraToken(bearerToken: string): Promise<string> {
  if (!bearerToken) throw new Error("Authorization header manquant");

  const decoded = jwt.decode(bearerToken, { complete: true });
  if (!decoded?.header?.kid) throw new Error("Token invalide (pas de kid)");

  const signingKey = await jwks.getSigningKey(decoded.header.kid);
  const verified = jwt.verify(bearerToken, signingKey.getPublicKey(), {
    audience: CLIENT_ID,
    issuer: [
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
      `https://sts.windows.net/${TENANT_ID}/`,
    ],
    algorithms: ["RS256"],
  }) as jwt.JwtPayload;

  const email =
    verified.preferred_username ?? verified.upn ?? verified.email ?? null;
  if (!email)
    throw new Error(
      "Impossible d'identifier l'utilisateur depuis le token Microsoft"
    );

  return (email as string).toLowerCase();
}
```

**"Commit directly to main"** → **"Commit new file"**

Dis-moi quand c'est fait.
