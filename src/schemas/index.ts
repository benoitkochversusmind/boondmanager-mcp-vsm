import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SEARCH_PAGE } from "../constants.js";

// Common search schema
export const SearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche (nom, email, compétences...)"),
    page: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_PAGE)
      .default(1)
      .describe(`Numéro de page (défaut: 1, max: ${MAX_SEARCH_PAGE})`),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE)
      .describe(`Nombre de résultats par page (max: ${MAX_PAGE_SIZE}, défaut: ${DEFAULT_PAGE_SIZE})`),
  })
  .strict();

// ---- Reusable filter field helpers ----
// IMPORTANT: input field names below MUST match the BoondManager API query parameter names
// exactly (e.g., perimeterManagers, resourceStates, opportunityStates). buildSearchQuery
// passes them through as `key[]=value` for arrays. See https://doc.boondmanager.com/api-externe/
const pageField = z
  .number()
  .int()
  .min(1)
  .max(MAX_SEARCH_PAGE)
  .default(1)
  .describe(`Numéro de page (défaut: 1, max: ${MAX_SEARCH_PAGE})`);
const pageSizeField = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE)
  .describe(`Nombre de résultats par page (max: ${MAX_PAGE_SIZE}, défaut: ${DEFAULT_PAGE_SIZE})`);
const sortField = z.string().optional().describe("Champ de tri (ex: lastName, firstName, updateDate)");
const orderField = z.enum(["asc", "desc"]).optional().describe("Ordre de tri (asc/desc)");
const intArray = (doc: string) => z.array(z.number().int()).optional().describe(doc);
const strArray = (doc: string) => z.array(z.string()).optional().describe(doc);

// Shared "perimeter" filters available on every entity search (from RAML trait `searchable`).
// These are the CORRECT filters for "my team / my agency / my N-1" — NOT the old `mainManagers`.
const perimeterManagersField = intArray(
  "IDs des managers (ressources). Conserve les entités dont le responsable est l'un de ces managers. " +
    "Pour 'mon équipe / N-1 d'une personne X', passer [X_id]. Obtenir son propre ID via boond_application_current_user."
);
const perimeterAgenciesField = intArray(
  "IDs d'agences. Conserve les entités dont le responsable appartient à ces agences."
);
const perimeterPolesField = intArray("IDs de pôles. Conserve les entités dont le responsable appartient à ces pôles.");
const perimeterBusinessUnitsField = intArray(
  "IDs de business units. Conserve les entités dont le responsable appartient à ces BU."
);
const perimeterDynamicField = z
  .array(z.enum(["data", "agencies", "poles", "businessUnits", "managers"]))
  .optional()
  .describe(
    "Périmètre dynamique relatif à l'utilisateur courant (raccourci sans avoir à connaître son propre ID). " +
      "Valeurs : 'data' (mes propres données), 'managers' (mon équipe / mes N-1), 'agencies' (mes agences), " +
      "'poles' (mes pôles), 'businessUnits' (mes BU). Combinable."
  );
const narrowPerimeterField = z
  .boolean()
  .optional()
  .describe("Si true, jointure ET entre les filtres `perimeter*` (au lieu de OU par défaut).");
const startDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Date de début (YYYY-MM-DD), à utiliser avec `period`.");
const endDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe("Date de fin (YYYY-MM-DD), à utiliser avec `period`.");

// ---- Resource search schema (collaborateurs internes) ----
// Source: https://doc.boondmanager.com/api-externe/raml-build/resources/resources/search.raml
export const ResourceSearchSchema = z
  .object({
    keywords: z
      .string()
      .optional()
      .describe(
        "Mots-clés (par défaut, recherche dans CV + dossier technique). Pour cibler un champ précis, " +
          "fournir aussi `keywordsType` (ex: lastName, firstName, fullName, emails, title, titleSkills, phones, reference)."
      ),
    keywordsType: z
      .enum([
        "resumeTd",
        "lastName",
        "firstName",
        "fullName",
        "strictFullName",
        "emails",
        "title",
        "titleSkills",
        "phones",
        "reference",
        "resume",
        "td",
      ])
      .optional()
      .describe(
        "Champ ciblé par `keywords`. Défaut: 'resumeTd' (CV + dossier technique). " +
          "Pour 'fullName' utiliser `keywords = 'NOM#PRENOM'`."
      ),
    perimeterManagers: perimeterManagersField,
    perimeterAgencies: perimeterAgenciesField,
    perimeterPoles: perimeterPolesField,
    perimeterBusinessUnits: perimeterBusinessUnitsField,
    perimeterDynamic: perimeterDynamicField,
    narrowPerimeter: narrowPerimeterField,
    resourceStates: intArray(
      "IDs d'états de ressource (dictionnaire setting.state.resource via boond_application_dictionary)."
    ),
    excludeResourceStates: intArray("IDs d'états de ressource à EXCLURE."),
    resourceTypes: intArray("IDs de types de ressource (dictionnaire setting.typeOf.resource)."),
    excludeResourceTypes: intArray("IDs de types de ressource à EXCLURE."),
    activityAreas: strArray("IDs de secteurs d'activité (dictionnaire setting.activityArea)."),
    expertiseAreas: strArray("IDs de domaines d'expertise (dictionnaire setting.expertiseArea)."),
    tools: strArray(
      "IDs d'outils/technos (dictionnaire setting.tool). Logique OU par défaut. " +
        "Pour ET, ajouter '#AND#' en 1er élément: tools=['#AND#','12','34']."
    ),
    experiences: intArray("IDs de niveaux d'expérience (dictionnaire setting.experience)."),
    trainings: strArray("IDs de formations (dictionnaire setting.training)."),
    mobilityAreas: strArray("IDs de zones de mobilité (dictionnaire setting.mobilityArea)."),
    languages: strArray(
      "Langues parlées au format `langueId|niveauId` (dictionnaires setting.languageSpoken et setting.languageLevel). Ex: ['anglais|courant']."
    ),
    flags: intArray("IDs de tags (drapeaux) attachés à la ressource."),
    period: z
      .string()
      .optional()
      .describe(
        "Champ temporel pour filtrer par période. Valeurs courantes: 'available' (disponibilité), " +
          "'working' (en mission hors interne), 'workingAll', 'absent', 'idle', 'hired', 'left', " +
          "'employed', 'unemployed', 'updated', 'arrival', 'birthday', 'seniority', 'present', " +
          "'noAction'/'withActions'/'withoutActions'/'withAbsences'/'withoutAbsences'. " +
          "À combiner avec `startDate` + `endDate`."
      ),
    startDate: startDateField,
    endDate: endDateField,
    providerCompanies: intArray("IDs de sociétés sous-traitantes (filtre pour ressources externes)."),
    coordinates: z
      .string()
      .optional()
      .describe("Coordonnées GPS 'latitude,longitude' pour recherche géographique. À combiner avec `geoDistance`."),
    location: z
      .string()
      .optional()
      .describe("Adresse texte (ville, etc.) pour recherche géographique. À combiner avec `geoDistance`."),
    geoDistance: z
      .number()
      .int()
      .min(5)
      .max(200)
      .optional()
      .describe(
        "Rayon en km pour la recherche géographique (5-200). Requis si `coordinates` ou `location` est fourni."
      ),
    excludeManager: z.boolean().optional().describe("Si true, ne retourne que les ressources sans compte manager."),
    shields: z
      .array(z.enum(["uncomplete", "minimum", "complete"]))
      .optional()
      .describe("Niveau de complétude des champs conditionnels."),
    sort: sortField,
    order: orderField,
    page: pageField,
    pageSize: pageSizeField,
  })
  .strict();

// ---- Candidate search schema ----
// Source: https://doc.boondmanager.com/api-externe/raml-build/resources/candidates/search.raml
export const CandidateSearchSchema = z
  .object({
    keywords: z
      .string()
      .optional()
      .describe("Mots-clés (par défaut, recherche dans CV + dossier technique). Combinable avec `keywordsType`."),
    keywordsType: z
      .enum([
        "resumeTd",
        "lastName",
        "firstName",
        "fullName",
        "strictFullName",
        "emails",
        "title",
        "titleSkills",
        "phones",
        "reference",
        "resume",
        "td",
      ])
      .optional()
      .describe("Champ ciblé par `keywords` (défaut: 'resumeTd')."),
    perimeterManagers: perimeterManagersField,
    perimeterAgencies: perimeterAgenciesField,
    perimeterPoles: perimeterPolesField,
    perimeterBusinessUnits: perimeterBusinessUnitsField,
    perimeterDynamic: perimeterDynamicField,
    perimeterManagersType: z
      .enum(["main", "hr"])
      .optional()
      .describe("Type de responsable visé par `perimeterManagers`: 'main' (Main Manager) ou 'hr' (HR Manager)."),
    narrowPerimeter: narrowPerimeterField,
    candidateStates: intArray(
      "IDs d'états de candidat (dictionnaire setting.state.candidate via boond_application_dictionary)."
    ),
    stateLabel: z
      .string()
      .optional()
      .describe(
        "Libellé d'état candidat (ex: 'Vivier chaud', 'Sourcé', 'Embauché'). " +
          "Résolu vers son ID via le dictionnaire `setting.state.candidate` mis en cache. " +
          "Ignoré si `candidateStates` est fourni (priorité à l'ID explicite)."
      ),
    candidateTypes: intArray("IDs de types de candidat (dictionnaire setting.typeOf.resource)."),
    contractTypes: intArray("IDs de types de contrat recherchés (dictionnaire setting.typeOf.contract)."),
    availabilityTypes: intArray("IDs de types de disponibilité (dictionnaire setting.availability)."),
    activityAreas: strArray("IDs de secteurs d'activité (dictionnaire setting.activityArea)."),
    expertiseAreas: strArray("IDs de domaines d'expertise."),
    tools: strArray("IDs d'outils/technos. Logique OU par défaut. Pour ET, ajouter '#AND#' en 1er élément."),
    experiences: intArray("IDs de niveaux d'expérience."),
    trainings: strArray("IDs de formations."),
    mobilityAreas: strArray("IDs de zones de mobilité."),
    languages: strArray("Langues au format `langueId|niveauId` (ex: ['anglais|courant'])."),
    evaluations: strArray("IDs d'évaluations."),
    sources: strArray("IDs de sources de recrutement (dictionnaire setting.source)."),
    flags: intArray("IDs de tags."),
    period: z
      .string()
      .optional()
      .describe(
        "Filtre temporel : 'created', 'updated', 'available', " +
          "'noAction'/'withActions'/'withoutActions'. À combiner avec `startDate` + `endDate`."
      ),
    startDate: startDateField,
    endDate: endDateField,
    providerCompanies: intArray("IDs de sociétés sous-traitantes."),
    coordinates: z.string().optional().describe("Coordonnées GPS 'lat,lon'. Requiert `geoDistance`."),
    location: z.string().optional().describe("Adresse texte. Requiert `geoDistance`."),
    geoDistance: z.number().int().min(5).max(200).optional().describe("Rayon km (5-200)."),
    shields: z
      .array(z.enum(["uncomplete", "minimum", "complete"]))
      .optional()
      .describe("Niveau de complétude."),
    sort: sortField,
    order: orderField,
    page: pageField,
    pageSize: pageSizeField,
    fetchAll: z
      .boolean()
      .optional()
      .describe(
        "Si true, paginate automatiquement jusqu'à `maxResults` (cap 1000) au lieu de retourner la page courante. " +
          "Force `pageSize: 500` et ignore `page`. Pratique pour rapatrier l'intégralité d'un vivier filtré."
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Plafond strict côté agent quand `fetchAll: true` (défaut: 500, max: 1000)."),
  })
  .strict();

// ---- Contact search schema ----
// Source: https://doc.boondmanager.com/api-externe/raml-build/resources/contacts/search.raml
export const ContactSearchSchema = z
  .object({
    keywords: z
      .string()
      .optional()
      .describe(
        "Mots-clés (défaut: nom + prénom + société + fonction + périmètre technique). " +
          "Combinable avec `keywordsType`."
      ),
    keywordsType: z
      .enum([
        "default",
        "lastName",
        "firstName",
        "fullName",
        "strictFullName",
        "companyFullName",
        "emails",
        "phones",
        "socialNetworks",
      ])
      .optional()
      .describe(
        "Champ ciblé. Défaut: 'default'. Pour 'fullName' utiliser `keywords = 'NOM#PRENOM'`. " +
          "Pour 'companyFullName' utiliser `keywords = 'CSOCid#NOM#PRENOM'`."
      ),
    perimeterManagers: perimeterManagersField,
    perimeterAgencies: perimeterAgenciesField,
    perimeterPoles: perimeterPolesField,
    perimeterBusinessUnits: perimeterBusinessUnitsField,
    perimeterDynamic: perimeterDynamicField,
    narrowPerimeter: narrowPerimeterField,
    states: intArray("IDs d'états de contact (dictionnaire setting.state.contact)."),
    companyStates: intArray("IDs d'états des sociétés rattachées (dictionnaire setting.state.company)."),
    typesOf: intArray(
      "IDs de types de contact (dictionnaire setting.typeOf.contact). " +
        "⚠️ Le paramètre s'appelle `typesOf` (avec un 's'), PAS `typeOf`."
    ),
    origins: strArray("IDs d'origines (dictionnaire setting.origin)."),
    activityAreas: strArray("IDs de secteurs d'activité de la société."),
    expertiseAreas: strArray("IDs de domaines d'expertise de la société."),
    tools: strArray("IDs d'outils. Logique OU par défaut, '#AND#' en 1er pour ET."),
    influencers: intArray("IDs de contacts influenceurs."),
    flags: intArray("IDs de tags."),
    period: z
      .string()
      .optional()
      .describe(
        "Filtre temporel : 'created', 'updated', 'noAction'/'withActions'/'withoutActions'. " +
          "À combiner avec `startDate` + `endDate`."
      ),
    startDate: startDateField,
    endDate: endDateField,
    completeness: strArray(
      "Filtre par complétude des champs au format `fieldId:mode` (fieldId: email/phone/socialNetworks ; " +
        "mode: empty/filled). Logique OU par défaut, '#AND#' en 1er pour ET. Ex: ['email:empty','phone:empty']."
    ),
    shields: z
      .array(z.enum(["uncomplete", "minimum", "complete"]))
      .optional()
      .describe("Niveau de complétude."),
    sort: sortField,
    order: orderField,
    page: pageField,
    pageSize: pageSizeField,
  })
  .strict();

// ---- Company search schema ----
// Source: https://doc.boondmanager.com/api-externe/raml-build/resources/companies/search.raml
export const CompanySearchSchema = z
  .object({
    keywords: z
      .string()
      .optional()
      .describe("Mots-clés (défaut: nom + ville + pays + expertise + informations). Combinable avec `keywordsType`."),
    keywordsType: z
      .enum(["default", "name", "phones", "emails", "socialNetworks"])
      .optional()
      .describe("Champ ciblé par `keywords`. Défaut: 'default'."),
    perimeterManagers: perimeterManagersField,
    perimeterAgencies: perimeterAgenciesField,
    perimeterPoles: perimeterPolesField,
    perimeterBusinessUnits: perimeterBusinessUnitsField,
    perimeterDynamic: perimeterDynamicField,
    narrowPerimeter: narrowPerimeterField,
    states: intArray("IDs d'états de société (dictionnaire setting.state.company)."),
    expertiseAreas: strArray("IDs de domaines d'expertise (dictionnaire setting.expertiseArea)."),
    origins: strArray("IDs d'origines (dictionnaire setting.origin)."),
    influencers: intArray("IDs d'influenceurs."),
    flags: intArray("IDs de tags."),
    period: z
      .string()
      .optional()
      .describe(
        "Filtre temporel : 'created', 'updated', 'noAction'/'withActions'/'withoutActions'. " +
          "À combiner avec `startDate` + `endDate`."
      ),
    startDate: startDateField,
    endDate: endDateField,
    shields: z
      .array(z.enum(["uncomplete", "minimum", "complete"]))
      .optional()
      .describe("Niveau de complétude."),
    sort: sortField,
    order: orderField,
    page: pageField,
    pageSize: pageSizeField,
  })
  .strict();

// ---- Opportunity search schema ----
// Source: https://doc.boondmanager.com/api-externe/raml-build/resources/opportunities/search.raml
export const OpportunitySearchSchema = z
  .object({
    keywords: z
      .string()
      .optional()
      .describe(
        "Mots-clés. Pour cibler par ID préfixé : 'AOnnn' (opportunité), 'CSOCnnn' (société), " +
          "'CCONnnn' (contact), 'CANDnnn' (candidat), 'COMPnnn' (ressource), 'PRODnnn' (produit). " +
          "Sinon recherche plein texte sur titre/société."
      ),
    perimeterManagers: perimeterManagersField,
    perimeterAgencies: perimeterAgenciesField,
    perimeterPoles: perimeterPolesField,
    perimeterBusinessUnits: perimeterBusinessUnitsField,
    perimeterDynamic: perimeterDynamicField,
    perimeterManagersType: z
      .enum(["main", "hr"])
      .optional()
      .describe("Type de responsable visé par `perimeterManagers` (main/hr)."),
    narrowPerimeter: narrowPerimeterField,
    opportunityStates: intArray("IDs d'états d'opportunité (dictionnaire setting.state.opportunity)."),
    opportunityTypes: strArray("IDs de types d'opportunité (dictionnaire setting.typeOf.project)."),
    positioningStates: strArray("IDs d'états de positionnement, ou 'none' pour les opportunités sans positionnement."),
    expertiseAreas: strArray("IDs de domaines d'expertise."),
    activityAreas: strArray("IDs de secteurs d'activité."),
    tools: strArray("IDs d'outils."),
    places: strArray("IDs de zones (dictionnaire setting.mobilityArea)."),
    durations: intArray("IDs de durées (dictionnaire setting.duration)."),
    origins: strArray("IDs d'origines."),
    flags: intArray("IDs de tags."),
    period: z
      .string()
      .optional()
      .describe(
        "Filtre temporel : 'created' (création), 'started', 'closingDate' (date de closing), " +
          "'updated', 'updatedPositioning', 'noAction'/'withActions'/'withoutActions'. " +
          "À combiner avec `startDate` + `endDate`."
      ),
    startDate: startDateField,
    endDate: endDateField,
    shields: z
      .array(z.enum(["uncomplete", "minimum", "complete"]))
      .optional()
      .describe("Niveau de complétude."),
    sort: sortField,
    order: orderField,
    page: pageField,
    pageSize: pageSizeField,
  })
  .strict();

// ---- Project search schema ----
// Source: https://doc.boondmanager.com/api-externe/raml-build/resources/projects/search.raml
export const ProjectSearchSchema = z
  .object({
    keywords: z
      .string()
      .optional()
      .describe(
        "Mots-clés. Pour cibler par ID préfixé : 'PRJnnn' (projet), 'CSOCnnn' (société), " +
          "'CCONnnn' (contact), 'AOnnn' (opportunité), 'COMPnnn' (ressource), 'CTRnnn' (contrat)."
      ),
    perimeterManagers: perimeterManagersField,
    perimeterAgencies: perimeterAgenciesField,
    perimeterPoles: perimeterPolesField,
    perimeterBusinessUnits: perimeterBusinessUnitsField,
    perimeterDynamic: perimeterDynamicField,
    narrowPerimeter: narrowPerimeterField,
    projectStates: intArray("IDs d'états de projet (dictionnaire setting.state.project)."),
    projectTypes: intArray("IDs de types de projet (dictionnaire setting.typeOf.project)."),
    companies: intArray("IDs de sociétés clientes : projets rattachés à ces sociétés."),
    expertiseAreas: strArray("IDs de domaines d'expertise."),
    activityAreas: strArray("IDs de secteurs d'activité."),
    flags: intArray("IDs de tags."),
    period: z
      .string()
      .optional()
      .describe(
        "Filtre temporel : 'running' (en cours), 'created', 'started', 'stopped', 'closed', 'updated', " +
          "'hasAdditionalDataOrPurchase'. À combiner avec `startDate` + `endDate`."
      ),
    startDate: startDateField,
    endDate: endDateField,
    sort: sortField,
    order: orderField,
    page: pageField,
    pageSize: pageSizeField,
  })
  .strict();

// ID param schema
export const IdSchema = z
  .object({
    id: z.string().min(1).describe("Identifiant unique de l'entité BoondManager"),
  })
  .strict();

// ID + tab param schema
export const IdTabSchema = z
  .object({
    id: z.string().min(1).describe("Identifiant unique de l'entité"),
    tab: z
      .string()
      .optional()
      .describe("Onglet spécifique à récupérer (information, technical, financial, actions, contracts, documents)"),
  })
  .strict();

// ---- Candidate schemas ----

export const CandidateCreateSchema = z
  .object({
    firstName: z.string().min(1).describe("Prénom du candidat"),
    lastName: z.string().min(1).describe("Nom de famille du candidat"),
    email1: z.string().email().optional().describe("Email principal"),
    phone1: z.string().optional().describe("Téléphone principal"),
    city: z.string().optional().describe("Ville"),
    country: z.string().optional().describe("Pays"),
    title: z.string().optional().describe("Titre du poste / fonction"),
    state: z.number().int().optional().describe("État du candidat (0=en cours, 1=placé, 2=archivé...)"),
    mainSkills: z.string().optional().describe("Compétences principales (texte libre)"),
    note: z.string().optional().describe("Notes / commentaires"),
  })
  .strict();

export const CandidateUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID du candidat à modifier"),
    firstName: z.string().optional().describe("Prénom"),
    lastName: z.string().optional().describe("Nom"),
    email1: z.string().email().optional().describe("Email principal"),
    phone1: z.string().optional().describe("Téléphone"),
    city: z.string().optional().describe("Ville"),
    country: z.string().optional().describe("Pays"),
    title: z.string().optional().describe("Titre / fonction"),
    state: z.number().int().optional().describe("État du candidat"),
    mainSkills: z.string().optional().describe("Compétences principales"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

// ---- Resource schemas ----

export const ResourceCreateSchema = z
  .object({
    firstName: z.string().min(1).describe("Prénom de la ressource/collaborateur"),
    lastName: z.string().min(1).describe("Nom de famille"),
    email1: z.string().email().optional().describe("Email principal"),
    phone1: z.string().optional().describe("Téléphone"),
    city: z.string().optional().describe("Ville"),
    country: z.string().optional().describe("Pays"),
    title: z.string().optional().describe("Titre / poste"),
    state: z.number().int().optional().describe("État de la ressource"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

export const ResourceUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID de la ressource à modifier"),
    firstName: z.string().optional().describe("Prénom"),
    lastName: z.string().optional().describe("Nom"),
    email1: z.string().email().optional().describe("Email principal"),
    phone1: z.string().optional().describe("Téléphone"),
    city: z.string().optional().describe("Ville"),
    country: z.string().optional().describe("Pays"),
    title: z.string().optional().describe("Titre / poste"),
    state: z.number().int().optional().describe("État"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

// ---- Contact schemas ----

export const ContactCreateSchema = z
  .object({
    firstName: z.string().min(1).describe("Prénom du contact"),
    lastName: z.string().min(1).describe("Nom de famille"),
    email1: z.string().email().optional().describe("Email principal"),
    phone1: z.string().optional().describe("Téléphone"),
    city: z.string().optional().describe("Ville"),
    country: z.string().optional().describe("Pays"),
    title: z.string().optional().describe("Titre / fonction"),
    companyId: z.string().optional().describe("ID de la société associée"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

export const ContactUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID du contact à modifier"),
    firstName: z.string().optional().describe("Prénom"),
    lastName: z.string().optional().describe("Nom"),
    email1: z.string().email().optional().describe("Email"),
    phone1: z.string().optional().describe("Téléphone"),
    city: z.string().optional().describe("Ville"),
    title: z.string().optional().describe("Titre / fonction"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

// ---- Company schemas ----

export const CompanyCreateSchema = z
  .object({
    name: z.string().min(1).describe("Nom de la société"),
    email1: z.string().email().optional().describe("Email de la société"),
    phone1: z.string().optional().describe("Téléphone"),
    city: z.string().optional().describe("Ville"),
    country: z.string().optional().describe("Pays"),
    website: z.string().optional().describe("Site web"),
    siret: z.string().optional().describe("Numéro SIRET"),
    state: z.number().int().optional().describe("État de la société"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

export const CompanyUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID de la société à modifier"),
    name: z.string().optional().describe("Nom"),
    email1: z.string().email().optional().describe("Email"),
    phone1: z.string().optional().describe("Téléphone"),
    city: z.string().optional().describe("Ville"),
    country: z.string().optional().describe("Pays"),
    website: z.string().optional().describe("Site web"),
    siret: z.string().optional().describe("Numéro SIRET"),
    state: z.number().int().optional().describe("État"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

// ---- Opportunity schemas ----

export const OpportunityCreateSchema = z
  .object({
    name: z.string().min(1).describe("Nom / titre de l'opportunité"),
    companyId: z.string().optional().describe("ID de la société cliente"),
    contactId: z.string().optional().describe("ID du contact associé"),
    state: z.number().int().optional().describe("État de l'opportunité"),
    startDate: z.string().optional().describe("Date de début prévue (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin prévue (YYYY-MM-DD)"),
    note: z.string().optional().describe("Notes / description"),
  })
  .strict();

export const OpportunityUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID de l'opportunité à modifier"),
    name: z.string().optional().describe("Nom / titre"),
    state: z.number().int().optional().describe("État"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

// ---- Action schemas ----

export const ActionSearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche"),
    candidateId: z.string().optional().describe("Filtrer par ID candidat"),
    resourceId: z.string().optional().describe("Filtrer par ID ressource"),
    contactId: z.string().optional().describe("Filtrer par ID contact"),
    companyId: z.string().optional().describe("Filtrer par ID société"),
    managerId: z
      .string()
      .optional()
      .describe(
        "Filtrer par auteur de l'action (ID de la ressource qui a créé l'action). Mappé sur `perimeterManagers[]` côté API BoondManager — le trait searchable définit `perimeterManagers` comme « results whose responsible belongs to these manager IDs », ce qui cible le `mainManager` (= créateur) sur l'endpoint /actions."
      ),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "Borne inférieure de période (YYYY-MM-DD). Mappé sur `startDate` côté API. Combiner avec `period` pour choisir le champ filtré."
      ),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "Borne supérieure de période (YYYY-MM-DD). Mappé sur `endDate` côté API. Combiner avec `period` pour choisir le champ filtré."
      ),
    period: z
      .enum(["started", "created", "updated"])
      .default("started")
      .describe(
        "Champ date filtré par `dateFrom` / `dateTo`. 'started' = date de l'action, 'created' = création, 'updated' = dernière modification. Défaut: 'started'."
      ),
    typeOf: z
      .array(z.number().int())
      .optional()
      .describe(
        "Filtrer par IDs de types d'action (mappé sur `actionTypes[]` côté API). " +
          "Exemples observés sur cette org : 12=Entretien visio, 19=Entretien présentiel, 13=Note, 41=Appel, 42=Email. " +
          "Pour la liste complète, lire `boond_application_dictionary` avec `dictionaryType = setting.action` (les types sont scopés par entité linkable : contact, candidate, resource, opportunity, project, order, invoice — mais les IDs sont globaux)."
      ),
    actionType: z
      .string()
      .optional()
      .describe(
        "Raccourci textuel — mot-clé résolu vers `typeOf` via un mapping interne. " +
          "Catégories : note, appel, email, entretien (présentiel + visio + technique), entretien 1/2, visio, présentiel, technique, qualification, pré-qualification, relance, reprise, rappel, proposition, embauche, signature, présentation, test, résultats, référence, infocom, prospection, rendez-vous (alias rdv), soutenance, revue, recrutement. " +
          "Si `typeOf` est aussi fourni, `typeOf` gagne. Un libellé inconnu est silencieusement ignoré."
      ),
    periodDynamic: z
      .enum([
        "today",
        "yesterday",
        "thisWeek",
        "lastWeek",
        "thisMonth",
        "lastMonth",
        "thisQuarter",
        "lastQuarter",
        "thisYear",
        "lastYear",
      ])
      .optional()
      .describe(
        "Période dynamique relative au jour courant. Combinable avec `period` (qui choisit le champ filtré : started / created / updated). Plus pratique que `dateFrom`+`dateTo` pour les requêtes récurrentes."
      ),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

export const ActionCreateSchema = z
  .object({
    // BoondManager stores typeOf as an **integer** (e.g. 3 = "Rappel / To do",
    // 17 = "1 bis - (Re)prise de contact", 61 = "1 - Prospection Appel"...).
    // We accept either a number or a numeric string and cast to number before
    // hitting the API. Use `boond_application_dictionary` with
    // `setting.action.{contact|candidate|resource|...}` to list the IDs.
    typeOf: z
      .union([z.number().int(), z.string().regex(/^\d+$/)])
      .describe(
        "ID numérique du type d'action (ex: 3=Rappel / To do, 17=Reprise de contact, 41=Appel, 42=Email, 61=Prospection Appel). " +
          "Lister les IDs via `boond_application_dictionary` avec `setting.action.<entity>` (contact, candidate, resource, opportunity, project, order, invoice)."
      ),
    title: z.string().optional().describe("Titre de l'action (attribut `title` BoondManager)."),
    text: z.string().optional().describe("Contenu / description HTML de l'action (attribut `text` BoondManager)."),
    // Back-compat aliases — the previous schema accepted these names, but the
    // BoondManager attributes are actually `title` and `text`. We forward
    // subject→title and content→text in the handler so existing callers still
    // work, while documenting the canonical names.
    subject: z.string().optional().describe("Alias rétro-compatible de `title`."),
    content: z.string().optional().describe("Alias rétro-compatible de `text`."),
    startDate: z
      .string()
      .optional()
      .describe(
        "Date / horaire de début. Accepté : `YYYY-MM-DD` (normalisé à minuit Europe/Paris) ou ISO 8601 complet."
      ),
    endDate: z.string().optional().describe("Date / horaire de fin (même formats que `startDate`)."),
    // ---- Linked-entity relationships ----
    // BoondManager exige UNE relation `dependsOn` polymorphe. On la construit
    // depuis le premier de ces IDs renseigné (priorité : contact > candidate >
    // company > opportunity > project > resource). Sans aucun, l'API renvoie
    // 422 Missing required attribute dependsOn — on lève une erreur claire
    // côté serveur avant l'appel.
    candidateId: z.string().optional().describe("ID du candidat lié (dépose l'action sur ce candidat)."),
    resourceId: z.string().optional().describe("ID de la ressource liée (collaborateur interne)."),
    contactId: z.string().optional().describe("ID du contact lié (action commerciale sur un contact)."),
    companyId: z.string().optional().describe("ID de la société liée."),
    opportunityId: z.string().optional().describe("ID de l'opportunité liée."),
    projectId: z.string().optional().describe("ID du projet lié."),
    mainManagerId: z
      .string()
      .optional()
      .describe(
        "ID de la ressource responsable de l'action. Défaut : la ressource correspondant à l'utilisateur courant " +
          "(résolue via `/application/current-user.thumbnail` → `resource_<id>_*`). Lever une erreur explicite si non résolvable."
      ),
  })
  .strict();

// ---- Resource missions history (composite) ----

export const ResourceMissionsHistorySchema = z
  .object({
    resourceId: z
      .string()
      .min(1)
      .describe(
        'Identifiant de la ressource (consultant) : ID numérique (ex: `"20"`) ou nom (ex: `"Damien BLAISE"`, `"BLAISE"`). ' +
          "Si nom : le serveur résout automatiquement via `/resources?keywords=…` ; erreur claire si 0 ou plusieurs correspondances (avec la liste des candidats pour désambiguïser)."
      ),
    withProjectDates: z
      .boolean()
      .optional()
      .describe(
        "Si true (défaut), fetch chaque projet individuellement pour récupérer `startDate`. " +
          "Coût : 1 GET /projects/{id} par mission. Mettre `false` pour gagner du temps quand seul le nom client compte."
      ),
    groupByCompany: z
      .boolean()
      .optional()
      .describe(
        "Si true (défaut), regroupe la sortie par société cliente, triée par nombre de missions décroissant " +
          "puis par mission la plus récente. Si false, sortie en liste plate triée par `startDate` décroissante."
      ),
    maxEnrichments: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Plafond du nombre de GET parallèles (sociétés + projets) pour borner la latence. Défaut : 100. " +
          "Au-delà, les missions excédentaires sont listées avec leur ID seulement (drill manuel via `boond_projects_get`)."
      ),
  })
  .strict();

export type ResourceMissionsHistoryInput = z.infer<typeof ResourceMissionsHistorySchema>;

// ---- Timesheet schemas ----

export const ResourceTimesheetSchema = z
  .object({
    resourceId: z.string().min(1).describe("ID de la ressource"),
    month: z.number().int().min(1).max(12).optional().describe("Mois (1-12). Si omis, mois courant."),
    year: z.number().int().min(2000).optional().describe("Année (ex: 2025). Si omis, année courante."),
  })
  .strict();

// `/times-reports` requires `startMonth` and `endMonth` in YYYY-MM form. Passing
// YYYY-MM-DD or omitting them surfaces a 422 "Missing required attribute" from
// the API, so the schema enforces both at the boundary.
export const TimesheetSearchSchema = z
  .object({
    startMonth: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .describe("Mois de début au format YYYY-MM (ex: '2025-01'). Requis."),
    endMonth: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .describe("Mois de fin au format YYYY-MM (ex: '2025-03'). Requis."),
    keywords: z.string().optional().describe("Mots-clés (préfixes 'TPS', 'COMP'...)."),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE)
      .describe(`Nombre de résultats par page (max: ${MAX_PAGE_SIZE}, défaut: ${DEFAULT_PAGE_SIZE})`),
  })
  .strict();

export const TimesheetGetSchema = z
  .object({
    id: z.string().min(1).describe("Identifiant unique de la feuille de temps"),
  })
  .strict();

// ---- Project schemas ----

export const ProjectCreateSchema = z
  .object({
    name: z.string().min(1).describe("Nom du projet / mission"),
    companyId: z.string().optional().describe("ID de la société cliente"),
    contactId: z.string().optional().describe("ID du contact associé"),
    opportunityId: z.string().optional().describe("ID de l'opportunité liée"),
    state: z.number().int().optional().describe("État du projet (0=en cours, 1=terminé, 2=archivé...)"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    note: z.string().optional().describe("Notes / description du projet"),
  })
  .strict();

export const ProjectUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID du projet à modifier"),
    name: z.string().optional().describe("Nom du projet"),
    state: z.number().int().optional().describe("État du projet"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

// ---- Invoice schemas ----

export const InvoiceCreateSchema = z
  .object({
    reference: z.string().optional().describe("Référence de la facture"),
    companyId: z.string().optional().describe("ID de la société facturée"),
    projectId: z.string().optional().describe("ID du projet associé"),
    state: z.number().int().optional().describe("État de la facture"),
    invoiceDate: z.string().optional().describe("Date de facturation (YYYY-MM-DD)"),
    dueDate: z.string().optional().describe("Date d'échéance (YYYY-MM-DD)"),
    amountExcludingTax: z.number().optional().describe("Montant HT"),
    taxRate: z.number().optional().describe("Taux de TVA (%)"),
    note: z.string().optional().describe("Notes / commentaires"),
  })
  .strict();

export const InvoiceUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID de la facture à modifier"),
    reference: z.string().optional().describe("Référence de la facture"),
    state: z.number().int().optional().describe("État de la facture"),
    invoiceDate: z.string().optional().describe("Date de facturation (YYYY-MM-DD)"),
    dueDate: z.string().optional().describe("Date d'échéance (YYYY-MM-DD)"),
    amountExcludingTax: z.number().optional().describe("Montant HT"),
    taxRate: z.number().optional().describe("Taux de TVA (%)"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

export const InvoiceSearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche (référence, société...)"),
    companyId: z.string().optional().describe("Filtrer par ID société"),
    projectId: z.string().optional().describe("Filtrer par ID projet"),
    states: intArray("IDs d'états de facture (dictionnaire setting.state.invoice via boond_application_dictionary)."),
    perimeterManagers: perimeterManagersField,
    perimeterManagersType: z
      .enum(["main", "hr"])
      .optional()
      .describe("Type de responsable visé par `perimeterManagers` ('main' = Main Manager, 'hr' = HR Manager)."),
    perimeterAgencies: perimeterAgenciesField,
    perimeterPoles: perimeterPolesField,
    perimeterBusinessUnits: perimeterBusinessUnitsField,
    perimeterDynamic: perimeterDynamicField,
    narrowPerimeter: narrowPerimeterField,
    startDate: z.string().optional().describe("Date de début de période (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin de période (YYYY-MM-DD)"),
    period: z
      .string()
      .optional()
      .describe("Type de période (created, updated, expectedPayment, performedPayment, period)"),
    sort: sortField,
    order: orderField,
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

// ---- Invoice overdue (composite tool) ----

export const InvoiceOverdueSchema = z
  .object({
    asOfDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "Date de référence (YYYY-MM-DD) au-delà de laquelle une `dueDate` est considérée en retard. Défaut: aujourd'hui."
      ),
    companyId: z.string().optional().describe("Restreindre à une société particulière (ID)."),
    perimeterManagers: perimeterManagersField,
    perimeterManagersType: z
      .enum(["main", "hr"])
      .optional()
      .describe("Type de responsable visé par `perimeterManagers` ('main'/'hr')."),
    perimeterAgencies: perimeterAgenciesField,
    perimeterPoles: perimeterPolesField,
    perimeterBusinessUnits: perimeterBusinessUnitsField,
    perimeterDynamic: perimeterDynamicField,
    narrowPerimeter: narrowPerimeterField,
    amountMinExcludingTax: z
      .number()
      .nonnegative()
      .optional()
      .describe("Montant HT minimum (€) — exclut les factures dont le HT est strictement inférieur."),
    amountMaxExcludingTax: z
      .number()
      .nonnegative()
      .optional()
      .describe("Montant HT maximum (€) — exclut les factures dont le HT est strictement supérieur."),
    groupByCompany: z
      .boolean()
      .optional()
      .describe(
        "Si true, regroupe la sortie par société avec total impayé. Défaut: false (liste plate triée par jours de retard décroissants)."
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(MAX_PAGE_SIZE)
      .describe(`Taille de page interne pour l'appel /invoices (max: ${MAX_PAGE_SIZE}, défaut: ${MAX_PAGE_SIZE}).`),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_PAGE)
      .default(5)
      .describe("Nombre maximum de pages à scanner côté API. Défaut: 5 (= 2500 factures avec pageSize=500)."),
  })
  .strict();

export type InvoiceOverdueInput = z.infer<typeof InvoiceOverdueSchema>;

// ---- Order schemas (Bons de commande) ----

export const OrderCreateSchema = z
  .object({
    reference: z.string().optional().describe("Référence du bon de commande"),
    companyId: z.string().optional().describe("ID de la société"),
    projectId: z.string().optional().describe("ID du projet associé"),
    state: z.number().int().optional().describe("État du bon de commande"),
    orderDate: z.string().optional().describe("Date du bon de commande (YYYY-MM-DD)"),
    amountExcludingTax: z.number().optional().describe("Montant HT"),
    note: z.string().optional().describe("Notes / commentaires"),
  })
  .strict();

export const OrderUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID du bon de commande à modifier"),
    reference: z.string().optional().describe("Référence"),
    state: z.number().int().optional().describe("État"),
    orderDate: z.string().optional().describe("Date (YYYY-MM-DD)"),
    amountExcludingTax: z.number().optional().describe("Montant HT"),
    note: z.string().optional().describe("Notes"),
  })
  .strict();

export const OrderSearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche"),
    companyId: z.string().optional().describe("Filtrer par ID société"),
    projectId: z.string().optional().describe("Filtrer par ID projet"),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

// ---- Delivery schemas (Livraisons / CRA) ----

export const DeliverySearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche"),
    projectId: z.string().optional().describe("Filtrer par ID projet"),
    companyId: z.string().optional().describe("Filtrer par ID société"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

// ---- Absence schemas ----

export const AbsenceCreateSchema = z
  .object({
    resourceId: z.string().min(1).describe("ID de la ressource en absence"),
    typeOf: z.string().min(1).describe("Type d'absence (congé payé, RTT, maladie, sans solde...)"),
    startDate: z.string().min(1).describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().min(1).describe("Date de fin (YYYY-MM-DD)"),
    state: z.number().int().optional().describe("État de la demande (0=en attente, 1=validé, 2=refusé...)"),
    note: z.string().optional().describe("Commentaire / motif"),
  })
  .strict();

export const AbsenceUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID de l'absence à modifier"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    state: z.number().int().optional().describe("État de la demande"),
    note: z.string().optional().describe("Commentaire / motif"),
  })
  .strict();

export const AbsenceSearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche"),
    resourceId: z.string().optional().describe("Filtrer par ID ressource"),
    startDate: z.string().optional().describe("Date de début de période (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin de période (YYYY-MM-DD)"),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

// ---- Expense schemas (Notes de frais) ----

export const ExpenseCreateSchema = z
  .object({
    resourceId: z.string().min(1).describe("ID de la ressource"),
    projectId: z.string().optional().describe("ID du projet associé"),
    typeOf: z.string().optional().describe("Type de frais (transport, repas, hébergement...)"),
    expenseDate: z.string().min(1).describe("Date du frais (YYYY-MM-DD)"),
    amount: z.number().describe("Montant du frais"),
    currency: z.string().optional().describe("Devise (EUR, USD...)"),
    state: z.number().int().optional().describe("État de la note de frais"),
    note: z.string().optional().describe("Description / justification"),
  })
  .strict();

export const ExpenseUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID de la note de frais à modifier"),
    amount: z.number().optional().describe("Montant"),
    state: z.number().int().optional().describe("État"),
    note: z.string().optional().describe("Description"),
  })
  .strict();

export const ExpenseSearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche"),
    resourceId: z.string().optional().describe("Filtrer par ID ressource"),
    projectId: z.string().optional().describe("Filtrer par ID projet"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

// ---- Product schemas ----

export const ProductCreateSchema = z
  .object({
    name: z.string().min(1).describe("Nom du produit"),
    reference: z.string().optional().describe("Référence du produit"),
    unitPrice: z.number().optional().describe("Prix unitaire HT"),
    taxRate: z.number().optional().describe("Taux de TVA (%)"),
    state: z.number().int().optional().describe("État du produit"),
    note: z.string().optional().describe("Description du produit"),
  })
  .strict();

export const ProductUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID du produit à modifier"),
    name: z.string().optional().describe("Nom du produit"),
    reference: z.string().optional().describe("Référence"),
    unitPrice: z.number().optional().describe("Prix unitaire HT"),
    taxRate: z.number().optional().describe("Taux de TVA (%)"),
    state: z.number().int().optional().describe("État"),
    note: z.string().optional().describe("Description"),
  })
  .strict();

// ---- Positioning schemas ----

export const PositioningCreateSchema = z
  .object({
    candidateId: z.string().optional().describe("ID du candidat positionné"),
    resourceId: z.string().optional().describe("ID de la ressource positionnée"),
    projectId: z.string().optional().describe("ID du projet"),
    opportunityId: z.string().optional().describe("ID de l'opportunité"),
    state: z.number().int().optional().describe("État du positionnement"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    note: z.string().optional().describe("Notes / commentaires"),
  })
  .strict();

export const PositioningSearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche"),
    candidateId: z.string().optional().describe("Filtrer par ID candidat"),
    resourceId: z.string().optional().describe("Filtrer par ID ressource"),
    projectId: z.string().optional().describe("Filtrer par ID projet"),
    opportunityId: z.string().optional().describe("Filtrer par ID opportunité"),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

// ---- Payment schemas ----

export const PaymentSearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche"),
    invoiceId: z.string().optional().describe("Filtrer par ID facture"),
    companyId: z.string().optional().describe("Filtrer par ID société"),
    startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
    endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

// ---- Advantage schemas ----

export const AdvantageSearchSchema = z
  .object({
    keywords: z.string().optional().describe("Mots-clés de recherche"),
    resourceId: z.string().optional().describe("Filtrer par ID ressource"),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
  })
  .strict();

// ---- Application schemas ----

// ---- Validation schemas ----
// `/validations` requires `startMonth` + `endMonth` (YYYY-MM). Optional filters
// from the official RAML follow.
export const ValidationSearchSchema = z
  .object({
    startMonth: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .describe("Mois de début YYYY-MM. Requis."),
    endMonth: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .describe("Mois de fin YYYY-MM. Requis."),
    keywords: z
      .string()
      .optional()
      .describe("Mots-clés. Préfixes acceptés : 'TPS' (CRA), 'EXP' (frais), 'ABS' (absence), 'COMP' (ressource)."),
    documentTypes: z
      .array(z.enum(["absencesReport", "timesReport", "expensesReport"]))
      .optional()
      .describe("Types de documents à valider."),
    resourceTypes: z
      .array(z.number().int())
      .optional()
      .describe("IDs de types de ressource (dictionnaire setting.typeOf.resource)."),
    validationStates: z
      .array(z.enum(["waitingForValidation", "validated", "rejected"]))
      .optional()
      .describe("États de validation."),
    validationAlerts: z.boolean().optional().describe("Filtrer sur les validations avec alertes."),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE)
      .describe(`Nombre de résultats par page (max: ${MAX_PAGE_SIZE}, défaut: ${DEFAULT_PAGE_SIZE})`),
  })
  .strict();

// ---- Notification schemas ----
// `/notifications` requires the singular `category` (activity/thread/corporate)
// per the official RAML. Optional `state` filters read/unread; `parentType`
// narrows by entity module.
export const NotificationSearchSchema = z
  .object({
    category: z
      .enum(["activity", "thread", "corporate"])
      .describe(
        "Catégorie (requis): 'activity' (notifications d'activité), 'thread' (messages), 'corporate' (annonces)."
      ),
    state: z.enum(["new", "read"]).optional().describe("Filtrer par état de lecture."),
    parentType: z
      .array(z.string())
      .optional()
      .describe("Types de modules parents (ex: 'contract', 'global', 'project'...)."),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE)
      .describe(`Nombre de résultats par page (max: ${MAX_PAGE_SIZE}, défaut: ${DEFAULT_PAGE_SIZE})`),
  })
  .strict();

// ---- Reporting schemas ----
// `/reporting-companies` and `/reporting-resources` require `startDate` +
// `endDate` (YYYY-MM-DD); the others tolerate omission but still benefit from
// a period filter.
export const ReportingDateRequiredSchema = z
  .object({
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Date de début YYYY-MM-DD. Requis."),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Date de fin YYYY-MM-DD. Requis."),
    keywords: z.string().optional().describe("Mots-clés."),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE)
      .describe(`Nombre de résultats par page (max: ${MAX_PAGE_SIZE}, défaut: ${DEFAULT_PAGE_SIZE})`),
  })
  .strict();

export const ReportingDateOptionalSchema = z
  .object({
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Date de début YYYY-MM-DD."),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Date de fin YYYY-MM-DD."),
    keywords: z.string().optional().describe("Mots-clés."),
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1).describe(`Numéro de page (max: ${MAX_SEARCH_PAGE})`),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE)
      .describe(`Nombre de résultats par page (max: ${MAX_PAGE_SIZE}, défaut: ${DEFAULT_PAGE_SIZE})`),
  })
  .strict();

export const DictionaryGetSchema = z
  .object({
    dictionaryType: z
      .string()
      .min(1)
      .describe(
        "Type de dictionnaire (ex: typeOf/actions, typeOf/absences, states/candidates, states/resources, states/opportunities, states/projects, states/invoices, countries, currencies, languages...)"
      ),
  })
  .strict();

export type SearchInput = z.infer<typeof SearchSchema>;
export type ResourceSearchInput = z.infer<typeof ResourceSearchSchema>;
export type CandidateSearchInput = z.infer<typeof CandidateSearchSchema>;
export type ContactSearchInput = z.infer<typeof ContactSearchSchema>;
export type CompanySearchInput = z.infer<typeof CompanySearchSchema>;
export type OpportunitySearchInput = z.infer<typeof OpportunitySearchSchema>;
export type ProjectSearchInput = z.infer<typeof ProjectSearchSchema>;
export type IdInput = z.infer<typeof IdSchema>;
export type IdTabInput = z.infer<typeof IdTabSchema>;
export type ResourceTimesheetInput = z.infer<typeof ResourceTimesheetSchema>;
export type TimesheetSearchInput = z.infer<typeof TimesheetSearchSchema>;
export type TimesheetGetInput = z.infer<typeof TimesheetGetSchema>;
export type DictionaryGetInput = z.infer<typeof DictionaryGetSchema>;
