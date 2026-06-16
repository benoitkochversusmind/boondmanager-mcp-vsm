# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.20.0] - 2026-06-16

### Corrigé

- **`boond_candidates_update` était inopérant** — il passait par le factory CRUD générique en `PATCH /candidates/{id}`, verbe **rejeté par l'API (405)**, comme pour l'administratif. L'outil est réimplémenté pour écrire la **fiche information** du candidat via **`PUT /candidates/{id}/information`** (repli automatique **POST** sur 404/405). Seuls les champs fournis sont envoyés.

### Modifié

- **Schéma `boond_candidates_update` aligné sur les vrais attributs de l'onglet information.** Ajout des champs jusqu'ici non couverts : **`postcode`**, **`town`** (ville), **`globalEvaluation`** (évaluation globale, note entière, -1 = non évaluée), ainsi que `address`, `email2`/`email3`, `phone2`/`phone3`, `informationComments`. Retrait des champs qui **n'étaient pas** des attributs candidat et étaient silencieusement ignorés (`city` → remplacé par `town`, `state`, `mainSkills`, `note` → `informationComments`). Pour la disponibilité/mobilité/salaires/contrat souhaité, voir `boond_candidates_administrative_update`.

## [1.19.0] - 2026-06-11

### Ajouté

- **`boond_resources_technical_data_update`** — écriture du Dossier Technique des **ressources** (collaborateurs), jusqu'ici possible uniquement pour les candidats. Mêmes champs et garde-fous que la version candidat (outils + niveaux, domaines, secteurs S1–S12, compétences, expérience, langues CEFR, merge/replace). Le serveur expose **180 outils**.

### Modifié

- **Cœur DT factorisé** : `updateCandidateTechnicalData` et `updateResourceTechnicalData` partagent une seule logique paramétrée par l'entité parente. Seule la résolution du `tdId` diffère (`/candidates/{id}/technical-data` vs `/resources/{id}/technical-data`) ; l'écriture cible le même endpoint partagé `PUT /technical-datas/{tdId}`. Le schéma DT (champs + descriptions) est mutualisé entre les deux outils.

## [1.18.2] - 2026-06-11

### Corrigé

- **`boond_candidates_administrative_update` : 405 persistant** — le test prod a montré que `PUT /candidates/{id}` (base) est **aussi** rejeté (405), pas seulement `PATCH`, et que l'écriture base partait en premier (avant d'atteindre `/administrative`). Désormais **toute** l'écriture (y compris disponibilité/mobilité) cible la **sous-ressource `/candidates/{id}/administrative`**, en **PUT** avec **repli automatique sur POST** si l'API renvoie 404/405 (le verbe exact dépend de l'instance).

### Ajouté (observabilité)

- **Log des requêtes d'écriture** : chaque appel non-GET vers BoondManager logge `méthode + chemin` (niveau info → visible dans Log Analytics), pour diagnostiquer sans ambiguïté les mismatches endpoint/verbe en prod.

## [1.18.1] - 2026-06-11

### Corrigé

- **`boond_candidates_administrative_update` renvoyait `405 Method Not Allowed`** — l'écriture passait par `PATCH /candidates/{id}`, verbe rejeté par l'API, et les champs administratifs ne vivent pas sur l'endpoint de base. Désormais routage par cible en **PUT** : les attributs administratifs (salaires, contrat souhaité, situation, nationalité…) → **`PUT /candidates/{id}/administrative`** (sous-ressource), la disponibilité et la mobilité → **`PUT /candidates/{id}`**. Création de contrat (`dependsOn`) confirmée OK en prod (v1.18.0), inchangée.

## [1.18.0] - 2026-06-11

Ouvre en **écriture** des informations candidat jusqu'ici non modifiables (disponibilité, mobilité, administratif/salaire/contrat souhaité) et fiabilise/enrichit les **contrats de travail**.

### Ajouté

- **`boond_candidates_administrative_update`** — met à jour, via PATCH `/candidates/{id}` (read-modify-write) :
  - **disponibilité** (`availability`) et **mobilité** (`mobilityAreas` — libellés/ids résolus contre `setting.mobilityArea`, dict hiérarchique régions › villes) ;
  - **administratif / prétentions** : `actualSalary`, `desiredSalary` (min/max), `actualAverageDailyCost`, `desiredAverageDailyCost` (min/max), **contrat souhaité** (`desiredContract` → `setting.typeOf.contract`), **situation** (`setting.situation`), nationalité, naissance, commentaires.
  - Résolution libellé→id insensible casse/accents ; **tout libellé non résolu = erreur bloquante** (aucune écriture partielle) ; une fourchette ne fournissant qu'une borne préserve l'autre. Le serveur expose **179 outils**.
- **`boond_contracts_update`** — modification d'un contrat de travail (PUT `/contracts/{id}`) : type, dates, classification, salaires, durée hebdo, période d'essai…

### Corrigé

- **`boond_contracts_create`** — la création liait la ressource via `relationships.resource` (ignoré par l'API → contrat orphelin). Désormais la relation polymorphe **`dependsOn` (type `resource`)** est utilisée (même correctif que les positionnements). Création enrichie (type via `setting.typeOf.contract`, classification, salaires mensuel/horaire, durée, période d'essai, commentaires).

### Tests

- Vitest : résolution mobilité/contrat/situation, fusion de fourchette salariale, garde-fous bloquants, `dependsOn` du contrat, résolution `typeOf`, update PUT. Suite à **655 tests**.

## [1.17.1] - 2026-06-10

### Corrigé

- **`boond_candidates_documents` / `boond_resources_documents` renvoyaient vide** alors que l'entité possède des CV. La relation **`resumes`** (les CV) est portée par la sous-ressource **`/information`**, pas par le `GET /{entity}/{id}` nu — la lecture base-seule ne la voyait pas (vérifié en prod : candidat 2123 et ressource 113 ont leurs `resumes` uniquement sur `/information`). Le listing utilise désormais **`fetchEntityWithInformation()`** (fetch fusionné base ∪ `/information`, identique à `boond_*_get`). Pour les actions, `/information` n'existe pas → repli non-fatal sur le base (qui porte bien `files`). `boond_documents_get` est inchangé (fonctionnait déjà).

## [1.17.0] - 2026-06-10

Ajoute la **lecture du contenu et le téléchargement des pièces jointes PDF** (candidats, ressources, actions).

### Ajouté

- **Lister les pièces jointes** : `boond_candidates_documents`, `boond_resources_documents`, `boond_actions_documents` — agrègent les relations `resumes` (CV → id `<n>_resume`) et `files` (pièces jointes → id `<n>_document`) de l'entité (les actions n'ont que `files`). Renvoient l'ID composite + la nature de chaque document. Le serveur expose désormais **177 outils**.
- **Lire le contenu** : `boond_documents_get(documentId)` — stratégie **hybride** : si le PDF a une couche texte, renvoie le texte extrait (via `unpdf`, pdf.js sans dépendance native) ; sinon (PDF scanné/image) renvoie le PDF en ressource embarquée pour lecture directe par le modèle (plafond 6 Mo ; au-delà → renvoi vers le téléchargement). Fichier non-PDF : métadonnée + lien de téléchargement.
- **Télécharger** : endpoint hors-bande `GET /documents/download?documentId=<id>` (auth Bearer, jusqu'à 15 Mo), symétrique de `POST /documents/upload` — le binaire ne transite pas par le LLM. Client `fetchDocument()` ajouté (`GET /documents/{id}` → flux binaire + nom via `Content-Disposition`).

### Tests

- Vitest : listing (agrégation resumes+files, action files-only, vide), lecture hybride (texte / PDF scanné en ressource / cap de taille / non-PDF / erreur), `parseContentDispositionFilename`, `fetchDocument` (happy path + 404). Suite à **646 tests**.

## [1.16.0] - 2026-06-10

Ajoute l'**écriture du Dossier Technique candidat** (`boond_candidates_technical_data_update`), validée en production, et fiabilise le déploiement.

### Ajouté

- **`boond_candidates_technical_data_update`** — met à jour le Dossier Technique d'un candidat (outils, domaines, secteurs, compétences, expérience, langues) en *read-modify-write* puis `PUT /technical-datas/{tdId}`. Le serveur expose désormais **173 outils**.
  - **Résolution libellé→id** insensible casse/accents contre les dictionnaires (`setting.tool` / `setting.activityArea` / `setting.expertiseArea` / `setting.experience` / `setting.languageSpoken` / `setting.languageLevel`). Tout libellé/niveau non résolu = **erreur bloquante, sans écriture partielle**.
  - **`tools`** : format `"<outil>"` ou `"<outil>|<niveau>"` (niveau entier 0–5, défaut 0 = non évalué), sérialisé `[{tool, level}]`. Le libellé doit matcher la *value* exacte du dictionnaire (« .Net: C# » ou id « csharp », pas « C# »).
  - **`activityAreas`** / **`expertiseAreas`** : tableaux d'ids à plat ; `expertiseAreas` **restreint au jeu codifié S1–S12**.
  - **`languages`** : format `"<langue>|<niveau CEFR>"` (A1–C2), sérialisé `[{language, level}]` en id canonique. En *merge*, le niveau d'une langue déjà présente est écrasé.
  - **`mode`** : `merge` (défaut, union dédupliquée par outil/langue) ou `replace` (remplace les seuls champs fournis).

### Corrigé

- **Forme du payload `tools`** — l'API attend `[{tool:<id>, level:<int>}]` (stockage `tool|level`) ; un id à plat était rejeté par un `1017 Missing required attribute` sur `/tools/0/tool`.
- **Hint d'erreur trompeur** (`formatApiError`, `src/services/boond-client.ts`) — sur une erreur de champ structurée (ex. `1017` avec pointeur de paramètre), le hint générique « typically wrong credentials / password mismatch » n'est plus ajouté (il orientait le diagnostic à tort). Conservé pour les 422 opaques (vrai cas d'auth) et les 429/5xx transitoires.

### CI/CD

- **`docker-build.yml`** — le job `deploy-to-aca` peut désormais être déclenché manuellement (`workflow_dispatch`, toujours borné à `main`), pour re-piloter un déploiement après un build *flaky* (ex. GHCR « unknown blob » à l'export de couche) sans commit vide.

### Tests

- Couverture Vitest étendue (formes par champ, niveaux outil/langue, merge/replace, garde-fous bloquants, suppression du hint trompeur) ; suite à **631 tests**.

## [1.15.0] - 2026-06-10

Corrige la **création** de positionnements (cassée) et ajoute la **modification**.

### Corrigé

- **`boond_positionings_create` — relation `dependsOn` manquante** (`src/tools/positionings.ts`). Le handler envoyait `relationships.candidate` / `relationships.resource`, que l'API `/positionings` ignore → rejet systématique **« 1017 - Missing required attribute (dependsOn) »**. Le consultant est en réalité porté par la relation polymorphe **`dependsOn`** (type `candidate`|`resource`), comme pour les actions. Désormais : `candidateId → dependsOn{type:candidate}`, `resourceId → dependsOn{type:resource}`, et la cible via `opportunity`/`project`. Contrat vérifié en prod (création réelle puis suppression) : `dependsOn` **+** (`opportunity` OU `project`) sont les deux relations requises. Garde-fous serveur : erreur claire si aucun consultant ou aucune cible (avant l'appel API). `note` mappé sur l'attribut réel `informationComments`.

### Ajouté

- **`boond_positionings_update`** — modification d'un positionnement existant via `PUT /positionings/{id}` (état, période, commentaires ; seuls les champs fournis changent ; `note` → `informationComments`). Contrat vérifié en prod (PUT attributs → 200). Schéma `PositioningUpdateSchema`. Le serveur expose désormais **172 outils**.

### Tests

- **+5 tests** (`positionings.test.ts`) : create `candidateId → dependsOn(candidate)` + opportunity + `note → informationComments` ; create `resourceId → dependsOn(resource)` + project ; rejet sans consultant ; rejet sans cible ; update `PUT` + `note → informationComments`. Compte d'outils 4 → 5. **599 tests passants** (vs 594 en 1.14.1).

## [1.14.1] - 2026-06-09

Les filtres par entité de `boond_positionings_search` (`candidateId` / `resourceId` / `projectId` / `opportunityId`) fonctionnent enfin : l'API `/positionings` ignore ces noms en query littérale, le serveur les route désormais via les **préfixes keyword BoondManager** (comme `boond_actions_search`).

### Corrigé

- **`boond_positionings_search` — routage des filtres entité** (`src/tools/positionings.ts`). `candidateId → CAND<id>`, `resourceId → COMP<id>`, `projectId → PRJ<id>`, `opportunityId → AO<id>`, injectés dans `keywords` (un `keywords` utilisateur est préservé et concaténé). Vérifié en prod : `keywords=CAND34592` → 7 positionnements tous sur le candidat 34592 ; `keywords=COMP17537` → 43 positionnements tous sur la ressource 17537. Avant : les noms `candidateId=` étaient silencieusement ignorés → résultats non filtrés.

### Tests

- **+2 tests** (`positionings.test.ts`) : routage candidateId/projectId → préfixes (et absence des params bruts dans la query) ; resourceId→COMP + opportunityId→AO + préservation du `keywords` utilisateur. **594 tests passants** (vs 592 en 1.14.0).

## [1.14.0] - 2026-06-09

`boond_positionings_search` affiche désormais le **nom du consultant** sur chaque ligne, et peut **masquer le bruit des candidatures sur annonce**.

### Ajouté

- **Nom du consultant sur chaque positionnement** (`formatPositioningsList`, `src/tools/positionings.ts`). Le consultant est porté par la relation polymorphe `dependsOn` (`type ∈ {candidate, resource}` — candidat externe vs collaborateur interne) — et **non** par `createdBy` (qui est l'auteur). Nouveau segment `· Consultant: Prénom NOM (candidat|ressource)` inséré juste après le segment opportunité/projet ; `· Consultant: (non renseigné)` si `dependsOn` est absent. Ajout purement additif — aucun segment existant supprimé ni réordonné (compatibilité avec le skill daily-synthesis préservée).
- **Paramètre `excludeApplications`** (boolean, défaut `false`) sur `boond_positionings_search` : quand `true`, masque les positionnements dont le **libellé d'état résolu** vaut « 00 - Candidature annonce » (matching sur le libellé, pas sur le préfixe). L'en-tête indique le nombre masqué. Filtre côté serveur MCP (exclu de la query Boondmanager).

### Choix d'implémentation (preuve empirique)

Résolution du consultant **sans aucun appel N+1** : la réponse LISTE de `/positionings` porte **nativement** un bloc `included[]` (présent même sans paramètre `include` — vérifié en prod : `include` ne change pas son contenu) contenant les `candidate`/`resource` liés avec `firstName`/`lastName`. On construit donc un index `(type:id) → "Prénom NOM"` depuis `included[]` (option a du brief). Coût réseau : 1 appel par page, quelle que soit la taille (jusqu'à 500). Cas de test confirmés : #14549 → `dependsOn=candidate 34592` = David TA (candidat) ; #14914 → `dependsOn=resource 17537` = Alexis LIAUD (ressource).

### Tests

- **+3 tests** `formatPositioningsList` (`positionings.test.ts`) : consultant candidat résolu depuis `included` ; consultant ressource avec fallback ID + libellé `(ressource)` ; `(non renseigné)` si `dependsOn` absent ; filtre `excludeApplications` (masque « 00 - Candidature annonce », conserve le reste, compte les masqués). **592 tests passants** (vs 590 en 1.13.2).

## [1.13.2] - 2026-06-09

Cosmétique : dans `formatPositioningsList`, les deux entités liées sont fusionnées en un seul segment `candidat/ressource → projet/opportunité`, de sorte que la flèche `→` n'apparaît qu'entre deux entités. Évite le séparateur orphelin `· →` quand un positionnement n'a pas de candidat/ressource résolu (cas « candidature annonce » lié à une opportunité seule). Aucun changement de comportement par ailleurs. 590 tests.

## [1.13.1] - 2026-06-09

Les positionnements remontent désormais leur **date de création** et leur **date de mise à jour** (ainsi que l'état en clair, la période et les entités liées) dans les recherches et les onglets — ces champs étaient présents dans le payload BoondManager mais masqués par le formateur de liste générique.

### Corrigé / Enrichi

- **`boond_positionings_search`** : rendu via un nouveau formateur dédié `formatPositioningsList` (au lieu de `formatEntitySummary` qui n'exposait que nom/état/titre). Chaque ligne affiche : entité(s) liée(s) (candidat/ressource → projet/opportunité, résolues via `include`), **état résolu en libellé** (dictionnaire `setting.state.positioning`), période `startDate → endDate`, et surtout **`créé <creationDate>` · `MàJ <updateDate>`**. La requête envoie désormais `include=candidate,resource,project,opportunity`.
- **`boond_positionings_get`** : préfixe une ligne de synthèse (avec les dates) au-dessus du JSON:API complet, et envoie aussi `include=…` pour nommer les entités liées.
- **Onglets `boond_{candidates,resources,opportunities}_positionings`** : `buildTabHandler` route désormais `tabName === "positionings"` vers `formatPositioningsList` (comme `actions` → `formatActionsList`). Les positionnements vus depuis une fiche candidat/ressource/opportunité affichent donc aussi les dates.

### Vérifié en prod (API v9.1.58.1)

Le payload `/positionings` expose bien `creationDate` et `updateDate` (format ISO `2026-06-09T18:53:13+0200`) en liste comme en détail — confirmé sur un positionnement réel. Le manque était purement côté formatage MCP.

### Tests

- **+3 tests** `formatPositioningsList` (`positionings.test.ts`) : dates + état (libellé) + période + entités liées surfacés ; fallback propre (état numérique + IDs) quand le dictionnaire est indisponible et `included` absent ; message vide. **590 tests passants** (vs 587 en 1.13.0).

## [1.13.0] - 2026-06-08

Upload de pièces jointes **multi-Mo** sans faire transiter les octets par le flux de tokens du LLM. Complète `boond_documents_create` (1.12.0), dont le mode base64 était plafonné par la limite de tokens de sortie (~750 Ko, troncature silencieuse au-delà).

### Contexte (vérifié en prod)

- **BoondManager plafonne les pièces jointes à 15 Mo** (sondé : 10 Mo OK, 20 Mo → 422 « exceeds 15 Mo »). L'objectif réel est donc « ≤ 15 Mo de façon fiable », pas « centaines de Mo » — 15 Mo tient sans peine en mémoire serveur.
- Le serveur tourne en **multi-replica** (max 10, `affinity=none`) : un staging local + `uploadId` (2 requêtes) pourrait taper 2 replicas différents. Choix retenu : **endpoint one-shot** (1 requête, pas de staging, robuste en multi-replica, aucune dépendance Azure nouvelle).

### Ajouté

- **Endpoint HTTP hors-bande `POST /documents/upload`** (`src/index.ts`) — même auth Bearer que `/mcp` (session OAuth ou token statique par utilisateur). Reçoit les **octets bruts** (`--data-binary`), `parentType`/`parentId`/`fileName` en query string, et forwarde directement vers `POST /documents` de Boond sous l'identité de l'utilisateur (JWT via AsyncLocalStorage). Les octets **ne passent jamais par le LLM**. Monté avant les parsers JSON globaux (corps brut via `express.raw`, plafond `MAX_DOCUMENT_BYTES` = 15 Mo, 413 propre au-delà). Usage type (Cowork) : `curl -X POST "$URL/documents/upload?parentType=action&parentId=12345&fileName=cr.pdf" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" --data-binary @cr.pdf`.
- **`fileUrl` documenté pour les liens pré-signés / SAS** (SharePoint, Blob) — comme c'est **Boond** qui télécharge l'URL (et non notre serveur), aucun binaire ne transite ni par le LLM ni par le MCP, et il n'y a **aucune surface SSRF** de notre côté. Voie idéale pour les gros fichiers déjà accessibles par lien.
- **`uploadDocument` (`src/services/boond-client.ts`)** accepte désormais une source `fileBuffer` (`Buffer`) en plus de `fileUrl`, partagée par l'endpoint (octets bruts) et par le mode base64 du tool (décodé en `Buffer`).

### Durci

- **Cap dur sur le mode base64 de `boond_documents_create`** : au-delà de `MAX_DOCUMENT_BASE64_CHARS` (~1 Mo de base64 ≈ 750 Ko de fichier), le tool **refuse proprement** avec un message renvoyant vers `fileUrl` ou l'endpoint d'upload — évite la troncature silencieuse de l'argument (fichier corrompu). Description du tool réécrite pour hiérarchiser les voies (fileUrl > endpoint > base64).

### Tests

- **+3 tests** `uploadDocument` (`boond-client.test.ts`) : POST multipart `/documents` avec part `file` (fileBuffer), `fileUrl` en champ de formulaire (SAS, pas de binaire), rejet sans source. **+1 test** `documents.test.ts` : rejet base64 au-delà du cap (sans appel API) + décodage base64 → `Buffer` avant forward. **587 tests passants** (vs 584 en 1.12.0).

### Notes & limites

- Le flux out-of-band suppose un client capable de POSTer un fichier (shell **Cowork** → `curl`) ; il n'est pas disponible dans Claude.ai chat pur (pas d'accès HTTP arbitraire). Pour ce cas, utiliser `fileUrl`.
- Endpoint **non couvert par les tests unitaires** (vit dans `index.ts`, point d'entrée à effets de bord) — validé en prod par un test contrôlé (5 Mo sur contact #514, créé puis supprimé).
- `fileContentBase64` (≤ ~750 Ko) conservé pour les petits fichiers.

## [1.12.0] - 2026-06-08

Nouvel outil **`boond_documents_create`** — upload d'une pièce jointe et rattachement à une entité BoondManager (action, candidat, contact, société, opportunité, projet, ressource…) en un seul appel. Répond au besoin « attacher un fichier à une action ».

### Ajouté

- **Tool `boond_documents_create`** (`src/tools/documents.ts`) — encapsule l'endpoint multipart `POST /documents`. Le document est lié à son entité parente dès la création via `parentType` + `parentId` (pas d'étape de liaison séparée ; la relation `files` du parent se peuple automatiquement). Deux sources de fichier mutuellement exclusives :
  - `fileUrl` : URL publiquement accessible — **BoondManager télécharge le fichier lui-même**, aucun binaire ne transite par le serveur MCP (recommandé).
  - `fileName` + `fileContentBase64` : contenu encodé en base64 (à réserver aux petits fichiers).
- **`uploadDocument()` dans `src/services/boond-client.ts`** — premier chemin **multipart/form-data** du client (jusqu'ici JSON-only). Réutilise l'auth per-user (JWT via AsyncLocalStorage) et le rate limiter partagé ; construit le corps via `FormData`/`Blob` natifs (Node 22) en laissant `fetch` dériver le boundary.
- **Schéma `DocumentCreateSchema`** (`src/schemas/index.ts`) : `parentType` (enum des entités courantes), `parentId`, `fileUrl` OU `fileName` + `fileContentBase64`. La validation XOR de la source du fichier est faite dans le handler (erreur claire `isError`).

### Vérification du contrat (API prod v9.1.58.1)

Contrat sondé en direct puis verrouillé par un test d'écriture contrôlé (création action de test sur le contact #514 → upload `file` + `fileUrl` → vérification de la relation `files` → suppression de tout, aucun résidu) :
- `POST /documents` est multipart-only (un POST JSON est rejeté). Champs requis : `file` **ou** `fileUrl`, plus `parentId` et `parentType`.
- `parentType` = nom d'entité en minuscule (`action` confirmé).
- Réponse : `{ data: { type: "document", id: "<n>_document", attributes: { name } } }` ; le parent expose alors `relationships.files = [{ id, type: "document" }]`.

### Tests

- **+7 tests** dans `src/tools/documents.test.ts` : enregistrement (1 tool, write/non-destructive), upload via `fileUrl`, upload via `fileName`+base64, rejet sans source, rejet double source, remontée d'erreur API en `isError`. **583 tests passants** (vs 576 en 1.11.2).
- **TOOLS.md** régénéré : **171 tools** (vs 170), 12 prompts, 21 resources. Liste `TOOL_REGISTRARS` du générateur mise à jour.

## [1.11.2] - 2026-06-05

Trois bugs corrigés sur `boond_absences_search`, signalés par l'intégration du datastore de prospection (cas d'usage : extraire les périodes d'absence sur une fenêtre glissante). Endpoint canonique, filtrage côté serveur MCP sur les périodes, et sortie enrichie nom/prénom/dates/type en un seul appel (plus de N+1).

### Corrigé

- **Bug 1 — filtre période ignoré** (`src/tools/absences.ts`). L'ancienne version appelait `/absences` avec `startDate`/`endDate` forwardés littéralement ; l'endpoint ignorait ces paramètres et renvoyait toute l'org (17 110 absences, validé en prod). Cette version applique le filtrage **côté serveur MCP** sur `attributes.absencesPeriods[].startDate/endDate` (overlap avec la fenêtre demandée) : une absence est retenue si AU MOINS une de ses périodes chevauche la fenêtre. Les bornes restent forwardées à l'API en best-effort (utile si BoondManager les exploite côté serveur sur certaines instances) mais la vérité reste le filtre client-side.

- **Bug 2 — sortie pauvre (juste l'ID et un titre optionnel)** (`src/tools/absences.ts`). La query envoie maintenant `include=resource` (JSON:API), ce qui hydrate `included[]` avec les ressources liées en un seul aller-retour. La sortie est ré-écrite : **une ligne par période** (chaque absences-report peut en contenir plusieurs), structurée `[absencesreport #id] LASTNAME Firstname | YYYY-MM-DD → YYYY-MM-DD (Xj) | Type · titre · état`. Plus de N+1 pour récupérer les noms.

- **Bug 3 — `boond_absences_get` 404 sur certains IDs récents** (#19336, #18913 signalés). Diagnostic : l'ancien `boond_absences_search` interrogeait `/absences` (collection legacy/hétérogène) alors que `get` utilise `/absences-reports/{id}` ; les deux endpoints renvoient des entités de types différents, certains IDs de `/absences` ne sont **pas** résolvables comme `/absences-reports/{id}`. Le fix réaligne search sur `/absences-reports` — désormais search et get parlent de la même entité (`type: "absencesreport"`), par construction tout ID listé est résolvable. La description de `boond_absences_get` documente que les anciens IDs externes peuvent provenir d'une autre entité.

### Ajouté

- **`fetchAll: boolean` + `maxScannedReports: 1-5000` (défaut 1000)** sur `AbsenceSearchSchema`. Auto-pagination forcée à `true` par défaut quand une fenêtre temporelle est fournie (sinon le filtre côté serveur MCP risque de jeter toute la première page et laisser le caller croire « aucun résultat »). Garde-fou anti-runaway via le cap.
- **`resourceId` route vers le préfixe `COMP<id>` dans `keywords`** (pattern identique à `boond_actions_search` v1.10.0, voir CHANGELOG v1.11.2 et la PR #1 mergée précédemment). L'API `/absences-reports` ignore le `resourceId=` littéral ; passer par le keyword prefix scope correctement.
- **`AbsenceSearchInput` exporté** + helpers `searchAbsencesEnriched`, `periodOverlapsWindow` exportés pour les tests et la réutilisation.

### Tests

- **+19 tests** dans `src/tools/absences.test.ts` (23 au total, vs 4 en 1.11.1) :
  - Suite `periodOverlapsWindow` (8 tests) : aucune borne, période avant/après/touchant les bornes, période nestée, période enveloppant la fenêtre, fenêtre demi-ouverte.
  - Suite `searchAbsencesEnriched` (11 tests) : appel sur `/absences-reports?include=resource`, filtrage par overlap (Bug 1), enrichissement nom/prénom via `included[]` (Bug 2), flatten multi-périodes par report, résultat vide sans faux positif, auto-pagination déclenchée par une fenêtre, cap `maxScannedReports` honoré, **pas** d'auto-pagination sans fenêtre (rétro-compat), `COMP<id>` injecté dans `keywords` (avec ou sans `keywords` caller-side), `startDate`/`endDate` forwardés à l'API en best-effort.
- **570 tests passants** (vs 551 en 1.11.1).

### Note sur la source — vérification de l'API

La doc RAML officielle (`https://doc.boondmanager.com/api-externe/raml-build/`) renvoie HTTP 403 sans authentification ; la vérification a été faite empiriquement par appels à l'API live (tenant `ca-boondmcp-vsm`, BoondManager v9.1.58.0, 2026-06-05) :
- `GET /absences-reports/11855` confirme `type: "absencesreport"`, `attributes.absencesPeriods[] = [{startDate, endDate, duration, title, workUnitType: {name, reference, activityType}}]`, `relationships.resource.data.id`.
- `GET /resources/{id}/absences-reports` retourne le même shape (test sur resource #20 → 122 rows, type `absencesreport`).
- `GET /absences?startDate=...&endDate=...` retourne le même nombre de rows que sans filtres (17 110) → filtre ignoré par l'API legacy.
- `GET /absences-reports/19336` → 404 (entité inexistante côté endpoint canonique → confirme que `/absences` listait des IDs externes au schéma).
- `GET /absences-reports` sans bornes → **422 `1017 - Missing required attribute (parameter: endMonth) | 1017 - Missing required attribute (parameter: startMonth)`** : l'API surface elle-même les noms canoniques (`startMonth`/`endMonth`, YYYY-MM). C'est cette source d'autorité (le message d'erreur API live, qui ne peut pas mentir) qui a piloté l'implémentation finale, plus fiable qu'une RAML inaccessible.

### Validation prod (révision `ca-boondmcp-vsm--0000054`, image `sha-8a83762`)

- **T1 critère 1** : `boond_absences_search({startDate: "2026-04-21", endDate: "2026-05-20"})` → **129 périodes** scopées (vs 17 110 baseline) sur 252 absences-reports scannés. Filtrage drastique et correct.
- **T2 critère 2** : chaque ligne porte nom + prénom + dates + type. Exemple : `[absencesreport #12251] DRIDI Nadhem | 2026-05-09 → 2026-05-15 (7j) | Maladie · validated`.
- **T4 cas limites** : fenêtre same-date (1 jour) retient les périodes à cheval (PRZYBYLSKI 2026-04-21 → 2026-04-30 capturé sur fenêtre 2026-04-26 → 2026-04-26).
- **T5 demi-journées + multi-jours + états non-validés** : tous présents dans le rendu (`BLUM Adeline · 0.5j · Après midi`, `RAMANAMBONINA · rejected`, `BLAISE · waitingForValidation`).
- **T3 + T6 non-régression** : `absences_get(6593)` toujours OK ; `planning_absences_search` toujours OK (610 résultats inchangés).

### Documenté / Corrigé (PR #1, mergée précédemment)

### Documenté / Corrigé

- **`boond_actions_search` — clarification du routing des filtres entité** : l'API BoondManager `/actions` ignore silencieusement les noms de paramètres littéraux `contactId=` / `candidateId=` / `companyId=` / `resourceId=` (vérifié en prod v9.1.58.0 : un raw `GET /actions?contactId=796` renvoie 153 090 actions, soit la totalité de l'org). **Notre tool MCP contourne déjà ce comportement depuis la v1.10.0** en injectant ces IDs dans `keywords` via les préfixes BoondManager `CCON<id>` / `CAND<id>` / `CSOC<id>` / `COMP<id>` (cf. `src/tools/actions.ts` lignes 607-612). Validé en prod : `boond_actions_search({contactId: "796"})` → 4 actions correctement scopées. La description du tool documente désormais explicitement cette transformation et signale les onglets scopés (`boond_contacts_actions`, `boond_candidates_actions`, `boond_companies_actions`, `boond_resources_actions`) comme alternative équivalente quand on veut juste « les actions d'une entité X ».
- **Sémantique `period` corrigée** : `started`→`startDate`, `created`→`creationDate`, `updated`→`updateDate`. L'ancienne note (« `created` cible `started` ») était inexacte sur cette version de l'API.
- **`/contacts/{id}/actions` n'expose pas `updateDate`** (seulement `startDate`/`creationDate`) — à connaître pour une capture incrémentale par date de modification (passer par `boond_actions_search` qui, lui, surface `updateDate`).

> Findings remontés par l'agent BoondProsp (projet P20260604) en intégrant le datastore de prospection, 2026-06-04. Vérifiés et reformulés côté MCP pour distinguer le comportement de l'API brute (cassé) de celui de notre tool MCP (correct grâce à la transformation v1.10.0).

## [1.11.1] - 2026-06-04

Le tool `boond_resources_missions_history` accepte désormais **un nom** (`"Damien BLAISE"`, `"BLAISE"`) en plus d'un ID numérique. Avant : seul un ID entier passait, sinon 404 sur `/resources/{name}/projects`. Après : le serveur résout le nom via `/resources?keywords=…` puis enchaîne avec la chaîne déjà en place v1.11.0.

### Ajouté

- **Helper exporté `resolveResourceIdentifier(input)`** (`src/tools/resources.ts`) :
  - Fast path : si l'input matche `/^\d+$/`, retour immédiat (zéro appel API).
  - Sinon : `GET /resources?keywords=<input>&keywordsType=lastName` (champ le plus discriminant).
  - Fallback si 0 résultat et input multi-token : retry avec `keywordsType=fullName`.
  - Coût : 1 appel API supplémentaire (2 dans le pire cas) — négligeable devant les N enrichissements companies/projets.
- **Gestion explicite des cas d'erreur** :
  - 0 match → `Error("Aucune ressource trouvée pour \"<input>\". Vérifiez l'orthographe ou utilisez \`boond_resources_search\` pour explorer.")`.
  - N matches → `Error("<N> ressources correspondent à \"<input>\". Précisez l'ID ou le nom complet :")` suivi des 10 premiers candidats (id + nom). Évite un round-trip de désambiguïsation côté agent.
  - Le handler du tool capture ces erreurs et les renvoie en `isError: true` avec un message lisible (plutôt qu'une stack trace).
- **`displayName` dans la sortie** : l'en-tête du rendu affiche désormais `📋 Historique des missions — Damien BLAISE (ressource #20)` au lieu de `ressource #20` seul (résolu via `attributes.firstName + lastName`, fallback `title`). Si l'input est un ID numérique, le nom n'est pas résolu (pas d'appel supplémentaire) et l'en-tête reste sur `ressource #<id>`.
- **Schéma `ResourceMissionsHistorySchema.resourceId`** mis à jour pour documenter les deux formats acceptés.

### Tests

- **+6 tests** dans `src/tools/resources.test.ts` :
  - Suite `resolveResourceIdentifier` (5 tests) : fast path numérique (zéro appel), 1 match via lastName, fallback fullName multi-token, 0 match → erreur claire, N matches → erreur avec liste.
  - Suite `fetchResourceMissionsHistory with name input` (1 test) : la résolution se cascade correctement et `displayName` remonte dans le retour.
- **551 tests passants** (vs 545 en 1.11.0).

### Cas d'usage débloqué

Avant : *« Donne-moi les missions de Damien BLAISE »* → l'agent devait d'abord appeler `boond_resources_search(keywords="BLAISE")` pour récupérer l'ID, puis `boond_resources_missions_history(resourceId="20")` — 2 outils, 2 appels.

Après : *« Donne-moi les missions de Damien BLAISE »* → un seul appel `boond_resources_missions_history(resourceId="Damien BLAISE")` qui résout en interne. Plus de friction pour les utilisateurs qui ne connaissent pas les IDs Boond par cœur.

## [1.11.0] - 2026-06-04

Nouvel outil composite **`boond_resources_missions_history`** — historique complet des missions d'un consultant en un seul appel, avec résolution automatique du nom des sociétés clientes et de la date de début de chaque mission. Répond au cas d'usage « toutes les missions et tous les clients sur lesquels un consultant a travaillé ».

### Ajouté

- **Tool `boond_resources_missions_history`** (`src/tools/resources.ts`) — orchestre côté serveur :
  1. `/resources/{resourceId}/projects` paginé (réutilise `fetchTabResponse` v1.10.3 — toutes les missions du consultant, plus seulement la première).
  2. Résolution du nom client via `GET /companies/{id}` (dédup par société + parallèle + cap `maxEnrichments`).
  3. Si `withProjectDates: true` (défaut), enrichissement de chaque projet via `GET /projects/{id}` pour récupérer `attributes.startDate` (le tab `/resources/projects` n'expose pas les dates).
  4. Tri par date de mission décroissante.
  5. Sortie groupée par société (par défaut, top clients en premier) ou en liste plate.
- **Schéma `ResourceMissionsHistorySchema`** (`src/schemas/index.ts`) avec `resourceId` (requis), `withProjectDates` (défaut true), `groupByCompany` (défaut true), `maxEnrichments` (1-200, défaut 100).
- **Helper exporté `fetchResourceMissionsHistory(params)`** pour les tests et la réutilisation. Helper interne `batchedLookup` pour les fetches parallèles dédupliqués avec cap.
- **Labels de type projet par défaut** (Régie, TJM forfaité, Forfait, Abonnement, Interne / formation) résolus en clair dans la sortie quand `typeOf` est connu.

### Cas d'usage débloqué (sur la ressource Damien BLAISE #20)

Avant : agent devait orchestrer manuellement 1 GET projects + 19 GET projects/{id} + ~12 GET companies/{id} = 32 appels MCP côté agent.

Après v1.11.0 : 1 seul appel `boond_resources_missions_history(resourceId="20")` renvoie un tableau structuré « 19 missions sur 12 sociétés (2018→2026), groupé par client » prêt à exploiter (génération CV interne, audit d'expérience, cartographie clients).

### Tests

- **+6 tests** dans `src/tools/resources.test.ts` (suite `fetchResourceMissionsHistory`) : agrégation projects + résolution noms + startDates en un appel, dédup company GETs (3 projets sur 1 société → 1 GET company), skip enrichissement projet quand `withProjectDates: false` (économie N appels), résultat vide pour consultant sans projet, cap `maxEnrichments` honoré. Test `registerResourceTools` mis à jour : 15 → 16 outils. **545 tests passants** (vs 539 en 1.10.3).
- **TOOLS.md** régénéré : **170 tools** (vs 169 en 1.10.3), 12 prompts, 21 resources.

## [1.10.3] - 2026-06-03

Généralisation du fix v1.10.1 (`Bug 1 : pagination des onglets`) aux 5 autres modules à onglets. En v1.10.1 le correctif n'avait été appliqué qu'à `candidates.ts` (et au `_get` mergé via `registerGetToolMerged`) ; les onglets dédiés des autres entités utilisaient encore le pattern bugué `apiRequest + formatDetailResponse(data[0])`. Reproduit en prod sur la ressource Damien BLAISE (#20, consultant depuis 6+ ans) :

| Outil | Avant (1.10.2) | Après (1.10.3) |
|---|---|---|
| `boond_resources_projects` | 1 projet (≪ CSE - Formation ≫ seul) | Toutes les missions du consultant |
| `boond_resources_positionings` | 1 positionnement | Tous les positionnements |
| `boond_resources_times_reports` | 1 CRA (mai 2026) | Tous les CRA mensuels |
| `boond_contacts_*` (tabs collection) | 1 ligne | Liste complète |
| `boond_opportunities_*` (tabs collection) | 1 ligne | Liste complète |
| `boond_companies_*` (tabs collection) | 1 ligne | Liste complète |
| `boond_projects_*` (tabs collection) | 1 ligne | Liste complète |

### Corrigé

- **Pagination transverse des tab tools** (`src/tools/crud-factory.ts`, `src/tools/{resources,contacts,opportunities,companies,projects,candidates}.ts`). Nouveau helper exporté **`buildTabHandler(apiPath, entityName, tabName)`** qui combine :
  - `fetchTabResponse(path)` (déjà existant depuis v1.10.1) : demande `maxResults=500` et walks pages jusqu'à `meta.totals.rows`.
  - `formatTabAuto(response, entityName)` (déjà existant) : auto-détection liste vs entité unique → `formatListResponse` (toutes les lignes) ou `formatDetailResponse` (single).
  - Route spéciale sur `tabName === "actions"` → `formatActionsList` (HTML strippé, typeLabel, mainManager + dependsOn résolus depuis `included[]`).

- **6 modules refactorés** pour utiliser le helper unifié dans leur boucle de tabs : `candidates.ts` (suppression du fix inline 1.10.1 au profit du helper transverse), `resources.ts`, `contacts.ts`, `opportunities.ts`, `companies.ts` (suppression de la condition `tab.name === "actions"` inline maintenant dans le helper), `projects.ts`. Net : -30 lignes dupliquées + comportement identique sur les 6 entités.

### Tests

- **+4 tests** dans `src/tools/crud-factory.test.ts` (suite `buildTabHandler`) : appel correct sur `${apiPath}/${id}/${tabName}`, rendu de TOUTES les lignes d'un onglet multi-rows (la dernière ligne #105 qui était dropped par `formatDetailResponse(data[0])` apparaît bien), routage automatique sur `formatActionsList` pour `tabName === "actions"`, fallback `formatDetailResponse` pour les onglets mono-entité (information). **539 tests passants** (vs 535 en 1.10.2).

## [1.10.2] - 2026-05-27

Correction de `boond_actions_create` qui retournait systématiquement HTTP 422 — la création d'action ne fonctionnait pas du tout. Diagnostic effectué en inspectant la vraie structure d'une action existante via `GET /actions/216050` plutôt qu'en se fiant à la doc.

### Corrigé

- **Bug — `boond_actions_create` échouait avec 422 « Missing required attribute (parameter: /data/relationships/dependsOn) »** (`src/tools/actions.ts`, `src/schemas/index.ts`).

  Causes multiples identifiées :
  1. **Relations mal construites** : le handler envoyait `relationships.contact`/`candidate`/`company`/`resource` mais l'API exige une relation polymorphe `dependsOn` dont le type varie selon l'entité parente (vérifié sur l'action 216050 : `dependsOn = { type: "candidate", id: "42893" }`).
  2. **Aucune relation `mainManager`** alors que c'est la ressource responsable de l'action (le collaborateur — vu dans la donnée réelle : `mainManager = { type: "resource", id: "33650" }`).
  3. **`typeOf` sérialisé comme string** alors que l'API stocke un integer (`typeOf: 17` dans la donnée réelle).
  4. **Noms d'attributs incorrects** : le tool envoyait `subject` et `content`, l'API attend `title` et `text`.

  Solution :
  - **`dependsOn` construit depuis l'un des `contactId` / `candidateId` / `companyId` / `opportunityId` / `projectId` / `resourceId` fournis** (priorité dans cet ordre). Le `type` de la relation correspond automatiquement à l'entité — `{ type: "contact", id: "514" }` pour un contactId, `{ type: "candidate", id }` pour un candidateId, etc. Aucun ID lié fourni → erreur claire côté serveur avant l'appel API (au lieu d'un 422 opaque).
  - **`mainManager` résolu automatiquement** depuis l'utilisateur courant : nouveau helper `resolveCurrentUserResourceId()` qui parse `thumbnail` de `/application/current-user` (pattern `resource_<id>_*`) — rien n'est codé en dur. Nouveau paramètre optionnel `mainManagerId` pour override explicite. Erreur claire si la résolution échoue.
  - **`typeOf` accepte désormais `number` OU `string` numérique** (`"3"`, `3` ; cast vers integer avant l'API). Les aliases textuels (`"call"`, `"email"`, etc.) sont désormais rejetés par le schéma — ils ne fonctionnaient déjà pas en prod, le contrat est juste rendu explicite.
  - **Mapping `subject` → `title` et `content` → `text`** : nouveau schéma documente `title`/`text` (noms canoniques BoondManager), conserve `subject`/`content` comme alias rétro-compatibles. Les noms canoniques gagnent en cas de double saisie.
  - **Normalisation `startDate`/`endDate`** : `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00+0200` (Europe/Paris). ISO 8601 complet passé tel quel.
  - **Log du payload en niveau debug** pour faciliter le diagnostic des prochains rejets.

### Tests

- **+20 tests** : `src/tools/actions.test.ts` (16 nouveaux — construction `dependsOn` polymorphe pour 6 types d'entités, résolution `mainManager` auto vs explicite, normalisation `typeOf` numérique, erreurs claires sans entité liée et `typeOf` invalide, priorité contact > candidate > company, normalisation ISO startDate, alias `subject`/`content` → `title`/`text`, fallback thumbnail malformé, helper `resolveCurrentUserResourceId`), `src/schemas/index.test.ts` (4 ajustés — contrat `typeOf` numérique strict). **535 tests passants** (vs 515 en 1.10.1).

## [1.10.1] - 2026-05-27

Deux corrections de bugs remontés en production sur les actions liées aux candidats.

### Corrigé

- **Bug 1 — onglets de collection tronqués à 1 résultat** (`src/services/boond-client.ts`, `src/tools/candidates.ts`, `src/tools/crud-factory.ts`). `boond_candidates_actions` et `boond_candidates_get(tab="actions")` ne renvoyaient qu'une seule action sur 6. Double cause : (a) l'endpoint tab `/candidates/{id}/actions` était appelé sans `maxResults`, donc la page size par défaut très basse de l'API ne ramenait qu'une ou deux lignes ; (b) le rendu passait par `formatDetailResponse` qui ne sérialise que `data[0]`, masquant les lignes restantes même quand l'API en renvoyait plusieurs. Solution :
  - Nouveau helper `fetchTabResponse(path, maxPages, pageSize)` qui demande `maxResults=500` et pagine jusqu'à couvrir `meta.totals.rows` (cap `maxPages`), sans appel superflu pour les onglets mono-entité (information, technical-data).
  - Nouveau helper `formatTabAuto(response, label)` qui détecte liste vs entité unique (`meta.totals.rows` présent ou `data.length > 1`) et route vers `formatListResponse` (toutes les lignes) ou `formatDetailResponse`.
  - `boond_candidates_actions` utilise `fetchTabResponse` + le formateur enrichi `formatActionsList` (HTML strippé, typeLabel, manager, entité liée). Les autres onglets-collection passent par `formatTabAuto`.
  - `registerGetToolMerged` (utilisé par candidates/contacts/opportunities/companies `_get`) applique le même pattern quand un `tab` est fourni — fix transverse à toutes les entités à onglets.
- **Bug 2 — `boond_actions_search` sans dates renvoyait 0 résultat** (`src/tools/actions.ts`). Le paramètre `period` (défaut Zod `"started"`) était systématiquement transmis à l'API, même sans `dateFrom`/`dateTo`. BoondManager interprète `period=started` sans fenêtre de dates comme une plage vide et renvoie 0 ligne — ce qui avalait silencieusement toutes les actions d'une recherche `candidateId`-only. Désormais `period` n'est envoyé que si au moins une borne (`dateFrom`/`dateTo`) OU un `periodDynamic` est fourni. `periodDynamic` reste transmis quand présent (seul cas légitime de `period` sans dates explicites).

### Tests

- **+11 tests** : `src/services/boond-client.test.ts` (fetchTabResponse : maxResults=500, single-page, multi-page walk, single-entity no-extra-call ; formatTabAuto : list vs detail), `src/tools/actions.test.ts` (period absent sans fenêtre, présent avec dateFrom/dateTo, présent avec dateFrom seul, présent avec periodDynamic), `src/tools/candidates.test.ts` (onglet actions routé via fetchTabResponse + rendu des 6 actions). **515 tests passants** (vs 504 en 1.10.0).

## [1.10.0] - 2026-05-22

Portage des 6 fonctionnalités métier du serveur MCP local Node.js (`boond-mcp-server/index.js`) vers le serveur Azure TypeScript. Toutes les modifications sont additives — pas de breaking change sur les outils existants, tous les nouveaux paramètres sont optionnels et l'authentification OAuth/JWT multi-utilisateurs reste inchangée.

### Ajouté

- **`stateLabel` sur `boond_candidates_search`** (`src/schemas/index.ts`, `src/tools/candidates.ts`) — raccourci textuel (ex: `stateLabel: "Vivier chaud"`) résolu vers `candidateStates: [<id>]` via le dictionnaire `setting.state.candidate` en cache (TTL 1h, partagé avec le reste du serveur). Lookup normalisé case/trim ; libellé inconnu silencieusement ignoré ; `candidateStates` explicite gagne toujours sur `stateLabel`.
- **`fetchAll: boolean` + `maxResults: number` sur `boond_candidates_search`** — opt-in pour la pagination automatique : force `pageSize: 500`, walks pages jusqu'à `maxResults` (défaut 500, max 1000), agrège les `data[]` en une seule sortie via `formatListResponse`. Garde-fous : break sur page partielle et cap dur côté serveur. La pagination manuelle (`page`, `pageSize`) reste inchangée.
- **`fetchEntityWithInformation` helper** (`src/services/boond-client.ts`) — fetch parallèle de l'endpoint principal + `/information`, merge des `attributes` (base wins) et union dédupliquée de `included[]` par `${type}:${id}`. Échec de `/information` non-fatal (404, blip réseau → la base remonte intacte).
- **`registerGetToolMerged` factory** (`src/tools/crud-factory.ts`) — variante de `registerGetTool` qui auto-merge entity + /information quand `tab` n'est pas fourni. Branchée sur **`boond_candidates_get`, `boond_contacts_get`, `boond_opportunities_get`, `boond_companies_get`**. Quand `tab` est explicite (ex: `tab="technical-data"`), le comportement single-tab d'origine est préservé exactement.
- **`actionType` sémantique sur `boond_actions_search`** (`src/schemas/index.ts`, `src/tools/actions.ts`) — mot-clé textuel (`note`, `appel`, `entretien`, `relance`, `prospection`, `rdv`, …) résolu vers `actionTypes: [<ids>]` via un mapping `KEYWORD_TO_TYPES` (30 catégories portées du serveur local). Accepte aussi un ID stringifié (`actionType: "42"`). `typeOf` explicite gagne ; libellé inconnu silencieusement ignoré.
- **`periodDynamic` sur `boond_actions_search`** — enum (`today`, `yesterday`, `thisWeek`, `lastWeek`, `thisMonth`, …, `lastYear`) forwardée à l'API tel quel. Combinable avec `period` (qui choisit le champ filtré).
- **Préfixes `CAND<id>` / `COMP<id>` / `CCON<id>` / `CSOC<id>` sur `boond_actions_search`** — les paramètres `candidateId`, `resourceId`, `contactId`, `companyId` sont désormais injectés dans `keywords` via les préfixes BoondManager (les noms `candidateId=` étaient silencieusement ignorés par l'API `/actions`). Combinable avec un `keywords` utilisateur (préfixes prepended).
- **Tab `boond_companies_actions` enrichi** (`src/tools/companies.ts`) — utilise désormais `formatActionsList` (HTML strippé, `typeLabel` résolu, nom du `mainManager` extrait des `included[]`, entité liée résolue) au lieu du dump JSON générique. Comportement aligné sur `boond_actions_search`.
- **`resolveActionLabel(typeId, dependsOnType, liveLabels)` + fallbacks statiques** (`src/tools/actions.ts`) — résolution du label en 3 étages : (1) dictionnaire live (`setting.action.*` en cache), (2) `STATIC_TYPE_LABELS_CONTACT` ou `STATIC_TYPE_LABELS_CANDIDATE` selon `dependsOn.type` (ports lignes 49-93 du fichier local), (3) `type#<id>` en dernier recours. Branché dans `formatActionSummary`.
- **`getStateMap(entity)` helper** (`src/services/dictionary.ts`) — wrapper typé sur le cache dictionnaire qui retourne `{ byId, byLabel }` pour `setting.state.<entity>` avec normalisation des labels. Exposable pour les 9 entités à états (candidate, resource, contact, company, opportunity, project, invoice, order, positioning).

### Tests

- **+16 tests** dans `src/tools/candidates.test.ts` (stateLabel resolution + normalize + override + fetchAll partial + fetchAll cap), `src/tools/actions.test.ts` (actionType sémantique + alias rdv + ID stringifié + typeOf wins + unknown silent + periodDynamic + 4 préfixes linked + keywords merge + scoped static fallback), `src/services/boond-client.test.ts` (fetchEntityWithInformation : merge base wins, dedup included, /information failure fallback, base failure propagated). **504 tests passants** (vs 484 en 1.9.5).

### Fichiers modifiés (résumé)

| Fichier | Rôle du change |
|---|---|
| `src/schemas/index.ts` | `CandidateSearchSchema` (+ stateLabel, fetchAll, maxResults), `ActionSearchSchema` (+ actionType, periodDynamic) |
| `src/services/dictionary.ts` | Helper `getStateMap()` + interface `StateMap` |
| `src/services/boond-client.ts` | Helper `fetchEntityWithInformation()` |
| `src/tools/crud-factory.ts` | Factory `registerGetToolMerged()` qui auto-merge entity + /information |
| `src/tools/candidates.ts` | Handler custom search (résolution stateLabel + auto-pagination), get merged |
| `src/tools/contacts.ts` | Get merged |
| `src/tools/opportunities.ts` | Get merged |
| `src/tools/companies.ts` | Get merged + tab `actions` utilise `formatActionsList` |
| `src/tools/actions.ts` | `KEYWORD_TO_TYPES`, `STATIC_TYPE_LABELS_*`, `resolveActionLabel`, handler search étendu (actionType, periodDynamic, préfixes linked), `formatActionsList` exporté |
| `src/tools/{candidates,actions}.test.ts` et `src/services/boond-client.test.ts` | +16 tests |

## [1.9.5] - 2026-05-21

Inspection directe de `GET /orders/2325` via le MCP en prod : l'ordre BoondManager **n'a pas de relation `company`** — uniquement `mainManager` (commercial) et `project`. La chaîne réelle est donc à 3 niveaux : invoice → order → project → company. v1.9.4 s'arrêtait à `/orders/{id}` et trouvait null. Cette version étend le second pass.

### Corrigé

- **Bug 2b (v3) — chaîne complète invoice → order → project → company** dans `resolveCompaniesViaOrders` (`src/tools/invoices.ts`) :
  1. `GET /orders/{orderId}` (sans include) → lire `relationships.project.data.id`. Le code teste d'abord une relation `company` directe sur l'ordre (défensif pour d'autres instances), puis tombe sur `project`.
  2. Pour chaque `projectId` distinct récolté à l'étape 1 : `GET /projects/{id}?include=company` → lire `relationships.company.data.id` + nom depuis `included[]`.
  3. Dédup à chaque niveau (plusieurs factures sur même ordre → 1 fetch ordre ; plusieurs ordres sur même projet → 1 fetch projet) — gain de latence sensible quand l'ESN bille un même projet en plusieurs jalons.
- Cap maintenu à 100 ordres uniques au niveau de l'étape 1 ; les ordres en surplus se voient affichés en `order #<id> (driller)` avec la note `boond_orders_get` / `boond_projects_get`.
- Court-circuit défensif : si l'ordre expose un champ inline `companyName` (certaines instances le font), on saute l'étape 2.
- Description du tool `boond_invoices_overdue` resserrée pour rester sous la limite de 2000 caractères (testée en CI via `descriptions.test.ts`).

### Tests

`src/tools/invoices.test.ts` : tests refactorés autour de la nouvelle signature `order(id, projectId, companyId?)` et d'un nouveau helper `project(id, companyId)`. Tests clés :
- `resolves company via the full invoice → order → project → company chain` — pinne le pipeline canonique avec les 4 fetches attendus (`/orders/2325`, `/orders/2326`, `/projects/1808`, `/projects/1809`).
- `uses the defensive 'order has company directly' short-circuit when available` — vérifie qu'on n'appelle pas `/projects/` quand l'ordre porte déjà la company.
- `dedupes both orderIds and projectIds in the chain` — 3 factures → 2 orders distincts + 1 projet partagé → exactement 2 fetches orders + 1 fetch projet.
- Cap test mis à jour : 150 ordres uniques → 100 fetches `/orders/` + 1 fetch `/projects/` (cap appliqué au niveau ordre).
- **483 tests passants** (vs 483 en 1.9.4, count identique car refactor + 1 nouveau test pour le short-circuit, - 1 ancien test).

## [1.9.4] - 2026-05-21

BoondManager n'honore pas le nested include `order.company` sur `/invoices` (testé en prod sur la révision 0000039) — l'order est bien embarqué dans `included[]`, mais sa propre relation `company` n'est pas suivie. Conséquence : v1.9.3 affichait `société #<id>` ou `société inconnue`. Cette version résout via un second passage explicite.

### Corrigé

- **Bug 2b (v2) — résolution société via `GET /orders/{id}?include=company`** (`src/tools/invoices.ts`). Pipeline complet :
  1. La query `/invoices` envoie `include=order,company,project` (plus de nested `order.company`).
  2. Après scan complet, on collecte les `orderId` uniques des lignes dont `companyName` est null.
  3. Fetch parallèle de chaque ordre via `GET /orders/{id}?include=company` — capé à **100 lookups uniques** pour borner la latence (≈ 10s avec rate limiter à 10 RPS).
  4. Cache `orderId → {companyId, companyName}` appliqué aux rows. Au-delà du cap, l'output affiche `order #<id> (driller)` à la place du nom + une note suggérant `boond_orders_get` pour drill manuel.
- **`OverdueRow.orderId`** ajouté pour pouvoir surfacer l'order quand la société reste introuvable.
- **`resolveCompaniesViaOrders`** exporté (`src/tools/invoices.ts`) — helper réutilisable qui dédup les orderIds, parallélise via `Promise.allSettled` (le rate limiter `src/services/rate-limiter.ts` throttle naturellement) et avale les erreurs unitaires pour qu'une seule mauvaise réponse ne casse pas le batch.
- **`boond_invoices_search` et `boond_invoices_get`** bénéficient aussi du second pass : la fonction `resolveUnresolvedCompanies` est partagée entre les 3 outils.
- **Détail de facture** : la sortie inclut désormais `Bon de commande lié : #<orderId>` quand un order est rattaché — utile pour driller.

### Tests

`src/tools/invoices.test.ts` : **+3 tests** (total 24, vs 21 en 1.9.3) :
- `resolves company via second-pass GET /orders/{id}` — vérifie le pipeline complet avec mocks pour `/orders/{id}` retournant `included: [company]`. Assert sur le `include=company` query param.
- `dedupes orderIds in the second-pass lookup` — 3 factures sur le même order → 1 seul GET /orders/.
- `caps the second-pass fetches` — 150 unique orders → exactement 100 fetches + `unresolvedOrdersAfterCap = 50`.
- `falls back to orderId display when even the second pass can't resolve` — pinne le comportement de drill.
- Test « returns companyId without name when order is embedded but its company isn't » remplacé par le scénario réel prod (`resolves company via second-pass GET /orders/{id}`).
- Le test de pagination filtre désormais les calls `/orders/{id}` du second pass pour rester ciblé sur les calls `/invoices`.
- **483 tests passants** (vs 480 en 1.9.3).

## [1.9.3] - 2026-05-21

Application des noms de champs exacts identifiés par le bloc de diagnostic ajouté en 1.9.2. Plus de probing « à la louche » sur les montants et de fallback de relation.

### Corrigé

- **Bug 2a — montant** : la liste de probing met désormais `turnoverInvoicedExcludingTax` (HT) et `turnoverInvoicedIncludingTax` (TTC) en tête. Ce sont les noms canoniques du payload `/invoices` (variante « facturé », distincte du `turnover*` générique des orders/opportunities). Les anciens noms restent en fallback défensif pour d'autres instances.
- **Bug 2b — société** : sur `/invoices`, la société n'est pas exposée par une relation directe sur la facture. La chaîne canonique est **`invoice.order → order.company`**. La query envoie maintenant `include=order.company,order,company,project` (nested include JSON:API) pour que BoondManager embarque les deux niveaux dans `included[]`. `resolveCompany` traverse cette chaîne et retourne le `companyId` même quand le nom n'est pas résolu (affichage `société #<id>` en fallback).

### Tests

`src/tools/invoices.test.ts` : +3 tests, total 21 (vs 18 en 1.9.2) :
- `resolves company via invoice → order → company chain` — pinne le pattern canonique avec ordres et sociétés embarqués dans `included[]`.
- `returns companyId without name when order is embedded but its company isn't` — couvre le cas où nested include ne marche que partiellement.
- `falls back to legacy turnoverExcludingTax when turnoverInvoiced* is absent` — vérifie que le fallback défensif fonctionne toujours.
- Le test global d'unpaid states utilise désormais `invoiceWithOrder` pour matcher la forme réelle de la prod.
- **480 tests passants** (vs 477 en 1.9.2).

## [1.9.2] - 2026-05-21

Correction de 4 bugs sur les tools factures, identifiés en prod après inspection du vrai dictionnaire `setting.state.invoice` et des payloads JSON:API renvoyés par BoondManager.

### Corrigé

- **Bug 3 — états « Avoiré », « ProForma », « Payée groupe », « Création » désormais exclus** de `boond_invoices_overdue` (`src/tools/invoices.ts`). La détection combine le flag natif BoondManager `isExcludedFromSentState` (utilisé pour Création + ProForma) et une regex étendue couvrant `^pay[ée]e` (sans `partiel`), `avoir`, `annul`. « Payée partiellement » (id 7) reste correctement incluse — solde encore dû. La fonction d'exclusion `isExcludedFromOverdue` est exportée pour tests unitaires.
- **Bug 2 — montant HT et nom de société désormais résolus** dans `boond_invoices_overdue`. Trois changements :
  1. La query envoie `include=company,order,project` pour que BoondManager embarque les ressources liées dans `included[]`.
  2. La résolution de société utilise le pattern `buildIncludedIndex` + `lookupRelated` (déjà éprouvé dans `actions.ts`), avec fallback `company → mainCompany → invoicedCompany → society`, puis chaîne `order → company` si la relation directe est absente.
  3. Le montant est lu défensivement parmi `turnoverExcludingTax`, `amountExcludingTax`, `totalExcludingTax`, `turnover`, `amount` (premier non-null gagne). Idem pour TTC : `turnoverIncludingTax`, `amountIncludingTax`, `totalIncludingTax`. La sortie affiche désormais montant HT + TTC quand présent.
- **Bug 1 — `expectedPaymentDate` est désormais le filtre strict** (plus de fallback `?? dueDate`). Cohérent avec la pratique comptable Versusmind : `expectedPaymentDate` (« Date de règlement prévu », saisie comptable) est le pivot du recouvrement ; `dueDate` (« Échéance ») est calculée et pas toujours fiable. Les factures sans `expectedPaymentDate` sont ignorées. Un commentaire d'en-tête dans `src/tools/invoices.ts` documente la convention.
- **Bug 4 — `boond_invoices_search` et `boond_invoices_get` enrichis** avec un formateur dédié `formatInvoiceList` / `formatInvoiceDetail`. La sortie inclut désormais : référence, nom société (résolue via `included[]`), `expectedPaymentDate` (ou `dueDate` en fallback display), montant HT + TTC, libellé d'état. Le détail conserve aussi le payload JSON:API brut en dessous pour les usages avancés. Les deux endpoints envoient désormais `include=company,order,project`.

### Garde-fou diagnostic

Si après ces probings le tool overdue retombe quand même sur des montants à zéro ou des sociétés inconnues sur l'intégralité du batch, la sortie ajoute un bloc « ⚠️ Diagnostic » listant les vrais noms `attributes[]` et `relationships[]` vus sur la 1re facture scannée. Permet d'étendre les listes `AMOUNT_*_FIELDS` / `COMPANY_REL_NAMES` sans round-trip de debug.

### Tests

`src/tools/invoices.test.ts` réécrit (**+8 tests**, total 18 dans ce fichier vs 10 en 1.9.1) :
- Le `INVOICE_STATE_DICT` reflète désormais le vrai dictionnaire prod (16 entrées, IDs 0-15 conformes).
- Suite dédiée `isExcludedFromOverdue` (6 tests) qui pinne : Création/ProForma via flag, Payée + Payée groupe, Avoiré, Annulée défensive, et le maintien de « Payée partiellement » + Relance 1/2 + Impayée + Contentieux.
- Tests sur `fetchOverdueInvoices` mis à jour : filtre strict `expectedPaymentDate` sans fallback, résolution société via `included[]`, résolution montant via `turnoverExcludingTax`, vérification que la query envoie `include=company,order,project` ET la bonne liste de states (1, 2, 4, 5, 6, 7).
- **477 tests passants** (vs 469 en 1.9.1).

## [1.9.1] - 2026-05-21

Correction de bug sur `boond_invoices_overdue` : le tool filtrait uniquement sur le champ `dueDate` de l'API BoondManager (échéance contractuelle, parfois calculée automatiquement). Mais en pratique, sur les factures Versusmind, c'est `expectedPaymentDate` (date de règlement prévu, saisie comptable) qui est renseigné. Résultat : le tool passait à côté de toutes les factures n'utilisant que `expectedPaymentDate` et renvoyait une liste vide à tort.

### Corrigé

- **Fallback `expectedPaymentDate` → `dueDate`** (`src/tools/invoices.ts`) — `fetchOverdueInvoices` calcule désormais une `effectiveDate = expectedPaymentDate ?? dueDate` pour chaque facture, puis applique le filtre `effectiveDate < asOfDate`. Les factures où ni l'un ni l'autre n'est rempli sont ignorées (comportement précédent préservé). La sortie indique quel champ a été utilisé (« règlement prévu » vs « échéance ») pour chaque ligne. L'`OverdueRow` interne change de `dueDate: string` à `{ effectiveDate, dateField: "expectedPaymentDate" | "dueDate" }`.
- **Suppression du `sort: dueDate asc` côté serveur** — il ordonnait les résultats en plaçant les factures sans `dueDate` (avec uniquement `expectedPaymentDate`) en fin de result set, risquant de les couper par `maxPages`. On laisse désormais BoondManager appliquer son ordre par défaut ; le tri définitif (`daysOverdue` décroissant) reste côté serveur MCP.

### Tests

- **+1 test** dans `src/tools/invoices.test.ts` (`uses expectedPaymentDate when populated, falling back to dueDate otherwise`) qui pinne le contrat avec 5 cas : `expectedPaymentDate` seul, `dueDate` seul, les deux (expectedPaymentDate gagne), aucun (drop), date future (drop). Le test existant sur le tri server-side est mis à jour pour vérifier qu'on n'envoie plus `sort`/`order`. **469 tests passants** (vs 468 en 1.9.0).

## [1.9.0] - 2026-05-21

Nouvel outil composite **`boond_invoices_overdue`** dédié à l'identification des factures en retard de paiement, plus extension de la surface de filtres du search facture (états + périmètre). Cible la demande Versusmind : "lister les factures en retard, filtrables par pôle / manager / client / montant".

### Ajouté

- **Tool `boond_invoices_overdue`** (`src/tools/invoices.ts`) — orchestre en un seul appel : récupération du dictionnaire `setting.state.invoice` → exclusion des états "payée" / "annulée" → recherche `/invoices` avec filtres `states[]` + périmètre + tri `dueDate asc` → filtre serveur sur `dueDate < asOfDate` (défaut aujourd'hui) → bornes `amountMin/MaxExcludingTax`. Sortie soit en liste plate triée par jours de retard décroissants, soit groupée par société (`groupByCompany: true`) avec total HT impayé. Pagination interne jusqu'à `maxPages` (défaut 5 × 500 = 2500 factures scannées). Hydrate les noms de sociétés depuis le `included` JSON:API quand l'API les renvoie.
- **Schema `InvoiceOverdueSchema`** (`src/schemas/index.ts`) — Zod strict avec `asOfDate`, `companyId`, `perimeterManagers/Type`, `perimeterAgencies`, `perimeterPoles`, `perimeterBusinessUnits`, `perimeterDynamic`, `narrowPerimeter`, `amountMin/MaxExcludingTax`, `groupByCompany`, `pageSize`, `maxPages`.
- **Prompt `factures_en_retard`** (`src/prompts/index.ts`) — wrapper utilisateur autour de `boond_invoices_overdue`. Args : `pole_id`, `manager_id` (ID ou libellé résolu via `boond_resources_search`), `society_id` (ID ou nom), `amount_min/max`, `as_of_date`, `group_by_company`. Restitue un plan d'action de relance basé sur le top 3 sociétés par montant impayé.

### Étendu

- **`InvoiceSearchSchema`** (`src/schemas/index.ts`) — ajout des filtres alignés sur l'API BoondManager : `states[]` (dictionnaire `setting.state.invoice`), `perimeterManagers`, `perimeterManagersType` (`main`/`hr`), `perimeterAgencies`, `perimeterPoles`, `perimeterBusinessUnits`, `perimeterDynamic`, `narrowPerimeter`, `sort`, `order`. La description du tool documente désormais le périmètre + les états + redirige vers `boond_invoices_overdue` pour le cas "factures en retard". Comportement par défaut ajusté : `period` n'est plus forcé à `"period"` quand non fourni (plus correct, sans casser les usages explicites).

### Tests

- **+7 tests** dans `src/tools/invoices.test.ts` : compte 6 tools (vs 5), hint readOnly sur overdue, et 5 tests sur `fetchOverdueInvoices` (exclusion payée/annulée + tri par retard, filtres montant + périmètre transmis à l'API, pagination jusqu'au remplissage partiel, hydratation des noms de sociétés via `included`, rejet `asOfDate` invalide). **+2 tests** dans `src/prompts/index.test.ts` (forward des filtres `pole_id`/`manager_id`/`amount_min` vers `boond_invoices_overdue`, opt-out de `groupByCompany` via `group_by_company: "non"`). **468 tests passants** (vs 461 en 1.8.2).

## [1.8.2] - 2026-05-08

Correction d'authentification : le client n'arrivait plus à se connecter à BoondManager via la méthode JWT (auto-construit ou pré-construit). L'API renvoyait `422 - Signature verification failed (parameter: jwt)` à chaque requête. Cause : le JWT était envoyé dans `Authorization: Bearer …`, alors que la spec officielle BoondManager exige le header dédié `X-Jwt-Client-Boondmanager`. Le mode BasicAuth (`BOOND_USER` + `BOOND_PASSWORD`) restait fonctionnel via `Authorization: Basic …`.

### Corrigé

- **Header d'auth JWT** (`src/services/boond-client.ts`, `src/types.ts`) — `initClient()` route désormais le JWT (auto-construit depuis `BOOND_USER_TOKEN` + `BOOND_CLIENT_TOKEN` + `BOOND_CLIENT_KEY`, ou pré-construit via `BOOND_API_TOKEN`) dans le header `X-Jwt-Client-Boondmanager` (constante exportée `JWT_HEADER_NAME`). BasicAuth continue d'utiliser `Authorization: Basic …`. `BoondConfig` passe de `{ baseUrl, authHeader }` à `{ baseUrl, authHeaderName, authHeaderValue }` pour porter le nom du header. Validé contre l'API réelle : `GET /application/current-user` répond désormais `200 OK`.

### Tests

- **+3 tests dans `src/services/boond-client.test.ts`** (`apiRequest auth header routing`) qui pinnent le contrat : JWT auto-construit → `X-Jwt-Client-Boondmanager` (pas d'`Authorization`), `BOOND_API_TOKEN` → idem, BasicAuth → `Authorization: Basic …`. **425 tests passants** (vs 422 en 1.8.1).

## [1.8.1] - 2026-05-04

Durcissement sécurité du transport HTTP et relèvement du plancher SDK pour fermer trois CVE remontées par les scanners marketplace.

### Sécurité

- **SDK MCP : plancher relevé à `^1.29.0`** (`package.json`) — la borne basse `^1.12.1` exposait la bibliothèque à trois avis publiés depuis :
  - `GHSA-345p-7cg4-v4c7` / **CVE-2026-25536** — fuite inter-clients via réutilisation d'instances `server`/`transport` (corrigé en 1.26.0).
  - `GHSA-8r9q-7v3j-jr4g` / **CVE-2026-0621** — ReDoS dans `UriTemplate` sur les patterns explosés (`{/id*}`, `{?tags*}`) (corrigé en 1.25.2).
  - `GHSA-w48q-cv73-mx4w` / **CVE-2025-66414** — la protection DNS rebinding n'était pas activée par défaut (atténué en 1.24.0, mais nécessite une configuration explicite côté serveur custom).
  Le lockfile résolvait déjà 1.29.0, mais la borne basse permettait à un consommateur de retomber sur une version vulnérable. La nouvelle borne ferme ce trou.
- **Validation du `Host` header dans le transport HTTP** (`src/transports/http.ts`) — atténue **CVE-2025-66414** au-delà du SDK lui-même. Quand le serveur écoute sur une interface loopback (`127.0.0.1`, `::1`, `localhost`), seuls les `Host` ∈ `{localhost, 127.0.0.1, [::1]}` sont acceptés ; un site malveillant qui exploiterait un DNS rebinding pour pointer un domaine arbitraire sur le port local du MCP reçoit désormais un `403 Invalid Host`. Sur un bind non-loopback (Docker, gateway), la validation est désactivée par défaut pour ne pas casser les déploiements derrière un reverse proxy ; pour activer une allow-list explicite, configurer `MCP_HTTP_ALLOWED_HOSTS=mcp.example.com,mcp.internal`. `MCP_HTTP_ALLOWED_HOSTS=*` est le bypass explicite documenté.

### Tests

- 6 tests supplémentaires dans `src/transports/http.test.ts` couvrent : parsing de `MCP_HTTP_ALLOWED_HOSTS`, sélection de la liste par défaut selon l'interface bind, opt-out via `*`, rejet d'un `Host` non listé (HTTP 403 avec message `Invalid Host: <name>`), acceptation d'un `Host` listé.

## [1.8.0] - 2026-05-04

Workaround pour les clients MCP qui mishandlent les prompts : 11 nouveaux outils `boond_workflow_*` qui exposent les mêmes runbooks que les prompts existants, mais via la surface `tools/list`.

### Contexte

Symptôme observé sur **claude.ai (Cowork) > menu connecteur > prompt** : après saisie des paramètres et validation, au lieu d'injecter le runbook comme message utilisateur, le client le sérialise comme une pièce jointe virtuelle nommée `{prompt_name}_text` que le modèle tente de `Read` depuis le dossier d'uploads — fichier qui n'existe pas, donc le modèle demande à l'utilisateur de réessayer ou d'attacher le fichier. Bug côté client (la réponse `prompts/get` côté serveur reste conforme à la spec MCP), mais bloquant côté UX.

### Ajouté

- **11 outils `boond_workflow_*`** (`src/tools/workflows.ts`) miroir 1:1 des prompts existants : `synthese_equipe`, `pipeline_commercial`, `factures_a_relancer`, `candidats_pour_opportunite`, `fiche_consultant`, `recap_hebdo`, `staffing_disponible`, `fin_de_mission`, `cartographie_competences`, `cvs_a_mettre_a_jour`, `recherche_profil_competences`. Chaque outil partage **exactement** le `build()` et l'`argsSchema` de son prompt source (export de `PROMPTS` depuis `src/prompts/index.ts`) — pas de duplication. Annotations : `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` (le runbook est synthétisé localement, l'agent l'exécute ensuite via les autres outils Boond).
- **Tests** : `src/tools/workflows.test.ts` (7 tests) — vérifie la parité tool↔prompt sur les noms, le schéma d'arguments, les annotations, et l'égalité `tool.callback({}) === prompt.build({})` pour `synthese_equipe`. Total : **413 tests passants** (vs 406 en 1.7.5).

### Aucune rupture

- Les **11 prompts MCP restent enregistrés** — Claude Desktop / Claude Code continuent de les utiliser comme avant. Les nouveaux outils sont une surface additionnelle, pas un remplacement. Le total monte à **167 outils** (156 + 11 workflows), 11 prompts, 21 ressources. Les 156 outils existants, leurs noms, schémas et annotations sont strictement inchangés.

### Comment l'utiliser dans claude.ai (Cowork)

Plus besoin de passer par le menu prompts : décrire la tâche en langage naturel et le modèle choisit le `boond_workflow_*` correspondant (`« fais-moi la synthèse de l'équipe de Jean Dupont sur le mois en cours »` → `boond_workflow_synthese_equipe`).

## [1.7.5] - 2026-05-04

Tournée de bugfixes après un test bout-en-bout du serveur contre un tenant BoondManager réel : sept outils renvoyaient soit un 422 « 1017 - Missing required attribute » silencieux (paramètre manquant côté schéma), soit un crash JavaScript, soit un message d'erreur opaque. Tous corrigés.

### Corrigé

- **`boond_timesheets_search` — schéma aligné sur l'API** (`src/schemas/index.ts`, `src/tools/timesheets.ts`) — l'endpoint `/times-reports` exige `startMonth` + `endMonth` au format `YYYY-MM` ; le schéma envoyait `startDate`/`endDate` au format `YYYY-MM-DD`. Conséquence : tout appel renvoyait un 422 quels que soient les arguments. Le schéma rejette maintenant les appels sans `startMonth`/`endMonth` (regex `^\d{4}-\d{2}$`) et la description du tool annonce les champs requis.
- **`boond_validations_search` — nouveau schéma RAML-fidèle** (`ValidationSearchSchema`) — `startMonth`/`endMonth` désormais requis (mêmes contraintes qu'au-dessus), plus les filtres officiels `documentTypes` (`absencesReport`/`timesReport`/`expensesReport`), `validationStates` (`waitingForValidation`/`validated`/`rejected`), `resourceTypes`, `validationAlerts`, `keywords` (préfixes `TPS`/`EXP`/`ABS`/`COMP`).
- **`boond_notifications_search` — `category` enforced** (`NotificationSearchSchema`) — l'endpoint refuse toute requête sans le paramètre singulier `category` ∈ {`activity`, `thread`, `corporate`}. Schéma typé en `z.enum`, plus filtres optionnels `state` (`new`/`read`) et `parentType[]`.
- **`boond_reporting_*` — schémas de date par endpoint** (`ReportingDateRequiredSchema` / `ReportingDateOptionalSchema`) — `companies`, `resources`, `synthesis` et `production_plans` exigent `startDate` + `endDate` (YYYY-MM-DD) ; `projects` les accepte mais ne les requiert pas. La factory `registerReportingTools` choisit le schéma adapté par endpoint.
- **`boond_calendars_search` — plus de crash sur réponse non JSON:API** (`src/services/boond-client.ts::formatEntitySummary`) — `/calendars` retourne des items plats `{iso, value, subCalendars}` sans le wrapper `attributes` ; l'ancien formatter accédait à `attributes.firstName` et levait `Cannot read properties of undefined`. Le formatter accepte maintenant les deux formes (avec/sans wrapper) et émet `value` + `ISO:` pour les items dictionnaires.
- **Erreurs API plus actionnables** (`parseBoondErrorBody`) — `errors[].source.parameter` (et `source.pointer` à défaut) est désormais surfacé dans le message. `1017 - Missing required attribute` devient `1017 - Missing required attribute (parameter: startMonth)` — l'agent (humain ou LLM) sait quoi corriger.
- **Détection des blocs Cloudflare WAF** (`formatApiError`) — quand le corps de réponse 4xx est une page de challenge Cloudflare (`<title>Attention Required! | Cloudflare</title>`, `cf-ray`, …), le message d'erreur le signale explicitement (`request blocked by Cloudflare WAF before reaching the API`) au lieu d'afficher le HTML brut suivi du faux indice « the user lacks permission ». Évite les fausses pistes côté debug quand la requête n'a jamais atteint BoondManager.

### Tests

- **+5 tests unitaires** ciblant les fixes : surface de `source.parameter`/`source.pointer` dans `parseBoondErrorBody`, détection des pages de challenge Cloudflare dans `formatApiError`, formatter défensif `formatEntitySummary` sur entités sans wrapper `attributes`, rejet du nouveau `TimesheetSearchSchema` sans `startMonth`/`endMonth` ou en `YYYY-MM-DD`. **406 tests passants** (vs 401 en 1.7.4).

### Aucune rupture côté outils

- Les noms d'outils, le nombre d'outils (156) et les arguments existants des autres tools sont inchangés. Seuls les **paramètres requis** des 4 tools listés ci-dessus changent — mais ces tools renvoyaient un 422 si on ne passait pas ces paramètres, donc tout caller fonctionnel passait déjà l'équivalent (ou n'arrivait pas à utiliser le tool). Le rejet est désormais en amont (schéma Zod) avec un message explicite.

## [1.7.4] - 2026-05-03

Hotfix metadata du bundle `.mcpb` : ajoute la déclaration `prompts_generated: true` au `manifest.json` pour que Claude Desktop accepte les 11 prompts dynamiques.

### Corrigé

- **`manifest.json` — `prompts_generated: true`** — sans cette déclaration, Claude Desktop loggait `[warn] Extension BoondManager MCP Server attempted undeclared prompt: synthese_equipe` à chaque tentative d'attachement de prompt et bloquait l'appel `prompts/get` **côté client** (1 ms après émission, jamais reçu par le serveur). Symptôme côté UI : "Failed to attach prompt. You can try again." Le manifest avait déjà `tools_generated: true` pour les 156 outils générés dynamiquement ; le pendant pour les prompts manquait simplement. Cf. [spec MCPB MANIFEST.md](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md) — un client conforme "should only look for tools/prompts present in the manifest.json" sauf si les flags `*_generated: true` sont posés.

### Aucune rupture

- Aucun changement de code (TypeScript inchangé). Seuls `manifest.json`, `package.json`, `server.json` et `package-lock.json` sont touchés. **Tous les utilisateurs ayant installé un `.mcpb` v1.7.3 ou antérieur doivent réinstaller** pour pouvoir attacher les prompts (`synthese_equipe`, `pipeline_commercial`, `staffing_disponible`, etc.) dans Claude Desktop.

## [1.7.3] - 2026-05-03

Hotfix critique de l'outil `boond_application_dictionary` et des ressources `boond://dictionary/*` : depuis l'origine, ces deux surfaces appelaient un endpoint qui n'existe pas (`/application/dictionaries/{slug}`, pluriel) et retournaient systématiquement un **404 BoondManager**, ce qui bloquait notamment l'attachement de ressources dans Claude Desktop ("Failed to attach resource"). L'API officielle expose en réalité un endpoint unique `/application/dictionary` (singulier) qui renvoie l'intégralité des dictionnaires en une seule réponse, structurée en `data.setting.*`, `data.country`, `data.languages`.

### Corrigé

- **Endpoint dictionnaire** — le tool `boond_application_dictionary` et toutes les ressources `boond://dictionary/*` appellent désormais `GET /application/dictionary` (cf. `https://doc.boondmanager.com/api-externe/raml-build/resources/application/dictionary.raml`). Le paramètre `dictionaryType` accepte un **chemin dotté** dans la réponse (`setting.state.resource`, `setting.tool`, `country`, …) au lieu de l'ancien slug pluriel inopérant. Un message d'aide explicite est renvoyé si le chemin n'existe pas (avec rappel : "states/resources" → "setting.state.resource").
- **Ressources MCP recalibrées** — la liste exposée reflète désormais ce qui existe vraiment côté API. Slugs supprimés (404 garanti) : `states/absences`, `typeOf/candidates`, `typeOf/actions`, `typeOf/absences`. Slugs ajoutés (utiles aux prompts staffing/skills) : `tools`, `expertiseAreas`, `experiences`, `activityAreas`, `mobilityAreas`. Total ressources : **21** (vs 20 en 1.7.2).

### Ajouté

- **Cache mémoire du dictionnaire** (`src/services/dictionary.ts`) — la réponse `/application/dictionary` est volumineuse (centaines de Ko) et stable. Elle est désormais récupérée **une seule fois par process** (TTL configurable via `BOOND_DICTIONARY_TTL_MS`, défaut 1h), avec déduplication des appels concurrents (un seul fetch en parallèle pour N reads simultanés au démarrage de session). Erreurs réseau ne polluent pas le cache (le prochain appel re-tente). Tests : `src/services/dictionary.test.ts` couvre cache hit, force-refresh, expiration TTL, dedup concurrent, retry après échec, et résolution de chemin (segments imbriqués, paths inconnus, paths vides). Service exporté `resetDictionaryCacheForTests()` pour les tests qui en ont besoin.

### Aucune rupture

- Les 156 outils, 11 prompts, schémas Zod et endpoints autres que `/application/dictionary` sont strictement inchangés. Côté UX : l'outil `boond_application_dictionary` accepte le même nom de paramètre (`dictionaryType`) — seules les valeurs valides changent (dotté plutôt que slash).

## [1.7.2] - 2026-05-02

Hotfix critique du bundle `.mcpb` (bloquant depuis la 1.6.0) et amélioration ergonomique des prompts (saisie par nom au lieu de l'ID).

### Corrigé

- **`.mcpbignore`** — le pattern `src/` (non ancré) excluait **récursivement** tous les dossiers `src/` du bundle, y compris `node_modules/real-require/src/index.js`. Or `real-require` est une dépendance transitive de **Pino** (logger structuré introduit en 1.6.0) et son `package.json` pointe `main: "src/index.js"` — donc dès que Pino chargeait `real-require` au démarrage, `uncaughtException`, le process MCP mourait juste après avoir répondu à `initialize`. Symptôme côté Claude Desktop : `Server transport closed unexpectedly` immédiatement après la connexion, sans la moindre trace dans `mcp-server-*.log` (l'erreur partait dans `main.log`). Tous les patterns critiques sont désormais ancrés à la racine (`/src/`, `/tsconfig.json`, `/.github/`, `/coverage/`, `/.vscode/`, `/.idea/`, `/.claude/`, `/CLAUDE.md`, `/eslint.config.js`). Les patterns de fichiers (`*.test.ts`, `*.log`, `.env*`, etc.) restent intentionnellement non-ancrés. **Tous les utilisateurs ayant installé un `.mcpb` v1.6.0/1.7.0/1.7.1 sont concernés et doivent mettre à jour.**

### Ajouté

- **Résolution polymorphe ID / nom dans tous les prompts** (`src/prompts/index.ts`) — les arguments `manager_id`, `society_id`, `opportunity_id`, `resource_id`, `agency_id` acceptent désormais soit un ID numérique (comportement antérieur, inchangé), soit un libellé textuel (« Prénom Nom », nom de société, intitulé d'opportunité, nom d'agence). Quand l'entrée n'est pas numérique, le runbook injecte une étape préalable de résolution via le `*_search` correspondant (avec `keywords` + `pageSize: 5`) et utilise un placeholder (`<MANAGER_ID>`, `<SOCIETE_ID>`, …) que le LLM substitue par l'`id` retenu. Si plusieurs candidats matchent, le prompt demande confirmation à l'utilisateur. Couvre les 10 prompts qui prennent une référence d'entité ; `recap_hebdo` est inchangé (pas d'ID en entrée). Tests : 11 nouveaux cas dans `src/prompts/index.test.ts` couvrant chaque prompt + un test négatif vérifiant que les IDs numériques bypassent toujours la résolution. Aucun changement pour les anciens appels qui passaient un ID numérique.

### Aucune rupture

- Les 156 outils, 11 prompts existants, 20 ressources et schémas Zod sont strictement inchangés. Les noms d'arguments des prompts (`manager_id`, etc.) sont préservés — seule la sémantique d'entrée s'élargit.

## [1.7.1] - 2026-05-02

Patch metadata pour finaliser la publication de 1.7.0 sur le **MCP Registry** et **GHCR**. La 1.7.0 a bien été publiée sur **npm** et **GitHub Releases** (`.mcpb` attaché), mais les étapes suivantes du workflow ont échoué — corrigé ici. Aucun changement de comportement côté serveur (mêmes 156 outils, 11 prompts, 20 ressources).

### Corrigé

- `package.json`, `manifest.json`, `server.json` : la `description` introduite en 1.7.0 (`"... 156 tools, 11 prompts, 20 resources across 36 domains for ERP/CRM data"`, 104 caractères) dépassait la limite de **100 caractères** imposée par le MCP Registry (`mcp-publisher` rejet 422 `body.description: expected length <= 100`). Conséquence en 1.7.0 : la publication MCP Registry et la construction de l'image Docker (étapes ultérieures du job) n'avaient pas pu s'exécuter. 1.7.1 raccourcit la description à `"MCP Server for BoondManager API - 156 tools, 11 prompts, 20 resources (ERP/CRM)"` (79 caractères) et republie l'ensemble (npm + GitHub Release + .mcpb + MCP Registry + GHCR).

### Note

- Pour les utilisateurs ayant déjà installé 1.7.0 via npm ou via le bundle Claude Desktop, **aucune action n'est requise** — le code et les outils sont strictement identiques entre 1.7.0 et 1.7.1, seules les chaînes de description des manifestes changent.

## [1.7.0] - 2026-05-02

Release axée sur les **workflows ressources / staffing** et l'**observabilité de l'API BoondManager**. Cinq nouveaux prompts MCP couvrent les usages quotidiens des managers et chargés de staffing, et un système de monitoring hebdomadaire détecte les évolutions de l'API officielle pour anticiper les ruptures côté serveur.

### Ajouté

- **5 nouveaux prompts MCP staffing & compétences** (`src/prompts/index.ts`) — passe de 6 à **11 prompts** pré-orchestrés :
  - `staffing_disponible` — qui est dispo bientôt, avec quelles compétences, sur quel périmètre.
  - `fin_de_mission` — détecte les missions qui se terminent dans les N prochaines semaines pour préparer le re-staffing.
  - `cartographie_competences` — recense les compétences de l'équipe (CV + skills déclarées) et les croise avec un périmètre manager / agence.
  - `cvs_a_mettre_a_jour` — repère les consultants dont le CV est ancien ou incomplet pour un audit qualité.
  - `recherche_profil_competences` — recherche multi-sources (resources + candidates) avec scoping manager / agence et gestion de la disponibilité.
  Chaque prompt utilise les filtres officiels (`perimeterDynamic`, `perimeterManagers`, `available`, `keywordsType: titleSkills`, etc.) — le serveur fournit le runbook, le LLM exécute. Catalogue auto-régénéré dans `TOOLS.md` (11 prompts).
- **Système de monitoring de l'API BoondManager** (`.github/workflows/api-monitor.yml`) — workflow GitHub Actions hebdomadaire (lundis 9h UTC) qui scrappe la documentation officielle (`https://doc.boondmanager.com/api-externe/raml-build/`), compare avec le snapshot précédent (`.github/api-snapshot.json`), et **ouvre une issue GitHub automatiquement** si de nouvelles ressources / paramètres sont détectés. Permet d'anticiper les changements amont avant qu'ils ne cassent les schémas Zod côté serveur. Le workflow dépose aussi des artefacts (snapshot brut + diff) pour audit. Workflow de test (`api-monitor.test.yml`) déclenchable manuellement pour valider le scraper sans bruit dans les issues. Documentation complète dans `.github/API_MONITORING.md`, `.github/ARCHITECTURE.md` et `.github/DEPLOYMENT_CHECKLIST.md`.
- **Script de test local du monitor** (`scripts/test-api-monitor.cjs`) — exécutable hors CI (`npm run api:monitor:test` / `--save`) pour itérer sur le scraper sans pousser à GitHub.

### Corrigé

- **Robustesse du scraper API** (`api-monitor.yml` + `api-monitor.test.yml`) — gestion explicite des HTTP 403 renvoyés par Cloudflare/WAF lors d'exécutions depuis des IPs filtrées. Ajout de headers HTTP réalistes (User-Agent, Accept, Accept-Language) pour traverser la protection, détection du header `cf-ray` pour identifier un blocage Cloudflare, sortie propre avec message informatif au lieu d'un échec silencieux. Timeout passé de 10 s à 30 s pour absorber la latence du site officiel.

### Améliorations internes

- **Documentation README** — section "Prompts" enrichie avec la liste complète des 11 prompts, instructions d'invocation et exemples d'usage côté client MCP.
- **Permissions GitHub Actions explicites** — `api-monitor.test.yml` déclare désormais `permissions: { contents: read }` (alerte CodeQL résolue).
- **Mises à jour de dépendances** (Dependabot, sans rupture) :
  - `actions/checkout@4 → 6`, `actions/upload-artifact@4 → 7`
  - `docker/setup-qemu-action@3 → 4`, `docker/login-action@3 → 4`, `docker/build-push-action@6 → 7`
  - groupe `dev-dependencies` (3 paquets) — TypeScript-eslint et outils de test alignés.

### Aucune rupture

- Les 156 outils, 6 prompts existants, 20 ressources et schémas Zod sont strictement inchangés. Les 5 nouveaux prompts s'ajoutent et n'écrasent rien.
- Le système de monitoring est **purement observationnel** : aucun appel sortant supplémentaire à l'API BoondManager depuis le serveur MCP, aucune dépendance d'exécution ajoutée — tout vit dans `.github/` et `scripts/`.

## [1.6.0] - 2026-04-26

Release axée sur l'**ergonomie développeur, la qualité du code et la robustesse en production**. Ajout du formatage automatique, d'un logger structuré pour l'observabilité, de validations strictes sur les métadonnées MCP, et d'un plafond de pagination pour éviter les requêtes excessives.

### Ajouté

- **Prettier + Husky + lint-staged** — formatage automatique du code (TypeScript, JSON) au commit via pre-commit hooks. Configuration : 2 espaces, single quotes, trailing commas ES5, pas de point-virgule sauf nécessaire. Commandes : `npm run format`, `npm run format:check`.
- **Logger structuré (Pino)** — journalisation structurée avec niveaux configurables (`LOG_LEVEL`: trace/debug/info/warn/error/fatal) et formats (`LOG_FORMAT`: json/pretty). Chaque requête HTTP reçoit un `corrId` (8 hex) pour tracer les appels dans la stack. Utilisé dans le transport HTTP pour loguer les requêtes/réponses et les erreurs. Implementation : `src/services/logger.ts`.
- **Validation des longueurs de descriptions** — tests automatiques (`src/tools/descriptions.test.ts`) qui vérifient que les descriptions MCP ne dépassent pas les limites : tools ≤2000 chars, prompts ≤3000 chars, resources ≤1000 chars. Garde-fou contre la dilution du contexte LLM. Fait échouer la CI si une description est trop longue.
- **Plafond de pagination sur les recherches** — `MAX_SEARCH_PAGE = 100` (configurable dans `src/constants.ts`). À 500 résultats/page, page 100 = 50 000 enregistrements — au-delà, le modèle doit affiner les filtres au lieu d'itérer indéfiniment. Les schémas Zod rejettent `page > MAX_SEARCH_PAGE` à la validation d'entrée avec un message d'erreur clair. Rationale documentée dans `CLAUDE.md`.
- **Utilisation de `package.json` pour `SERVER_VERSION`** — le transport HTTP lit la version depuis `package.json` plutôt qu'une constante codée en dur. Une seule source de vérité pour la version du serveur.

### Amélioré

- **Documentation développeur** — section "Search Pagination Limits" ajoutée dans `CLAUDE.md` expliquant le pourquoi du plafond (éviter les spirales de pagination avec `openWorldHint: true`) et comment ça marche (validation Zod côté client).
- **Couverture de tests** — 4 nouveaux tests pour les limites de descriptions (tools, prompts, resources) + 1 test pour la validation de `MAX_SEARCH_PAGE`.

### Aucune rupture

- Les outils, prompts et ressources existants sont inchangés — les descriptions qui respectaient déjà les limites passent sans modification.
- Le comportement de recherche reste identique pour les requêtes ≤100 pages — la limite n'affecte que les cas extrêmes (non-filtrés ou trop larges).

## [1.5.3] - 2026-04-26

Patch metadata pour finaliser la publication de 1.5.2 sur le MCP Registry
et GHCR. La 1.5.2 a bien été publiée sur **npm** et **GitHub Releases**
(`.mcpb` attaché), mais les étapes suivantes du workflow ont échoué à
cause d'un format de schéma incompatible dans `server.json` — résolu ici.
Aucun changement de comportement côté serveur.

### Corrigé

- `server.json` : `icons[].sizes` était une chaîne (`"128x128"`), le
  binaire `mcp-publisher` (Go) attend un tableau de chaînes
  (`["128x128"]`). Le JSON Schema MCP Registry tolérait les deux formes,
  pas le publisher. Conséquence en 1.5.2 : la publication MCP Registry
  et la construction de l'image Docker (étapes ultérieures) n'avaient
  pas pu s'exécuter. 1.5.3 republie l'ensemble (npm + GitHub Release
  +.mcpb + MCP Registry + GHCR) avec la correction.

### Note

- Pour les utilisateurs ayant déjà installé 1.5.2 via npm ou via le
  bundle Claude Desktop, **aucune action n'est requise** — le code et
  les outils sont strictement identiques entre 1.5.2 et 1.5.3, seule la
  forme du fichier de métadonnées MCP Registry change.

## [1.5.2] - 2026-04-26

Release principalement orientée **distribution, ergonomie pour le LLM et
qualité d'exploitation**. Aucune rupture sur les outils existants — les
six schémas de recherche corrigés en 1.5.1 sont conservés tels quels. Les
nouveautés ci-dessous s'ajoutent par-dessus.

### Ajouté

- **Prompts MCP pré-orchestrés** (`src/prompts/`) — 6 templates qui
  enchaînent les bons appels d'outils avec les bons filtres officiels
  (`perimeterDynamic`, `perimeterManagers`, `period`, etc.) :
  `synthese_equipe`, `pipeline_commercial`, `factures_a_relancer`,
  `candidats_pour_opportunite`, `fiche_consultant`, `recap_hebdo`.
  Visible comme slash-command dans les clients qui supportent les
  prompts MCP. Le serveur n'exécute rien — il fournit le runbook au
  modèle.
- **Ressources MCP (dictionnaires)** (`src/resources/`) — 19 ressources
  statiques sous `boond://dictionary/*` (états + types pour les six
  domaines de recherche, plus pays / devises / langues) et
  `boond://application/current-user`. Permet au modèle de traduire un
  `state` ou `typeOf` entier en libellé via une lecture de ressource
  plutôt qu'un appel d'outil. Mime-type `application/json`.
- **Image Docker multi-arch sur GHCR** —
  `ghcr.io/fauguste/boondmanager-mcp-server` publiée à chaque tag
  (`linux/amd64` + `linux/arm64`) avec provenance et SBOM. Démarre par
  défaut en transport HTTP sur `0.0.0.0:3000`. Tags `:X.Y.Z`, `:X.Y`,
  `:X`, `:latest`.
- **Listing Smithery** (`smithery.yaml` à la racine) — config
  d'installation un-clic avec UI pour les 7 paramètres d'auth Boond.
  Synchronisé à chaque push sur `main`.
- **`SECURITY.md`** — politique de divulgation responsable, canal
  privilégié = GitHub Security Advisory privé, tableau des versions
  supportées, scope in/out, garanties sur la gestion des credentials
  (env vars uniquement, aucune persistance, aucun log).
- **Catalogue d'outils auto-généré** (`TOOLS.md`) — 156 outils, 6
  prompts, 20 ressources groupés par domaine (alphabétique). Régénéré
  via `npm run docs:tools`. Une étape CI (`npm run docs:tools:check`)
  fait échouer le build si le catalogue dérive du code source.
- **Documentation distribution** (`docs/distribution.md`) — source
  unique de vérité pour ce qui est publié où (npm, MCP Registry,
  GitHub Releases .mcpb, GHCR, LobeHub, Smithery), comment chaque canal
  est synchronisé, et la checklist post-release en 6 points.
- **`CHANGELOG.md`** — nouvelles entrées en français,
  systématiquement extraites par le workflow Release pour le corps de
  la GitHub Release.
- **Métadonnées `server.json`** — `title`, `websiteUrl`, `repository`,
  `icons[]` (logo via `raw.githubusercontent.com`) pour enrichir la
  fiche MCP Registry et les marketplaces qui en découlent (LobeHub).
- **README** — sections "Ressources MCP", "Prompts pré-orchestrés",
  exemple Docker GHCR, mention Smithery / LobeChat.

### Modifié

- **Messages d'erreur API** (`src/services/boond-client.ts`) — sur
  réponse non-2xx, `parseBoondErrorBody()` extrait `errors[].detail`
  (et `title` quand distinct) du JSON:API d'erreur de Boond, et
  `formatApiError()` produit un message focalisé avec un *hint*
  spécifique par statut (401/403/404/422/429/5xx). Le corps brut n'est
  inclus qu'en repli quand le parsing échoue. Avant : ~500 caractères de
  JSON brut illisibles ; après : `BoondManager API 422 …: 422 -
  password mismatch` + diagnostic.
- **Licence** — passage de **MIT à Apache-2.0**. Voir `LICENSE` et le
  nouveau `NOTICE`. Aucune action utilisateur requise pour les binaires
  déjà installés ; les futurs forks doivent intégrer le `NOTICE`.

### Documentation interne

- **`CLAUDE.md`** rafraîchi — section "Search Filter Naming (CRITICAL)"
  qui cristallise la table de correspondance officielle
  (`mainManagers → perimeterManagers`, `states → resourceStates / candidateStates / opportunityStates / projectStates / typesOf` selon
  l'endpoint, vocabulaire `period` par endpoint, préfixes `keywords`
  `CSOC<id>` / `CCON<id>` / etc.) pour qu'aucun futur agent ne
  redécouvre les noms à tâtons. Sections "Adding a Prompt" et "Adding
  a Resource" ajoutées, "CI/CD" mis à jour avec les 4 publications de
  release et le drift check du catalogue.

### CI/CD

- **`docs:tools:check`** branché dans le workflow CI (Node 22) — toute
  PR qui ajoute / renomme / supprime un tool, prompt ou ressource doit
  régénérer `TOOLS.md` (le check fait échouer le build sinon).
- **Workflow Release étendu** — étapes Docker (QEMU + Buildx + login
  GHCR + build-push multi-arch) en plus des publications npm + MCP
  Registry + GitHub Release existantes.

## [1.5.1] - 2026-04-25

Correctif critique des filtres de recherche structurés introduits en 1.5.0 (#29).
Les filtres étaient silencieusement ignorés par l'API BoondManager parce que les
noms de champs en entrée ne correspondaient pas à la spec officielle RAML
(https://doc.boondmanager.com/api-externe/). Les six outils de recherche —
resources, candidates, contacts, companies, opportunities, projects — ont été
vérifiés en direct sur un tenant réel après cette correction : tous les filtres
annoncés s'appliquent désormais.

### Corrigé
- `boond_resources_search`, `boond_candidates_search`, `boond_contacts_search`,
  `boond_companies_search`, `boond_opportunities_search`,
  `boond_projects_search` : les paramètres d'entrée correspondent maintenant
  exactement aux noms attendus par l'API. Avant, le schéma acceptait des noms
  comme `mainManagers`, `states`, `agencies`, `poles`, `businessUnits`,
  `skills`, `typeOf`, `company`, `contact` que l'API n'honorait jamais —
  chaque appel renvoyait le total non filtré.

### Modifié (rupture sur les inputs des 6 outils de recherche)
- Filtres manager / agence / pôle / BU renommés et unifiés sur les six
  endpoints (issus du trait RAML partagé `searchable`) :
  - `mainManagers` → `perimeterManagers` (IDs entiers)
  - `agencies` → `perimeterAgencies` (IDs entiers)
  - `poles` → `perimeterPoles` (IDs entiers)
  - `businessUnits` → `perimeterBusinessUnits` (IDs entiers)
  - nouveau `perimeterDynamic` (`["data"|"managers"|"agencies"|"poles"|"businessUnits"]`)
    pour cibler « mes données / mes N-1 / mes agences » sans avoir à
    récupérer son propre userId au préalable
  - nouveau `narrowPerimeter` (booléen) : passe les jointures `perimeter*`
    en ET au lieu du OU par défaut
- Filtres états / types renommés par endpoint pour coller à l'API (IDs
  entiers issus de `boond_application_dictionary`) :
  - resources : `states` → `resourceStates`, `typeOf` → `resourceTypes`,
    plus `excludeResourceStates` / `excludeResourceTypes`
  - candidates : `states` → `candidateStates`, `typeOf` → `candidateTypes`
  - opportunities : `states` → `opportunityStates`,
    `typeOf` → `opportunityTypes`
  - projects : `states` → `projectStates`, `typeOf` → `projectTypes`
  - contacts : `typeOf` → `typesOf` (avec un `s` final) ; `states` et
    `companyStates` conservés
  - companies : `states` conservé ; le filtre `typeOf` retiré car
    l'endpoint `/companies` ne le supporte pas en search
- Filtres relationnels : `company` / `contact` (singulier) remplacés par
  `companies` (tableau pluriel, projets seulement) ou par la syntaxe de
  préfixe documentée dans `keywords` (`CSOC<id>`, `CCON<id>`, `CAND<id>`,
  `COMP<id>`, `AO<id>`, `PROD<id>`, `CTR<id>`, `MIS<id>`, `PRJ<id>`)
- Vocabulaire de `period` aligné sur l'API par endpoint (ex. `running`,
  `created`, `started`, `closed`, `available`, `working`, `closingDate`,
  `updatedPositioning`, `withActions`, `withoutActions`, `noAction`, …) —
  l'ancienne enum `creation`/`update`/`startDate`/`endDate` était fausse
- Pagination : `MAX_PAGE_SIZE` passé de 100 à 500 (limite officielle de
  l'API) et `DEFAULT_PAGE_SIZE` de 20 à 30 (défaut officiel)

### Ajouté
- `keywordsType` sur resources / candidates / contacts / companies — permet
  de cibler un champ précis pour la recherche texte (`lastName`,
  `firstName`, `fullName` avec `"NOM#PRENOM"`, `emails`, `phones`, `title`,
  `titleSkills`, `reference`, `resume`, `td`, `socialNetworks`, …).
  Auparavant, la recherche se faisait par défaut dans le CV uniquement,
  sans moyen de surcharger.
- Recherche géographique sur resources et candidates : `coordinates`
  (`"lat,lon"`) ou `location` (adresse libre) combinés à `geoDistance`
  (5–200 km)
- Mode ET pour `tools` : préfixer le tableau par `"#AND#"` pour exiger
  tous les outils listés (par défaut : OU)
- Nouveaux filtres branchés sur l'API :
  - resources : `expertiseAreas`, `experiences`, `trainings`,
    `mobilityAreas`, `languages` (`langueId|niveauId`), `flags`,
    `providerCompanies`, `excludeManager`, `shields`
  - candidates : `expertiseAreas`, `experiences`, `trainings`,
    `mobilityAreas`, `languages`, `flags`, `evaluations`, `sources`,
    `availabilityTypes`, `contractTypes`, `providerCompanies`, `shields`,
    `perimeterManagersType` (`"main"|"hr"`)
  - contacts : `expertiseAreas`, `tools`, `influencers`, `flags`,
    `completeness` (ex. `["email:empty","phone:empty"]`), `shields`
  - companies : `expertiseAreas`, `origins`, `influencers`, `flags`,
    `shields`
  - opportunities : `expertiseAreas`, `tools`, `places`, `durations`,
    `origins`, `flags`, `positioningStates`, `shields`,
    `perimeterManagersType`
  - projects : `expertiseAreas`, `flags`
- Descriptions des six outils de recherche réécrites avec des exemples
  d'appel concrets (mes données / mon équipe, par état, par période, par
  entité liée) pour que le modèle choisisse le bon filtre du premier coup

### Notes
- La validation `strict` est conservée sur chaque schéma de recherche : tout
  appelant qui passerait encore l'ancien nom (`mainManagers`, `agencies`,
  etc.) recevra un rejet clair plutôt qu'un résultat silencieusement non
  filtré.
- Les 274 tests unitaires existants passent ; la vérification en direct sur
  un tenant réel confirme que chaque filtre restreint bien les résultats.

## [1.5.0] - 2026-04-24

### Ajouté
- Schémas Zod structurés pour les recherches resources, candidates,
  contacts, companies, opportunities, projects, avec champs typés (#29)
- Sérialisation des paramètres tableau en notation `key[]=v1&key[]=v2`
- `registerSearchTool` accepte désormais des overrides schema / title /
  description

### Note
- Les filtres structurés introduits en 1.5.0 ne s'appliquaient pas
  réellement sur l'API BoondManager (mauvais noms de paramètres).
  Utiliser 1.5.1 — c'est la version qui rend opérationnel le design des
  filtres de 1.5.0.
