const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
let compression = null;
try {
  compression = require('compression');
} catch (e) {
  compression = null;
}

const app = express();
app.use(cors());
if (compression) app.use(compression());
// Global limit reduced to 1mb to prevent OOM
app.use(express.json({ limit: '1mb' }));
// Specific high-limit parser for admin routes only
const adminJsonParser = express.json({ limit: '50mb' });

const DATA_DIR = path.join(__dirname, 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const UPLOAD_TMP_DIR = path.join(DATA_DIR, '.tmp');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ENV_FILE = path.join(__dirname, '..', '.env');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(ENV_FILE);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_TMP_DIR)) fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

let savedConfig = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch (e) {
  savedConfig = {};
}

const defaultContext = {
  maxItems: 20,
  upsetItems: 8,
  optimizerItems: 5,
  titleSeedCutoff: 2,
  includeTeamProfiles: true,
  includeOptimizer: true,
  includeTitleAngles: true,
  autoOptimize: true,
};

const cfg = {
  adminPassword: process.env.ADMIN_PASSWORD || savedConfig.adminPassword || 'changeme2026',
  provider: process.env.LLM_PROVIDER || savedConfig.provider || 'deepseek',
  apiKey: process.env.LLM_API_KEY || savedConfig.apiKey || '',
  model: process.env.LLM_MODEL || savedConfig.model || '',
  temperature: parseFloat(process.env.LLM_TEMPERATURE || savedConfig.temperature || 0.7),
  maxTokens: parseInt(process.env.LLM_MAX_TOKENS || savedConfig.maxTokens || 1200, 10),
  brandName: savedConfig.brandName || 'BracketGPT',
  tagline: savedConfig.tagline || 'v5.3 ENSEMBLE · 2,278 ALL-PAIRS PREDICTIONS · KENPOM + ARCHETYPES',
  activeSeason: savedConfig.activeSeason || 2026,
  messagesPerMinute: parseInt(savedConfig.messagesPerMinute || 30, 10),
  weights: savedConfig.weights || { baseWeight: 0.6, upsetWeight: 0.25, floorWeight: 0.15 },
  features: savedConfig.features || {
    showTeamProfiles: true,
    showMatchupData: true,
    showOptimizerData: true,
    showUpsetPicks: true,
    showSafetyScores: true,
    includeHistoricalContext: true,
  },
  context: { ...defaultContext, ...(savedConfig.context || {}) },
};

function saveCfg() {
  try {
    // Atomic write: write to temp file first, then rename
    const tmpFile = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmpFile, CONFIG_FILE);
  } catch (e) {
    // noop
  }
}

saveCfg();

const store = {
  teams: null,
  humanSummaries: null,
  base: null,
  upset: null,
  floor: null,
  optimizer: null,
  bracket: null,
  context: null,
  bracket2025: null,
  ev: null,
  poolStrategy: null,
  seedMatchups: null,
  bracketMatchups: null,
  bracketOutput: null,
};
const FILE_MAP = {
  teams: ['team_profiles_2026.json', 'team_profiles_2025.json'],
  humanSummaries: ['team_human_summaries_2026.json', 'team_human_summaries_2025.json', 'team_human_summaries.json'],
  base: ['chatbot_predictions_v5.json'],
  upset: ['chatbot_predictions_v5.json'],
  floor: ['chatbot_predictions_v5.json'],
  optimizer: ['archetype_history.json'],
  bracket: ['bracket_predictions_2026.json', 'bracket_predictions_2025.json', 'bracket_predictions.json'],
  bracket2025: ['bracket_2026.json', 'bracket_2025.json'],
  ev: ['bracket_ev_espn.json'],
  poolStrategy: ['pool_strategy_2026.json', 'pool_strategy_2025.json', 'pool_strategy.json'],
  seedMatchups: ['historical/seed_matchup_all_rounds.json', 'seed_matchup_all_rounds.json'],
  bracketMatchups: ['bracketgpt_matchups_2026_v2.json', 'bracketgpt_matchups_2026_final.json', 'bracketgpt_matchups_2025_v2.json', 'bracketgpt_matchups_2025_final.json'],
  bracketOutput: ['bracketgpt_bracket_output_2026.json', 'bracketgpt_bracket_output_2025.json'],
  context: ['context_2026.json', 'context_2025.json', 'context.json'],
};

const DATA_FILES = {
  predictions: 'chatbot_predictions_v5.json',
  bracket: 'bracket_2026.json',
  bracket_ready: 'bracket_ready_2026.json',
  bracket_cache: 'bracket_cache_2026.json',
  bracket_output: 'bracketgpt_bracket_output_2026.json',
  team_profiles: 'team_profiles_2026.json',
  seed_matchups: 'seed_matchup_all_rounds.json',
  archetype_summary: 'archetype_summary_v5.json',
  archetype_history: 'archetype_history.json',
  kenpom_csv: 'kenpom_2026.csv',
  espn_public_csv: 'espn_peoples_bracket_2026.csv',
  team_round_probs_csv: 'bracket_tree_exact_probabilities_2026.csv',
  team_round_probs_json: 'bracket_probabilities_with_yahoo_corrected_2026.json',
};
const CSV_UPLOAD_TYPES = new Set(['kenpom_csv', 'espn_public_csv', 'team_round_probs_csv']);
const TEAM_MAPPING_FILE = 'team_name_mapping_2026.json';

const REGION_ORDER_2026 = ['South', 'East', 'West', 'Midwest'];
const FINAL_FOUR_PAIRINGS_2026 = [['South', 'East'], ['West', 'Midwest']];
const bracketReadyPath = path.join(DATA_DIR, DATA_FILES.bracket_ready);
let bracketReady = null;

function loadBracketReady() {
  try {
    if (fs.existsSync(bracketReadyPath)) {
      bracketReady = JSON.parse(fs.readFileSync(bracketReadyPath, 'utf8'));
      console.log(`Loaded bracket_ready_2026.json: ${bracketReady?.matchups?.length || 0} matchups, ${Object.keys(bracketReady?.team_directory || {}).length} teams`);
    } else {
      bracketReady = null;
      console.warn('bracket_ready_2026.json not found in', DATA_DIR);
    }
  } catch (e) {
    bracketReady = null;
    console.error('Failed to load bracket_ready_2026.json:', e.message);
  }
}

const dataStore = {};

const historicalIndex = {
  predictionsByTeam: new Map(),
  predictionsBySeed: new Map(),
  teamNames: [],
  archetypeHistory: {},
  seedMatchups: {},
  contextCache: new Map(),
};

const bracketMatchupIndex = {
  byId: new Map(),
  byRegion: new Map(),
  byTeam: new Map(),
  regions: REGION_ORDER_2026.slice(),
  season: 2026,
};

function firstExistingFile(candidates) {
  for (const fileName of candidates) {
    const p = path.join(DATA_DIR, fileName);
    if (fs.existsSync(p)) return { fileName, path: p };
  }
  return null;
}

function loadData() {
  let anyLoaded = false;
  for (const [key, candidates] of Object.entries(FILE_MAP)) {
    const selected = firstExistingFile(candidates);
    try {
      if (selected) {
        store[key] = JSON.parse(fs.readFileSync(selected.path, 'utf8'));
        anyLoaded = true;
      } else {
        store[key] = null;
      }
    } catch (e) {
      store[key] = null;
    }
  }
  loadTeamAliasLookup();
  const v53Loaded = loadDataFiles();
  return anyLoaded || v53Loaded;
}

let teamAliasLookup = new Map();

function normalizeTeamNameBase(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/\./g, '')
    .replace(/&/g, ' and ')
    .replace(/\bsaint\b/gi, 'st')
    .replace(/\bstate\b/gi, 'st')
    .replace(/\buniversity\b/gi, 'univ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function loadTeamAliasLookup() {
  const out = new Map();
  const mappingPath = path.join(DATA_DIR, TEAM_MAPPING_FILE);
  try {
    if (!fs.existsSync(mappingPath)) {
      teamAliasLookup = out;
      return;
    }
    const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    const aliases = raw?.team_alias_mapping || {};
    for (const [canonicalRaw, aliasList] of Object.entries(aliases)) {
      const canonical = normalizeTeamNameBase(canonicalRaw);
      if (!canonical) continue;
      out.set(canonical, canonical);
      if (!Array.isArray(aliasList)) continue;
      for (const aliasRaw of aliasList) {
        const alias = normalizeTeamNameBase(aliasRaw);
        if (!alias || alias.length <= 2) continue;
        out.set(alias, canonical);
      }
    }
    teamAliasLookup = out;
  } catch (e) {
    console.warn(`Team mapping load failed (${TEAM_MAPPING_FILE}): ${e.message}`);
    teamAliasLookup = out;
  }
}

function syncDataStoreAliases() {
  dataStore.bracketStructure = dataStore.bracket || null;
  dataStore.bracketCache = dataStore.bracket_cache || dataStore.bracketCache || null;
  dataStore.teamProfiles = dataStore.team_profiles || null;
  dataStore.seedMatchups = dataStore.seed_matchups || null;
  dataStore.archetypeSummary = dataStore.archetype_summary || null;
  dataStore.archetypeHistory = dataStore.archetype_history || null;
  dataStore.teamRoundProbabilities = getActiveTeamRoundProbabilitiesPayload();
}

function loadDataFiles() {
  let anyLoaded = false;
  console.log('Loading data files...');
  for (const [key, filename] of Object.entries(DATA_FILES)) {
    const filepath = path.join(DATA_DIR, filename);
    try {
      if (fs.existsSync(filepath)) {
        const raw = fs.readFileSync(filepath, 'utf8');
        if (key === 'team_round_probs_json') {
          dataStore[key] = parseUploadedTeamRoundProbabilitiesJson(raw).parsed;
        } else {
          dataStore[key] = CSV_UPLOAD_TYPES.has(key)
            ? parseUploadedCsv(key, raw).parsed
            : JSON.parse(raw);
        }
        const size = (Buffer.byteLength(raw) / 1024 / 1024).toFixed(1);
        console.log(`  [ok] ${filename} loaded (${size}MB)`);
        anyLoaded = true;
      } else {
        console.log(`  [warn] ${filename} not found - skipping`);
        dataStore[key] = null;
      }
    } catch (e) {
      console.error(`  [err] ${filename} failed to parse: ${e.message}`);
      dataStore[key] = null;
    }
  }
  syncDataStoreAliases();
  console.log('Data loading complete.');
  return anyLoaded;
}

function parseUploadedJson(rawInput) {
  const raw = String(rawInput || '');

  // Fast path for valid JSON to avoid expensive regex passes on large payloads.
  try {
    return { parsed: JSON.parse(raw), normalized: raw, mode: 'fast_path' };
  } catch (fastErr) {
    // Fall through to lenient parsing attempts.
  }

  const attempts = [];

  function pushCandidate(label, text) {
    const candidate = String(text || '').trim();
    if (!candidate) return;
    attempts.push({ label, text: candidate });
  }

  // 1) Raw content (with BOM removed)
  const noBom = raw.replace(/^\uFEFF/, '').trim();
  pushCandidate('raw', noBom);

  // 2) Markdown code fence content (```json ... ```)
  const fence = noBom.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) pushCandidate('code_fence', fence[1]);

  // 3) Extract likely JSON block from wrapper text
  const firstObj = noBom.indexOf('{');
  const firstArr = noBom.indexOf('[');
  let first = -1;
  if (firstObj >= 0 && firstArr >= 0) first = Math.min(firstObj, firstArr);
  else first = Math.max(firstObj, firstArr);
  const lastObj = noBom.lastIndexOf('}');
  const lastArr = noBom.lastIndexOf(']');
  const last = Math.max(lastObj, lastArr);
  if (first >= 0 && last > first) pushCandidate('slice', noBom.slice(first, last + 1));

  // 4) Lenient cleanup for comments and trailing commas
  const cleaned = noBom
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
  pushCandidate('cleaned', cleaned);

  // 5) Tolerate common non-JSON literals from notebook exports.
  const normalizedLiterals = cleaned
    .replace(/\bNone\b/g, 'null')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNaN\b/g, 'null')
    .replace(/\b-?Infinity\b/g, 'null')
    .trim();
  pushCandidate('normalized_literals', normalizedLiterals);

  let lastErr = null;
  for (const a of attempts) {
    try {
      return { parsed: JSON.parse(a.text), normalized: a.text, mode: a.label };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Invalid JSON');
}

function pickFirstRoundProbability(source, candidates) {
  for (const key of candidates) {
    if (!source || source[key] == null) continue;
    const value = parsePercentMaybe(source[key]);
    if (Number.isFinite(Number(value))) return value;
  }
  return null;
}

function normalizeTeamRoundProbabilityRow(source) {
  const row = source && typeof source === 'object' ? source : {};
  return {
    R32: pickFirstRoundProbability(row, ['R32', 'round_32', 'roundof32']),
    S16: pickFirstRoundProbability(row, ['S16', 'Sweet16', 'sweet_16', 'roundof16']),
    E8: pickFirstRoundProbability(row, ['E8', 'Elite8', 'elite_8', 'roundof8']),
    F4: pickFirstRoundProbability(row, ['F4', 'Final4', 'final_4', 'finalfour']),
    NCG: pickFirstRoundProbability(row, ['NCG', 'TitleGame', 'title_game', 'championship_game', 'roundof2']),
    Championship: pickFirstRoundProbability(row, ['Championship', 'Champion', 'champion', 'Champ']),
  };
}

function normalizeTeamPublicRoundProbabilityRow(source) {
  const row = source && typeof source === 'object' ? source : {};
  const base =
    (row.yahoo_pick_pct && typeof row.yahoo_pick_pct === 'object' ? row.yahoo_pick_pct : null)
    || (row.yahoo_pick_percentages && typeof row.yahoo_pick_percentages === 'object' ? row.yahoo_pick_percentages : null)
    || (row.public_pick_pct && typeof row.public_pick_pct === 'object' ? row.public_pick_pct : null)
    || (row.public_round_probs && typeof row.public_round_probs === 'object' ? row.public_round_probs : null);
  if (!base) return null;
  const out = {
    R64: pickFirstRoundProbability(base, ['R64', '64', 'round_64', 'roundof64']),
    R32: pickFirstRoundProbability(base, ['R32', '32', 'round_32', 'roundof32']),
    S16: pickFirstRoundProbability(base, ['S16', '16', 'Sweet16', 'sweet_16', 'roundof16']),
    E8: pickFirstRoundProbability(base, ['E8', '8', 'Elite8', 'elite_8', 'roundof8']),
    F4: pickFirstRoundProbability(base, ['F4', '4', 'Final4', 'final_4', 'finalfour']),
    NCG: pickFirstRoundProbability(base, ['NCG', '2', 'TitleGame', 'title_game', 'championship_game', 'roundof2']),
    Championship: pickFirstRoundProbability(base, ['Championship', 'Champion', 'champion', 'Champ']),
  };
  const hasAny = Object.values(out).some((value) => Number.isFinite(Number(value)));
  return hasAny ? out : null;
}

function parseTeamRoundProbabilitiesFromJsonPayload(payload) {
  const parsedPayload = payload && typeof payload === 'object' ? payload : {};
  const teamRoundProbs = {};
  const teamPublicRoundProbs = {};
  const normalizedRows = [];

  const teamEntries = [];
  if (parsedPayload.team_round_probs && typeof parsedPayload.team_round_probs === 'object' && !Array.isArray(parsedPayload.team_round_probs)) {
    teamEntries.push(...Object.entries(parsedPayload.team_round_probs));
  }
  if (parsedPayload.teams && typeof parsedPayload.teams === 'object' && !Array.isArray(parsedPayload.teams)) {
    teamEntries.push(...Object.entries(parsedPayload.teams));
  }
  if (Array.isArray(parsedPayload.rows)) {
    for (const row of parsedPayload.rows) {
      const team = String(row?.team || row?.Team || row?.team_name || row?.school || row?.School || '').trim();
      if (!team) continue;
      teamEntries.push([team, row]);
    }
  }

  const seen = new Set();
  for (const [teamRaw, row] of teamEntries) {
    const team = String(teamRaw || '').trim();
    if (!team) continue;
    const teamKey = team.toLowerCase();
    const publicRow = normalizeTeamPublicRoundProbabilityRow(row);
    if (seen.has(teamKey)) {
      if (publicRow && !teamPublicRoundProbs[team]) teamPublicRoundProbs[team] = publicRow;
      continue;
    }
    const parsedRow = normalizeTeamRoundProbabilityRow(row);
    const hasRound = Object.values(parsedRow).some((value) => Number.isFinite(Number(value)));
    if (!hasRound) continue;
    teamRoundProbs[team] = parsedRow;
    if (publicRow) teamPublicRoundProbs[team] = publicRow;
    normalizedRows.push({ team, ...parsedRow });
    seen.add(teamKey);
  }

  if (!Object.keys(teamRoundProbs).length) {
    throw new Error('No team round probabilities detected in JSON. Expected teams/team_round_probs with R32/Sweet16/Elite8/Final4/TitleGame/Champion values.');
  }

  const validation = validateTeamRoundProbabilities(teamRoundProbs);
  return {
    rows: normalizedRows,
    team_round_probs: teamRoundProbs,
    team_public_round_probs: teamPublicRoundProbs,
    count: normalizedRows.length,
    validation,
    source: 'team_round_probs_json',
    metadata: parsedPayload.metadata || null,
  };
}

function parseUploadedTeamRoundProbabilitiesJson(rawInput) {
  const parsedJson = parseUploadedJson(rawInput);
  return {
    parsed: parseTeamRoundProbabilitiesFromJsonPayload(parsedJson.parsed),
    normalized: parsedJson.normalized,
    mode: `json:${parsedJson.mode}`,
  };
}

function getActiveTeamRoundProbabilitiesPayload() {
  const jsonPayload = dataStore.team_round_probs_json;
  if (Object.keys(jsonPayload?.team_round_probs || {}).length > 0) return jsonPayload;
  return dataStore.team_round_probs_csv || null;
}

function parseCsvRows(rawInput) {
  const raw = String(rawInput || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQuotes && raw[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i += 1;
      continue;
    }
    if (!inQuotes && (ch === ',' || ch === '\n' || ch === '\r')) {
      row.push(cell);
      cell = '';
      if (ch === ',') {
        i += 1;
        continue;
      }
      if (ch === '\r' && raw[i + 1] === '\n') i += 1;
      if (row.some((v) => String(v || '').trim() !== '')) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  row.push(cell);
  if (row.some((v) => String(v || '').trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).map((vals) => {
    const out = {};
    for (let idx = 0; idx < headers.length; idx += 1) {
      const key = headers[idx] || `col_${idx + 1}`;
      out[key] = String(vals[idx] ?? '').trim();
    }
    return out;
  });
}

function normalizeTextKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeCanonicalRoundKey(value) {
  const key = normalizeTextKey(value).replace(/\s+/g, '');
  if (key === '64' || key === 'roundof64' || key === 'r64' || key === 'firstround' || key === 'round64') return 'R64';
  if (key === '32' || key === 'roundof32' || key === 'r32' || key === 'secondround' || key === 'round32') return 'R32';
  if (key === '16' || key === 'sweet16' || key === 's16' || key === 'roundof16') return 'S16';
  if (key === '8' || key === 'elite8' || key === 'e8' || key === 'roundof8') return 'E8';
  if (key === '4' || key === 'finalfour' || key === 'f4' || key === 'semifinal' || key === 'semifinals') return 'F4';
  if (key === '2' || key === 'championship' || key === 'titlegame' || key === 'ncg' || key === 'roundof2' || key === 'final') return 'NCG';
  return String(value || '').trim();
}

function parsePercentMaybe(value) {
  if (value == null) return null;
  const raw = String(value).trim().replace(/,/g, '').replace(/%$/, '');
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  if (n < 0) return 0;
  return n;
}

function parseNumberMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const direct = Number(raw.replace(/,/g, '').replace(/^#/, ''));
  if (Number.isFinite(direct)) return direct;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const fallback = Number(match[0]);
  return Number.isFinite(fallback) ? fallback : null;
}

function validateTeamRoundProbabilities(teamRoundProbs) {
  const warnings = [];
  const expected = {
    R32: 32,
    S16: 16,
    E8: 8,
    F4: 4,
    NCG: 2,
    Championship: 1,
  };
  const tolerance = 0.5;
  for (const [roundKey, target] of Object.entries(expected)) {
    const total = Object.values(teamRoundProbs || {}).reduce((sum, row) => sum + Number(row?.[roundKey] || 0), 0);
    if (Math.abs(total - target) > tolerance) {
      warnings.push(`${roundKey} mass check: total=${total.toFixed(4)}, expected=${target.toFixed(4)}`);
    }
  }
  const chain = ['R32', 'S16', 'E8', 'F4', 'NCG', 'Championship'];
  for (const [teamName, row] of Object.entries(teamRoundProbs || {})) {
    for (let idx = 0; idx < chain.length - 1; idx += 1) {
      const curr = Number(row?.[chain[idx]]);
      const next = Number(row?.[chain[idx + 1]]);
      if (!Number.isFinite(curr) || !Number.isFinite(next)) continue;
      if (next > curr + 1e-9) {
        warnings.push(`${teamName} monotonic check failed: ${chain[idx + 1]} (${next.toFixed(6)}) > ${chain[idx]} (${curr.toFixed(6)})`);
        break;
      }
    }
  }
  return {
    ok: warnings.length === 0,
    warnings,
  };
}

function normalizeCsvHeaderKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function makeCsvRowAccessor(row) {
  const byKey = {};
  for (const [key, rawVal] of Object.entries(row || {})) {
    const normalized = normalizeCsvHeaderKey(key);
    if (!normalized) continue;
    if (!(normalized in byKey)) byKey[normalized] = rawVal;
  }
  return (...candidates) => {
    for (const candidate of candidates) {
      const key = normalizeCsvHeaderKey(candidate);
      if (!key) continue;
      const val = byKey[key];
      if (val == null) continue;
      if (typeof val === 'string' && val.trim() === '') continue;
      return val;
    }
    return null;
  };
}

function parseUploadedCsv(type, rawInput) {
  const rows = parseCsvRows(rawInput);
  if (!rows.length) throw new Error('CSV appears empty.');
  if (type === 'kenpom_csv') {
    const normalized = {};
    let count = 0;
    for (const row of rows) {
      const pick = makeCsvRowAccessor(row);
      const name = pick('TeamName', 'Team', 'team', 'team_name', 'Team Name', 'School', 'school', 'SchoolName', 'Tm');
      const team = String(name || '').trim();
      if (!team) continue;
      const entry = {
        team,
        rank: parseNumberMaybe(pick(
          'Rank', 'rank', 'Rk', 'rk', 'KenPomRank', 'KP_Rank', 'KP Rank', 'Overall Rank',
          'AdjEM Rank', 'AdjEM_Rank', 'EM Rank', 'EM_Rank', 'RankAdjEM'
        )),
        adjoe: parseNumberMaybe(pick(
          'AdjOE', 'Adj O', 'AdjO', 'adjoe', 'adjo',
          'OffRating', 'Off Rating', 'ORtg', 'O Rtg',
          'OffEfficiency', 'Off Efficiency', 'OffensiveEfficiency', 'Offensive Efficiency',
          'AdjOff', 'Adj Off', 'AdjOffense', 'Adj Offense',
          'KP_ORtg', 'KPORtg'
        )),
        adjoe_rank: parseNumberMaybe(pick(
          'AdjOE_Rank', 'AdjOE Rank', 'AdjOERank',
          'AdjO_Rank', 'AdjO Rank', 'AdjORank',
          'adjoe_rank', 'adjo_rank',
          'OffRank', 'Off Rank', 'ORtgRank', 'ORtg Rank',
          'RankAdjOE', 'RankAdjO'
        )),
        adjde: parseNumberMaybe(pick(
          'AdjDE', 'Adj D', 'AdjD', 'adjde', 'adjd',
          'DefRating', 'Def Rating', 'DRtg', 'D Rtg',
          'DefEfficiency', 'Def Efficiency', 'DefensiveEfficiency', 'Defensive Efficiency',
          'AdjDef', 'Adj Def', 'AdjDefense', 'Adj Defense',
          'KP_DRtg', 'KPDRtg'
        )),
        adjde_rank: parseNumberMaybe(pick(
          'AdjDE_Rank', 'AdjDE Rank', 'AdjDERank',
          'AdjD_Rank', 'AdjD Rank', 'AdjDRank',
          'adjde_rank', 'adjd_rank',
          'DefRank', 'Def Rank', 'DRtgRank', 'DRtg Rank',
          'RankAdjDE', 'RankAdjD'
        )),
        adjem: parseNumberMaybe(pick(
          'AdjEM', 'Adj EM', 'adjem',
          'NetRtg', 'Net RTG', 'NetRating', 'Net Rating', 'Net',
          'EM', 'EfficiencyMargin', 'Efficiency Margin', 'AdjMargin', 'Adj Margin',
          'KP_NetRtg', 'KPNetRtg'
        )),
        adjem_rank: parseNumberMaybe(pick(
          'AdjEM_Rank', 'AdjEM Rank', 'AdjEMRank',
          'adjem_rank', 'EM_Rank', 'EM Rank', 'EMRank',
          'NetRank', 'Net Rank', 'RankNet', 'RankAdjEM'
        )),
        tempo: parseNumberMaybe(pick(
          'Tempo', 'tempo',
          'AdjTempo', 'Adj Tempo', 'AdjustedTempo', 'Adjusted Tempo',
          'AdjT', 'Adj T',
          'Pace', 'AdjPace', 'Adj Pace'
        )),
        tempo_rank: parseNumberMaybe(pick(
          'Tempo_Rank', 'Tempo Rank', 'TempoRank', 'tempo_rank',
          'AdjTempoRank', 'Adj Tempo Rank',
          'AdjT_Rank', 'AdjT Rank', 'AdjTRank',
          'PaceRank', 'Pace Rank', 'RankAdjTempo'
        )),
      };
      const keys = new Set([
        normalizeTextKey(team),
        normalizeTeamNameBase(team),
        normalizeTeamName(team),
      ]);
      for (const key of keys) {
        if (!key) continue;
        normalized[key] = entry;
      }
      count += 1;
    }
    return { parsed: { rows, teams: normalized, count }, normalized: String(rawInput || ''), mode: 'csv' };
  }
  if (type === 'espn_public_csv') {
    const hasMatchupShape = rows.some((row) => {
      const pick = makeCsvRowAccessor(row);
      const team1 = String(pick('team_1', 'team1', 'Team1') || '').trim();
      const team2 = String(pick('team_2', 'team2', 'Team2') || '').trim();
      return !!(team1 && team2);
    });
    const normalizedRows = [];
    if (hasMatchupShape) {
      for (const row of rows) {
        const pick = makeCsvRowAccessor(row);
        const team1 = String(pick('team_1', 'team1', 'Team1') || '').trim();
        const team2 = String(pick('team_2', 'team2', 'Team2') || '').trim();
        if (!team1 || !team2) continue;
        const roundRaw = String(pick('round', 'Round', 'round_key', 'round_label') || '').trim();
        normalizedRows.push({
          round: normalizeCanonicalRoundKey(roundRaw),
          round_raw: roundRaw,
          region_or_stage: String(pick('region_or_stage', 'region', 'stage') || '').trim(),
          matchup_number: parseNumberMaybe(pick('matchup_number', 'game_number', 'game_id', 'game')),
          team_1: team1,
          team_1_pct: parsePercentMaybe(pick('team_1_pct', 'team1_pct', 'public_1_pct')),
          team_2: team2,
          team_2_pct: parsePercentMaybe(pick('team_2_pct', 'team2_pct', 'public_2_pct')),
          source_format: 'matchup',
        });
      }
    } else {
      for (const row of rows) {
        const pick = makeCsvRowAccessor(row);
        const team = String(pick('team', 'Team', 'school', 'School', 'team_1', 'team1') || '').trim();
        if (!team) continue;
        const roundRaw = String(pick('round_label', 'round_key', 'round', 'Round') || '').trim();
        normalizedRows.push({
          round: normalizeCanonicalRoundKey(roundRaw),
          round_raw: roundRaw,
          region_or_stage: String(pick('region_or_stage', 'region', 'stage') || '').trim(),
          matchup_number: parseNumberMaybe(pick('matchup_number', 'game_number', 'game_id', 'game', 'rank', 'Rank')),
          team_1: team,
          team_1_pct: parsePercentMaybe(pick('pct_picked', 'pct', 'pick_pct', 'team_pct', 'public_pct', 'normalized_prob', 'raw_prob', 'prob')),
          team_2: '',
          team_2_pct: null,
          rank: parseNumberMaybe(pick('rank', 'Rank')),
          seed: parseNumberMaybe(pick('seed', 'Seed')),
          source_format: 'team_pick_distribution',
        });
      }
    }
    return { parsed: { rows: normalizedRows, count: normalizedRows.length }, normalized: String(rawInput || ''), mode: 'csv' };
  }
  if (type === 'team_round_probs_csv') {
    const teamRoundProbs = {};
    const normalizedRows = [];
    for (const row of rows) {
      const pick = makeCsvRowAccessor(row);
      const team = String(pick('Team', 'team', 'team_name', 'school', 'School') || '').trim();
      if (!team) continue;
      const parsed = {
        R32: parsePercentMaybe(pick('R32', 'round_32', 'roundof32')),
        S16: parsePercentMaybe(pick('S16', 'Sweet16', 'sweet_16', 'roundof16')),
        E8: parsePercentMaybe(pick('E8', 'Elite8', 'elite_8', 'roundof8')),
        F4: parsePercentMaybe(pick('F4', 'Final4', 'final_4', 'finalfour')),
        NCG: parsePercentMaybe(pick('NCG', 'TitleGame', 'title_game', 'championship_game', 'roundof2')),
        Championship: parsePercentMaybe(pick('Championship', 'Champion', 'champion', 'Champ')),
      };
      const hasRound = Object.values(parsed).some((v) => Number.isFinite(Number(v)));
      if (!hasRound) continue;
      teamRoundProbs[team] = parsed;
      normalizedRows.push({ team, ...parsed });
    }
    if (!Object.keys(teamRoundProbs).length) {
      throw new Error('No team round probabilities detected. Expected Team + R32/S16/E8/F4/TitleGame/Champion columns.');
    }
    const validation = validateTeamRoundProbabilities(teamRoundProbs);
    return {
      parsed: {
        rows: normalizedRows,
        team_round_probs: teamRoundProbs,
        count: normalizedRows.length,
        validation,
      },
      normalized: String(rawInput || ''),
      mode: 'csv',
    };
  }
  throw new Error(`Unsupported CSV type: ${type}`);
}

function parseUploadedData(rawInput, type) {
  if (type === 'team_round_probs_json') return parseUploadedTeamRoundProbabilitiesJson(rawInput);
  if (CSV_UPLOAD_TYPES.has(type)) return parseUploadedCsv(type, rawInput);
  return parseUploadedJson(rawInput);
}

function findMatchup(t1Id, t2Id) {
  const t1 = String(t1Id);
  const t2 = String(t2Id);
  const sources = [dataStore.bracket_cache, dataStore.predictions];
  for (const source of sources) {
    if (!source) continue;
    const lookup = source.bracket_lookup || {};
    const idx = lookup[t1]?.[t2] ?? lookup[t2]?.[t1];
    if (idx !== undefined && source.predictions?.[idx]) {
      return source.predictions[idx];
    }
  }
  return null;
}

function findTeamByName(name) {
  if (!name) return null;
  const lc = String(name).toLowerCase().trim();

  const dir = dataStore.predictions?.team_directory || {};
  for (const [id, team] of Object.entries(dir)) {
    if (team.name && String(team.name).toLowerCase() === lc) {
      return { id: parseInt(id, 10), ...team };
    }
  }
  for (const [id, team] of Object.entries(dir)) {
    if (team.name && String(team.name).toLowerCase().includes(lc)) {
      return { id: parseInt(id, 10), ...team };
    }
  }

  const profiles = dataStore.teamProfiles?.teams || {};
  for (const [id, team] of Object.entries(profiles)) {
    if (team.name && String(team.name).toLowerCase().includes(lc)) {
      return { id: parseInt(id, 10), ...team };
    }
  }
  return null;
}

function extractTeamNames(message) {
  const dir = dataStore.predictions?.team_directory || {};
  const found = [];
  const lc = String(message || '').toLowerCase();
  const teams = Object.values(dir).sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
  for (const team of teams) {
    if (team.name && lc.includes(String(team.name).toLowerCase())) {
      found.push(team);
      if (found.length >= 2) break;
    }
  }
  return found;
}

function findRelevantContext(userMessage) {
  const lc = String(userMessage || '').toLowerCase();
  const context = [];
  const seen = new Set();

  const predictions = dataStore.predictions?.predictions || [];
  const teamDir = dataStore.predictions?.team_directory || {};
  const lookup = dataStore.predictions?.bracket_lookup || {};
  const profiles = dataStore.team_profiles?.teams || {};
  const seedMatchups = dataStore.seed_matchups || {};
  const archDescriptions = dataStore.archetype_summary?.archetype_descriptions || {};

  const mentionedTeams = [];
  for (const [tid, team] of Object.entries(teamDir)) {
    const name = String(team.name || '').toLowerCase();
    if (name && name.length > 3 && lc.includes(name)) {
      mentionedTeams.push({ id: tid, ...team });
    }
  }

  if (mentionedTeams.length >= 2) {
    const t1 = mentionedTeams[0].id;
    const t2 = mentionedTeams[1].id;
    const idx = lookup[t1]?.[t2];
    if (idx !== undefined) {
      context.push({ type: 'matchup', item: predictions[idx] });
    }
  }

  for (const team of mentionedTeams) {
    const profile = profiles[team.id];
    if (profile) context.push({ type: 'team_profile', item: profile });
  }

  if (lc.includes('upset') || lc.includes('cinderella') || lc.includes('underdog')) {
    const upsets = predictions.filter((p) => p.upset_flag && String(p.upset_flag).includes('UPSET'));
    for (const u of upsets.slice(0, 10)) {
      context.push({ type: 'upset_pick', item: u });
    }
  }

  const seedMatch = lc.match(/(\d+)\s*(?:seed|vs|versus)/);
  if (seedMatch) {
    const seed = parseInt(seedMatch[1], 10);
    const seedPreds = predictions.filter((p) => p.t1_seed === seed || p.t2_seed === seed);
    for (const sp of seedPreds.slice(0, 8)) {
      context.push({ type: 'seed_matchup', item: sp });
    }
  }

  if (lc.includes('bracket') || lc.includes('strategy') || lc.includes('pool') || lc.includes('chalk')) {
    const valuePicks = [...predictions]
      .sort((a, b) => Math.abs(Number(b.value_score || 0)) - Math.abs(Number(a.value_score || 0)))
      .slice(0, 8);
    for (const vp of valuePicks) {
      context.push({ type: 'value_pick', item: vp });
    }
  }

  if (lc.includes('archetype') || lc.includes('style') || lc.includes('type of team')) {
    context.push({ type: 'archetype_info', item: archDescriptions });
  }

  for (const [round, roundData] of Object.entries(seedMatchups)) {
    if (lc.includes(String(round).toLowerCase())) {
      context.push({ type: 'seed_history', item: { round, data: roundData } });
    }
  }

  return context.filter((c) => {
    const key = JSON.stringify(c).substring(0, 200);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 15);
}

function buildChatContext(userMessage) {
  return findRelevantContext(userMessage);
}

function getSystemPrompt() {
  const systemPrompt = `You are BracketGPT, an elite AI March Madness bracket advisor powered by a 3-model ensemble (XGBoost + LightGBM + CatBoost) trained on 20+ years of NCAA tournament data with KenPom advanced metrics.

You have access to:
- 2,278 all-pairs predictions (every possible matchup between 68 tournament teams)
- Team archetypes (Juggernaut, Sharpshooter, Glass Cannon, Fortress, All-Arounder, Scorer, etc.)
- Historical archetype performance (upset rates, deep run rates by seed tier)
- Seed matchup history across all rounds (R64 through Championship)
- KenPom ratings (ORtg, DRtg, NetRtg, Tempo, SOS)
- Team momentum (last 10 games, margin trend, volatility)
- Per-team strengths and weaknesses
- Historical team comparisons (statistically similar past teams and their tournament outcomes)

When answering:
- Always cite the model win probability and confidence tier (LOCK/STRONG/LEAN/TOSS-UP)
- Reference the team archetype and what it means for the matchup
- Mention momentum and injury flags when relevant
- For upset picks, cite historical seed matchup win rates
- Use ESPN scoring (10-20-40-80-160-320) when discussing bracket strategy
- Be specific with numbers - don't say "likely," say "72% win probability"
- When comparing teams, reference KenPom efficiency ratings and four factors`;
  return systemPrompt;
}

function pushToMapArray(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function predictionFingerprint(pred) {
  return [
    normalizeTeamName(pred?.t1_name),
    normalizeTeamName(pred?.t2_name),
    Number(pred?.t1_seed || 0),
    Number(pred?.t2_seed || 0),
    String(pred?.season || ''),
  ].join('|');
}

function clearContextCache() {
  historicalIndex.contextCache.clear();
}

function buildHistoricalIndex() {
  historicalIndex.predictionsByTeam = new Map();
  historicalIndex.predictionsBySeed = new Map();
  historicalIndex.teamNames = [];
  historicalIndex.archetypeHistory = store.base?.archetype_history_lookup || {};
  historicalIndex.seedMatchups = store.seedMatchups || {};
  clearContextCache();

  const predictions = store.base?.predictions || [];
  for (const pred of predictions) {
    const t1 = normalizeTeamName(pred.t1_name);
    const t2 = normalizeTeamName(pred.t2_name);
    pushToMapArray(historicalIndex.predictionsByTeam, t1, pred);
    pushToMapArray(historicalIndex.predictionsByTeam, t2, pred);

    const s1 = Number(pred.t1_seed);
    const s2 = Number(pred.t2_seed);
    if (Number.isFinite(s1) && s1 >= 1 && s1 <= 16) pushToMapArray(historicalIndex.predictionsBySeed, s1, pred);
    if (Number.isFinite(s2) && s2 >= 1 && s2 <= 16) pushToMapArray(historicalIndex.predictionsBySeed, s2, pred);
  }

  historicalIndex.teamNames = Array.from(historicalIndex.predictionsByTeam.keys())
    .filter((name) => name && name.length >= 4)
    .sort((a, b) => b.length - a.length);
}

function addBracketByTeam(teamName, matchup) {
  const key = normalizeTeamName(teamName);
  if (!key) return;
  if (!bracketMatchupIndex.byTeam.has(key)) bracketMatchupIndex.byTeam.set(key, []);
  bracketMatchupIndex.byTeam.get(key).push(matchup);
}

function buildBracketMatchupIndex() {
  bracketMatchupIndex.byId = new Map();
  bracketMatchupIndex.byRegion = new Map();
  bracketMatchupIndex.byTeam = new Map();
  const payload = buildCanonicalR64Payload();
  const rows = Array.isArray(payload?.matchups) ? payload.matchups : [];
  bracketMatchupIndex.season = Number(payload?.season || cfg.activeSeason || 2026);
  const regionSet = new Set();

  for (const matchup of rows) {
    const id = String(matchup?.matchup_id || '');
    const region = String(matchup?.region || 'Unknown');
    if (id) bracketMatchupIndex.byId.set(id, matchup);
    regionSet.add(region);
    if (!bracketMatchupIndex.byRegion.has(region)) bracketMatchupIndex.byRegion.set(region, []);
    bracketMatchupIndex.byRegion.get(region).push(matchup);
    addBracketByTeam(matchup?.t1?.name, matchup);
    addBracketByTeam(matchup?.t2?.name, matchup);
  }

  bracketMatchupIndex.regions = regionSet.size ? Array.from(regionSet) : REGION_ORDER_2026.slice();
}

function normalizeRoundToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isR64Round(value) {
  const key = normalizeRoundToken(value);
  return key === '64' || key === 'r64' || key === 'round64' || key === 'roundof64' || key === 'firstround' || key === '1stround';
}

function normalizeR64Matchups(rows, seasonFallback) {
  const out = [];
  const data = Array.isArray(rows) ? rows : [];
  let r64 = data.filter((m) => isR64Round(m?.round));
  if (!r64.length && data.length) {
    r64 = [...data]
      .sort((a, b) => Number(a?.game_number || 0) - Number(b?.game_number || 0))
      .slice(0, 32);
  }
  for (const m of r64) {
    const season = Number(m?.season || seasonFallback || cfg.activeSeason || 2026);
    const region = String(m?.region || 'Unknown').trim() || 'Unknown';
    const gameNo = Number(m?.game_number || 0) || 1;
    const t1 = m?.t1 || {
      team_id: m?.team1Id ?? m?.team1_id ?? null,
      name: m?.team1 || m?.team1Name || m?.t1_name || 'TBD',
      seed: m?.seed1 ?? m?.team1Seed ?? m?.t1_seed ?? null,
      win_probability: m?.winProb ?? m?.model_win_prob ?? null,
      predicted_margin: m?.predicted_margin ?? null,
      abbreviation: m?.team1Abbreviation ?? null,
      color_primary: m?.team1Color ?? null,
    };
    const t2 = m?.t2 || {
      team_id: m?.team2Id ?? m?.team2_id ?? null,
      name: m?.team2 || m?.team2Name || m?.t2_name || 'TBD',
      seed: m?.seed2 ?? m?.team2Seed ?? m?.t2_seed ?? null,
      win_probability: null,
      predicted_margin: m?.predicted_margin == null ? null : -Number(m.predicted_margin),
      abbreviation: m?.team2Abbreviation ?? null,
      color_primary: m?.team2Color ?? null,
    };
    const p1 = normProb(t1?.win_probability ?? t1?.model_win_prob ?? 0.5);
    const winP1 = p1 === null ? 0.5 : p1;
    out.push({
      matchup_id: String(m?.matchup_id || `AUTO_R64_${region.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_${gameNo}`),
      season,
      round: 'R64',
      region,
      game_number: gameNo,
      t1: {
        team_id: t1?.team_id ?? t1?.id ?? null,
        name: String(t1?.name || t1?.team || 'TBD'),
        seed: Number.isFinite(Number(t1?.seed)) ? Number(t1.seed) : null,
        win_probability: winP1,
        predicted_margin: Number.isFinite(Number(t1?.predicted_margin)) ? Number(t1.predicted_margin) : null,
        abbreviation: t1?.abbreviation || null,
        color_primary: t1?.color_primary || null,
      },
      t2: {
        team_id: t2?.team_id ?? t2?.id ?? null,
        name: String(t2?.name || t2?.team || 'TBD'),
        seed: Number.isFinite(Number(t2?.seed)) ? Number(t2.seed) : null,
        win_probability: 1 - winP1,
        predicted_margin: Number.isFinite(Number(t2?.predicted_margin)) ? Number(t2.predicted_margin) : null,
        abbreviation: t2?.abbreviation || null,
        color_primary: t2?.color_primary || null,
      },
      matchup_meta: {
        predicted_winner: String(m?.matchup_meta?.predicted_winner || ''),
        upset_flag: String(m?.matchup_meta?.upset_flag || m?.matchup_meta?.display_flag || 'chalk'),
        display_flag: String(m?.matchup_meta?.display_flag || m?.matchup_meta?.upset_flag || 'chalk'),
        confidence: String(m?.matchup_meta?.confidence || 'projected'),
      },
    });
  }
  return out;
}

function deriveR64MatchupsFromBracketGames(games, seasonFallback) {
  if (!Array.isArray(games) || !games.length) return [];
  const r64Games = games.filter((g) => isR64Round(g?.round));
  if (!r64Games.length) return [];

  const season = Number(seasonFallback || cfg.activeSeason || 2026);
  const regionGameNo = new Map();
  const out = [];

  for (const game of r64Games) {
    const region = String(game?.region || 'Unknown').trim() || 'Unknown';
    const gameNo = (regionGameNo.get(region) || 0) + 1;
    regionGameNo.set(region, gameNo);

    const t1Id = game?.team1Id ?? game?.team1_id ?? null;
    const t2Id = game?.team2Id ?? game?.team2_id ?? null;
    const t1Name = String(game?.team1 || game?.team1Name || 'TBD');
    const t2Name = String(game?.team2 || game?.team2Name || 'TBD');
    const t1Seed = Number(game?.seed1 ?? game?.team1Seed);
    const t2Seed = Number(game?.seed2 ?? game?.team2Seed);

    let t1Prob = null;
    let t2Prob = null;
    let predictedWinner = String(game?.predictedWinner || '');
    let confidence = String(game?.confidence || '').toLowerCase();
    let upsetFlag = 'chalk';
    let predictedMargin = null;

    if (t1Id !== null && t2Id !== null) {
      const pred = findMatchup(t1Id, t2Id);
      if (pred) {
        const modelProb = normProb(pred.model_win_prob);
        const aligned = String(pred.t1_id ?? '') === String(t1Id);
        if (modelProb !== null) {
          t1Prob = aligned ? modelProb : (1 - modelProb);
          t2Prob = 1 - t1Prob;
        }
        predictedWinner = String(pred.predicted_winner_name || predictedWinner || '');
        confidence = String(pred.confidence || confidence || '').toLowerCase();
        upsetFlag = String(pred.upset_flag || upsetFlag || 'chalk').toLowerCase();
        const rawMargin = Number(pred.predicted_margin);
        if (Number.isFinite(rawMargin)) predictedMargin = aligned ? rawMargin : -rawMargin;
      }
    }

    if (t1Prob === null || t2Prob === null) {
      const fallback = normProb(game?.winProb);
      if (fallback !== null) {
        t1Prob = fallback;
        t2Prob = 1 - fallback;
      } else {
        t1Prob = 0.5;
        t2Prob = 0.5;
      }
    }

    if (!confidence) {
      const top = Math.max(t1Prob, t2Prob);
      if (top >= 0.95) confidence = 'lock';
      else if (top >= 0.85) confidence = 'confident';
      else if (top >= 0.70) confidence = 'lean';
      else confidence = 'toss_up';
    }

    out.push({
      matchup_id: `AUTO_R64_${region.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}_${gameNo}`,
      season,
      round: 'R64',
      region,
      game_number: gameNo,
      t1: {
        team_id: t1Id,
        name: t1Name,
        seed: Number.isFinite(t1Seed) ? t1Seed : null,
        win_probability: t1Prob,
        predicted_margin: predictedMargin,
      },
      t2: {
        team_id: t2Id,
        name: t2Name,
        seed: Number.isFinite(t2Seed) ? t2Seed : null,
        win_probability: t2Prob,
        predicted_margin: predictedMargin === null ? null : -predictedMargin,
      },
      matchup_meta: {
        predicted_winner: predictedWinner,
        upset_flag: upsetFlag,
        display_flag: upsetFlag,
        confidence,
      },
    });
  }

  return out.sort((a, b) => String(a.region).localeCompare(String(b.region)) || Number(a.game_number || 0) - Number(b.game_number || 0));
}

function deriveR64MatchupsFromBracket2025() {
  const games = Array.isArray(store.bracket2025?.bracketGames) ? store.bracket2025.bracketGames : [];
  return deriveR64MatchupsFromBracketGames(games, store.bracket2025?.season);
}

function deriveR64MatchupsFromRawJson(raw) {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.matchups)) {
    return normalizeR64Matchups(raw.matchups, raw.season);
  }
  const games = Array.isArray(raw.bracketGames) ? raw.bracketGames : (Array.isArray(raw.games) ? raw.games : []);
  if (games.length) {
    return deriveR64MatchupsFromBracketGames(games, raw.season);
  }
  return [];
}

function deriveR64MatchupsFromDisk() {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => /\.json$/i.test(f));
  } catch (e) {
    return [];
  }
  if (!files.length) return [];

  const preferred = [
    'bracketgpt_matchups_2026_final.json',
    'bracketgpt_matchups_2025_final.json',
    'bracketgpt_matchups_2026_v2.json',
    'bracketgpt_matchups_2025_v2.json',
    'bracket_2026.json',
    'bracket_2025.json',
    'bracket_predictions_2026.json',
    'bracket_predictions_2025.json',
    'bracket_predictions.json',
  ];
  const ordered = [
    ...preferred.filter((f) => files.includes(f)),
    ...files.filter((f) => !preferred.includes(f) && /(bracket|matchup)/i.test(f)),
  ];

  for (const file of ordered) {
    try {
      const full = path.join(DATA_DIR, file);
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      const matchups = deriveR64MatchupsFromRawJson(raw);
      if (matchups.length) return matchups;
    } catch (e) {
      // keep scanning files
    }
  }
  return [];
}

function getFinalFourPairingsArray() {
  if (Array.isArray(store.bracketMatchups?.finalFourPairings) && store.bracketMatchups.finalFourPairings.length >= 2) {
    return store.bracketMatchups.finalFourPairings;
  }
  return FINAL_FOUR_PAIRINGS_2026;
}

function getFinalFourPairingsObject(pairings) {
  const rows = Array.isArray(pairings) ? pairings : getFinalFourPairingsArray();
  return {
    semifinal_1: {
      region_a: String(rows?.[0]?.[0] || 'South'),
      region_b: String(rows?.[0]?.[1] || 'East'),
    },
    semifinal_2: {
      region_a: String(rows?.[1]?.[0] || 'West'),
      region_b: String(rows?.[1]?.[1] || 'Midwest'),
    },
  };
}

function confidenceTierFromProb(prob) {
  const p = Number(prob);
  if (!Number.isFinite(p)) return 'TOSS-UP';
  const edge = Math.max(p, 1 - p);
  if (edge >= 0.95) return 'LOCK';
  if (edge >= 0.80) return 'CONFIDENT';
  if (edge >= 0.65) return 'LEAN';
  if (edge >= 0.55) return 'SLIGHT EDGE';
  return 'TOSS-UP';
}

function fallbackWinProbBySeed(higherSeed, lowerSeed) {
  const h = Number(higherSeed);
  const l = Number(lowerSeed);
  if (!Number.isFinite(h) || !Number.isFinite(l)) return 0.5;
  if (h === 1 && l === 16) return 0.99;
  const diff = Math.max(0, l - h);
  return Math.max(0.51, Math.min(0.95, 0.5 + diff * 0.03));
}

function upsetLabelFromSeeds(t1Seed, t2Seed, t1WinProb) {
  const s1 = Number(t1Seed);
  const s2 = Number(t2Seed);
  if (!Number.isFinite(s1) || !Number.isFinite(s2)) return null;
  const seedDiff = Math.abs(s1 - s2);
  if (seedDiff <= 1) return null;
  const p1 = Number(t1WinProb);
  if (!Number.isFinite(p1)) return null;
  const p2 = 1 - p1;
  const underdogFavored = (s1 > s2 && p1 > 0.5) || (s2 > s1 && p2 > 0.5);
  if (underdogFavored && seedDiff >= 2) return 'UPSET ALERT';
  const favoredProb = Math.max(p1, p2);
  if (seedDiff >= 3 && favoredProb < 0.65) return 'UPSET WATCH';
  if (seedDiff >= 5 && favoredProb < 0.75) return 'COMPETITIVE';
  return null;
}

function upsetFlagToken(label) {
  return String(label || '').toLowerCase().replace(/\s+/g, '_');
}

function buildTeamDirectoryIndexes(teamDirectory) {
  const byNorm = new Map();
  const byId = new Map();
  for (const [rawId, teamRaw] of Object.entries(teamDirectory || {})) {
    const team = teamRaw || {};
    const id = Number(team.id ?? rawId);
    const entry = {
      id: Number.isFinite(id) ? id : null,
      ...team,
    };
    const nameKey = normalizeTeamName(entry.name);
    if (nameKey && !byNorm.has(nameKey)) byNorm.set(nameKey, entry);
    if (entry.id != null) byId.set(String(entry.id), entry);
  }
  return { byNorm, byId };
}

function buildPredictionIndexes(predictions) {
  const byNames = new Map();
  const byIds = new Map();
  const byTeamOppSeed = new Map();
  const rows = Array.isArray(predictions) ? predictions : [];

  function addTeamOppSeed(teamKey, oppSeed, pred, side) {
    const seed = Number(oppSeed);
    if (!teamKey || !Number.isFinite(seed)) return;
    const key = `${teamKey}|${seed}`;
    if (!byTeamOppSeed.has(key)) byTeamOppSeed.set(key, []);
    byTeamOppSeed.get(key).push({ pred, side });
  }

  for (const pred of rows) {
    const t1Key = normalizeTeamName(pred?.t1_name);
    const t2Key = normalizeTeamName(pred?.t2_name);
    if (t1Key && t2Key) {
      byNames.set(`${t1Key}|${t2Key}`, pred);
      byNames.set(`${t2Key}|${t1Key}`, pred);
      addTeamOppSeed(t1Key, pred?.t2_seed, pred, 't1');
      addTeamOppSeed(t2Key, pred?.t1_seed, pred, 't2');
    }
    const id1 = pred?.t1_id;
    const id2 = pred?.t2_id;
    if (id1 != null && id2 != null) {
      byIds.set(`${id1}|${id2}`, pred);
      byIds.set(`${id2}|${id1}`, pred);
    }
  }
  return { byNames, byIds, byTeamOppSeed };
}

function resolveTeamEntry(teamIndexes, teamName) {
  const byNorm = teamIndexes?.byNorm || new Map();
  const exact = byNorm.get(normalizeTeamName(teamName));
  if (exact) return exact;
  const target = normalizeTeamName(teamName);
  if (!target) return null;
  for (const [key, team] of byNorm.entries()) {
    if (key.includes(target) || target.includes(key)) return team;
  }
  return null;
}

function pickPredictionForTeams(predIndexes, higherName, lowerName, higherId, lowerId, lowerSeed) {
  const byIds = predIndexes?.byIds || new Map();
  const byNames = predIndexes?.byNames || new Map();
  const byTeamOppSeed = predIndexes?.byTeamOppSeed || new Map();
  const highKey = normalizeTeamName(higherName);
  const lowKey = normalizeTeamName(lowerName);

  let pred = null;
  let proxy = false;
  if (higherId != null && lowerId != null) {
    pred = byIds.get(`${higherId}|${lowerId}`) || null;
  }
  if (!pred) pred = byNames.get(`${highKey}|${lowKey}`) || null;

  let side = null;
  if (pred) {
    if (normalizeTeamName(pred?.t1_name) === highKey || String(pred?.t1_id ?? '') === String(higherId ?? '')) side = 't1';
    else if (normalizeTeamName(pred?.t2_name) === highKey || String(pred?.t2_id ?? '') === String(higherId ?? '')) side = 't2';
  }

  if (!pred) {
    const candidates = byTeamOppSeed.get(`${highKey}|${Number(lowerSeed)}`) || [];
    if (candidates.length) {
      candidates.sort((a, b) => {
        const pa = normProb(a?.pred?.model_win_prob);
        const pb = normProb(b?.pred?.model_win_prob);
        const aEdge = Number.isFinite(pa) ? Math.abs(pa - 0.5) : 0;
        const bEdge = Number.isFinite(pb) ? Math.abs(pb - 0.5) : 0;
        return bEdge - aEdge;
      });
      pred = candidates[0].pred;
      side = candidates[0].side;
      proxy = true;
    }
  }

  if (!side && pred) {
    side = normalizeTeamName(pred?.t1_name) === highKey ? 't1' : 't2';
  }
  return { pred, side, proxy };
}

function buildTeamPayloadFromCache(teamEntry, pred, side, winProb) {
  const prefix = side === 't2' ? 't2' : 't1';
  const fallbackProfile = teamEntry?.profile || null;
  const predProfile = pred?.[`${prefix}_profile`] || null;
  return {
    name: teamEntry?.name || '',
    seed: Number(teamEntry?.seed ?? null),
    team_id: teamEntry?.id ?? null,
    win_probability: Number.isFinite(Number(winProb)) ? Number(winProb) : 0.5,
    archetype: teamEntry?.archetype || pred?.[`${prefix}_archetype`] || 'Unknown',
    profile: fallbackProfile || predProfile || null,
    key_players: predProfile?.key_players || fallbackProfile?.key_players || null,
    topComp: pred?.[`${prefix}_topComp`] || null,
    comp_context: pred?.[`${prefix}_comp_context`] || null,
    secondaryComp: pred?.[`${prefix}_secondaryComp`] || null,
    secondary_comp_context: pred?.[`${prefix}_secondary_comp_context`] || null,
    archetype_history: pred?.[`${prefix}_archetype_history`] || null,
  };
}

function buildR64PayloadFromBracketCache() {
  return null;
}

function buildLegacyCanonicalR64Payload() {
  return {
    season: Number(cfg.activeSeason || 2026),
    regions: REGION_ORDER_2026.slice(),
    matchups: [],
  };
}

function buildCanonicalR64Payload() {
  if (bracketReady && Array.isArray(bracketReady.matchups) && bracketReady.matchups.length > 0) {
    return bracketReady;
  }
  return {
    season: Number(cfg.activeSeason || 2026),
    regions: REGION_ORDER_2026.slice(),
    matchups: [],
    team_directory: {},
    all_predictions: [],
    bracket_lookup: {},
    seed_matchup_history: {},
    archetype_matchup_matrix: {},
    archetype_history: {},
    display_names: {},
    espn_scoring: {},
  };
}

function canonicalSeedPair(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  return `${Math.min(a, b)}v${Math.max(a, b)}`;
}

function orientHigherSeedFirst(matchup) {
  const m = matchup || {};
  const s1 = Number(m?.t1?.seed);
  const s2 = Number(m?.t2?.seed);
  if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 <= s2) return m;
  return {
    ...m,
    t1: { ...(m.t2 || {}) },
    t2: { ...(m.t1 || {}) },
  };
}

function matchupUniqKey(matchup) {
  const m = matchup || {};
  const region = String(m?.region || '').toLowerCase();
  const teamA = normalizeTeamName(m?.t1?.name);
  const teamB = normalizeTeamName(m?.t2?.name);
  const a = teamA <= teamB ? teamA : teamB;
  const b = teamA <= teamB ? teamB : teamA;
  const pair = canonicalSeedPair(m?.t1?.seed, m?.t2?.seed);
  return `${region}|${pair}|${a}|${b}`;
}

function stabilizeR64Matchups(rows) {
  const data = Array.isArray(rows) ? rows.map(orientHigherSeedFirst) : [];
  if (!data.length) return [];
  const regionOrder = Array.from(new Set(data.map((m) => String(m?.region || 'Unknown').trim() || 'Unknown')));
  const targetPairs = ['1v16', '8v9', '5v12', '4v13', '6v11', '3v14', '7v10', '2v15'];
  const out = [];
  const seen = new Set();

  for (const region of regionOrder) {
    const regionRows = data
      .filter((m) => String(m?.region || 'Unknown').trim() === region)
      .sort((a, b) => Number(a?.game_number || 0) - Number(b?.game_number || 0));

    const byPair = new Map();
    for (const row of regionRows) {
      const key = canonicalSeedPair(row?.t1?.seed, row?.t2?.seed);
      if (!key) continue;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(row);
    }

    const ordered = [];
    for (const pair of targetPairs) {
      const pick = (byPair.get(pair) || []).shift();
      if (pick) ordered.push(pick);
    }
    for (const row of regionRows) {
      if (!ordered.includes(row)) ordered.push(row);
    }

    for (let i = 0; i < ordered.length; i += 1) {
      const row = ordered[i];
      const uniq = matchupUniqKey(row);
      if (seen.has(uniq)) continue;
      seen.add(uniq);
      out.push({
        ...row,
        region,
        game_number: Number(row?.game_number || 0) || (i + 1),
      });
    }
  }

  return out;
}

function logBracketPayloadDiagnostics(context, payload) {
  const rows = Array.isArray(payload?.matchups) ? payload.matchups : [];
  const pairs = {};
  const rounds = new Set();
  const regions = new Set();
  for (const row of rows) {
    rounds.add(String(row?.round || ''));
    regions.add(String(row?.region || ''));
    const key = canonicalSeedPair(row?.t1?.seed, row?.t2?.seed) || 'unknown';
    pairs[key] = (pairs[key] || 0) + 1;
  }
  console.log(`[bracket:${context}] total=${rows.length} regions=${Array.from(regions).join(',')} rounds=${Array.from(rounds).join(',')}`);
  console.log(`[bracket:${context}] seedPairs=${Object.entries(pairs).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join(',')}`);
}

function getProfileMap() {
  const profiles = store.teams?.profiles || store.teams?.teams || (Array.isArray(store.teams) ? store.teams : []);
  const profileMap = {};
  for (const p of profiles) {
    const id = p.teamId ?? p.team_id ?? p.id;
    if (id !== undefined && id !== null) profileMap[id] = p;
  }
  return profileMap;
}

function enrichBracketWithPlayers() {
  if (!store.bracket2025 || !Array.isArray(store.bracket2025.bracketGames)) return;
  const profileMap = getProfileMap();
  store.bracket2025.bracketGames = store.bracket2025.bracketGames.map((game) => ({
    ...game,
    team1Players: Array.isArray(game.team1Players) && game.team1Players.length > 0
      ? game.team1Players
      : (profileMap[game.team1Id]?.keyPlayers || []),
    team2Players: Array.isArray(game.team2Players) && game.team2Players.length > 0
      ? game.team2Players
      : (profileMap[game.team2Id]?.keyPlayers || []),
  }));
}

let hasData = loadData();
loadBracketReady();
enrichBracketWithPlayers();
buildHistoricalIndex();
buildBracketMatchupIndex();
logBracketPayloadDiagnostics('startup', buildCanonicalR64Payload());
if (store.bracketOutput?.strategies) {
  console.log(`Bracket output loaded: ${Object.keys(store.bracketOutput.strategies).length} strategies`);
} else {
  console.log('No bracket output - EP features disabled');
}

function reloadDataFromDisk(reason = 'reload') {
  const loaded = loadData();
  loadBracketReady();
  enrichBracketWithPlayers();
  buildHistoricalIndex();
  buildBracketMatchupIndex();
  logBracketPayloadDiagnostics(reason, buildCanonicalR64Payload());
  hasData = loaded;
  console.log(`[data] ${reason} | loaded:${loaded ? 'yes' : 'no'}`);
}

let dataReloadTimer = null;
try {
  fs.watch(DATA_DIR, { persistent: false }, (eventType, fileName) => {
    if (!fileName || fileName.startsWith('tmp')) return;
    const lower = fileName.toLowerCase();
    if (!lower.endsWith('.json') && !lower.endsWith('.csv')) return;
    clearTimeout(dataReloadTimer);
    dataReloadTimer = setTimeout(() => reloadDataFromDisk(`fs:${eventType}:${fileName}`), 150);
  });
} catch (e) {
  console.warn('[data] watch unavailable, continuing without file watch');
}

function normProb(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return 1;
}

function asPositiveInt(v, fallback, min = 1, max = 100) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function hasContent(data) {
  if (!data) return false;
  if (Array.isArray(data)) return data.length > 0;
  if (typeof data !== 'object') return false;

  const candidates = [
    data.predictions,
    data.profiles,
    data.results,
    data.bracket,
    data.games,
    data.matchups,
    data.picks,
    data.rounds,
  ];

  for (const item of candidates) {
    if (Array.isArray(item) && item.length) return true;
    if (item && typeof item === 'object' && Object.keys(item).length) return true;
  }

  return Object.keys(data).length > 0;
}

function contextCfg() {
  return {
    maxItems: asPositiveInt(cfg.context?.maxItems, defaultContext.maxItems, 1, 100),
    upsetItems: asPositiveInt(cfg.context?.upsetItems, defaultContext.upsetItems, 0, 30),
    optimizerItems: asPositiveInt(cfg.context?.optimizerItems, defaultContext.optimizerItems, 0, 20),
    titleSeedCutoff: asPositiveInt(cfg.context?.titleSeedCutoff, defaultContext.titleSeedCutoff, 1, 16),
    includeTeamProfiles: cfg.context?.includeTeamProfiles !== false,
    includeOptimizer: cfg.context?.includeOptimizer !== false,
    includeTitleAngles: cfg.context?.includeTitleAngles !== false,
    autoOptimize: cfg.context?.autoOptimize !== false,
  };
}

function poolStrategyPromptBlock() {
  const quickRef = store.poolStrategy?.quick_reference;
  if (!quickRef || typeof quickRef !== 'object') return '';

  const order = ['small', 'medium', 'large', 'mega'];
  const lines = [];
  for (const tier of order) {
    const item = quickRef[tier];
    if (!item) continue;
    const range = item.pool_range || tier;
    const oneLiner = item.one_liner || '';
    const champs = item.champion_picks || 'N/A';
    const upsets = item.upset_picks || 'N/A';
    lines.push(`- ${String(range)}: ${String(oneLiner)} Champion picks: ${String(champs)}. Upsets: ${String(upsets)}.`);
  }

  if (!lines.length) return '';
  return `\nPOOL SIZE STRATEGY (from leverage EV model):\n${lines.join('\\n')}\nUse this when the user mentions pool size.\n`;
}

function sysPrompt() {
  const n = (store.base?.predictions || []).length;
  return `You are BracketGPT â€” a sharp, opinionated March Madness bracket advisor.
You sound like Bill Simmons meets Nate Silver: data-backed but conversational.
Confident, opinionated, backed by data.

MODEL: v5.2 stacked ensemble (Optuna-tuned XGBoost + LightGBM + CatBoost, 5-fold OOF stacking, isotonic calibration) trained on 2003-2024 NCAA tournament data. ${n} matchup predictions loaded.

V5 FEATURES YOU KNOW ABOUT:
- MOMENTUM: Each team has a margin_trend (slope of scoring margin over the season) and last10_win_rate. "Rising" = trending up AND winning lately. "Fading" = declining or losing. "Steady" = flat.
- VOLATILITY: margin_std measures game-to-game scoring variance. volatility_score is 0-100 (min-max normalized). High volatility = unpredictable â€” great for upsets, bad for chalk picks.
- INJURY PROXY: If a team's last 5 games scoring margin dropped 6+ points vs their season average, they get an injury_alert. This flags possible injuries, suspensions, or fatigue without needing an injury database.
- CONFERENCE TOURNEY: How far they went â€” champion, finalist, semifinalist, or first_round_exit. Momentum signal.
- HOME/AWAY SPLIT: home_away_net_diff shows how much better a team plays at home. Big splits mean they may struggle on neutral courts (all tournament games are neutral).
- MATCHUP RISK NOTE: Flags like "High variance matchup", "Momentum mismatch favoring X", or "Injury concern â€” monitor roster news".

HOW TO USE V5 DATA:
- When someone asks about a team, ALWAYS mention momentum status if rising or fading.
- If a team has an injury_alert, warn about it and quote the drop: "Their net margin dropped X pts in the final 5 games â€” could signal injuries or fatigue."
- For upset picks, favor teams that are RISING + opponent is FADING or has high volatility.
- For safe/chalk picks, favor teams that are STEADY or RISING with LOW volatility.
- Mention the matchup_risk_note when it exists â€” it's pre-computed analysis.
- Conference tourney results matter: a conf tourney champion has momentum, a first-round exit raises questions.

ARCHETYPES: Each team has a named archetype (Juggernaut, Fortress, Glass Cannon, etc.) with historical matchup win rates. Use these for color and narrative.

## Historical Enrichment Data Available
You now have access to three enriched data sources generated by historical_enrichment_pipeline.py. You MUST reference these in every matchup analysis, team comparison, and bracket recommendation. Historical data is what separates your analysis from generic predictions - use it aggressively.

### 1. Archetype History (archetype_history_lookup)
Each of the 9 archetypes has a full historical profile from 2003-2024 tournament data. Located in predictions JSON under archetype_history_lookup and per-prediction under t1_archetype_history / t2_archetype_history.

Fields available per archetype:
- sample_size - total tournament appearances
- deep_run_rate - % reaching Sweet 16+
- upset_rate_as_underdog - % of seeds 5+ that won at least one game
- seed_tier_performance - broken into three tiers:
  - 1_to_4: count, avg_wins, final_four_rate, championship_rate
  - 5_to_8: count, avg_wins, sweet_16_rate
  - 9_to_16: count, avg_wins, upset_rate_r64
- strength - tournament-specific advantage
- weakness - tournament-specific vulnerability
- notable_runs - 3-4 curated historical examples with team, year, seed, result, and one-sentence narrative
- trend - one-sentence summary of the archetype's historical pattern

How to use:
- When analyzing a team, ALWAYS cite their archetype base rate for their seed tier.
- When comparing two teams, contrast archetype strengths and weaknesses.
- For upset potential, reference upset_rate_as_underdog and 9_to_16 upset_rate_r64.
- Use notable_runs only when the comp is actually relevant, and explain why it matters.
- If an archetype tier has fewer than 10 appearances, flag it as directional.
- Known thin samples: Efficient Half-Court (9 total), Rebounding Bully (69 total), and Standard (310 total but spread thin across tiers).

### 2. Seed Matchup Lookup (seed_matchup_all_rounds.json)
Round-by-round historical records for every seed-vs-seed matchup. Located per prediction under historical_seed_matchup, and standalone at historical/seed_matchup_all_rounds.json.

Structure: {round: {matchup_key: data}} where matchup_key is like "1v16" or "5v12".
Fields per matchup:
- record
- higher_seed_win_pct
- upset_pct
- sample_size
- notable_upsets (up to 3 most recent)
- summary

Rounds available: R64, R32, S16, E8, F4, Championship

How to use:
- ALWAYS cite seed matchup record when analyzing a specific game.
- For upset picks, cross-reference seed matchup upset_pct with underdog archetype upset rates.
- In later rounds, note shrinking sample size and flag sample_size < 5.
- Use notable_upsets to ground analysis in concrete historical examples.

### 3. Comp Context - Primary and Secondary
Each team has a primary comp (t1_comp_context / t2_comp_context) and secondary comp (t1_secondary_comp_context / t2_secondary_comp_context).

Primary and secondary comp fields:
- comp_team, comp_year, comp_seed, comp_result, comp_wins
- similarity
- shared_traits
- comp_outcome_explanation
- lesson_for_current_team
- narrative

How to use:
- Primary comp sets ceiling or floor expectation.
- Secondary comp provides contrast and range of outcomes.
- For "how far will X go?", lead with primary comp result, then frame range with secondary comp.
- Use shared_traits to justify relevance.
- Use lesson_for_current_team for bracket advice.

### 4. Pre-Built Historical Response and Blurb
Each prediction has:
- responses.historical (3-5 sentence blended historical analysis)
- historical_blurb (one-sentence synthesis with confidence signal)

Use historical_blurb for quick summaries and multi-team comparisons.

## Response Integration Rules
1. Every matchup analysis must include at least one historical data point.
2. Cite specific numbers, not vague historical claims.
3. Use both comps to frame range of outcomes.
4. Flag small samples when sample_size < 10 or tier count < 5.
5. Layer archetype + seed matchup + comp into a coherent narrative.
6. Use historical_blurb as lead sentence for multi-team comparisons.
7. Anchor upset strategy with seed matchup upset rate.
8. Use archetype strengths/weaknesses for matchup-specific advice.
9. NEVER invent or interpolate statistics. Every percentage, record, and sample size must come directly from provided context data. If the specific number is missing, say exactly: "historical data is limited here."

HOW TO TALK:
- Casual. Contractions. No corporate speak.
- NEVER say: "based on my analysis", "it's important to note", "it's worth noting", "let's dive in", "certainly", "I'd be happy to", "great question"
- Use basketball language: "chalk pick", "live dog", "fade", "value play", "cinderella", "bracket buster", "trending up"
- Lead with your pick, THEN explain. 2-4 short paragraphs max.
- Exception: if user asks for a full bracket, round-by-round picks, or "fill out my bracket," use the UI #2 bracket layout format block instead of paragraph-only style.
- Bold team names when first mentioned. Don't over-format â€” no bullet point dumps.
- When data shows momentum/injury flags, weave them into the narrative naturally. Don't just list stats.

EXAMPLES OF GOOD RESPONSES:

Q: "Who wins Duke vs Vermont?"
A: "**Duke** cruises. They're a Juggernaut archetype â€” elite on both ends â€” and they're trending up with a 9-1 last-10 record. Vermont's been fading down the stretch (margin dropped 5 pts in the final 5 games, possible injury concern). Duke by 15+, lock it in."

Q: "Best upset pick in the first round?"
A: "Love **New Mexico** as a 10-seed over 7-seed Marquette. The Lobos are rising â€” 8-2 in their last 10, conference tourney champs, and their margin trend is +1.3 pts per game improvement. Marquette's a Glass Cannon with a volatility score of 78 â€” that inconsistency kills you in March. Model gives New Mexico 48%, but the momentum gap makes this closer to a coin flip I'd lean into for a big pool."

Q: "Is Houston safe to go deep?"
A: "**Houston** is the safest bet in the bracket. Fortress archetype â€” elite defense, steady momentum, volatility score of just 22. Their home/away split is tight too, meaning they play the same everywhere. No injury alert. Conference tourney finalists. The only concern is their offense can stall against elite D, but that's a Sweet 16 problem, not a first weekend problem."

CONFIDENCE TIERS:
- 85%+ â†’ "Lock it in"
- 70-85% â†’ "Solid pick"
- 55-70% â†’ "Slight lean"
- 50-55% â†’ "Coin flip â€” go with your gut"

STRATEGY: ESPN scoring 10-20-40-80-160-320. Small pools = chalk. Big pools = need upsets in later rounds for max value.

${poolStrategyPromptBlock()}

If you don't have data on a specific matchup, say so honestly â€” don't make up numbers.`;
}

function detectIntent(message) {
  const lc = String(message || '').toLowerCase();
  if (/value pick|undervalued|beat my pool|contrarian|best bang for buck|who should i pick|value play/.test(lc)) return 'value';
  if (/compare|\bvs\b|versus|matchup|who wins|who would win/.test(lc)) return 'compare';
  if (/\b(south|east|west|midwest)\s+region\b/.test(lc)) return 'region';
  if (/win it all|cut the nets|champion|national title|natty/.test(lc)) return 'champion';
  if (/upset|cinderella|underdog|dark.?horse|sleeper/.test(lc)) return 'upset';
  if (/stats|numbers|probability|elo|kenpom/.test(lc)) return 'stats';
  if (/bracket|pool|strategy|final four|elite 8|round/.test(lc)) return 'bracket';
  return 'quick';
}


function pickContextRows() {
  const c = store.context;
  if (!c) return [];
  if (Array.isArray(c)) return c;
  if (Array.isArray(c.context)) return c.context;
  if (Array.isArray(c.items)) return c.items;
  if (Array.isArray(c.rows)) return c.rows;
  if (Array.isArray(c.entries)) return c.entries;
  if (typeof c === 'object') return [c];
  return [];
}

function parseTeamPairFromQuery(query) {
  const raw = String(query || '').replace(/[?]/g, ' ').trim();
  if (!raw) return null;
  const patterns = [
    /([a-z0-9 .&'â€™-]+?)\s+(?:vs\.?|versus)\s+([a-z0-9 .&'â€™-]+)/i,
    /who\s+would\s+win\s+if\s+([a-z0-9 .&'â€™-]+?)\s+played\s+([a-z0-9 .&'â€™-]+)/i,
  ];
  for (const rx of patterns) {
    const m = raw.match(rx);
    if (m) return [m[1].trim(), m[2].trim()];
  }
  return null;
}

function findPredictionForTeams(teamA, teamB) {
  if (!teamA || !teamB) return null;
  const a = normalizeTeamName(teamA);
  const b = normalizeTeamName(teamB);
  for (const p of store.base?.predictions || []) {
    const t1 = normalizeTeamName(p.t1_name);
    const t2 = normalizeTeamName(p.t2_name);
    if ((t1 === a && t2 === b) || (t1 === b && t2 === a)) return p;
  }
  return null;
}

function findBracketMatchupById(matchupId) {
  return bracketMatchupIndex.byId.get(String(matchupId || '')) || null;
}

function fuzzyTeamKey(rawTeam) {
  const target = normalizeTeamName(rawTeam);
  if (!target) return '';
  if (bracketMatchupIndex.byTeam.has(target)) return target;
  let best = '';
  let bestScore = 0;
  const targetTokens = new Set(target.split(' ').filter(Boolean));
  for (const key of bracketMatchupIndex.byTeam.keys()) {
    let score = 0;
    if (key.includes(target) || target.includes(key)) {
      score += 4;
    }
    const keyTokens = String(key).split(' ').filter(Boolean);
    for (const token of keyTokens) {
      if (targetTokens.has(token)) score += 1;
    }
    if (score > bestScore || (score === bestScore && score > 0 && key.length > best.length)) {
      best = key;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : '';
}

function resolveTeamKey(rawTeam) {
  const target = normalizeTeamName(rawTeam);
  if (!target) return '';
  const bracketKey = fuzzyTeamKey(target);
  if (bracketKey) return bracketKey;
  if (historicalIndex.predictionsByTeam.has(target)) return target;
  let best = '';
  let bestScore = 0;
  const targetTokens = new Set(target.split(' ').filter(Boolean));
  for (const key of historicalIndex.predictionsByTeam.keys()) {
    let score = 0;
    if (key.includes(target) || target.includes(key)) score += 4;
    const keyTokens = String(key).split(' ').filter(Boolean);
    for (const token of keyTokens) {
      if (targetTokens.has(token)) score += 1;
    }
    if (score > bestScore || (score === bestScore && score > 0 && key.length > best.length)) {
      best = key;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : '';
}

function teamFromProfileOrBracket(teamKey, seedFallback) {
  const profile = buildProfileLookup().get(teamKey) || null;
  const rows = bracketMatchupIndex.byTeam.get(teamKey) || [];
  let bracketTeam = null;
  for (const row of rows) {
    const t1Key = normalizeTeamName(row?.t1?.name);
    const t2Key = normalizeTeamName(row?.t2?.name);
    if (t1Key === teamKey) { bracketTeam = row.t1; break; }
    if (t2Key === teamKey) { bracketTeam = row.t2; break; }
  }
  return {
    team_id: profile?.team_id ?? profile?.teamId ?? bracketTeam?.team_id ?? null,
    name: profile?.name || profile?.school || profile?.team || bracketTeam?.name || teamKey,
    seed: Number(profile?.seed ?? bracketTeam?.seed ?? seedFallback ?? 0) || null,
    abbreviation: profile?.abbreviation || profile?.abbr || bracketTeam?.abbreviation || null,
    color_primary: profile?.color_primary || bracketTeam?.color_primary || null,
    win_probability: null,
    predicted_margin: null,
    archetypes: profile?.archetypes || bracketTeam?.archetypes || null,
    key_players: profile?.key_players || profile?.keyPlayers || bracketTeam?.key_players || bracketTeam?.keyPlayers || [],
    primary_comp: profile?.primary_comp || profile?.primaryComp || bracketTeam?.primary_comp || null,
    pool: profile?.pool || bracketTeam?.pool || null,
  };
}

function buildSyntheticMatchup(aKey, bKey) {
  if (!aKey || !bKey || aKey === bKey) return null;
  const pred = findPredictionForTeams(aKey, bKey);
  if (!pred) return null;

  const predT1Key = normalizeTeamName(pred.t1_name);
  const forward = predT1Key === aKey;
  const modelProb = normProb(pred.model_win_prob);
  const aProb = modelProb === null ? null : (forward ? modelProb : (1 - modelProb));
  const bProb = aProb === null ? null : (1 - aProb);
  const baseMargin = Number(pred.predicted_margin || 0);
  const aMargin = forward ? baseMargin : -baseMargin;
  const bMargin = -aMargin;
  const t1 = teamFromProfileOrBracket(aKey, forward ? pred.t1_seed : pred.t2_seed);
  const t2 = teamFromProfileOrBracket(bKey, forward ? pred.t2_seed : pred.t1_seed);
  t1.win_probability = aProb;
  t2.win_probability = bProb;
  t1.predicted_margin = Number.isFinite(aMargin) ? aMargin : null;
  t2.predicted_margin = Number.isFinite(bMargin) ? bMargin : null;

  return {
    matchup_id: `SYNTH_${aKey.replace(/\s+/g, '_')}_${bKey.replace(/\s+/g, '_')}`,
    season: Number(pred.season || bracketMatchupIndex.season || cfg.activeSeason || 2026),
    round: 'Projected',
    region: 'Projected',
    game_number: null,
    t1,
    t2,
    matchup_meta: {
      confidence: pred.confidence || 'projected',
      upset_flag: pred.upset_flag || 'projected',
      display_flag: pred.upset_flag || 'toss_up',
      model_agrees_with_seed: pred.model_agrees_with_seed ?? null,
      predicted_winner: (aProb ?? 0.5) >= 0.5 ? t1.name : t2.name,
      seed_matchup: pred.historical_seed_matchup || null,
      archetype_h2h: null,
      pool_meta: { leverage_delta: Number(pred.value_score || 0) || 0 },
      risk: {
        tier: (aProb === null) ? 'medium' : ((Math.abs((aProb - 0.5)) >= 0.2) ? 'low' : 'medium'),
        reason: 'Projected matchup generated from base model predictions.',
      },
      chatbot_prompt: `Compare ${t1.name} vs ${t2.name} in this projected matchup.`,
    },
  };
}

function findBracketMatchupByTeams(teamA, teamB) {
  const aKey = resolveTeamKey(teamA);
  const bKey = resolveTeamKey(teamB);
  if (!aKey || !bKey) return null;
  const aRows = bracketMatchupIndex.byTeam.get(aKey) || [];
  const bSet = new Set((bracketMatchupIndex.byTeam.get(bKey) || []).map((m) => String(m.matchup_id)));
  const match = aRows.find((row) => bSet.has(String(row.matchup_id)));
  if (match) return match;
  return buildSyntheticMatchup(aKey, bKey);
}

function slimMatchupForContext(matchup) {
  if (!matchup) return null;
  return {
    matchup_id: matchup.matchup_id,
    round: matchup.round,
    region: matchup.region,
    t1: {
      name: matchup.t1?.name,
      seed: matchup.t1?.seed,
      win_probability: matchup.t1?.win_probability,
      predicted_margin: matchup.t1?.predicted_margin,
      archetypes: matchup.t1?.archetypes,
    },
    t2: {
      name: matchup.t2?.name,
      seed: matchup.t2?.seed,
      win_probability: matchup.t2?.win_probability,
      predicted_margin: matchup.t2?.predicted_margin,
      archetypes: matchup.t2?.archetypes,
    },
    confidence: matchup.matchup_meta?.confidence,
    upset_flag: matchup.matchup_meta?.upset_flag,
    display_flag: matchup.matchup_meta?.display_flag,
    risk: matchup.matchup_meta?.risk || null,
    seed_matchup: matchup.matchup_meta?.seed_matchup || null,
    archetype_h2h: matchup.matchup_meta?.archetype_h2h || null,
    chatbot_prompt: matchup.matchup_meta?.chatbot_prompt || '',
  };
}

function bracketOutputRoundKeys() {
  return ['R64', 'R32', 'S16', 'E8', 'F4', 'Championship'];
}

function getChampionProbMap() {
  if (!store.bracketOutput || typeof store.bracketOutput !== 'object') return {};
  const nested = store.bracketOutput?.bracket_structure?.champion_probs;
  if (nested && typeof nested === 'object') return nested;
  const topLevel = store.bracketOutput?.champion_probs;
  if (topLevel && typeof topLevel === 'object') return topLevel;
  return {};
}

function getScoringMap() {
  const fallback = { R64: 10, R32: 20, S16: 40, E8: 80, F4: 160, Championship: 320 };
  const s = store.bracketOutput?.metadata?.scoring;
  if (!s || typeof s !== 'object') return fallback;
  return {
    R64: Number(s.R64 || fallback.R64),
    R32: Number(s.R32 || fallback.R32),
    S16: Number(s.S16 || fallback.S16),
    E8: Number(s.E8 || fallback.E8),
    F4: Number(s.F4 || fallback.F4),
    Championship: Number(s.Championship || fallback.Championship),
  };
}

function buildTeamEpBreakdown(teamName) {
  const out = { R64: 0, R32: 0, S16: 0, E8: 0, F4: 0, Championship: 0, total: 0 };
  const normalized = normalizeTeamName(teamName);
  if (!normalized || !store.bracketOutput?.strategies) return out;
  for (const strategy of Object.values(store.bracketOutput.strategies || {})) {
    for (const key of bracketOutputRoundKeys()) {
      const picks = strategy?.rounds?.[key] || [];
      for (const pick of picks) {
        if (normalizeTeamName(pick?.pick) !== normalized) continue;
        const ep = Number(pick?.ep || 0);
        if (ep > out[key]) out[key] = ep;
      }
    }
  }
  out.total = Number((out.R64 + out.R32 + out.S16 + out.E8 + out.F4 + out.Championship).toFixed(2));
  return out;
}

function formatExpectedPointsContext(bracketState) {
  if (!store.bracketOutput) return '';
  const picks = bracketState?.picks && typeof bracketState.picks === 'object' ? bracketState.picks : {};
  const uniqueTeams = Array.from(new Set(Object.values(picks || {}).map((v) => String(v || '').trim()).filter(Boolean)));
  const score = getScoringMap();
  const lines = [];
  lines.push('EXPECTED POINTS CONTEXT:');
  lines.push(`Scoring: R64=${score.R64}, R32=${score.R32}, S16=${score.S16}, E8=${score.E8}, F4=${score.F4}, Championship=${score.Championship}`);
  if (!uniqueTeams.length) {
    lines.push('No user picks yet.');
    return lines.join('\n');
  }
  const sampled = uniqueTeams.slice(0, 16);
  const championProbs = getChampionProbMap();
  for (const team of sampled) {
    const ep = buildTeamEpBreakdown(team);
    const champProb = Number(championProbs?.[team] || 0);
    lines.push(`${team} EP breakdown: R64=${ep.R64.toFixed(2)}, R32=${ep.R32.toFixed(2)}, S16=${ep.S16.toFixed(2)}, Total=${ep.total.toFixed(2)} | Champion probability: ${(champProb * 100).toFixed(2)}%`);
  }
  return lines.join('\n');
}

function formatBracketStateContext(bracketState, focusMatchup) {
  if (!bracketState || typeof bracketState !== 'object') return '';
  const picks = bracketState.picks && typeof bracketState.picks === 'object' ? bracketState.picks : {};
  const pickIds = Object.keys(picks);
  const completed = Number(bracketState.completion?.total || pickIds.length || 0);
  const completionPct = Math.round((completed / 63) * 100);
  const pickedLines = [];
  for (const matchupId of pickIds.slice(0, 24)) {
    const winner = picks[matchupId];
    const matchup = findBracketMatchupById(matchupId);
    const loser = matchup?.t1?.name === winner ? matchup?.t2?.name : matchup?.t1?.name;
    const round = matchup?.round || 'Round';
    pickedLines.push(`- ${winner} over ${loser || 'opponent TBD'} (${round})`);
  }
  if (!pickedLines.length) pickedLines.push('- No picks submitted yet.');

  const remainingLines = [];
  for (const matchup of (store.bracketMatchups?.matchups || [])) {
    if (matchup?.round !== 'R64') continue;
    if (picks[matchup.matchup_id]) continue;
    const favorite = (Number(matchup.t1?.win_probability || 0) >= Number(matchup.t2?.win_probability || 0)) ? matchup.t1 : matchup.t2;
    const favPct = Number(favorite?.win_probability || 0) * 100;
    remainingLines.push(`- ${matchup.t1?.name} vs ${matchup.t2?.name} (R64) - model says ${favorite?.name || 'favorite'} ${favPct.toFixed(1)}%`);
    if (remainingLines.length >= 12) break;
  }
  if (!remainingLines.length) remainingLines.push('- None in R64.');

  const activeStrategy = String(
    bracketState.activeStrategy || bracketState.strategy || bracketState.selectedStrategy || ''
  ).trim();

  let focusBlock = '';
  if (focusMatchup) {
    const focus = findBracketMatchupById(focusMatchup) || null;
    if (focus) {
      focusBlock = `\nFOCUS_MATCHUP:\n${JSON.stringify(slimMatchupForContext(focus), null, 0)}\n`;
    }
  }

  const epBlock = formatExpectedPointsContext(bracketState);

  return `=== USER'S BRACKET STATUS ===
Completion: ${completed}/63 picks (${completionPct}%)
Active strategy: ${activeStrategy || 'custom/manual'}
Current picks so far:
${pickedLines.join('\n')}

Remaining unpicked games in current view:
${remainingLines.join('\n')}
${focusBlock}
${epBlock}
When giving advice, reference existing picks and how new picks interact with this bracket strategy.`;
}

function formatUi2BracketLayoutContext() {
  const regionOrder = (Array.isArray(bracketMatchupIndex.regions) && bracketMatchupIndex.regions.length)
    ? bracketMatchupIndex.regions
    : REGION_ORDER_2026.slice();
  return `UI2_BRACKET_LAYOUT_RULES:
- When user asks for full bracket output or round-by-round picks, follow this exact layout.
- Region order: ${regionOrder.join(', ')}
- In each region, present picks in this progression: R64 -> R32 -> S16 -> E8
- Then present national rounds: F4 (two games) -> Championship (one game)
- Use official team names from bracket data; do not invent aliases.
- Do not add extra rounds or alternate bracket structures.`;
}

function findEvByTeamName(teamName) {
  const name = normalizeTeamName(teamName);
  const teams = store.ev?.teams || store.ev?.data || (Array.isArray(store.ev) ? store.ev : []);
  return teams.find((t) => normalizeTeamName(t.name) === name) || null;
}

function isRealBracketMatchup(teamA, teamB) {
  const a = normalizeTeamName(teamA);
  const b = normalizeTeamName(teamB);
  if (!a || !b) return false;
  return getAuthoritativeR64Matchups().some((m) => {
    const t1 = normalizeTeamName(m?.t1?.name || '');
    const t2 = normalizeTeamName(m?.t2?.name || '');
    return (t1 === a && t2 === b) || (t1 === b && t2 === a);
  });
}

function getAuthoritativeR64Matchups() {
  const primary = Array.isArray(store.bracketMatchups?.matchups) ? store.bracketMatchups.matchups : [];
  const fallback = Array.from(bracketMatchupIndex.byId.values());
  const source = primary.length ? primary : fallback;
  const out = [];
  const seen = new Set();
  for (const row of source) {
    if (!row || !isR64Round(row.round)) continue;
    const id = String(row.matchup_id || '');
    const key = id || `${normalizeTeamName(row?.t1?.name || '')}|${normalizeTeamName(row?.t2?.name || '')}|${String(row.region || '')}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  const regionOrder = (Array.isArray(bracketMatchupIndex.regions) && bracketMatchupIndex.regions.length)
    ? bracketMatchupIndex.regions
    : REGION_ORDER_2026;
  const regionRank = new Map(regionOrder.map((region, idx) => [String(region || '').toLowerCase(), idx]));
  out.sort((a, b) => {
    const ar = regionRank.has(String(a?.region || '').toLowerCase()) ? regionRank.get(String(a?.region || '').toLowerCase()) : 999;
    const br = regionRank.has(String(b?.region || '').toLowerCase()) ? regionRank.get(String(b?.region || '').toLowerCase()) : 999;
    if (ar !== br) return ar - br;
    const ag = Number(a?.game_number ?? 999);
    const bg = Number(b?.game_number ?? 999);
    if (ag !== bg) return ag - bg;
    return String(a?.matchup_id || '').localeCompare(String(b?.matchup_id || ''));
  });
  return out;
}

function buildUpsetMatchupGuardrailContext() {
  const rows = getAuthoritativeR64Matchups();
  if (!rows.length) {
    return `UPSET_MATCHUP_GUARDRAIL:
- Round of 64 authoritative matchup list is unavailable.
- Never invent first-round pairings; if unclear, explicitly say matchup data is unavailable.`;
  }
  const lines = rows.map((m) => {
    const s1 = Number(m?.t1?.seed);
    const s2 = Number(m?.t2?.seed);
    const seed1 = Number.isFinite(s1) ? s1 : '?';
    const seed2 = Number.isFinite(s2) ? s2 : '?';
    return `- ${m.matchup_id || 'R64'}: (${seed1}) ${m?.t1?.name || 'TBD'} vs (${seed2}) ${m?.t2?.name || 'TBD'} [${m?.region || 'Unknown'}]`;
  });
  return `UPSET_MATCHUP_GUARDRAIL:
- For upset lists, use ONLY these Round of 64 pairings.
- Never combine teams from different matchup_id rows.
- If user suggests an invalid pairing, correct it directly using this list.
AUTHORITATIVE_R64_MATCHUPS:
${lines.join('\n')}`;
}

function findCtx(query, opts = {}) {
  const ctx = [];
  const lc = (query || '').toLowerCase();

  // Context config with defaults
  const c = typeof contextCfg === 'function' ? contextCfg() : {
    maxItems: 25,
    includeTeamProfiles: true,
    upsetItems: 8,
    includeOptimizer: true,
    optimizerItems: 5,
    includeTitleAngles: true,
    titleSeedCutoff: 3,
  };

  // Team profiles
  const profilesRaw = store.teams?.profiles || store.teams?.teams || (Array.isArray(store.teams) ? store.teams : []);
  const profiles = Array.isArray(profilesRaw) ? profilesRaw : [];
  if (c.includeTeamProfiles !== false) {
    for (const t of profiles) {
      const name = (t.name || t.school || '').toLowerCase();
      if (name && lc.includes(name)) ctx.push({ type: 'team', data: t });
    }
  }

  // Bracket games (if loaded)
  const bracketGamesRaw = store.bracket?.games || store.bracket?.predictions || [];
  const bracketGames = Array.isArray(bracketGamesRaw) ? bracketGamesRaw : [];
  const bracketMatchupsRaw = store.bracketMatchups?.matchups || [];
  const bracketMatchups = Array.isArray(bracketMatchupsRaw) ? bracketMatchupsRaw : [];
  const basePredictions = Array.isArray(store.base?.predictions) ? store.base.predictions : [];

  const parsedPair = parseTeamPairFromQuery(query);
  if (parsedPair) {
    const pairMatchup = findBracketMatchupByTeams(parsedPair[0], parsedPair[1]);
    if (pairMatchup) ctx.push({ type: 'matchup', data: pairMatchup });
  }

  // Matchup search in bracket pick-card data
  for (const m of bracketMatchups) {
    const t1 = normalizeTeamName(m?.t1?.name);
    const t2 = normalizeTeamName(m?.t2?.name);
    let hit = (t1 && lc.includes(t1)) || (t2 && lc.includes(t2));
    if (!hit && t1 && t2) hit = lc.includes(`${t1} vs ${t2}`) || lc.includes(`${t2} vs ${t1}`);
    if (hit) ctx.push({ type: 'matchup', data: m });
  }

  // Prediction search across all models
  for (const model of ['base', 'upset', 'floor']) {
    const modelPredictions = Array.isArray(store[model]?.predictions) ? store[model].predictions : [];
    for (const p of modelPredictions) {
      const t1 = (p.t1_name || '').toLowerCase();
      const t2 = (p.t2_name || '').toLowerCase();
      let hit = (t1 && lc.includes(t1)) || (t2 && lc.includes(t2));

      // Seed-based matching
      if (!hit) {
        const m = lc.match(/(\d+)\s*(?:seed|vs|versus)/);
        if (m && (p.t1_seed === +m[1] || p.t2_seed === +m[1])) hit = true;
      }

      // Archetype matching
      if (!hit && /juggernaut|fortress|glass.cannon|gunslinger|grinder|wall|crusher|lockdown|sniper|sharpshooter/.test(lc)) {
        const a1 = (p.t1_archetype || '').toLowerCase();
        const a2 = (p.t2_archetype || '').toLowerCase();
        if (lc.includes(a1.replace('the ', '')) || lc.includes(a2.replace('the ', ''))) hit = true;
      }

      if (hit) ctx.push({ type: 'pred', model, data: p });
    }
  }

  // V5: Momentum/trending queries â€” find teams that are rising or fading
  if (/momentum|trending|hot|cold|streak|surge|slump|fading|rising|peaking|form/.test(lc)) {
    for (const p of basePredictions) {
      const fr = p.form_and_risk || {};
      const t1_rising = fr.t1_momentum === 'rising';
      const t2_rising = fr.t2_momentum === 'rising';
      const t1_fading = fr.t1_momentum === 'fading';
      const t2_fading = fr.t2_momentum === 'fading';

      if (/hot|rising|surge|peaking|trending.up/.test(lc) && (t1_rising || t2_rising)) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      } else if (/cold|fading|slump|declining/.test(lc) && (t1_fading || t2_fading)) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      } else if (/momentum|form|trending/.test(lc) && (t1_rising || t2_rising || t1_fading || t2_fading)) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  // V5: Injury/risk queries
  if (/injur|hurt|risk|concern|health|questionable|doubtful|alert|monitor/.test(lc)) {
    for (const p of basePredictions) {
      const fr = p.form_and_risk || {};
      if (fr.t1_injury_alert || fr.t2_injury_alert) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  // V5: Volatility/variance queries
  if (/volatil|variance|inconsisten|unpredictable|wild.card|chaos|bust|reliable|steady|consistent|safe/.test(lc)) {
    for (const p of basePredictions) {
      const fr = p.form_and_risk || {};
      const v1 = fr.t1_volatility_score || 0;
      const v2 = fr.t2_volatility_score || 0;
      if (/safe|reliable|steady|consistent/.test(lc) && (v1 < 30 || v2 < 30)) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      } else if (/volatil|wild|chaos|bust|unpredictable|inconsisten/.test(lc) && (v1 > 60 || v2 > 60)) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  // V5: Conference tourney champion queries
  if (/conference.tourn|conf.champ|conf.winner|tournament.champ/.test(lc)) {
    for (const p of basePredictions) {
      const fr = p.form_and_risk || {};
      if (fr.t1_conf_tourney_result === 'champion' || fr.t2_conf_tourney_result === 'champion') {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  // Upset queries
  if (/upset|cinderella|underdog|dark.?horse|sleeper|bust/.test(lc)) {
    const limit = c.upsetItems || 8;
    const r64 = getAuthoritativeR64Matchups();
    const ranked = r64
      .map((m) => {
        const s1 = Number(m?.t1?.seed);
        const s2 = Number(m?.t2?.seed);
        const p1 = Number(m?.t1?.win_probability);
        const p2 = Number(m?.t2?.win_probability);
        const t1Dog = Number.isFinite(s1) && Number.isFinite(s2) ? s1 > s2 : false;
        const dogProbRaw = t1Dog ? p1 : p2;
        const dogProb = Number.isFinite(dogProbRaw) ? dogProbRaw : 0;
        const seedGap = Number.isFinite(s1) && Number.isFinite(s2) ? Math.abs(s1 - s2) : 0;
        const upsetFlag = String(m?.matchup_meta?.upset_flag || '').toLowerCase();
        const upsetBoost = upsetFlag && upsetFlag !== 'chalk' ? 0.2 : 0;
        const score = dogProb + upsetBoost + (seedGap >= 3 ? 0.05 : 0);
        return { matchup: m, dogProb, upsetFlag, score };
      })
      .sort((a, b) => b.score - a.score);
    const chosen = [];
    const chosenIds = new Set();
    for (const item of ranked) {
      const id = String(item?.matchup?.matchup_id || '');
      const looksUpset = item.dogProb >= 0.33 || (item.upsetFlag && item.upsetFlag !== 'chalk');
      if (!looksUpset || chosenIds.has(id)) continue;
      chosen.push(item.matchup);
      chosenIds.add(id);
      if (chosen.length >= limit) break;
    }
    if (chosen.length < limit) {
      for (const item of ranked) {
        const id = String(item?.matchup?.matchup_id || '');
        if (chosenIds.has(id)) continue;
        chosen.push(item.matchup);
        chosenIds.add(id);
        if (chosen.length >= limit) break;
      }
    }
    for (const m of chosen) {
      ctx.push({ type: 'matchup', data: m });
      const pred = findPredictionForTeams(m?.t1?.name, m?.t2?.name);
      if (pred) ctx.push({ type: 'pred', model: 'base', data: pred });
    }
    if (!chosen.length) {
      for (const p of basePredictions) {
        if (!isRealBracketMatchup(p?.t1_name, p?.t2_name)) continue;
        if (p.upset_flag && p.upset_flag !== '' && p.upset_flag !== 'chalk') {
          ctx.push({ type: 'pred', model: 'base', data: p });
          if (ctx.length >= limit) break;
        }
      }
    }
  }

  // Bracket structure queries
  if (/bracket|region|draw|path|south|east|midwest|west/.test(lc)) {
    for (const g of bracketGames) {
      if (g.round === 'Round of 64') ctx.push({ type: 'bracket', data: g });
    }
  }

  // Optimizer / strategy queries
  if (c.includeOptimizer !== false && /bracket|strateg|pool|optim|espn|points/.test(lc)) {
    const optimizerResults = Array.isArray(store.optimizer?.results) ? store.optimizer.results : [];
    for (const o of optimizerResults.slice(0, c.optimizerItems || 5)) {
      ctx.push({ type: 'opt', data: o });
    }
  }

  // Final Four / champion queries
  if (/final.four|champ|win.it.all|natty|title|favorite/.test(lc)) {
    for (const g of bracketGames) {
      if ((g.seed1 || 99) <= (c.titleSeedCutoff || 3) || (g.seed2 || 99) <= (c.titleSeedCutoff || 3)) {
        ctx.push({ type: 'bracket', data: g });
      }
    }
    // Also surface base predictions for top seeds
    for (const p of basePredictions) {
      if ((p.t1_seed || 99) <= 2 && (p.t2_seed || 99) <= 2) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  // Base dedupe before optimization
  const seen = new Set();
  const deduped = ctx.filter((item) => {
    const key = ctxFingerprint(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (c.autoOptimize === false) {
    return deduped.slice(0, c.maxItems || 25);
  }

  return optimizeCtx(deduped, query, { ...opts, cfg: c });
}

function classifyHistoricalQuery(message) {
  const msg = String(message || '').toLowerCase();
  const isFinalFour = /final\s*four|final\s*4|\bf4\b/.test(msg);
  const isEliteEight = /elite\s*(eight|8)|\be8\b/.test(msg);
  const isUpsets = /upset|cinderella|bust|sleeper|underdog/.test(msg);
  const isChampion = /champion|win\s*it\s*all|title|natty|cut the nets/.test(msg);
  const isCompare = /compare|rank|versus|\bvs\b|which/.test(msg);
  const seedMatches = Array.from(msg.matchAll(/\b([1-9]|1[0-6])\s*-?\s*seed\b/g)).map((m) => Number(m[1]));
  return { isFinalFour, isEliteEight, isUpsets, isChampion, isCompare, seedMatches };
}

function detectMentionedTeamsFromQuery(message) {
  const normalized = normalizeTeamName(message);
  const mentioned = [];
  for (const teamName of historicalIndex.teamNames) {
    if (normalized.includes(teamName)) mentioned.push(teamName);
    if (mentioned.length >= 8) break;
  }

  const parsedPair = parseTeamPairFromQuery(message) || [];
  for (const rawTeam of parsedPair) {
    const norm = normalizeTeamName(rawTeam);
    if (!norm) continue;
    if (historicalIndex.predictionsByTeam.has(norm) && !mentioned.includes(norm)) {
      mentioned.push(norm);
      continue;
    }
    const fallback = historicalIndex.teamNames.find((name) => name.includes(norm) || norm.includes(name));
    if (fallback && !mentioned.includes(fallback)) mentioned.push(fallback);
  }

  return mentioned.slice(0, 8);
}

function maxPredictionsForQuery(flags, mentionedTeams, userMessage) {
  const parsedPair = parseTeamPairFromQuery(userMessage || '');
  if (Array.isArray(parsedPair) && parsedPair.length >= 2) return 3;
  if (mentionedTeams.length === 1) return 8;
  if (flags.isUpsets) return 20;
  if (flags.isChampion || flags.isFinalFour) return 25;
  if (flags.isEliteEight) return 30;
  return 20;
}

function slimHistoricalPrediction(pred) {
  const slim = {
    t1_name: pred.t1_name,
    t1_seed: pred.t1_seed,
    t2_name: pred.t2_name,
    t2_seed: pred.t2_seed,
    predicted_winner_name: pred.predicted_winner_name,
    model_win_prob: pred.model_win_prob,
    confidence: pred.confidence,
    upset_flag: pred.upset_flag,
    value_score: pred.value_score,
  };

  if (Array.isArray(pred.t1_archetypes)) slim.t1_archetypes = pred.t1_archetypes;
  if (Array.isArray(pred.t2_archetypes)) slim.t2_archetypes = pred.t2_archetypes;
  if (pred.t1_archetype) slim.t1_archetype = pred.t1_archetype;
  if (pred.t2_archetype) slim.t2_archetype = pred.t2_archetype;
  if (pred.t1_archetype_history) slim.t1_archetype_history = pred.t1_archetype_history;
  if (pred.t2_archetype_history) slim.t2_archetype_history = pred.t2_archetype_history;
  if (pred.historical_seed_matchup) slim.historical_seed_matchup = pred.historical_seed_matchup;
  if (pred.t1_comp_context) slim.t1_comp_context = pred.t1_comp_context;
  if (pred.t2_comp_context) slim.t2_comp_context = pred.t2_comp_context;
  if (pred.t1_secondary_comp_context) slim.t1_secondary_comp_context = pred.t1_secondary_comp_context;
  if (pred.t2_secondary_comp_context) slim.t2_secondary_comp_context = pred.t2_secondary_comp_context;
  if (pred.historical_blurb) slim.historical_blurb = pred.historical_blurb;
  if (pred.responses?.historical) slim.responses = { historical: pred.responses.historical };
  if (pred.form_and_risk) slim.form_and_risk = pred.form_and_risk;
  if (Array.isArray(pred.key_factors)) slim.key_factors = pred.key_factors.slice(0, 4);

  return slim;
}

function buildSeedMatchupSubset(predictions) {
  const rounds = ['R64', 'R32', 'S16', 'E8', 'F4', 'Championship'];
  const out = {};
  const seedMatchups = historicalIndex.seedMatchups || {};
  for (const pred of predictions) {
    const s1 = Number(pred.t1_seed);
    const s2 = Number(pred.t2_seed);
    if (!Number.isFinite(s1) || !Number.isFinite(s2)) continue;
    const higher = Math.min(s1, s2);
    const lower = Math.max(s1, s2);
    const key = `${higher}v${lower}`;
    for (const round of rounds) {
      const row = seedMatchups?.[round]?.[key];
      if (!row) continue;
      if (!out[round]) out[round] = {};
      out[round][key] = row;
      break;
    }
  }
  return out;
}

function getRelevantHistoricalContext(userMessage) {
  // Extract intents and teams first for better cache key
  const flags = classifyHistoricalQuery(userMessage);
  const mentionedTeams = detectMentionedTeamsFromQuery(userMessage);
  
  // Build cache key from extracted intents and teams instead of raw message
  const cacheKeyParts = [
    flags.isUpsets ? 'upsets' : '',
    flags.isFinalFour ? 'ff' : '',
    flags.isChampion ? 'champ' : '',
    flags.isEliteEight ? 'e8' : '',
    flags.isCompare ? 'compare' : '',
    ...mentionedTeams.map(t => normalizeTeamName(t))
  ].filter(Boolean);
  const cacheKey = cacheKeyParts.join('|');
  
  if (cacheKey && historicalIndex.contextCache.has(cacheKey)) {
    return historicalIndex.contextCache.get(cacheKey);
  }
  const seen = new Set();
  const relevantPreds = [];
  const addPred = (pred) => {
    const fp = predictionFingerprint(pred);
    if (!fp || seen.has(fp)) return;
    seen.add(fp);
    relevantPreds.push(pred);
  };

  for (const team of mentionedTeams) {
    for (const pred of (historicalIndex.predictionsByTeam.get(team) || [])) {
      if (flags.isUpsets && !isRealBracketMatchup(pred?.t1_name, pred?.t2_name)) continue;
      addPred(pred);
    }
  }

  if (flags.isFinalFour || flags.isChampion) {
    for (let seed = 1; seed <= 4; seed += 1) {
      for (const pred of (historicalIndex.predictionsBySeed.get(seed) || [])) addPred(pred);
    }
  }

  if (flags.isEliteEight) {
    for (let seed = 1; seed <= 5; seed += 1) {
      for (const pred of (historicalIndex.predictionsBySeed.get(seed) || [])) addPred(pred);
    }
  }

  if (flags.isUpsets) {
    const beforeUpsetAdds = relevantPreds.length;
    const r64 = getAuthoritativeR64Matchups();
    for (const matchup of r64) {
      const pred = findPredictionForTeams(matchup?.t1?.name, matchup?.t2?.name);
      if (pred) addPred(pred);
    }
    if (relevantPreds.length === beforeUpsetAdds) {
      for (let seed = 5; seed <= 16; seed += 1) {
        for (const pred of (historicalIndex.predictionsBySeed.get(seed) || [])) {
          if (!isRealBracketMatchup(pred?.t1_name, pred?.t2_name)) continue;
          addPred(pred);
        }
      }
    }
  }

  for (const seedNum of flags.seedMatches) {
    for (const pred of (historicalIndex.predictionsBySeed.get(seedNum) || [])) {
      if (flags.isUpsets && !isRealBracketMatchup(pred?.t1_name, pred?.t2_name)) continue;
      addPred(pred);
    }
  }

  if (!relevantPreds.length) {
    for (let seed = 1; seed <= 4; seed += 1) {
      for (const pred of (historicalIndex.predictionsBySeed.get(seed) || [])) addPred(pred);
    }
  }

  const maxPreds = maxPredictionsForQuery(flags, mentionedTeams, userMessage);
  const cappedPreds = relevantPreds.slice(0, maxPreds);
  const archetypes = new Set();
  for (const pred of cappedPreds) {
    const t1List = Array.isArray(pred.t1_archetypes) ? pred.t1_archetypes : [pred.t1_archetype];
    const t2List = Array.isArray(pred.t2_archetypes) ? pred.t2_archetypes : [pred.t2_archetype];
    for (const a of t1List) if (a) archetypes.add(String(a));
    for (const a of t2List) if (a) archetypes.add(String(a));
  }

  const filteredArchetypes = {};
  for (const archetype of archetypes) {
    if (historicalIndex.archetypeHistory?.[archetype]) {
      filteredArchetypes[archetype] = historicalIndex.archetypeHistory[archetype];
    }
  }

  const context = {
    predictions: cappedPreds.map(slimHistoricalPrediction),
    archetype_history: filteredArchetypes,
    seed_matchups: buildSeedMatchupSubset(cappedPreds),
    query_type: {
      mentionedTeams,
      isFinalFour: flags.isFinalFour,
      isEliteEight: flags.isEliteEight,
      isUpsets: flags.isUpsets,
      isChampion: flags.isChampion,
      isCompare: flags.isCompare,
    },
  };

  if (cacheKey) {
    if (historicalIndex.contextCache.size >= 200) {
      const firstKey = historicalIndex.contextCache.keys().next().value;
      if (firstKey) historicalIndex.contextCache.delete(firstKey);
    }
    historicalIndex.contextCache.set(cacheKey, context);
  }
  return context;
}

function alignHistoricalContextToUiProbabilities(historicalCtx) {
  if (!historicalCtx || typeof historicalCtx !== 'object') return historicalCtx;
  const predictions = Array.isArray(historicalCtx.predictions) ? historicalCtx.predictions : [];
  if (!predictions.length) return historicalCtx;

  let changed = false;
  const alignedPredictions = predictions.map((pred) => {
    const matchup = findBracketMatchupByTeams(pred?.t1_name, pred?.t2_name);
    if (!matchup) return pred;

    const predT1 = normalizeTeamName(pred?.t1_name || '');
    const matchT1 = normalizeTeamName(matchup?.t1?.name || '');
    const matchT2 = normalizeTeamName(matchup?.t2?.name || '');

    let uiProbForPredT1 = Number(matchup?.t1?.win_probability);
    if (predT1 && predT1 === matchT2) {
      uiProbForPredT1 = Number(matchup?.t2?.win_probability);
    } else if (predT1 && predT1 !== matchT1 && predT1 !== matchT2) {
      return pred;
    }
    if (!Number.isFinite(uiProbForPredT1)) return pred;

    changed = true;
    return {
      ...pred,
      model_win_prob: uiProbForPredT1,
      predicted_winner_name: uiProbForPredT1 >= 0.5 ? pred?.t1_name : pred?.t2_name,
      ui_probability_source: 'bracket_matchup_cards',
    };
  });

  if (!changed) return historicalCtx;
  return { ...historicalCtx, predictions: alignedPredictions };
}

function ctxFingerprint(item) {
  if (!item || !item.type) return '';
  if (item.type === 'pred') {
    const p = item.data || {};
    return `pred:${item.model || 'x'}:${normalizeTeamName(p.t1_name)}:${normalizeTeamName(p.t2_name)}:${p.t1_seed || ''}:${p.t2_seed || ''}`;
  }
  if (item.type === 'team') {
    const t = item.data || {};
    return `team:${normalizeTeamName(t.name || t.school || t.team)}`;
  }
  if (item.type === 'bracket') {
    const g = item.data || {};
    return `bracket:${g.round || ''}:${normalizeTeamName(g.team1)}:${normalizeTeamName(g.team2)}:${g.region || ''}`;
  }
  if (item.type === 'opt') {
    const o = item.data || {};
    return `opt:${normalizeTeamName(o.team || o.name || o.school)}:${o.seed || ''}:${o.round || ''}`;
  }
  if (item.type === 'matchup') {
    const m = item.data || {};
    return `matchup:${m.matchup_id || ''}:${normalizeTeamName(m.t1?.name)}:${normalizeTeamName(m.t2?.name)}`;
  }
  return JSON.stringify(item);
}

function scoreCtxItem(item, lc, intent) {
  let score = 0;

  if (item.type === 'pred') score += 5;
  if (item.type === 'bracket') score += 4;
  if (item.type === 'matchup') score += 6;
  if (item.type === 'team') score += 3;
  if (item.type === 'opt') score += 2;

  if (item.type === 'pred') {
    const p = item.data || {};
    const t1 = String(p.t1_name || '').toLowerCase();
    const t2 = String(p.t2_name || '').toLowerCase();
    if (t1 && lc.includes(t1)) score += 8;
    if (t2 && lc.includes(t2)) score += 8;
    if (p.upset_flag && /upset|cinderella|underdog|dark.?horse|sleeper/.test(lc)) score += 6;
    const fr = p.form_and_risk || {};
    if ((fr.t1_injury_alert || fr.t2_injury_alert) && /injur|hurt|health|risk|concern/.test(lc)) score += 6;
    const volatile = (fr.t1_volatility_score || 0) > 60 || (fr.t2_volatility_score || 0) > 60;
    if (volatile && /volatil|variance|chaos|wild|upset/.test(lc)) score += 5;
  }

  if (item.type === 'team') {
    const t = item.data || {};
    const name = String(t.name || t.school || '').toLowerCase();
    if (name && lc.includes(name)) score += 7;
  }

  if (item.type === 'bracket') {
    const g = item.data || {};
    if ((g.round || '').toLowerCase().includes('round of 64') && /upset|first round|round of 64/.test(lc)) score += 3;
    if ((g.region || '').toLowerCase() && lc.includes(String(g.region || '').toLowerCase())) score += 5;
  }

  if (item.type === 'opt' && /pool|strateg|espn|points|optimi|value/.test(lc)) score += 5;
  if (item.type === 'matchup') {
    const m = item.data || {};
    const t1 = String(m.t1?.name || '').toLowerCase();
    const t2 = String(m.t2?.name || '').toLowerCase();
    if (t1 && lc.includes(t1)) score += 9;
    if (t2 && lc.includes(t2)) score += 9;
    if (/vs|versus|matchup|who wins|pick/.test(lc)) score += 6;
  }

  if (intent === 'compare' && item.type === 'pred') score += 4;
  if (intent === 'upset' && (item.type === 'pred' || item.type === 'bracket')) score += 4;
  if (intent === 'bracket' && item.type === 'bracket') score += 4;
  if (intent === 'value' && item.type === 'opt') score += 6;
  if (intent === 'champion' && item.type === 'bracket') score += 3;

  return score;
}

function optimizeCtx(ctx, query, opts = {}) {
  const c = opts.cfg || contextCfg();
  const intent = opts.intent || detectIntent(query);
  const messageCount = Number(opts.messageCount || 1);
  const lc = String(query || '').toLowerCase();
  const tokenishLen = lc.split(/\s+/).filter(Boolean).length;

  let limit = c.maxItems || 20;
  if (intent === 'compare') limit = Math.min(limit, 14);
  if (intent === 'quick') limit = Math.max(8, Math.min(limit, 12));
  if (intent === 'value') limit = Math.min(limit, 18);
  if (intent === 'upset') limit = Math.min(limit + 2, 24);
  if (intent === 'bracket' || intent === 'champion' || intent === 'region') limit = Math.min(limit + 3, 26);
  if (tokenishLen > 60) limit = Math.max(8, limit - 3);
  if (messageCount > 12) limit = Math.max(8, limit - 2);

  const unique = [];
  const seen = new Set();
  for (const item of ctx) {
    const fp = ctxFingerprint(item);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    unique.push(item);
  }

  const scored = unique
    .map((item) => ({ item, score: scoreCtxItem(item, lc, intent) }))
    .sort((a, b) => b.score - a.score);

  // Keep type diversity: avoid flooding with only one type.
  const typeCaps = {
    matchup: Math.max(2, Math.floor(limit * 0.35)),
    pred: Math.max(4, Math.floor(limit * 0.65)),
    bracket: Math.max(2, Math.floor(limit * 0.4)),
    team: Math.max(2, Math.floor(limit * 0.35)),
    opt: Math.max(1, Math.floor(limit * 0.25)),
  };
  const typeCount = { matchup: 0, pred: 0, bracket: 0, team: 0, opt: 0 };
  const selected = [];
  const deferred = [];

  for (const row of scored) {
    const t = row.item.type;
    if (typeCaps[t] !== undefined && typeCount[t] >= typeCaps[t]) {
      deferred.push(row.item);
      continue;
    }
    selected.push(row.item);
    if (typeCount[t] !== undefined) typeCount[t] += 1;
    if (selected.length >= limit) return selected;
  }

  for (const item of deferred) {
    selected.push(item);
    if (selected.length >= limit) break;
  }

  return selected;
}

const SUPPORTED_SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);

function seedKey(seed) {
  return `seed_${seed}`;
}

function requiredSeedHeaders() {
  return SUPPORTED_SEEDS.map((seed) => `### SEED_${seed}`);
}

function fmtCtx(ctx) {
  return ctx.map((item) => {
    if (item.type === 'team') {
      return 'TEAM: ' + JSON.stringify(item.data);
    }

    if (item.type === 'pred') {
      const p = item.data;
      const uiMatchup = findBracketMatchupByTeams(p?.t1_name, p?.t2_name);
      const p1Ui = Number(uiMatchup?.t1?.win_probability);
      const p2Ui = Number(uiMatchup?.t2?.win_probability);
      const predT1 = normalizeTeamName(p?.t1_name || '');
      const uiT2 = normalizeTeamName(uiMatchup?.t2?.name || '');
      let uiProbForPredT1 = p1Ui;
      if (predT1 && predT1 === uiT2) uiProbForPredT1 = p2Ui;
      const useUi = Number.isFinite(uiProbForPredT1);
      const resolvedP1 = useUi ? uiProbForPredT1 : Number(p?.model_win_prob || 0.5);
      const prob = Math.max(resolvedP1, 1 - resolvedP1);
      const winner = resolvedP1 >= 0.5 ? p.t1_name : p.t2_name;

      // Base prediction line
      let line = `[${item.model}] (${p.t1_seed})${p.t1_name} vs (${p.t2_seed})${p.t2_name}`;
      line += ` â†’ ${winner} ${(prob * 100).toFixed(0)}% ${p.confidence || ''}`;

      if (useUi) line += ' [UI_PROB]';
      if (p.upset_flag) line += ` ${p.upset_flag}`;

      // Archetype info
      if (p.t1_archetype || p.t2_archetype) {
        line += ` | Archetypes: ${p.t1_archetype || '?'} vs ${p.t2_archetype || '?'}`;
      }

      // V5: form_and_risk â€” this is the key upgrade
      const fr = p.form_and_risk;
      if (fr) {
        // Momentum
        const momParts = [];
        if (fr.t1_momentum && fr.t1_momentum !== 'steady') {
          momParts.push(`${p.t1_name}: ${fr.t1_momentum} (L10: ${((fr.t1_last10_win_rate || 0) * 100).toFixed(0)}%, trend: ${fr.t1_margin_trend > 0 ? '+' : ''}${(fr.t1_margin_trend || 0).toFixed(1)})`);
        }
        if (fr.t2_momentum && fr.t2_momentum !== 'steady') {
          momParts.push(`${p.t2_name}: ${fr.t2_momentum} (L10: ${((fr.t2_last10_win_rate || 0) * 100).toFixed(0)}%, trend: ${fr.t2_margin_trend > 0 ? '+' : ''}${(fr.t2_margin_trend || 0).toFixed(1)})`);
        }
        if (momParts.length) line += ` | Momentum: ${momParts.join('; ')}`;

        // Volatility
        if (fr.t1_volatility_score > 60 || fr.t2_volatility_score > 60) {
          line += ` | Volatility: ${p.t1_name}=${fr.t1_volatility_score}/100 ${p.t2_name}=${fr.t2_volatility_score}/100`;
        }

        // Injury alerts
        if (fr.t1_injury_alert) {
          line += ` | âš ï¸ INJURY ALERT ${p.t1_name}: ${fr.t1_injury_context || 'efficiency drop in final 5 games'}`;
        }
        if (fr.t2_injury_alert) {
          line += ` | âš ï¸ INJURY ALERT ${p.t2_name}: ${fr.t2_injury_context || 'efficiency drop in final 5 games'}`;
        }

        // Conference tourney results (if notable)
        const confParts = [];
        if (fr.t1_conf_tourney_result === 'champion') confParts.push(`${p.t1_name}: conf tourney CHAMP`);
        if (fr.t2_conf_tourney_result === 'champion') confParts.push(`${p.t2_name}: conf tourney CHAMP`);
        if (fr.t1_conf_tourney_result === 'first_round_exit') confParts.push(`${p.t1_name}: conf tourney 1st round exit`);
        if (fr.t2_conf_tourney_result === 'first_round_exit') confParts.push(`${p.t2_name}: conf tourney 1st round exit`);
        if (confParts.length) line += ` | Conf: ${confParts.join('; ')}`;

        // Risk note
        if (fr.matchup_risk_note) {
          line += ` | RISK: ${fr.matchup_risk_note}`;
        }
      }

      return line;
    }

    if (item.type === 'matchup') {
      const m = item.data || {};
      const t1Win = Number(m.t1?.win_probability || 0) * 100;
      const t2Win = Number(m.t2?.win_probability || 0) * 100;
      const slim = slimMatchupForContext(m);
      const confV2 = m.matchup_meta?.confidence || '';
      const confV1 = m.matchup_meta?.confidence_v1 || 'same';
      const upset = m.matchup_meta?.upset_flag || '';
      const riskTier = m.matchup_meta?.risk?.tier || '';
      const riskReason = m.matchup_meta?.risk?.reason || '';
      const t1Mom = Number(m.t1?.momentum_adjustment || 0);
      const t2Mom = Number(m.t2?.momentum_adjustment || 0);
      let line = `MATCHUP_CARD (${m.round || ''} ${m.region || ''}): (${m.t1?.seed})${m.t1?.name} ${t1Win.toFixed(1)}% vs (${m.t2?.seed})${m.t2?.name} ${t2Win.toFixed(1)}%`;
      line += ` | Confidence: ${confV2} (v1 was: ${confV1})`;
      line += ` | Upset Flag: ${upset}`;
      line += ` | Risk: ${riskTier} - ${riskReason}`;
      line += ` | Momentum: ${m.t1?.name || 't1'} ${t1Mom >= 0 ? '+' : ''}${(t1Mom * 100).toFixed(1)}%, ${m.t2?.name || 't2'} ${t2Mom >= 0 ? '+' : ''}${(t2Mom * 100).toFixed(1)}%`;
      if (m.matchup_meta?.chatbot_prompt) line += ` | prompt="${m.matchup_meta.chatbot_prompt}"`;
      line += ` | DATA=${JSON.stringify(slim)}`;
      return line;
    }

    if (item.type === 'bracket') {
      const g = item.data;
      const prob = g.winProb ? Math.max(g.winProb, 1 - g.winProb) : 0.5;
      let line = `ðŸ€ BRACKET ${g.round || ''}`;
      if (g.projected) line += ' (PROJECTED)';
      line += `: (${g.seed1})${g.team1} vs (${g.seed2})${g.team2}`;
      if (g.predictedWinner) line += ` â†’ ${g.predictedWinner} ${(prob * 100).toFixed(0)}%`;
      if (g.region) line += ` [${g.region}]`;
      return line;
    }

    if (item.type === 'opt') {
      return 'OPT: ' + JSON.stringify(item.data);
    }

    return '';
  }).filter(Boolean).join('\n');
}

function normalizeTeamName(value) {
  const normalized = normalizeTeamNameBase(value);
  return teamAliasLookup.get(normalized) || normalized;
}

function readBracket2025Source() {
  return store.bracket2025 || store.bracket || null;
}

function flattenBracketGames(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenBracketGames(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;

  const looksLikeGame = (
    node.team || node.team_name || node.name || node.school ||
    node.seed || node.region || node.slot || node.home_team || node.away_team
  );
  if (looksLikeGame) {
    out.push(node);
    // Return immediately to avoid processing nested duplicates
    return out;
  }

  for (const value of Object.values(node)) {
    if (value && (Array.isArray(value) || typeof value === 'object')) {
      flattenBracketGames(value, out);
    }
  }
  return out;
}

function extractTeamRowsFromBracket(rawBracket) {
  const rows = [];
  const games = flattenBracketGames(rawBracket);
  for (const g of games) {
    const candidates = [];
    if (g.team || g.team_name || g.name || g.school) candidates.push(g);
    if (g.home_team || g.away_team) {
      if (g.home_team) candidates.push({ ...g.home_team, region: g.region || g.home_region || g.bracket_region });
      if (g.away_team) candidates.push({ ...g.away_team, region: g.region || g.away_region || g.bracket_region });
    }
    if (Array.isArray(g.teams)) {
      for (const t of g.teams) candidates.push({ ...t, region: t.region || g.region || g.bracket_region });
    }

    for (const team of candidates) {
      const name = team.team || team.team_name || team.name || team.school;
      const seed = Number(team.seed ?? team.team_seed ?? team.seed_number);
      const region = team.region || g.region || g.bracket_region || g.conference || 'Unknown';
      if (!name || !Number.isFinite(seed)) continue;
      rows.push({ team: String(name), seed, region: String(region) });
    }
  }
  return rows;
}

function buildCanonicalSeedBuckets(rawBracket) {
  const rows = extractTeamRowsFromBracket(rawBracket);
  const seen = new Set();
  const buckets = Object.fromEntries(SUPPORTED_SEEDS.map((seed) => [seedKey(seed), []]));

  for (const row of rows) {
    if (!SUPPORTED_SEEDS.includes(row.seed)) continue;
    const key = `${normalizeTeamName(row.team)}|${row.seed}|${normalizeTeamName(row.region)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    buckets[seedKey(row.seed)].push(row);
  }

  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => a.region.localeCompare(b.region) || a.team.localeCompare(b.team));
  }

  return buckets;
}

const BRACKET_SEED_ORDER = [1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15];

function uniqTeamRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${normalizeTeamName(row.team)}|${row.seed}|${normalizeTeamName(row.region)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function buildRegionSeedLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    const region = row.region;
    if (!lookup.has(region)) lookup.set(region, new Map());
    const seedMap = lookup.get(region);
    if (!seedMap.has(row.seed)) seedMap.set(row.seed, []);
    const teams = seedMap.get(row.seed);
    if (!teams.includes(row.team)) teams.push(row.team);
  }
  return lookup;
}

function fmtSeedOpponent(regionSeedLookup, region, seed) {
  const seedMap = regionSeedLookup.get(region);
  const teams = seedMap?.get(seed) || [];
  if (!teams.length) return `(${seed}) TBD`;
  return `(${seed}) ${teams.join(' / ')}`;
}

function buildProjectedPath(regionSeedLookup, row) {
  const idx = BRACKET_SEED_ORDER.indexOf(row.seed);
  if (idx === -1) return null;

  const r2Idx = idx % 2 === 0 ? idx + 1 : idx - 1;
  const r2Seed = BRACKET_SEED_ORDER[r2Idx];

  const g4Start = Math.floor(idx / 4) * 4;
  const g4 = BRACKET_SEED_ORDER.slice(g4Start, g4Start + 4);
  const s16Seeds = g4.filter((seed) => seed !== row.seed && seed !== r2Seed);

  const g8Start = Math.floor(idx / 8) * 8;
  const g8 = BRACKET_SEED_ORDER.slice(g8Start, g8Start + 8);
  const e8Seeds = g8.filter((seed) => !g4.includes(seed));

  const r2 = fmtSeedOpponent(regionSeedLookup, row.region, r2Seed);
  const s16 = s16Seeds.map((seed) => fmtSeedOpponent(regionSeedLookup, row.region, seed)).join(' vs ');
  const e8 = e8Seeds.map((seed) => fmtSeedOpponent(regionSeedLookup, row.region, seed)).join(' / ');

  return `R2 vs ${r2} â†’ S16 vs winner of ${s16} â†’ E8 vs winner of ${e8}`;
}

function buildBracketGroundingContext() {
  const rawBracket = readBracket2025Source();
  if (!rawBracket) return 'BRACKET_GROUNDING: bracket data not available.';

  const rows = uniqTeamRows(extractTeamRowsFromBracket(rawBracket)).filter((row) => SUPPORTED_SEEDS.includes(row.seed));
  if (!rows.length) return 'BRACKET_GROUNDING: bracket data loaded but no seed rows parsed.';

  const regionSeedLookup = buildRegionSeedLookup(rows);
  const lines = rows
    .map((row) => {
      const path = buildProjectedPath(regionSeedLookup, row) || 'data not available';
      return `- (${row.seed}) ${row.team} | ${row.region} | Path: ${path}`;
    })
    .sort((a, b) => a.localeCompare(b));

  return `BRACKET_GROUNDING_2026 (authoritative seed/region/path source; never override with memory):\n${lines.join('\n')}`;
}

function buildProfileLookup() {
  const profiles = store.teams?.profiles || store.teams?.teams || (Array.isArray(store.teams) ? store.teams : []);
  const out = new Map();
  for (const p of profiles) {
    const name = p.name || p.school || p.team;
    if (!name) continue;
    out.set(normalizeTeamName(name), p);
  }
  return out;
}

function buildSeedArchetypeStats() {
  const out = {};
  const preds = store.base?.predictions || [];
  const stats = new Map();

  function bump(seedA, seedB, aWon) {
    const key = `${seedA}v${seedB}`;
    const item = stats.get(key) || { games: 0, seedAWinRate: 0 };
    item.games += 1;
    if (aWon) item.seedAWinRate += 1;
    stats.set(key, item);
  }

  for (const p of preds) {
    const s1 = Number(p.t1_seed);
    const s2 = Number(p.t2_seed);
    if (!Number.isFinite(s1) || !Number.isFinite(s2)) continue;
    const winner = normalizeTeamName(p.predicted_winner_name || '');
    const t1 = normalizeTeamName(p.t1_name || '');
    const t2 = normalizeTeamName(p.t2_name || '');
    bump(s1, s2, winner && winner === t1);
    bump(s2, s1, winner && winner === t2);
  }

  for (const [k, v] of stats.entries()) {
    out[k] = { games: v.games, seedAWinRate: v.games ? Number((v.seedAWinRate / v.games).toFixed(3)) : null };
  }

  return out;
}

const STAGE2_PROMPT_TEMPLATE = `You are BracketGPT writing a grounded seed-bucket analysis from canonical data only.

STRICT RULES:
1) Only reference teams present in the provided CANONICAL_BUCKETS object.
2) Use exactly these markdown headers in this order:
${requiredSeedHeaders().join('\n')}
3) Under each section, discuss only the teams assigned to that seed.
4) For each team mention, include:
   - archetype from TEAM_PROFILES when available
   - model view (probabilities/confidence if available)
   - historical seed/archetype angle from HISTORICAL_SEED_STATS when relevant
5) Never invent teams, seeds, regions, or constraints.
6) If a field is unavailable, say "data not available" instead of guessing.

OUTPUT FORMAT:
- Keep each section short and information-dense.
- Use bullet points per team.
- Keep all claims tied to provided JSON.
`;

const CORRECTION_PROMPT_TEMPLATE = `Your previous response violated seed-bucket grounding rules.

You must rewrite the full answer and correct every violation.

Error report:
{{ERROR_REPORT}}

Repeat requirements:
- Use only teams in CANONICAL_BUCKETS.
- Use headers exactly and in order:
${requiredSeedHeaders().join('\n')}
- Teams may appear only in their canonical section.
- No invented teams/seeds/regions.

Return only the corrected final markdown answer.`;

function buildStage2Payload(userRequest, buckets) {
  const profileLookup = buildProfileLookup();
  const archetypeStats = buildSeedArchetypeStats();
  const matchedProfiles = {};

  for (const [bucket, rows] of Object.entries(buckets)) {
    matchedProfiles[bucket] = rows.map((r) => {
      const profile = profileLookup.get(normalizeTeamName(r.team)) || null;
      return {
        team: r.team,
        seed: r.seed,
        region: r.region,
        profile,
      };
    });
  }

  return {
    userRequest,
    canonicalBuckets: buckets,
    teamProfiles: matchedProfiles,
    historicalSeedStats: archetypeStats,
  };
}

function parseNarrativeSections(text) {
  const sections = Object.fromEntries(SUPPORTED_SEEDS.map((seed) => [seedKey(seed), '']));
  const regex = /^###\s*SEED_(\d{1,2})\s*$/gim;
  const matches = Array.from(text.matchAll(regex)).filter((m) => SUPPORTED_SEEDS.includes(Number(m[1])));

  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const bucket = seedKey(Number(matches[i][1]));
    sections[bucket] = text.slice(start, end).trim();
  }

  return sections;
}

function validateNarrativeAgainstBuckets(text, buckets) {
  const sections = parseNarrativeSections(text);
  const allTeams = [];
  for (const [bucket, rows] of Object.entries(buckets)) {
    for (const row of rows) {
      const norm = normalizeTeamName(row.team);
      allTeams.push({ norm, team: row.team, bucket });
    }
  }

  const errors = [];
  for (const [bucket, textBlock] of Object.entries(sections)) {
    const blockNorm = normalizeTeamName(textBlock);
    for (const t of allTeams) {
      if (!t.norm || !blockNorm.includes(t.norm)) continue;
      if (t.bucket !== bucket) {
        errors.push(`Team "${t.team}" belongs in ${t.bucket} but was mentioned in ${bucket}.`);
      }
    }
  }

  for (const [bucket, block] of Object.entries(sections)) {
    if (!block) errors.push(`Missing required section content for ${bucket}.`);
  }

  return { ok: errors.length === 0, errors };
}

async function generateSeedBucketNarrative(userRequest) {
  const rawBracket = readBracket2025Source();
  if (!rawBracket) {
    return { error: 'Missing bracket_2026.json (or fallback bracket_2025.json / bracket_predictions.json).' };
  }

  const buckets = buildCanonicalSeedBuckets(rawBracket);
  const payload = buildStage2Payload(userRequest, buckets);
  const userContent = `CANONICAL_BUCKETS:\n${JSON.stringify(payload.canonicalBuckets, null, 2)}\n\nTEAM_PROFILES:\n${JSON.stringify(payload.teamProfiles, null, 2)}\n\nHISTORICAL_SEED_STATS:\n${JSON.stringify(payload.historicalSeedStats, null, 2)}\n\nUser request: ${userRequest || 'Provide seed analysis.'}`;

  let narrative = await callLLM([{ role: 'user', content: userContent }], STAGE2_PROMPT_TEMPLATE, { temperature: 0, rawSystemPrompt: true });
  let validation = validateNarrativeAgainstBuckets(narrative, buckets);
  let attempts = 0;

  while (!validation.ok && attempts < 2) {
    attempts += 1;
    const errorReport = validation.errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
    const correctionPrompt = CORRECTION_PROMPT_TEMPLATE.replace('{{ERROR_REPORT}}', errorReport);
    narrative = await callLLM(
      [
        { role: 'user', content: userContent },
        { role: 'assistant', content: narrative },
        { role: 'user', content: correctionPrompt },
      ],
      STAGE2_PROMPT_TEMPLATE,
      { temperature: 0, rawSystemPrompt: true },
    );
    validation = validateNarrativeAgainstBuckets(narrative, buckets);
  }

  return {
    stage1: buckets,
    stage2: narrative,
    validation,
    prompts: {
      stage2Prompt: STAGE2_PROMPT_TEMPLATE,
      correctionPrompt: CORRECTION_PROMPT_TEMPLATE,
    },
  };
}

function normalizeMessageContent(rawContent) {
  if (typeof rawContent === 'string') return rawContent.trim();
  if (Array.isArray(rawContent)) {
    const parts = rawContent
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .filter(Boolean);
    return parts.join('\n').trim();
  }
  if (rawContent == null) return '';
  return String(rawContent).trim();
}

function sanitizeIncomingMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  const MAX_USER_MESSAGE_CHARS = 2000;
  const out = [];
  for (const msg of rawMessages.slice(-40)) {
    if (!msg || typeof msg !== 'object') continue;
    const roleRaw = String(msg.role || '').toLowerCase();
    const role = (roleRaw === 'assistant' || roleRaw === 'system') ? roleRaw : 'user';
    let content = normalizeMessageContent(msg.content);
    // Hard cap user messages to prevent OOM from malicious or accidental large inputs
    if (role === 'user' && content.length > MAX_USER_MESSAGE_CHARS) {
      content = content.slice(0, MAX_USER_MESSAGE_CHARS);
    }
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function parseErrorMessage(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  if (typeof payload.message === 'string') return payload.message;
  return '';
}

async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { _rawText: text };
  }
}

function buildUpstreamError(providerName, statusCode, payload) {
  const detail = parseErrorMessage(payload) || String(payload?._rawText || '').slice(0, 220);
  return detail
    ? `API error (${providerName} ${statusCode}): ${detail}`
    : `API error (${providerName} ${statusCode})`;
}

async function callLLM(messages, ctxStr, options = {}) {
  const key = cfg.apiKey;
  if (!key) return 'Need an API key! Admin: set LLM_API_KEY in Railway env vars or go to /admin.';
  const system = options.rawSystemPrompt ? ctxStr : (sysPrompt() + (ctxStr ? `\n\n-- DATA --\n${ctxStr}` : ''));
  const temperature = Number.isFinite(options.temperature) ? options.temperature : cfg.temperature;

  try {
    if (typeof fetch !== 'function') {
      return 'Server runtime is missing fetch(). Use Node.js 18+ or add a fetch polyfill.';
    }

    if (cfg.provider === 'deepseek') {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: cfg.model || 'deepseek-chat',
          messages: [{ role: 'system', content: system }, ...messages],
          temperature,
          max_tokens: cfg.maxTokens,
        }),
      });
      const d = await parseJsonSafe(r);
      if (!r.ok) return buildUpstreamError('deepseek', r.status, d);
      if (d.error) return `API error: ${d.error.message || JSON.stringify(d.error)}`;
      return d.choices?.[0]?.message?.content || 'No response.';
    }

    if (cfg.provider === 'claude') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model || 'claude-sonnet-4-20250514',
          max_tokens: cfg.maxTokens,
          system,
          messages,
        }),
      });
      const d = await parseJsonSafe(r);
      if (!r.ok) return buildUpstreamError('claude', r.status, d);
      if (d.error) return `API error: ${d.error.message || JSON.stringify(d.error)}`;
      return d.content?.[0]?.text || 'No response.';
    }

    if (cfg.provider === 'gemini') {
      const model = cfg.model || 'gemini-2.0-flash';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${system}\n\n${messages.map((m) => `${m.role}: ${m.content}`).join('\n')}` }] }],
          generationConfig: { temperature, maxOutputTokens: cfg.maxTokens },
        }),
      });
      const d = await parseJsonSafe(r);
      if (!r.ok) return buildUpstreamError('gemini', r.status, d);
      if (d.error) return `API error: ${d.error.message || JSON.stringify(d.error)}`;
      return d.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
    }

    return `Unknown provider: ${cfg.provider}`;
  } catch (e) {
    console.error('LLM err:', e);
    const msg = String(e?.message || '').trim();
    return msg ? `Connection issue: ${msg}` : 'Connection issue. Try again.';
  }
}

const rates = new Map();
function rateOk(ip) {
  const now = Date.now();
  let entry = rates.get(ip);
  if (!entry || now - entry.t >= 60000) entry = { c: 0, t: now };
  if (entry.c >= cfg.messagesPerMinute) {
    rates.set(ip, entry);
    return false;
  }
  entry.c += 1;
  rates.set(ip, entry);
  return true;
}

function auth(req, res, next) {
  if ((req.header('x-admin-password') || '') !== cfg.adminPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/api/config', (req, res) => {
  res.json({ brandName: cfg.brandName, tagline: cfg.tagline, activeSeason: cfg.activeSeason, dataLoaded: hasData });
});

app.get('/api/data-status', (req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch (e) {
    files = [];
  }
  const bracketRows = Array.isArray(store.bracketMatchups?.matchups) ? store.bracketMatchups.matchups.length : 0;
  const pickCardRows = Array.isArray(dataStore.pick_cards?.matchups)
    ? dataStore.pick_cards.matchups.length
    : bracketRows;
  res.json({
    bracketMatchups: bracketRows,
    predictions: dataStore.predictions?.predictions?.length || 0,
    teams: Object.keys(dataStore.predictions?.team_directory || {}).length,
    teamProfiles: Object.keys(dataStore.team_profiles?.teams || {}).length,
    profiles: Object.keys(dataStore.team_profiles?.teams || {}).length,
    pickCards: pickCardRows,
    archetypes: Object.keys(dataStore.archetype_summary?.archetype_descriptions || {}).length,
    bracket_lookup: Object.keys(dataStore.predictions?.bracket_lookup || {}).length > 0,
    seed_rounds: Object.keys(dataStore.seed_matchups || {}).length,
    files,
  });
});


app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'bracketgpt', season: cfg.activeSeason, dataLoaded: hasData });
});

app.get('/api/ready', (req, res) => {
  const loaded = Object.keys(FILE_MAP).reduce((acc, key) => {
    const d = store[key];
    acc[key] = hasContent(d);
    return acc;
  }, {});
  const ready = loaded.base || loaded.upset || loaded.floor;
  res.status(ready ? 200 : 503).json({ ready, loaded, provider: cfg.provider, hasApiKey: !!cfg.apiKey });
});

app.get('/api/bracket', (req, res) => {
  if (!bracketReady || !Array.isArray(bracketReady.matchups) || bracketReady.matchups.length === 0) {
    return res.status(404).json({
      error: 'No bracket data loaded',
      hint: 'Upload bracket_ready_2026.json to backend/data/ (generated by model_v5_4.py in Colab)',
    });
  }
  return res.json(bracketReady);
});

app.get('/api/bracket/bootstrap', (req, res) => {
  if (!bracketReady || !Array.isArray(bracketReady.matchups) || bracketReady.matchups.length === 0) {
    return res.status(404).json({
      error: 'No bracket data loaded',
      hint: 'Upload bracket_ready_2026.json to backend/data/ (generated by model_v5_4.py in Colab)',
    });
  }
  return res.json(bracketReady);
});

app.get('/api/bracket-output', (req, res) => {
  if (!store.bracketOutput) return res.status(404).json({ error: 'Bracket output data not loaded.' });
  return res.json(store.bracketOutput);
});

app.get('/api/bracket-output/strategy/:strategy', (req, res) => {
  if (!store.bracketOutput?.strategies) return res.status(404).json({ error: 'Bracket output data not loaded.' });
  const key = String(req.params.strategy || '').toLowerCase().trim();
  const strategy = store.bracketOutput.strategies[key];
  if (!strategy) {
    return res.status(400).json({ error: 'Invalid strategy. Use chalk, balanced, or upset.' });
  }
  return res.json({
    strategy: key,
    scoring: getScoringMap(),
    total_ep: Number(strategy.total_ep || 0),
    rounds: strategy.rounds || {},
    mc_validation: strategy.mc_validation || null,
  });
});

app.get('/api/bracket-output/ep-rankings', (req, res) => {
  if (!store.bracketOutput?.team_ep_rankings) return res.status(404).json({ error: 'EP rankings unavailable.' });
  return res.json({
    count: Object.keys(store.bracketOutput.team_ep_rankings).length,
    rankings: store.bracketOutput.team_ep_rankings,
  });
});

app.get('/api/bracket-output/champion-probs', (req, res) => {
  const champion_probs = getChampionProbMap();
  if (!Object.keys(champion_probs).length) {
    return res.status(404).json({ error: 'Champion probabilities unavailable.' });
  }
  return res.json({
    champion_probs,
  });
});

app.get('/api/kenpom', (req, res) => {
  const rows = dataStore.kenpom_csv?.rows || [];
  const teams = dataStore.kenpom_csv?.teams || {};
  return res.json({
    loaded: rows.length > 0,
    count: rows.length,
    teams,
  });
});

app.get('/api/public-perception', (req, res) => {
  const rows = dataStore.espn_public_csv?.rows || [];
  return res.json({
    loaded: rows.length > 0,
    count: rows.length,
    rows,
  });
});

app.get('/api/team-round-probabilities', (req, res) => {
  const payload = getActiveTeamRoundProbabilitiesPayload() || {};
  const map = payload?.team_round_probs || {};
  const publicMap = payload?.team_public_round_probs || {};
  const rows = payload?.rows || [];
  const source = payload === dataStore.team_round_probs_json
    ? 'team_round_probs_json'
    : (payload === dataStore.team_round_probs_csv ? 'team_round_probs_csv' : null);
  return res.json({
    loaded: Object.keys(map).length > 0,
    count: Number(payload?.count || rows.length || 0),
    team_round_probs: map,
    team_public_round_probs: publicMap,
    validation: payload?.validation || null,
    source,
  });
});

app.get('/api/matchup/by-teams/:t1/:t2', (req, res) => {
  const matchup = findBracketMatchupByTeams(req.params.t1, req.params.t2);
  if (!matchup) return res.status(404).json({ error: 'Matchup not found.' });
  return res.json(matchup);
});

app.get('/api/bracket-cache', (req, res) => {
  if (dataStore.bracketCache) {
    return res.json(dataStore.bracketCache);
  }
  if (dataStore.predictions) {
    return res.json(dataStore.predictions);
  }
  return res.status(404).json({ error: 'No bracket data loaded' });
});

app.get('/api/matchup', (req, res) => {
  const { t1, t2 } = req.query;
  if (!t1 || !t2) {
    return res.status(400).json({ error: 'Provide t1 and t2 query params (team IDs)' });
  }
  const matchup = findMatchup(t1, t2);
  if (!matchup) {
    return res.status(404).json({ error: `No prediction found for ${t1} vs ${t2}` });
  }
  return res.json(matchup);
});

app.get('/api/team/:id', (req, res) => {
  const teamId = String(req.params.id || '');
  const fromProfiles = dataStore.team_profiles?.teams?.[teamId];
  const fromDir = dataStore.predictions?.team_directory?.[teamId];
  const team = fromProfiles || fromDir;
  if (!team) {
    return res.status(404).json({ error: `Team ${teamId} not found` });
  }
  return res.json({ id: parseInt(teamId, 10), ...team });
});

app.get('/api/matchup/:t1/:t2', (req, res) => {
  const t1 = String(req.params.t1 || '');
  const t2 = String(req.params.t2 || '');
  if (!t1 || !t2) {
    return res.status(400).json({ error: 'Provide two team IDs in path params' });
  }
  const matchup = findMatchup(t1, t2);
  if (!matchup) {
    return res.status(404).json({ error: `No prediction found for ${t1} vs ${t2}` });
  }
  return res.json(matchup);
});

app.get('/api/seed-history/:round', (req, res) => {
  const round = String(req.params.round || '');
  const data = dataStore.seed_matchups?.[round];
  if (!data) {
    return res.status(404).json({ error: `No seed data for round ${round}` });
  }
  return res.json(data);
});

app.get('/api/matchup/:matchupId', (req, res) => {
  const matchup = findBracketMatchupById(req.params.matchupId);
  if (!matchup) return res.status(404).json({ error: 'Matchup not found.' });
  return res.json(matchup);
});

app.get('/api/bracket/region/:region', (req, res) => {
  const target = String(req.params.region || '').trim().toLowerCase();
  const regionKey = bracketMatchupIndex.regions.find((r) => String(r).toLowerCase() === target);
  if (!regionKey) {
    return res.status(400).json({ error: 'Invalid region. Valid regions: South, West, East, Midwest.' });
  }
  const matchups = bracketMatchupIndex.byRegion.get(regionKey) || [];
  return res.json({ season: bracketMatchupIndex.season, region: regionKey, matchups });
});

app.get('/api/bracket/export', (req, res) => {
  const raw = String(req.query.picks || '');
  let picks = {};
  try { if (raw) picks = JSON.parse(raw); } catch (e) { picks = {}; }
  const lines = Object.entries(picks).map(([matchupId, winner]) => {
    const m = findBracketMatchupById(matchupId);
    const loser = m?.t1?.name === winner ? m?.t2?.name : m?.t1?.name;
    return `${winner} over ${loser || 'TBD'} (${m?.round || 'Round'})`;
  });
  res.json({
    season: bracketMatchupIndex.season,
    picks: Object.keys(picks).length,
    summary: lines,
  });
});

async function handleChat(req, res, opts = {}) {
  try {
    if (!rateOk(req.ip || 'x')) return res.status(429).json({ error: 'Too many messages.' });
    const msgs = sanitizeIncomingMessages(req.body?.messages);
    if (!msgs.length) return res.status(400).json({ error: 'No valid message content.' });

    const joined = msgs.map((m) => m.content).join(' ');
    const intent = detectIntent(joined);
    const ctx = findCtx(joined, { intent, messageCount: msgs.length });
    const historicalCtxRaw = getRelevantHistoricalContext(joined);
    const historicalCtx = alignHistoricalContextToUiProbabilities(historicalCtxRaw);
    const intentHint = intent === 'value'
      ? 'INTENT: VALUE. Lead with EV/value-edge vs public pick rates and bracket leverage.'
      : `INTENT: ${intent.toUpperCase()}.`;
    const bracketGrounding = buildBracketGroundingContext();
    const bracketState = req.body?.bracketState;
    const focusMatchup = req.body?.focusMatchup;
    const shouldIncludeBracket = opts.forceBracketContext || !!bracketState;
    const seasonMentions = Array.from(String(joined || '').matchAll(/\b(20\d{2})\b/g)).map((m) => Number(m[1]));
    const requestedSeason = seasonMentions.length ? seasonMentions[seasonMentions.length - 1] : null;
    const loadedSeason = Number(bracketMatchupIndex.season || cfg.activeSeason || 0) || null;
    const seasonGuardrailBlock = (requestedSeason && loadedSeason && requestedSeason !== loadedSeason)
      ? `SEASON_GUARDRAIL:
- Loaded bracket season is ${loadedSeason}, but user requested ${requestedSeason}.
- Explicitly state this mismatch before giving picks.
- Do not claim ${requestedSeason} first-round matchups unless ${requestedSeason} bracket data is loaded.`
      : '';
    const upsetGuardrailBlock = intent === 'upset' ? buildUpsetMatchupGuardrailContext() : '';
    const bracketStateBlock = shouldIncludeBracket ? formatBracketStateContext(bracketState || {}, focusMatchup) : '';
    const ui2LayoutBlock = shouldIncludeBracket ? formatUi2BracketLayoutContext() : '';
    const uiProbabilityRule = shouldIncludeBracket
      ? `UI_PROBABILITY_RULES:
- Treat bracket UI matchup-card win probabilities as the single source of truth.
- If any other context has a different probability for the same matchup, ignore it and use the UI value.
- If a matchup is not present in UI matchup-card data, say "UI probability not available for this matchup."`
      : '';

    const reply = await callLLM(msgs, `${intentHint}
${seasonGuardrailBlock}
${bracketGrounding}
${upsetGuardrailBlock}
RELEVANT_HISTORICAL_CONTEXT:
${JSON.stringify(historicalCtx, null, 0)}
CONTEXT_COUNTS: predictions=${historicalCtx.predictions.length}, archetypes=${Object.keys(historicalCtx.archetype_history || {}).length}
${bracketStateBlock}
${ui2LayoutBlock}
${uiProbabilityRule}
${fmtCtx(ctx)}`);
    return res.json({ reply, intent });
  } catch (e) {
    console.error(e);
    const detail = String(e?.message || '').trim();
    return res.status(500).json({ error: detail ? `Something broke: ${detail}` : 'Something broke.' });
  }
}

app.post('/api/chat', async (req, res) => {
  return handleChat(req, res);
});

app.post('/api/bracket-chat', async (req, res) => {
  return handleChat(req, res, { forceBracketContext: true });
});


app.get('/api/value-picks', (req, res) => {
  const rows = store.bracketMatchups?.matchups || [];
  const r64 = rows.filter((m) => String(m?.round || '').toUpperCase() === 'R64');
  const epMap = store.bracketOutput?.team_ep_rankings || {};

  if (r64.length) {
    const teams = [];
    for (const m of r64) {
      for (const side of ['t1', 't2']) {
        const t = m?.[side] || {};
        const model = Number(t.win_probability || 0);
        let pub = t?.pool?.public_pick_pct;
        pub = Number(pub);
        if (!Number.isFinite(pub)) pub = null;
        if (pub != null && pub > 1) pub = pub / 100;
        const edge = (model - (pub || 0));
        teams.push({
          team: t.name,
          seed: Number(t.seed || 0) || null,
          region: m.region || null,
          round: m.round || 'R64',
          model_probability: model,
          public_pick_pct: pub,
          edge,
          confidence: m.matchup_meta?.confidence || null,
          upset_flag: m.matchup_meta?.upset_flag || null,
          risk_tier: m.matchup_meta?.risk?.tier || null,
          ep_total: Number(epMap[t.name] || 0),
          matchup_id: m.matchup_id,
          opponent: side === 't1' ? m?.t2?.name : m?.t1?.name,
        });
      }
    }

    const hiddenGems = teams.filter((t) =>
      t.public_pick_pct != null
      && (t.model_probability - t.public_pick_pct) > 0.15
      && (t.upset_flag === 'slight_upset_pick' || t.upset_flag === 'vulnerable_favorite')
    );

    const fadeThese = teams.filter((t) =>
      t.public_pick_pct != null
      && (t.public_pick_pct - t.model_probability) > 0.15
      && (t.confidence === 'toss-up' || t.confidence === 'lean')
    );

    const leaderboard = teams
      .slice()
      .sort((a, b) => {
        const byEdge = Number(b.edge || 0) - Number(a.edge || 0);
        if (Math.abs(byEdge) > 0.0001) return byEdge;
        return Number(b.ep_total || 0) - Number(a.ep_total || 0);
      });

    return res.json({
      source: 'matchups_v2',
      count: leaderboard.length,
      leaderboard,
      hiddenGems,
      fadeThese,
      ep_rankings: epMap,
    });
  }

  const teams = store.ev?.teams || store.ev?.data || (Array.isArray(store.ev) ? store.ev : []);
  const normalized = teams.map((team) => ({
    ...team,
    championEdge: Number(team.rounds?.Champion?.value_edge || 0),
    finalFourEdge: Number(team.rounds?.['Final Four']?.value_edge || 0),
    round32Edge: Number(team.rounds?.['Round of 32']?.value_edge || 0),
    ep_total: Number(epMap[team.name] || 0),
  }));
  return res.json({
    source: 'legacy_ev',
    count: normalized.length,
    leaderboard: normalized.sort((a, b) => Number(b.championEdge || 0) - Number(a.championEdge || 0)),
    hiddenGems: normalized.filter((t) => t.championEdge >= 10 || t.finalFourEdge >= 10 || t.round32Edge >= 10),
    fadeThese: normalized.filter((t) => t.championEdge <= -10 || t.finalFourEdge <= -10 || t.round32Edge <= -10),
    ep_rankings: epMap,
  });
});

app.get('/api/pool-strategy', (req, res) => {
  if (!store.poolStrategy) {
    return res.status(404).json({ error: 'Pool strategy data not loaded. Upload pool_strategy_2026.json via admin.' });
  }

  const tier = String(req.query.tier || '').toLowerCase();
  if (tier && store.poolStrategy.strategies?.[tier]) {
    return res.json({
      ...store.poolStrategy,
      strategies: { [tier]: store.poolStrategy.strategies[tier] },
      ev_tables: { [tier]: store.poolStrategy.ev_tables?.[tier] },
    });
  }

  return res.json(store.poolStrategy);
});

app.post('/api/seed-bucket-analysis', async (req, res) => {
  try {
    if (!rateOk(req.ip || 'x')) return res.status(429).json({ error: 'Too many messages.' });
    const userRequest = req.body?.query || req.body?.request || '';
    const result = await generateSeedBucketNarrative(userRequest);
    if (result.error) return res.status(400).json(result);
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Seed bucket analysis failed.' });
  }
});

app.get('/api/admin/data-status', auth, (req, res) => {
  const activeTeamRoundProbs = getActiveTeamRoundProbabilitiesPayload() || {};
  const activeTeamRoundType = activeTeamRoundProbs === dataStore.team_round_probs_json
    ? 'team_round_probs_json'
    : (activeTeamRoundProbs === dataStore.team_round_probs_csv ? 'team_round_probs_csv' : null);
  const summary = {
    predictions: dataStore.predictions?.predictions?.length || 0,
    bracket: dataStore.bracket?.teams?.length || 0,
    bracket_cache: dataStore.bracket_cache?.total_matchups || dataStore.bracketCache?.total_matchups || 0,
    teams: Object.keys(dataStore.predictions?.team_directory || bracketReady?.team_directory || {}).length,
    profiles: Object.keys(dataStore.team_profiles?.teams || {}).length,
    archetypes: Object.keys(dataStore.archetype_summary?.archetype_descriptions || {}).length,
    bracket_lookup: Object.keys(dataStore.predictions?.bracket_lookup || bracketReady?.bracket_lookup || {}).length > 0,
    seed_rounds: Object.keys(dataStore.seed_matchups || bracketReady?.seed_matchup_history || {}).length,
    bracket_output_strategies: Object.keys(store.bracketOutput?.strategies || {}).length,
    kenpom_rows: Number(dataStore.kenpom_csv?.count || dataStore.kenpom_csv?.rows?.length || 0),
    espn_public_rows: Number(dataStore.espn_public_csv?.count || dataStore.espn_public_csv?.rows?.length || 0),
    team_round_probs_rows: Number(activeTeamRoundProbs?.count || activeTeamRoundProbs?.rows?.length || 0),
    team_round_probs_source: activeTeamRoundType,
  };

  return res.json({
    ...summary,
    files: {
      bracket_ready: {
        loaded: !!bracketReady,
        matchups: Array.isArray(bracketReady?.matchups) ? bracketReady.matchups.length : 0,
        teams: Object.keys(bracketReady?.team_directory ?? {}).length,
      },
      predictions: {
      loaded: !!dataStore.predictions,
      matchups: dataStore.predictions?.predictions?.length ?? 0,
      version: dataStore.predictions?.model_version ?? null,
      season: dataStore.predictions?.backtest_season ?? null,
      teams: Object.keys(dataStore.predictions?.team_directory ?? {}).length,
      },
      bracket: {
        loaded: !!dataStore.bracket,
        teams: Array.isArray(dataStore.bracket?.teams) ? dataStore.bracket.teams.length : 0,
        r64_matchups: Array.isArray(dataStore.bracket?.r64_matchups) ? dataStore.bracket.r64_matchups.length : 0,
      },
      bracket_cache: {
        loaded: !!(dataStore.bracket_cache || dataStore.bracketCache),
        matchups: dataStore.bracket_cache?.total_matchups ?? dataStore.bracketCache?.total_matchups ?? 0,
        total_all_pairs: dataStore.bracket_cache?.total_all_pairs ?? dataStore.bracketCache?.total_all_pairs ?? 0,
      },
      team_profiles: {
        loaded: !!dataStore.team_profiles,
        teams: Object.keys(dataStore.team_profiles?.teams ?? {}).length,
      },
      seed_matchups: {
        loaded: !!dataStore.seed_matchups,
        rounds: Object.keys(dataStore.seed_matchups ?? {}).length,
      },
      archetype_summary: {
        loaded: !!dataStore.archetype_summary,
        archetypes: Object.keys(dataStore.archetype_summary?.archetype_descriptions ?? {}).length,
      },
      archetype_history: {
        loaded: !!dataStore.archetype_history,
        entries: Object.keys(dataStore.archetype_history ?? {}).length,
      },
      bracket_output: {
        loaded: !!store.bracketOutput,
        strategies: Object.keys(store.bracketOutput?.strategies ?? {}).length,
        team_ep_rankings: Object.keys(store.bracketOutput?.team_ep_rankings ?? {}).length,
        champion_probs: Object.keys(getChampionProbMap()).length,
      },
      kenpom_csv: {
        loaded: Number(dataStore.kenpom_csv?.count || 0) > 0,
        rows: Number(dataStore.kenpom_csv?.count || 0),
        teams: Object.keys(dataStore.kenpom_csv?.teams || {}).length,
      },
      espn_public_csv: {
        loaded: Number(dataStore.espn_public_csv?.count || 0) > 0,
        rows: Number(dataStore.espn_public_csv?.count || 0),
      },
      team_round_probs_csv: {
        loaded: Number(dataStore.team_round_probs_csv?.count || 0) > 0,
        rows: Number(dataStore.team_round_probs_csv?.count || 0),
        teams: Object.keys(dataStore.team_round_probs_csv?.team_round_probs || {}).length,
        warnings: Array.isArray(dataStore.team_round_probs_csv?.validation?.warnings)
          ? dataStore.team_round_probs_csv.validation.warnings.length
          : 0,
      },
      team_round_probs_json: {
        loaded: Number(dataStore.team_round_probs_json?.count || 0) > 0,
        rows: Number(dataStore.team_round_probs_json?.count || 0),
        teams: Object.keys(dataStore.team_round_probs_json?.team_round_probs || {}).length,
        warnings: Array.isArray(dataStore.team_round_probs_json?.validation?.warnings)
          ? dataStore.team_round_probs_json.validation.warnings.length
          : 0,
      },
    },
  });
});

app.get('/admin/config', auth, (req, res) => {
  const dataStatus = {};
  for (const key of Object.keys(FILE_MAP)) {
    const d = store[key];
    dataStatus[key] = hasContent(d);
  }
  res.json({ ...cfg, context: contextCfg(), dataStatus });
});

app.post('/admin/config', adminJsonParser, auth, (req, res) => {
  const body = req.body || {};
  for (const key of ['provider', 'apiKey', 'model', 'brandName', 'tagline', 'activeSeason']) {
    if (body[key] !== undefined) cfg[key] = body[key];
  }
  if (body.temperature !== undefined) {
    const temperature = Number(body.temperature);
    if (Number.isFinite(temperature)) cfg.temperature = temperature;
  }
  if (body.maxTokens !== undefined) {
    cfg.maxTokens = asPositiveInt(body.maxTokens, cfg.maxTokens, 1, 8192);
  }
  if (body.messagesPerMinute !== undefined) {
    cfg.messagesPerMinute = asPositiveInt(body.messagesPerMinute, cfg.messagesPerMinute, 1, 600);
  }
  if (body.weights) cfg.weights = body.weights;
  if (body.features) cfg.features = body.features;
  if (body.context) cfg.context = { ...cfg.context, ...body.context };
  saveCfg();
  res.json({ ok: true, context: contextCfg() });
});

app.post('/admin/context-preview', auth, (req, res) => {
  const query = req.body?.query || '';
  const intent = detectIntent(query);
  const ctx = findCtx(query, { intent, messageCount: 1 });
  const historicalCtx = getRelevantHistoricalContext(query);
  res.json({
    query,
    intent,
    contextSettings: contextCfg(),
    contextCount: ctx.length,
    contextPreview: ctx,
    formattedContext: fmtCtx(ctx),
    historicalContextCounts: {
      predictions: historicalCtx.predictions.length,
      archetypes: Object.keys(historicalCtx.archetype_history || {}).length,
      seedRounds: Object.keys(historicalCtx.seed_matchups || {}).length,
    },
    historicalContextPreview: historicalCtx,
  });
});

app.post('/admin/password', auth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Both required' });
  if (oldPassword !== cfg.adminPassword) return res.status(403).json({ error: 'Wrong password' });
  cfg.adminPassword = newPassword;
  saveCfg();
  return res.json({ ok: true });
});

const upload = multer({
  dest: UPLOAD_TMP_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
});
app.post('/admin/upload', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'File too large. Max upload size is 100MB.' });
      }
      return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    }

    const t = String(req.body.type || '').trim();
    const uploadTypeMap = {
      predictions: 'chatbot_predictions_v5.json',
      bracket: 'bracket_2026.json',
      bracket_ready: 'bracket_ready_2026.json',
      bracket_cache: 'bracket_cache_2026.json',
      bracket_output: 'bracketgpt_bracket_output_2026.json',
      team_profiles: 'team_profiles_2026.json',
      seed_matchups: 'seed_matchup_all_rounds.json',
      archetype_summary: 'archetype_summary_v5.json',
      archetype_history: 'archetype_history.json',
      kenpom_csv: 'kenpom_2026.csv',
      espn_public_csv: 'espn_peoples_bracket_2026.csv',
      team_round_probs_csv: 'bracket_tree_exact_probabilities_2026.csv',
      team_round_probs_json: 'bracket_probabilities_with_yahoo_corrected_2026.json',
    };
    const typeAliases = {
      base: 'predictions',
      bracket2026: 'bracket',
      bracket2025: 'bracket',
      bracketReady: 'bracket_ready',
      bracket_ready_2025: 'bracket_ready',
      bracket_ready_2026: 'bracket_ready',
      bracketCache: 'bracket_cache',
      bracket_cache_2025: 'bracket_cache',
      bracket_cache_2026: 'bracket_cache',
      cache: 'bracket_cache',
      bracketOutput: 'bracket_output',
      bracket_output_2025: 'bracket_output',
      bracket_output_2026: 'bracket_output',
      monte_carlo: 'bracket_output',
      montecarlo: 'bracket_output',
      teams: 'team_profiles',
      upset: 'seed_matchups',
      floor: 'archetype_summary',
      optimizer: 'archetype_history',
      teamProfiles: 'team_profiles',
      seedMatchups: 'seed_matchups',
      archetypeSummary: 'archetype_summary',
      archetypeHistory: 'archetype_history',
      kenpom: 'kenpom_csv',
      kenpomcsv: 'kenpom_csv',
      espn_public: 'espn_public_csv',
      espnpublic: 'espn_public_csv',
      peoples_bracket: 'espn_public_csv',
      team_round_probs: 'team_round_probs_csv',
      team_round_probabilities: 'team_round_probs_csv',
      teamroundprobs: 'team_round_probs_csv',
      teamroundprobabilities: 'team_round_probs_csv',
      exact_round_probabilities: 'team_round_probs_csv',
      bracket_tree_exact: 'team_round_probs_csv',
      bracket_tree_exact_probabilities: 'team_round_probs_csv',
      bracket_exact_probabilities: 'team_round_probs_csv',
      full_bracket_probabilities: 'team_round_probs_csv',
      bracket_probabilities_with_yahoo_corrected: 'team_round_probs_json',
      bracket_probabilities_with_yahoo: 'team_round_probs_json',
      team_round_probs_json: 'team_round_probs_json',
      teamroundprobsjson: 'team_round_probs_json',
    };
    if (!req.file) return res.status(400).json({ success: false, error: 'File required' });

    function normalizeFileKey(v) {
      return String(v || '')
        .toLowerCase()
        .replace(/\.(json|csv)$/i, '')
        .replace(/[_\-\s().]+/g, '');
    }

    function inferTypeFromFilename(fileName) {
      const key = normalizeFileKey(fileName);
      if (!key) return '';
      if (key.includes('chatbotpredictionsv5') || key.includes('predictionsv5') || key.includes('allpairs')) return 'predictions';
      if (key.includes('bracketready2026') || key.includes('bracketready2025') || key.includes('bracketready')) return 'bracket_ready';
      if (key.includes('bracket2026') || key.includes('bracket2025') || key === 'bracket') return 'bracket';
      if (key.includes('bracketcache2026') || key.includes('bracketcache2025') || key.includes('bracketcache')) return 'bracket_cache';
      if (key.includes('bracketgptbracketoutput2026') || key.includes('bracketoutput2026') || key.includes('bracketgptbracketoutput2025') || key.includes('bracketoutput2025') || key.includes('bracketoutput') || key.includes('montecarlooutput') || key.includes('montecarlo')) return 'bracket_output';
      if (key.includes('teamprofiles2026') || key.includes('teamprofiles2025') || key.includes('teamprofiles')) return 'team_profiles';
      if (key.includes('seedmatchupallrounds') || key.includes('seedmatchups') || key.includes('seedhistory')) return 'seed_matchups';
      if (key.includes('archetypesummaryv5') || key.includes('archetypesummary')) return 'archetype_summary';
      if (key.includes('archetypehistory')) return 'archetype_history';
      if (key.includes('kenpom') || key.includes('summary26')) return 'kenpom_csv';
      if (key.includes('espnpeoplesbracket') || key.includes('peoplesbracket') || key.includes('yahoobracketpickdistribution') || key.includes('pickdistribution')) return 'espn_public_csv';
      if (key.includes('bracketprobabilitieswithyahoocorrected') || key.includes('bracketprobabilitieswithyahoo')) return 'team_round_probs_json';
      if (key.includes('brackettreeexactprobabilities') || key.includes('teamroundprobabilities') || key.includes('bracketexactprobabilities') || key.includes('fullbracketprobabilities')) return 'team_round_probs_csv';
      return '';
    }

    const inferredType = inferTypeFromFilename(req.file.originalname);
    let resolvedType = '';
    const normalizedType = typeAliases[t] || t;
    if (normalizedType && uploadTypeMap[normalizedType]) resolvedType = normalizedType;
    if (!resolvedType && inferredType && uploadTypeMap[inferredType]) resolvedType = inferredType;
    if (!resolvedType) {
      return res.status(400).json({
        success: false,
        error: `Invalid type "${t || 'missing'}". Allowed: ${Object.keys(uploadTypeMap).join(', ')}. You can also upload by filename like chatbot_predictions_v5*.json, bracket_ready_2026*.json, bracket_2026*.json, bracket_cache_2026*.json, bracketgpt_bracket_output_2026*.json, bracket_output_enriched_2026*.json, kenpom_2026*.csv, summary26*.csv, espn_peoples_bracket_2026*.csv, yahoo_bracket_pick_distribution*.csv, bracket_tree_exact_probabilities_2026*.csv, team_round_probabilities_2026*.csv, bracket_exact_probabilities_2026*.csv, bracket_probabilities_with_yahoo_corrected_2026*.json, team_profiles_2026*.json, seed_matchup_all_rounds*.json, archetype_summary_v5*.json, archetype_history*.json`
      });
    }

    try {
      const raw = fs.readFileSync(req.file.path, 'utf8');
      const { parsed, normalized, mode } = parseUploadedData(raw, resolvedType);
      fs.writeFileSync(path.join(DATA_DIR, uploadTypeMap[resolvedType]), normalized);
      fs.unlinkSync(req.file.path);
      dataStore[resolvedType] = parsed;
      syncDataStoreAliases();
      reloadDataFromDisk('admin-upload');
      if (resolvedType === 'bracket_ready' || /bracket_ready/i.test(String(req.file.originalname || ''))) {
        loadBracketReady();
      }
      const sizeMB = (Buffer.byteLength(normalized) / 1024 / 1024).toFixed(1);
      if (t && t !== resolvedType) {
        console.log(`  [upload] type override: requested=${t}, inferred=${resolvedType}, file=${req.file.originalname}`);
      }
      console.log(`  [upload] ${uploadTypeMap[resolvedType]} uploaded and reloaded (${sizeMB}MB, parse:${mode})`);
      return res.json({
        success: true,
        savedAs: uploadTypeMap[resolvedType],
        size: `${sizeMB}MB`,
        type: resolvedType,
      });
    } catch (e) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: `Invalid JSON or write failed: ${e.message}` });
    }
  });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'admin.html'), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

app.get('/value-picks', (req, res) => {
  return res.redirect(302, '/');
});

app.get('/bracket', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'bracket.html'), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

app.get('/', (req, res) => {
  return res.redirect(302, '/bracket');
});

app.use('/data', express.static(path.join(__dirname, 'data')));
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'bracket.html'), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BracketGPT on :${PORT} | ${cfg.provider} | key:${cfg.apiKey ? 'yes' : 'NO'} | data:${hasData ? 'yes' : 'NO'}`);
});
