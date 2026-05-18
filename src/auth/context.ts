/**
 * context.ts
 * Stocke le JWT Boondmanager courant dans un contexte isolé par requête.
 * Utilise AsyncLocalStorage pour éviter tout état partagé entre utilisateurs.
 */
import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  userEmail: string;
  boondJwt: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
