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
};
const FILE_MAP = {
  teams: ['team_profiles_2025.json', 'team_profiles.json'],
  humanSummaries: ['team_human_summaries_2025.json', 'team_human_summaries.json'],
  base: ['chatbot_predictions_base_2025.json', 'chatbot_predictions_base.json'],
  upset: ['chatbot_predictions_upset_2025.json', 'chatbot_predictions_upset.json'],
  floor: ['chatbot_predictions_floor_2025.json', 'chatbot_predictions_floor.json'],
  optimizer: ['bracket_optimizer_results_2025.json', 'bracket_optimizer_results.json'],
  bracket: ['bracket_predictions_2025.json', 'bracket_predictions.json'],
  bracket2025: ['bracket_2025.json'],
  ev: ['bracket_ev_espn.json'],
  context: ['context_2025.json', 'context.json'],
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
  };
}

function sysPrompt() {
  const n = (store.base?.predictions || []).length;
  return `You are BracketGPT — a sharp, opinionated March Madness bracket advisor.
You sound like Bill Simmons meets Nate Silver: data-backed but conversational.
Confident, opinionated, backed by data.

MODEL: v5.2 stacked ensemble (Optuna-tuned XGBoost + LightGBM + CatBoost, 5-fold OOF stacking, isotonic calibration) trained on 2003-2024 NCAA tournament data. ${n} matchup predictions loaded.

V5 FEATURES YOU KNOW ABOUT:
- MOMENTUM: Each team has a margin_trend (slope of scoring margin over the season) and last10_win_rate. "Rising" = trending up AND winning lately. "Fading" = declining or losing. "Steady" = flat.
- VOLATILITY: margin_std measures game-to-game scoring variance. volatility_score is 0-100 (min-max normalized). High volatility = unpredictable — great for upsets, bad for chalk picks.
- INJURY PROXY: If a team's last 5 games scoring margin dropped 6+ points vs their season average, they get an injury_alert. This flags possible injuries, suspensions, or fatigue without needing an injury database.
- CONFERENCE TOURNEY: How far they went — champion, finalist, semifinalist, or first_round_exit. Momentum signal.
- HOME/AWAY SPLIT: home_away_net_diff shows how much better a team plays at home. Big splits mean they may struggle on neutral courts (all tournament games are neutral).
- MATCHUP RISK NOTE: Flags like "High variance matchup", "Momentum mismatch favoring X", or "Injury concern — monitor roster news".

HOW TO USE V5 DATA:
- When someone asks about a team, ALWAYS mention momentum status if rising or fading.
- If a team has an injury_alert, warn about it and quote the drop: "Their net margin dropped X pts in the final 5 games — could signal injuries or fatigue."
- For upset picks, favor teams that are RISING + opponent is FADING or has high volatility.
- For safe/chalk picks, favor teams that are STEADY or RISING with LOW volatility.
- Mention the matchup_risk_note when it exists — it's pre-computed analysis.
- Conference tourney results matter: a conf tourney champion has momentum, a first-round exit raises questions.

ARCHETYPES: Each team has a named archetype (Juggernaut, Fortress, Glass Cannon, etc.) with historical matchup win rates. Use these for color and narrative.

HOW TO TALK:
- Casual. Contractions. No corporate speak.
- NEVER say: "based on my analysis", "it's important to note", "it's worth noting", "let's dive in", "certainly", "I'd be happy to", "great question"
- Use basketball language: "chalk pick", "live dog", "fade", "value play", "cinderella", "bracket buster", "trending up"
- Lead with your pick, THEN explain. 2-4 short paragraphs max.
- Bold team names when first mentioned. Don't over-format — no bullet point dumps.
- When data shows momentum/injury flags, weave them into the narrative naturally. Don't just list stats.

EXAMPLES OF GOOD RESPONSES:

Q: "Who wins Duke vs Vermont?"
A: "**Duke** cruises. They're a Juggernaut archetype — elite on both ends — and they're trending up with a 9-1 last-10 record. Vermont's been fading down the stretch (margin dropped 5 pts in the final 5 games, possible injury concern). Duke by 15+, lock it in."

Q: "Best upset pick in the first round?"
A: "Love **New Mexico** as a 10-seed over 7-seed Marquette. The Lobos are rising — 8-2 in their last 10, conference tourney champs, and their margin trend is +1.3 pts per game improvement. Marquette's a Glass Cannon with a volatility score of 78 — that inconsistency kills you in March. Model gives New Mexico 48%, but the momentum gap makes this closer to a coin flip I'd lean into for a big pool."

Q: "Is Houston safe to go deep?"
A: "**Houston** is the safest bet in the bracket. Fortress archetype — elite defense, steady momentum, volatility score of just 22. Their home/away split is tight too, meaning they play the same everywhere. No injury alert. Conference tourney finalists. The only concern is their offense can stall against elite D, but that's a Sweet 16 problem, not a first weekend problem."

CONFIDENCE TIERS:
- 85%+ → "Lock it in"
- 70-85% → "Solid pick"
- 55-70% → "Slight lean"
- 50-55% → "Coin flip — go with your gut"

STRATEGY: ESPN scoring 10-20-40-80-160-320. Small pools = chalk. Big pools = need upsets in later rounds for max value.

If you don't have data on a specific matchup, say so honestly — don't make up numbers.`;
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
    /([a-z0-9 .&'’-]+?)\s+(?:vs\.?|versus)\s+([a-z0-9 .&'’-]+)/i,
    /who\s+would\s+win\s+if\s+([a-z0-9 .&'’-]+?)\s+played\s+([a-z0-9 .&'’-]+)/i,
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

function findCtx(query) {
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

  // V5: Momentum/trending queries — find teams that are rising or fading
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

  // Deduplicate
  const seen = new Set();
  return ctx
    .filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, c.maxItems || 25);
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
      line += ` → ${winner} ${(prob * 100).toFixed(0)}% ${p.confidence || ''}`;

      if (p.upset_flag) line += ` ${p.upset_flag}`;

      // Archetype info
      if (p.t1_archetype || p.t2_archetype) {
        line += ` | Archetypes: ${p.t1_archetype || '?'} vs ${p.t2_archetype || '?'}`;
      }

      // V5: form_and_risk — this is the key upgrade
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
          line += ` | ⚠️ INJURY ALERT ${p.t1_name}: ${fr.t1_injury_context || 'efficiency drop in final 5 games'}`;
        }
        if (fr.t2_injury_alert) {
          line += ` | ⚠️ INJURY ALERT ${p.t2_name}: ${fr.t2_injury_context || 'efficiency drop in final 5 games'}`;
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

    if (item.type === 'bracket') {
      const g = item.data;
      const prob = g.winProb ? Math.max(g.winProb, 1 - g.winProb) : 0.5;
      let line = `🏀 BRACKET ${g.round || ''}`;
      if (g.projected) line += ' (PROJECTED)';
      line += `: (${g.seed1})${g.team1} vs (${g.seed2})${g.team2}`;
      if (g.predictedWinner) line += ` → ${g.predictedWinner} ${(prob * 100).toFixed(0)}%`;
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

  return `R2 vs ${r2} → S16 vs winner of ${s16} → E8 vs winner of ${e8}`;
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
    acc[key] = !!(d && (Array.isArray(d) ? d.length : d.predictions?.length || d.profiles?.length || d.results?.length));
    return acc;
  }, {});
  const ready = loaded.base || loaded.upset || loaded.floor;
  res.status(ready ? 200 : 503).json({ ready, loaded, provider: cfg.provider, hasApiKey: !!cfg.apiKey });
});

app.post('/api/chat', async (req, res) => {
  try {
    if (!rateOk(req.ip || 'x')) return res.status(429).json({ error: 'Too many messages.' });

    const msgs = req.body?.messages;
    if (!Array.isArray(msgs) || !msgs.length) return res.status(400).json({ error: 'No message.' });

    const joined = msgs.map((m) => m.content).join(' ');
    const intent = detectIntent(joined);
    const ctx = findCtx(joined);
    const intentHint = intent === 'value'
      ? 'INTENT: VALUE. Lead with EV/value-edge vs public pick rates and bracket leverage.'
      : `INTENT: ${intent.toUpperCase()}.`;
    const bracketGrounding = buildBracketGroundingContext();
    return res.json({ reply: await callLLM(msgs, `${intentHint}
${bracketGrounding}
${fmtCtx(ctx)}`), intent });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Something broke.' });
  }
});


app.get('/api/value-picks', (req, res) => {
  const teams = store.ev?.teams || store.ev?.data || (Array.isArray(store.ev) ? store.ev : []);
  const normalized = teams.map((team) => ({
    ...team,
    championEdge: Number(team.rounds?.Champion?.value_edge || 0),
    finalFourEdge: Number(team.rounds?.['Final Four']?.value_edge || 0),
    round32Edge: Number(team.rounds?.['Round of 32']?.value_edge || 0),
  }));
  res.json({
    count: normalized.length,
    leaderboard: normalized.sort((a, b) => Number(b.championEdge || 0) - Number(a.championEdge || 0)),
    hiddenGems: normalized.filter((t) => t.championEdge >= 10 || t.finalFourEdge >= 10 || t.round32Edge >= 10),
    fadeThese: normalized.filter((t) => t.championEdge <= -10 || t.finalFourEdge <= -10 || t.round32Edge <= -10),
  });
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
  const ctx = findCtx(query);
  res.json({
    query,
    contextSettings: contextCfg(),
    contextCount: ctx.length,
    contextPreview: ctx,
    formattedContext: fmtCtx(ctx),
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
    hasData = loadData();
    enrichBracketWithPlayers();
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
