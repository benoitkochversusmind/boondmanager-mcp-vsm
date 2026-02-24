import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../constants.js";

// Common search schema
export const SearchSchema = z.object({
  keywords: z.string().optional().describe("Mots-clés de recherche (nom, email, compétences...)"),
  page: z.number().int().min(1).default(1).describe("Numéro de page (défaut: 1)"),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE)
    .describe(`Nombre de résultats par page (max: ${MAX_PAGE_SIZE}, défaut: ${DEFAULT_PAGE_SIZE})`),
}).strict();

// ID param schema
export const IdSchema = z.object({
  id: z.string().min(1).describe("Identifiant unique de l'entité BoondManager"),
}).strict();

// ID + tab param schema
export const IdTabSchema = z.object({
  id: z.string().min(1).describe("Identifiant unique de l'entité"),
  tab: z.string().optional().describe("Onglet spécifique à récupérer (information, technical, financial, actions, contracts, documents)"),
}).strict();

// ---- Candidate schemas ----

export const CandidateCreateSchema = z.object({
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
}).strict();

export const CandidateUpdateSchema = z.object({
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
}).strict();

// ---- Resource schemas ----

export const ResourceCreateSchema = z.object({
  firstName: z.string().min(1).describe("Prénom de la ressource/collaborateur"),
  lastName: z.string().min(1).describe("Nom de famille"),
  email1: z.string().email().optional().describe("Email principal"),
  phone1: z.string().optional().describe("Téléphone"),
  city: z.string().optional().describe("Ville"),
  country: z.string().optional().describe("Pays"),
  title: z.string().optional().describe("Titre / poste"),
  state: z.number().int().optional().describe("État de la ressource"),
  note: z.string().optional().describe("Notes"),
}).strict();

export const ResourceUpdateSchema = z.object({
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
}).strict();

// ---- Contact schemas ----

export const ContactCreateSchema = z.object({
  firstName: z.string().min(1).describe("Prénom du contact"),
  lastName: z.string().min(1).describe("Nom de famille"),
  email1: z.string().email().optional().describe("Email principal"),
  phone1: z.string().optional().describe("Téléphone"),
  city: z.string().optional().describe("Ville"),
  country: z.string().optional().describe("Pays"),
  title: z.string().optional().describe("Titre / fonction"),
  companyId: z.string().optional().describe("ID de la société associée"),
  note: z.string().optional().describe("Notes"),
}).strict();

export const ContactUpdateSchema = z.object({
  id: z.string().min(1).describe("ID du contact à modifier"),
  firstName: z.string().optional().describe("Prénom"),
  lastName: z.string().optional().describe("Nom"),
  email1: z.string().email().optional().describe("Email"),
  phone1: z.string().optional().describe("Téléphone"),
  city: z.string().optional().describe("Ville"),
  title: z.string().optional().describe("Titre / fonction"),
  note: z.string().optional().describe("Notes"),
}).strict();

// ---- Company schemas ----

export const CompanyCreateSchema = z.object({
  name: z.string().min(1).describe("Nom de la société"),
  email1: z.string().email().optional().describe("Email de la société"),
  phone1: z.string().optional().describe("Téléphone"),
  city: z.string().optional().describe("Ville"),
  country: z.string().optional().describe("Pays"),
  website: z.string().optional().describe("Site web"),
  siret: z.string().optional().describe("Numéro SIRET"),
  state: z.number().int().optional().describe("État de la société"),
  note: z.string().optional().describe("Notes"),
}).strict();

export const CompanyUpdateSchema = z.object({
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
}).strict();

// ---- Opportunity schemas ----

export const OpportunityCreateSchema = z.object({
  name: z.string().min(1).describe("Nom / titre de l'opportunité"),
  companyId: z.string().optional().describe("ID de la société cliente"),
  contactId: z.string().optional().describe("ID du contact associé"),
  state: z.number().int().optional().describe("État de l'opportunité"),
  startDate: z.string().optional().describe("Date de début prévue (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Date de fin prévue (YYYY-MM-DD)"),
  note: z.string().optional().describe("Notes / description"),
}).strict();

export const OpportunityUpdateSchema = z.object({
  id: z.string().min(1).describe("ID de l'opportunité à modifier"),
  name: z.string().optional().describe("Nom / titre"),
  state: z.number().int().optional().describe("État"),
  startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD)"),
  note: z.string().optional().describe("Notes"),
}).strict();

// ---- Action schemas ----

export const ActionSearchSchema = z.object({
  keywords: z.string().optional().describe("Mots-clés de recherche"),
  candidateId: z.string().optional().describe("Filtrer par ID candidat"),
  resourceId: z.string().optional().describe("Filtrer par ID ressource"),
  contactId: z.string().optional().describe("Filtrer par ID contact"),
  companyId: z.string().optional().describe("Filtrer par ID société"),
  page: z.number().int().min(1).default(1).describe("Numéro de page"),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe("Résultats par page"),
}).strict();

export const ActionCreateSchema = z.object({
  typeOf: z.string().min(1).describe("Type d'action (ex: call, email, meeting, note)"),
  subject: z.string().optional().describe("Sujet de l'action"),
  content: z.string().optional().describe("Contenu / description"),
  startDate: z.string().optional().describe("Date de début (YYYY-MM-DD ou ISO)"),
  endDate: z.string().optional().describe("Date de fin"),
  candidateId: z.string().optional().describe("ID du candidat associé"),
  resourceId: z.string().optional().describe("ID de la ressource associée"),
  contactId: z.string().optional().describe("ID du contact associé"),
  companyId: z.string().optional().describe("ID de la société associée"),
}).strict();

export type SearchInput = z.infer<typeof SearchSchema>;
export type IdInput = z.infer<typeof IdSchema>;
export type IdTabInput = z.infer<typeof IdTabSchema>;
