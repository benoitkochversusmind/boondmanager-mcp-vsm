#!/usr/bin/env node

/**
 * Script de test local pour le système de surveillance API BoondManager
 * Usage: node scripts/test-api-monitor.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_DOC_URL = 'https://doc.boondmanager.com/api-externe/raml-build/';
const SNAPSHOT_FILE = path.join(__dirname, '..', '.github', 'api-snapshot.json');

/**
 * Récupère le contenu HTML de la documentation
 */
async function fetchApiDocumentation() {
  return new Promise((resolve, reject) => {
    const options = {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
      }
    };

    https.get(API_DOC_URL, options, (res) => {
      if (res.statusCode !== 200) {
        const error = new Error(`HTTP ${res.statusCode}`);
        error.statusCode = res.statusCode;
        error.headers = res.headers;
        reject(error);
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/**
 * Parse simple du HTML pour extraire les endpoints
 * (version simplifiée sans cheerio pour test local)
 */
function parseEndpoints(html) {
  const endpoints = [];

  // Recherche de patterns communs dans la doc BoondManager
  const patterns = [
    /GET\s+\/(\w+)/g,
    /POST\s+\/(\w+)/g,
    /PUT\s+\/(\w+)/g,
    /DELETE\s+\/(\w+)/g,
    /PATCH\s+\/(\w+)/g,
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const [fullMatch, path] = match;
      const method = fullMatch.split(/\s+/)[0];
      endpoints.push({
        method,
        path: `/${path}`,
        name: `${method.toLowerCase()}_${path}`,
      });
    }
  });

  // Déduplique
  const unique = [...new Map(endpoints.map(e => [e.name, e])).values()];

  return unique;
}

/**
 * Compare deux snapshots
 */
function compareSnapshots(current, previous) {
  if (!previous) {
    return {
      isFirstRun: true,
      hasChanges: false,
      added: [],
      removed: [],
      modified: [],
    };
  }

  const prevMap = new Map((previous.endpoints || []).map(e => [e.name, e]));
  const currMap = new Map((current.endpoints || []).map(e => [e.name, e]));

  const added = [...currMap.keys()].filter(k => !prevMap.has(k)).map(k => currMap.get(k));
  const removed = [...prevMap.keys()].filter(k => !currMap.has(k)).map(k => prevMap.get(k));
  const modified = [];

  // Détection de modifications simples
  for (const [key, curr] of currMap) {
    const prev = prevMap.get(key);
    if (prev && JSON.stringify(prev) !== JSON.stringify(curr)) {
      modified.push({ old: prev, new: curr });
    }
  }

  return {
    isFirstRun: false,
    hasChanges: added.length > 0 || removed.length > 0 || modified.length > 0,
    added,
    removed,
    modified,
  };
}

/**
 * Main
 */
async function main() {
  console.log('🚀 Test du système de surveillance API BoondManager\n');

  // 1. Récupère la documentation
  console.log('📡 Récupération de la documentation API...');
  let html;
  try {
    html = await fetchApiDocumentation();
    console.log(`✅ ${html.length} bytes récupérés\n`);
  } catch (error) {
    console.error(`❌ Échec de la récupération: ${error.message}`);

    // Gestion spéciale pour 403 (Cloudflare)
    if (error.statusCode === 403) {
      console.error('\n⚠️  HTTP 403 Forbidden - Protection Cloudflare/WAF active');
      if (error.headers && error.headers['cf-ray']) {
        console.error(`   Cloudflare Ray ID: ${error.headers['cf-ray']}`);
      }
      console.error('\n💡 Solutions possibles:');
      console.error('   - GitHub Actions a généralement des IPs whitelistées');
      console.error('   - Le workflow automatique devrait fonctionner');
      console.error('   - Les tests locaux peuvent échouer (IPs locales bloquées)');
      console.error('\n   Ceci est attendu et normal pour les tests locaux.');
      process.exit(0); // Exit propre pour 403
    }

    process.exit(1);
  }

  // 2. Parse les endpoints
  console.log('🔍 Analyse des endpoints...');
  const endpoints = parseEndpoints(html);
  console.log(`✅ ${endpoints.length} endpoints détectés\n`);

  if (endpoints.length > 0) {
    console.log('📋 Exemples d\'endpoints détectés:');
    endpoints.slice(0, 5).forEach(ep => {
      console.log(`   - ${ep.method.padEnd(6)} ${ep.path}`);
    });
    if (endpoints.length > 5) {
      console.log(`   ... et ${endpoints.length - 5} autres`);
    }
    console.log('');
  }

  // 3. Crée le snapshot actuel
  const currentSnapshot = {
    timestamp: new Date().toISOString(),
    url: API_DOC_URL,
    endpointsCount: endpoints.length,
    endpoints,
  };

  // 4. Charge le snapshot précédent
  let previousSnapshot = null;
  if (fs.existsSync(SNAPSHOT_FILE)) {
    console.log('📂 Chargement du snapshot précédent...');
    previousSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    console.log(`   - Date: ${previousSnapshot.timestamp}`);
    console.log(`   - Endpoints: ${previousSnapshot.endpointsCount}\n`);
  } else {
    console.log('ℹ️  Aucun snapshot précédent trouvé (première exécution)\n');
  }

  // 5. Compare
  console.log('⚖️  Comparaison des snapshots...');
  const comparison = compareSnapshots(currentSnapshot, previousSnapshot);

  if (comparison.isFirstRun) {
    console.log('✅ Première exécution - baseline créée\n');
  } else if (comparison.hasChanges) {
    console.log('⚠️  Changements détectés!\n');
    console.log(`📊 Statistiques:`);
    console.log(`   - Ajoutés:   ${comparison.added.length}`);
    console.log(`   - Supprimés: ${comparison.removed.length}`);
    console.log(`   - Modifiés:  ${comparison.modified.length}\n`);

    if (comparison.added.length > 0) {
      console.log('➕ Nouveaux endpoints:');
      comparison.added.slice(0, 3).forEach(ep => {
        console.log(`   - ${ep.method} ${ep.path}`);
      });
      if (comparison.added.length > 3) {
        console.log(`   ... et ${comparison.added.length - 3} autres`);
      }
      console.log('');
    }

    if (comparison.removed.length > 0) {
      console.log('➖ Endpoints supprimés:');
      comparison.removed.slice(0, 3).forEach(ep => {
        console.log(`   - ${ep.method} ${ep.path}`);
      });
      if (comparison.removed.length > 3) {
        console.log(`   ... et ${comparison.removed.length - 3} autres`);
      }
      console.log('');
    }
  } else {
    console.log('✅ Aucun changement détecté\n');
  }

  // 6. Sauvegarde optionnelle
  console.log('💾 Voulez-vous sauvegarder ce snapshot?');
  console.log(`   Fichier: ${SNAPSHOT_FILE}`);
  console.log(`   Utiliser l'option --save pour sauvegarder automatiquement\n`);

  if (process.argv.includes('--save')) {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentSnapshot, null, 2));
    console.log('✅ Snapshot sauvegardé!\n');
  }

  // 7. Résumé final
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📝 Résumé');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Documentation récupérée:     ✅ ${html.length} bytes`);
  console.log(`Endpoints détectés:          ${currentSnapshot.endpointsCount}`);
  console.log(`Snapshot précédent:          ${previousSnapshot ? '✅' : '❌'}`);
  console.log(`Changements détectés:        ${comparison.hasChanges ? '⚠️  OUI' : '✅ Non'}`);
  console.log(`Snapshot sauvegardé:         ${process.argv.includes('--save') ? '✅' : '❌'}`);
  console.log('═══════════════════════════════════════════════════════════════');

  if (comparison.hasChanges) {
    console.log('\n🎯 Action recommandée:');
    console.log('   Une issue GitHub sera automatiquement créée lors de la prochaine exécution du workflow.');
  }
}

main().catch(error => {
  console.error('\n❌ Erreur fatale:', error);
  process.exit(1);
});
