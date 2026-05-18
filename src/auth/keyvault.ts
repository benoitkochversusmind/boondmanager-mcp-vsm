import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
import { buildJwt } from "../services/boond-client.js";

const kvClient = new SecretClient(
  process.env.AZURE_KEYVAULT_URL!,
  new DefaultAzureCredential()
);

interface CachedCreds {
  jwt: string;
  expiresAt: number;
}

const cache = new Map<string, CachedCreds>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function emailToSecretName(email: string): string {
  return "boond-user-" + email.toLowerCase().replace(/[@.]/g, "-");
}

export async function getBoondJwtForUser(userEmail: string): Promise<string> {
  const cached = cache.get(userEmail);
  if (cached && cached.expiresAt > Date.now()) return cached.jwt;

  const keyName = emailToSecretName(userEmail);

  const [userTokenSecret, clientTokenSecret, clientKeySecret] =
    await Promise.all([
      kvClient.getSecret(keyName).catch(() => {
        const msg =
          "No Boondmanager token found for " +
          userEmail +
          ". Register it with: az keyvault secret set" +
          " --vault-name vsm-boond-kv --name " +
          keyName +
          " --value USER_TOKEN";
        throw new Error(msg);
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
