const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
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
  adminPassword: process.env.ADMIN_PASSWORD || savedConfig.adminPassword || 'changeme2025',
  provider: process.env.LLM_PROVIDER || savedConfig.provider || 'deepseek',
  apiKey: process.env.LLM_API_KEY || savedConfig.apiKey || '',
  model: process.env.LLM_MODEL || savedConfig.model || '',
  temperature: parseFloat(process.env.LLM_TEMPERATURE || savedConfig.temperature || 0.7),
  maxTokens: parseInt(process.env.LLM_MAX_TOKENS || savedConfig.maxTokens || 1200, 10),
  brandName: savedConfig.brandName || 'BracketGPT',
  tagline: savedConfig.tagline || 'AI Bracket Advisor',
  activeSeason: savedConfig.activeSeason || '2025',
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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
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
  teams: ['team_profiles_2025.json', 'team_profiles.json'],
  humanSummaries: ['team_human_summaries_2025.json', 'team_human_summaries.json'],
  base: ['chatbot_predictions_base_2025_historical.json', 'chatbot_predictions_base_2025.json', 'chatbot_predictions_base.json'],
  upset: ['chatbot_predictions_upset_2025.json', 'chatbot_predictions_upset.json'],
  floor: ['chatbot_predictions_floor_2025.json', 'chatbot_predictions_floor.json'],
  optimizer: ['bracket_optimizer_results_2025.json', 'bracket_optimizer_results.json'],
  bracket: ['bracket_predictions_2025.json', 'bracket_predictions.json'],
  bracket2025: ['bracket_2025.json'],
  ev: ['bracket_ev_espn.json'],
  poolStrategy: ['pool_strategy_2025.json', 'pool_strategy.json'],
  seedMatchups: ['historical/seed_matchup_all_rounds.json', 'seed_matchup_all_rounds.json'],
  bracketMatchups: ['bracketgpt_matchups_2025_v2.json', 'bracketgpt_matchups_2025_final.json'],
  bracketOutput: ['bracketgpt_bracket_output_2025.json'],
  context: ['context_2025.json', 'context.json'],
};

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
  regions: ['South', 'West', 'East', 'Midwest'],
  season: 2025,
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
  return anyLoaded;
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
  const rows = store.bracketMatchups?.matchups || [];
  bracketMatchupIndex.season = Number(store.bracketMatchups?.season || cfg.activeSeason || 2025);
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

  bracketMatchupIndex.regions = regionSet.size ? Array.from(regionSet) : ['South', 'West', 'East', 'Midwest'];
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
enrichBracketWithPlayers();
buildHistoricalIndex();
buildBracketMatchupIndex();
if (store.bracketOutput?.strategies) {
  console.log(`✅ Bracket output loaded: ${Object.keys(store.bracketOutput.strategies).length} strategies`);
} else {
  console.log('⚠️ No bracket output — EP features disabled');
}

function reloadDataFromDisk(reason = 'reload') {
  const loaded = loadData();
  enrichBracketWithPlayers();
  buildHistoricalIndex();
  buildBracketMatchupIndex();
  hasData = loaded;
  console.log(`[data] ${reason} | loaded:${loaded ? 'yes' : 'no'}`);
}

let dataReloadTimer = null;
try {
  fs.watch(DATA_DIR, { persistent: false }, (eventType, fileName) => {
    if (!fileName || fileName.startsWith('tmp')) return;
    if (!fileName.toLowerCase().endsWith('.json')) return;
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
    season: Number(pred.season || bracketMatchupIndex.season || cfg.activeSeason || 2025),
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
  for (const team of sampled) {
    const ep = buildTeamEpBreakdown(team);
    const champProb = Number(store.bracketOutput?.bracket_structure?.champion_probs?.[team] || 0);
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

function findEvByTeamName(teamName) {
  const name = normalizeTeamName(teamName);
  const teams = store.ev?.teams || store.ev?.data || (Array.isArray(store.ev) ? store.ev : []);
  return teams.find((t) => normalizeTeamName(t.name) === name) || null;
}

function isRealBracketMatchup(teamA, teamB) {
  if (!store.bracket2025?.bracketGames) return false;
  const a = normalizeTeamName(teamA);
  const b = normalizeTeamName(teamB);
  return store.bracket2025.bracketGames.some((g) => {
    const g1 = normalizeTeamName(g.team1 || g.team1Name || g.team1_name || g.team1School);
    const g2 = normalizeTeamName(g.team2 || g.team2Name || g.team2_name || g.team2School);
    return (g1 === a && g2 === b) || (g1 === b && g2 === a);
  });
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
  const profiles = store.teams?.profiles || store.teams?.teams || (Array.isArray(store.teams) ? store.teams : []);
  if (c.includeTeamProfiles !== false) {
    for (const t of profiles) {
      const name = (t.name || t.school || '').toLowerCase();
      if (name && lc.includes(name)) ctx.push({ type: 'team', data: t });
    }
  }

  // Bracket games (if loaded)
  const bracketGames = store.bracket?.games || store.bracket?.predictions || [];
  const bracketMatchups = store.bracketMatchups?.matchups || [];

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
    for (const p of (store[model]?.predictions || [])) {
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
    for (const p of (store.base?.predictions || [])) {
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
    for (const p of (store.base?.predictions || [])) {
      const fr = p.form_and_risk || {};
      if (fr.t1_injury_alert || fr.t2_injury_alert) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  // V5: Volatility/variance queries
  if (/volatil|variance|inconsisten|unpredictable|wild.card|chaos|bust|reliable|steady|consistent|safe/.test(lc)) {
    for (const p of (store.base?.predictions || [])) {
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
    for (const p of (store.base?.predictions || [])) {
      const fr = p.form_and_risk || {};
      if (fr.t1_conf_tourney_result === 'champion' || fr.t2_conf_tourney_result === 'champion') {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  // Upset queries
  if (/upset|cinderella|underdog|dark.?horse|sleeper|bust/.test(lc)) {
    let count = 0;
    // Bracket-aware upsets first
    for (const g of bracketGames) {
      if (g.upsetFlag === 'upset' || (g.predictedWinner && g.seed1 < g.seed2 && g.predictedWinner === g.team2)) {
        ctx.push({ type: 'bracket', data: g });
        count++;
        if (count >= (c.upsetItems || 8)) break;
      }
    }
    // V5 enhancement: also surface high-volatility opponents + rising underdogs
    if (count < (c.upsetItems || 8)) {
      for (const p of (store.base?.predictions || [])) {
        if (p.upset_flag && p.upset_flag !== '' && p.upset_flag !== 'chalk') {
          ctx.push({ type: 'pred', model: 'base', data: p });
          count++;
          if (count >= (c.upsetItems || 8)) break;
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
    for (const o of (store.optimizer?.results || []).slice(0, c.optimizerItems || 5)) {
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
    for (const p of (store.base?.predictions || [])) {
      if ((p.t1_seed || 99) <= 2 && (p.t2_seed || 99) <= 2) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  // Base dedupe before optimization
  const seen = new Set();
  const deduped = ctx.filter((item) => {
    const key = JSON.stringify(item);
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
  const cacheKey = normalizeTeamName(userMessage || '');
  if (cacheKey && historicalIndex.contextCache.has(cacheKey)) {
    return historicalIndex.contextCache.get(cacheKey);
  }

  const flags = classifyHistoricalQuery(userMessage);
  const mentionedTeams = detectMentionedTeamsFromQuery(userMessage);
  const seen = new Set();
  const relevantPreds = [];
  const addPred = (pred) => {
    const fp = predictionFingerprint(pred);
    if (!fp || seen.has(fp)) return;
    seen.add(fp);
    relevantPreds.push(pred);
  };

  for (const team of mentionedTeams) {
    for (const pred of (historicalIndex.predictionsByTeam.get(team) || [])) addPred(pred);
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
    for (let seed = 5; seed <= 16; seed += 1) {
      for (const pred of (historicalIndex.predictionsBySeed.get(seed) || [])) addPred(pred);
    }
  }

  for (const seedNum of flags.seedMatches) {
    for (const pred of (historicalIndex.predictionsBySeed.get(seedNum) || [])) addPred(pred);
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
      const prob = Math.max(p.model_win_prob || 0.5, 1 - (p.model_win_prob || 0.5));
      const winner = p.predicted_winner_name || (p.model_win_prob > 0.5 ? p.t1_name : p.t2_name);

      // Base prediction line
      let line = `[${item.model}] (${p.t1_seed})${p.t1_name} vs (${p.t2_seed})${p.t2_name}`;
      line += ` â†’ ${winner} ${(prob * 100).toFixed(0)}% ${p.confidence || ''}`;

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
  return String(value || '')
    .normalize('NFKD')
    .replace(/[â€™']/g, '')
    .replace(/\./g, '')
    .replace(/&/g, ' and ')
    .replace(/\bsaint\b/gi, 'st')
    .replace(/\bstate\b/gi, 'st')
    .replace(/\buniversity\b/gi, 'univ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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
  if (looksLikeGame) out.push(node);

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

  return `BRACKET_GROUNDING_2025 (authoritative seed/region/path source; never override with memory):\n${lines.join('\n')}`;
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
    return { error: 'Missing bracket_2025.json (or fallback bracket_predictions.json).' };
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

async function callLLM(messages, ctxStr, options = {}) {
  const key = cfg.apiKey;
  if (!key) return 'Need an API key! Admin: set LLM_API_KEY in Railway env vars or go to /admin.';
  const system = options.rawSystemPrompt ? ctxStr : (sysPrompt() + (ctxStr ? `\n\n-- DATA --\n${ctxStr}` : ''));
  const temperature = Number.isFinite(options.temperature) ? options.temperature : cfg.temperature;

  try {
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
      const d = await r.json();
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
      const d = await r.json();
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
      const d = await r.json();
      return d.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
    }

    return `Unknown provider: ${cfg.provider}`;
  } catch (e) {
    console.error('LLM err:', e);
    return 'Connection issue. Try again.';
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
  const allMatchups = store.bracketMatchups?.matchups || [];
  const matchups = allMatchups.filter((m) => String(m.round || '').toUpperCase() === 'R64');
  const pairings = (
    Array.isArray(store.bracketMatchups?.finalFourPairings) &&
    store.bracketMatchups.finalFourPairings.length >= 2
  )
    ? store.bracketMatchups.finalFourPairings
    : [['South', 'West'], ['East', 'Midwest']];
  res.json({
    season: bracketMatchupIndex.season,
    regions: bracketMatchupIndex.regions,
    matchups,
    finalFourPairings: pairings,
  });
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
  if (!store.bracketOutput?.bracket_structure?.champion_probs) {
    return res.status(404).json({ error: 'Champion probabilities unavailable.' });
  }
  return res.json({
    champion_probs: store.bracketOutput.bracket_structure.champion_probs,
  });
});

app.get('/api/matchup/by-teams/:t1/:t2', (req, res) => {
  const matchup = findBracketMatchupByTeams(req.params.t1, req.params.t2);
  if (!matchup) return res.status(404).json({ error: 'Matchup not found.' });
  return res.json(matchup);
});

app.get('/api/matchup', (req, res) => {
  const t1 = String(req.query.t1 || '').trim();
  const t2 = String(req.query.t2 || '').trim();
  if (!t1 || !t2) return res.status(400).json({ error: 't1 and t2 are required.' });
  const matchup = findBracketMatchupByTeams(t1, t2);
  if (!matchup) return res.status(404).json({ error: 'not found' });

  const q1 = normalizeTeamName(t1);
  const q2 = normalizeTeamName(t2);
  const m1 = normalizeTeamName(matchup?.t1?.name);
  const m2 = normalizeTeamName(matchup?.t2?.name);
  const flipped = m1 === q2 && m2 === q1;
  const side1 = flipped ? matchup.t2 : matchup.t1;
  const side2 = flipped ? matchup.t1 : matchup.t2;

  let t1Prob = normProb(side1?.win_probability);
  let t2Prob = normProb(side2?.win_probability);
  if (t1Prob === null && t2Prob !== null) t1Prob = 1 - t2Prob;
  if (t2Prob === null && t1Prob !== null) t2Prob = 1 - t1Prob;
  if (t1Prob === null) t1Prob = 0.5;
  if (t2Prob === null) t2Prob = 1 - t1Prob;

  const predictedWinner = matchup?.matchup_meta?.predicted_winner
    || (t1Prob >= t2Prob ? side1?.name : side2?.name)
    || side1?.name
    || side2?.name
    || '';
  const predictedWinnerSeed = normalizeTeamName(predictedWinner) === normalizeTeamName(side1?.name)
    ? Number(side1?.seed || 0) || null
    : (normalizeTeamName(predictedWinner) === normalizeTeamName(side2?.name)
      ? Number(side2?.seed || 0) || null
      : null);
  const upsetFlag = String(matchup?.matchup_meta?.upset_flag || matchup?.matchup_meta?.display_flag || 'chalk').toLowerCase();

  return res.json({
    t1_prob: t1Prob,
    t2_prob: t2Prob,
    predicted_winner: predictedWinner,
    predicted_winner_seed: predictedWinnerSeed,
    upset_flag: upsetFlag,
    t1_seed: Number(side1?.seed || 0) || null,
    t2_seed: Number(side2?.seed || 0) || null,
  });
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
    const msgs = req.body?.messages;
    if (!Array.isArray(msgs) || !msgs.length) return res.status(400).json({ error: 'No message.' });

    const joined = msgs.map((m) => m.content).join(' ');
    const intent = detectIntent(joined);
    const ctx = findCtx(joined, { intent, messageCount: msgs.length });
    const historicalCtx = getRelevantHistoricalContext(joined);
    const intentHint = intent === 'value'
      ? 'INTENT: VALUE. Lead with EV/value-edge vs public pick rates and bracket leverage.'
      : `INTENT: ${intent.toUpperCase()}.`;
    const bracketGrounding = buildBracketGroundingContext();
    const bracketState = req.body?.bracketState;
    const focusMatchup = req.body?.focusMatchup;
    const shouldIncludeBracket = opts.forceBracketContext || !!bracketState;
    const bracketStateBlock = shouldIncludeBracket ? formatBracketStateContext(bracketState || {}, focusMatchup) : '';

    const reply = await callLLM(msgs, `${intentHint}
${bracketGrounding}
RELEVANT_HISTORICAL_CONTEXT:
${JSON.stringify(historicalCtx, null, 0)}
CONTEXT_COUNTS: predictions=${historicalCtx.predictions.length}, archetypes=${Object.keys(historicalCtx.archetype_history || {}).length}
${bracketStateBlock}
${fmtCtx(ctx)}`);
    return res.json({ reply, intent });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Something broke.' });
  }
}

app.post('/api/chat', async (req, res) => {
  return handleChat(req, res, { forceBracketContext: false });
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
    return res.status(404).json({ error: 'Pool strategy data not loaded. Upload pool_strategy_2025.json via admin.' });
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

app.get('/admin/config', auth, (req, res) => {
  const dataStatus = {};
  for (const key of Object.keys(FILE_MAP)) {
    const d = store[key];
    dataStatus[key] = hasContent(d);
  }
  res.json({ ...cfg, context: contextCfg(), dataStatus });
});

app.post('/admin/config', auth, (req, res) => {
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

const up = multer({ dest: TMP_DIR });
app.post('/admin/upload', auth, up.single('file'), (req, res) => {
  const type = req.body.type;
  if (!type || !FILE_MAP[type]) return res.status(400).json({ success: false, error: 'Bad type' });
  const targetFile = FILE_MAP[type][0];
  if (!req.file) return res.status(400).json({ success: false, error: 'No file' });

  try {
    const raw = fs.readFileSync(req.file.path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!hasContent(parsed)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'JSON is empty or missing supported fields.' });
    }
    fs.writeFileSync(path.join(DATA_DIR, targetFile), raw);
    fs.unlinkSync(req.file.path);
    reloadDataFromDisk('admin-upload');
    return res.json({ success: true });
  } catch (e) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: 'Bad JSON' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'admin.html'), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

app.get('/value-picks', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'value-picks.html'), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

app.get('/bracket', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'bracket.html'), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

app.use('/data', express.static(path.join(__dirname, 'data')));
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'), (err) => {
    if (err && !res.headersSent) res.status(404).send('Not found');
  });
});

process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BracketGPT on :${PORT} | ${cfg.provider} | key:${cfg.apiKey ? 'yes' : 'NO'} | data:${hasData ? 'yes' : 'NO'}`);
});


