## Fichier 3 — `src/auth/keyvault.ts`

Va sur :
`https://github.com/benoitkochversusmind/boondmanager-mcp-vsm/new/main/src/auth`

Dans **"Name your file..."** : `keyvault.ts`

Colle :

```typescript
/**
 * keyvault.ts
 * Récupère les tokens Boondmanager depuis Azure Key Vault
 * et construit le JWT HS256 attendu par l'API Boondmanager.
 *
 * Convention de nommage des secrets Key Vault :
 *   boond-user-{email}    → USER_TOKEN individuel
 *                           ex: boond-user-benoit-koch-versusmind-eu
 *   boond-client-token    → CLIENT_TOKEN partagé (organisation)
 *   boond-client-key      → CLIENT_KEY partagé (organisation)
 */
import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
import { buildJwt } from "../services/boond-client.js";

const kvClient = new SecretClient(
  process.env.AZURE_KEYVAULT_URL!,
  new DefaultAzureCredential()
);

// Cache mémoire 5 min — évite de saturer Key Vault pour 15 utilisateurs
interface CachedCreds {
  jwt: string;
  expiresAt: number;
}
const cache = new Map<string, CachedCreds>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getBoondJwtForUser(userEmail: string): Promise<string> {
  const cached = cache.get(userEmail);
  if (cached && cached.expiresAt > Date.now()) return cached.jwt;

  // Convention : remplace @ et . par des tirets
  const keyName =
    "boond-user-" + userEmail.toLowerCase().replace(/[@.]/g, "-");

  const [userTokenSecret, clientTokenSecret, clientKeySecret] =
    await Promise.all([
      kvClient.getSecret(keyName).catch(() => {
        throw new Error(
          `Aucun token Boondmanager trouvé pour ${userEmail}. ` +
            `Enregistrer via : az keyvault secret set ` +
            `--vault-name vsm-boond-kv --name ${keyName} --value <USER_TOKEN>`
        );
      }),
      kvClient.getSecret("boond-client-token"),
      kvClient.getSecret("boond-client-key"),
    ]);

  const boondJwt = buildJwt(
    userTokenSecret.value!,
    clientTokenSecret.value!,
    clientKeySecret.value!
  );

  cache.set(userEmail, {
    jwt: boondJwt,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return boondJwt;
}
```

**"Commit directly to main"** → **"Commit new file"**

Dis-moi quand c'est fait.
