const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(__dirname, 'config.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_TMP = path.join(DATA_DIR, 'tmp');
if (!fs.existsSync(DATA_TMP)) fs.mkdirSync(DATA_TMP, { recursive: true });

// ─── DEFAULT CONFIG ───
const DEFAULT_CONFIG = {
  adminPassword: 'changeme2025',
  brandName: 'BracketGPT',
  tagline: 'AI Bracket Advisor · 2025 Tournament',
  provider: 'deepseek',
  apiKey: '',
  model: '',
  temperature: 0.7,
  maxTokens: 1200,
  weights: { baseWeight: 0.6, upsetWeight: 0.25, floorWeight: 0.15 },
  features: {
    showTeamProfiles: true,
    showMatchupData: true,
    showOptimizerData: true,
    showUpsetPicks: true,
    showSafetyScores: true,
    includeHistoricalContext: true
  },
  activeSeason: '2025',
  messagesPerMinute: 30
};

let config = DEFAULT_CONFIG;
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
} catch (err) {
  console.error('Config load failed, using defaults', err);
}

// ─── DATA STORE ───
const dataStore = {
  team_profiles: [],
  chatbot_predictions_base: [],
  chatbot_predictions_upset: [],
  chatbot_predictions_floor: [],
  bracket_optimizer_results: []
};

function loadDataFiles() {
  const mapping = {
    team_profiles: 'team_profiles.json',
    chatbot_predictions_base: 'chatbot_predictions_base.json',
    chatbot_predictions_upset: 'chatbot_predictions_upset.json',
    chatbot_predictions_floor: 'chatbot_predictions_floor.json',
    bracket_optimizer_results: 'bracket_optimizer_results.json'
  };
  let loaded = false;
  for (const key of Object.keys(mapping)) {
    const p = path.join(DATA_DIR, mapping[key]);
    try {
      if (fs.existsSync(p)) {
        dataStore[key] = JSON.parse(fs.readFileSync(p, 'utf8'));
        loaded = true;
      } else {
        dataStore[key] = [];
      }
    } catch (e) {
      console.warn('Failed to load', p, e.message);
      dataStore[key] = [];
    }
  }
  return loaded;
}

const dataLoaded = loadDataFiles();

// ─── ERROR HANDLERS ───
process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled:', reason));

// ─── RATE LIMITER ───
const rateMap = new Map();
function checkRateLimit(ip) {
  const limit = config.messagesPerMinute || 30;
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start >= 60000) entry = { count: 0, start: now };
  if (entry.count >= limit) { rateMap.set(ip, entry); return false; }
  entry.count++;
  rateMap.set(ip, entry);
  return true;
}

// ─── ADMIN AUTH ───
function requireAdmin(req, res, next) {
  const pw = req.header('x-admin-password') || '';
  if (!pw || pw !== config.adminPassword) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); return true; }
  catch (e) { console.error('Config save failed', e); return false; }
}

// ─── SYSTEM PROMPT (HUMAN-SOUNDING CHAT) ───
function buildSystemPrompt() {
  const base = dataStore.chatbot_predictions_base || {};
  const preds = base.predictions || [];

  return `You are BracketGPT — a sharp, casual March Madness bracket advisor. You talk like a knowledgeable friend at a sports bar, not a data scientist. You're fun, direct, and opinionated while backing it up with data.

PERSONALITY:
- Casual and confident. Use contractions. Keep it conversational.
- Never say "based on my analysis" or "the model suggests" — just give your take like you OWN it.
- Use sports language naturally: "chalk pick," "live dog," "fade," "value play," "cinderella."
- Be direct. Lead with your pick, THEN explain why.
- Keep responses punchy — 2-4 short paragraphs max. No bullet point dumps.
- Use emphasis sparingly: bold a team name or key stat, not everything.
- If someone asks a vague question, answer it AND suggest follow-ups naturally.
- Match the user's energy — if they're hyped, be hyped. If they want analysis, go deeper.

WRONG WAY: "Based on our ensemble model's prediction of 73.2% win probability incorporating efficiency metrics and Elo ratings, Duke appears to be the stronger team in this matchup."

RIGHT WAY: "Duke takes this one. Their defense is suffocating — top 5 in adjusted defensive efficiency — and they've got the Elo edge by 80+ points. I'd put them around 73% to win. Not a sweat pick."

STRATEGY CONTEXT:
- You advise for ESPN bracket scoring: 10-20-40-80-160-320 per round
- For small pools (<20): play it safe, chalk wins
- For big pools (50+): you NEED differentiation — find smart upsets
- Always think about "who else will pick this" — pool leverage matters

DATA ACCESS:
You have ${preds.length} matchup predictions from a 3-model ensemble (XGBoost + LightGBM + meta-learner) trained on 2003-2024 tournament data with KenPom/Barttorvik efficiency metrics.

When you reference specific predictions, embed confidence naturally:
- 85%+ → "Lock it in" / "Don't overthink this"
- 70-85% → "Solid pick" / "I like them here"  
- 55-70% → "Slight lean" / "Could go either way but..."
- 50-55% → "True toss-up" / "Flip a coin honestly"

If a prediction has upset_flag = "upset", get excited about it. Upsets are what make March Madness.

When you don't have specific data for a matchup, say so naturally and give your best take based on what you do know.`;
}

// ─── CONTEXT BUILDER ───
function buildContextFromQuery(queryText) {
  const context = [];
  const lc = String(queryText || '').toLowerCase();

  // Search team profiles
  let teams = [];
  if (Array.isArray(dataStore.team_profiles)) teams = dataStore.team_profiles;
  else if (dataStore.team_profiles?.profiles) teams = dataStore.team_profiles.profiles;
  else if (dataStore.team_profiles?.teams) teams = dataStore.team_profiles.teams;

  if (Array.isArray(teams)) {
    for (const t of teams) {
      const name = (t.name || t.school || t.TeamName || '').toLowerCase();
      if (name && lc.includes(name)) context.push({ type: 'team_profile', team: t });
    }
  }

  // Search base predictions
  const basePreds = dataStore.chatbot_predictions_base?.predictions || [];
  for (const p of basePreds) {
    const t1 = (p.t1_name || '').toLowerCase();
    const t2 = (p.t2_name || '').toLowerCase();
    if ((t1 && lc.includes(t1)) || (t2 && lc.includes(t2))) {
      context.push({ type: 'prediction', item: p });
    }
    const seedMatch = lc.match(/(\d+)\s*(?:seed|vs|versus)/);
    if (seedMatch) {
      const seed = parseInt(seedMatch[1]);
      if (p.t1_seed === seed || p.t2_seed === seed) {
        context.push({ type: 'prediction', item: p });
      }
    }
  }

  // Search upset predictions
  const upsetPreds = dataStore.chatbot_predictions_upset?.predictions || [];
  for (const p of upsetPreds) {
    const t1 = (p.t1_name || '').toLowerCase();
    const t2 = (p.t2_name || '').toLowerCase();
    if ((t1 && lc.includes(t1)) || (t2 && lc.includes(t2))) {
      context.push({ type: 'prediction', item: p });
    }
  }

  // Optimizer data for strategy questions
  if (lc.includes('bracket') || lc.includes('optim') || lc.includes('strategy') || lc.includes('pool')) {
    const opt = dataStore.bracket_optimizer_results?.results || [];
    for (const o of opt.slice(0, 5)) context.push({ type: 'optimizer', item: o });
  }

  // General upset queries
  if (lc.includes('upset') || lc.includes('cinderella') || lc.includes('underdog') || lc.includes('dark horse')) {
    for (const p of basePreds) {
      if (p.upset_flag && p.upset_flag.includes('upset')) {
        context.push({ type: 'prediction', item: p });
      }
    }
  }

  // Region queries
  const regions = { 'south': 'W', 'east': 'X', 'midwest': 'Y', 'west': 'Z' };
  for (const [rName, rCode] of Object.entries(regions)) {
    if (lc.includes(rName + ' region') || lc.includes(rName + ' bracket')) {
      // If we have seed data, filter predictions by region
      // For now, add a region hint
      context.push({ type: 'region_hint', region: rName, code: rCode });
    }
  }

  // Final four / championship queries
  if (lc.includes('final four') || lc.includes('championship') || lc.includes('champion') || lc.includes('win it all')) {
    // Add top-seed matchups
    for (const p of basePreds) {
      if (p.t1_seed <= 2 && p.t2_seed <= 2) {
        context.push({ type: 'prediction', item: p });
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return context.filter(c => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

// ─── PROVIDER CALLERS ───
async function sendToProvider(provider, payload) {
  const key = config.apiKey;
  if (!key) return 'I need an API key to work — the admin needs to set one up at /admin. If you\'re the admin, head there and add your key!';

  const systemPrompt = payload.system;
  const messages = payload.messages || [];
  
  // Build context string with cleaner formatting
  const contextStr = (payload.context || []).map(c => {
    if (c.type === 'team_profile') return 'TEAM: ' + JSON.stringify(c.team);
    if (c.type === 'prediction') {
      const p = c.item;
      const lines = [];
      lines.push(`MATCHUP: (${p.t1_seed}) ${p.t1_name} vs (${p.t2_seed}) ${p.t2_name}`);
      lines.push(`Pick: ${p.predicted_winner_name} at ${(Math.max(p.model_win_prob, 1-p.model_win_prob)*100).toFixed(0)}% | Confidence: ${p.confidence} | ${p.upset_flag || 'chalk'}`);
      if (p.predicted_margin) lines.push(`Predicted margin: ${p.predicted_margin > 0 ? '+' : ''}${p.predicted_margin.toFixed(1)}`);
      if (p.kenpom) lines.push(`KenPom: ${p.t1_name} ${p.kenpom.t1_adjem > 0 ? '+' : ''}${p.kenpom.t1_adjem} vs ${p.t2_name} ${p.kenpom.t2_adjem > 0 ? '+' : ''}${p.kenpom.t2_adjem}`);
      if (p.key_factors) lines.push(`Elo diff: ${p.key_factors.elo_diff > 0 ? '+' : ''}${p.key_factors.elo_diff}`);
      if (p.responses?.quick) lines.push(`Quick take: ${p.responses.quick}`);
      return lines.join('\n');
    }
    if (c.type === 'optimizer') return 'OPTIMIZER: ' + JSON.stringify(c.item);
    if (c.type === 'region_hint') return `REGION QUERY: User asking about the ${c.region} region`;
    return '';
  }).filter(Boolean).join('\n---\n');

  const fullSystem = systemPrompt + (contextStr ? '\n\n─── RELEVANT DATA ───\n' + contextStr : '');

  try {
    if (provider === 'deepseek') {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: config.model || 'deepseek-chat',
          messages: [{ role: 'system', content: fullSystem }, ...messages],
          temperature: payload.temperature || 0.7,
          max_tokens: payload.maxTokens || 1200,
        })
      });
      const data = await res.json();
      if (data.error) return 'Hmm, hit an API issue: ' + (data.error.message || JSON.stringify(data.error));
      return data.choices?.[0]?.message?.content || 'No response from the model.';
    }

    if (provider === 'claude') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.model || 'claude-sonnet-4-20250514',
          max_tokens: payload.maxTokens || 1200,
          system: fullSystem,
          messages: messages,
        })
      });
      const data = await res.json();
      if (data.error) return 'API issue: ' + (data.error.message || JSON.stringify(data.error));
      return data.content?.[0]?.text || 'No response from Claude.';
    }

    if (provider === 'gemini') {
      const modelName = config.model || 'gemini-2.0-flash';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullSystem + '\n\n' + messages.map(m => m.role + ': ' + m.content).join('\n') }] }],
          generationConfig: { temperature: payload.temperature || 0.7, maxOutputTokens: payload.maxTokens || 1200 }
        })
      });
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.';
    }

    return 'Unknown provider: ' + provider;
  } catch (err) {
    console.error('Provider error:', err);
    return 'Hit a connection issue. Give it another shot in a sec.';
  }
}

// ─── PUBLIC ROUTES ───

app.get('/api/config', (req, res) => {
  res.json({
    brandName: config.brandName,
    tagline: config.tagline,
    dataLoaded: !!dataLoaded,
    activeSeason: config.activeSeason
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Slow down — too many messages. Try again in a minute.' });

    const messages = req.body?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'No message received.' });

    const system = buildSystemPrompt();
    const context = buildContextFromQuery(messages.map(m => m.content).join(' '));
    const payload = { system, messages, context, temperature: config.temperature, maxTokens: config.maxTokens };
    const reply = await sendToProvider(config.provider || 'deepseek', payload);
    res.json({ reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something broke on my end. Try again.' });
  }
});

// ─── ADMIN ROUTES ───

app.get('/admin/config', requireAdmin, (req, res) => {
  // Return config with data status
  const dataStatus = {
    teams: !!(Array.isArray(dataStore.team_profiles) ? dataStore.team_profiles.length : dataStore.team_profiles?.profiles?.length),
    base: !!(dataStore.chatbot_predictions_base?.predictions?.length),
    upset: !!(dataStore.chatbot_predictions_upset?.predictions?.length),
    floor: !!(dataStore.chatbot_predictions_floor?.predictions?.length),
    optimizer: !!(dataStore.bracket_optimizer_results?.results?.length),
  };
  res.json({ ...config, dataStatus });
});

app.post('/admin/config', requireAdmin, (req, res) => {
  const incoming = req.body || {};
  for (const k of Object.keys(incoming)) {
    if (k === 'dataStatus') continue; // don't save this
    if (k in config) {
      config[k] = incoming[k];
    } else if (['brandName', 'tagline', 'activeSeason'].includes(k)) {
      config[k] = incoming[k];
    } else if (k === 'weights' && typeof incoming.weights === 'object') {
      config.weights = incoming.weights;
    } else if (k === 'features' && typeof incoming.features === 'object') {
      config.features = incoming.features;
    }
  }
  if (!saveConfig()) return res.status(500).json({ error: 'Failed to save' });
  res.json({ ok: true, config });
});

app.post('/admin/password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (oldPassword !== config.adminPassword) return res.status(403).json({ error: 'Wrong old password' });
  config.adminPassword = newPassword;
  saveConfig();
  res.json({ ok: true });
});

const upload = multer({ dest: DATA_TMP });
app.post('/admin/upload', requireAdmin, upload.single('file'), (req, res) => {
  const t = req.body.type;
  const allowed = ['teams', 'base', 'upset', 'floor', 'optimizer'];
  if (!t || !allowed.includes(t)) return res.status(400).json({ error: 'Invalid type', success: false });
  if (!req.file) return res.status(400).json({ error: 'File required', success: false });

  const mapping = {
    teams: 'team_profiles.json',
    base: 'chatbot_predictions_base.json',
    upset: 'chatbot_predictions_upset.json',
    floor: 'chatbot_predictions_floor.json',
    optimizer: 'bracket_optimizer_results.json'
  };

  try {
    const raw = fs.readFileSync(req.file.path, 'utf8');
    JSON.parse(raw); // validate
    fs.writeFileSync(path.join(DATA_DIR, mapping[t]), raw);
    fs.unlinkSync(req.file.path);
    loadDataFiles();
    res.json({ success: true, savedAs: mapping[t] });
  } catch (e) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'Invalid JSON or write failed', success: false });
  }
});

// ─── SERVE FRONTEND ───

// Admin panel — serve the HTML file
app.get('/admin', (req, res) => {
  const adminPath = path.join(__dirname, '..', 'frontend', 'admin.html');
  if (fs.existsSync(adminPath)) {
    res.sendFile(adminPath);
  } else {
    res.status(404).send('Admin panel not found. Make sure frontend/admin.html exists.');
  }
});

// Static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Catch-all → index.html
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '..', 'frontend', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err && !res.headersSent) res.status(404).send('Not Found');
  });
});

// ─── START ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏀 BracketGPT running on port ${PORT}`);
  console.log(`   Frontend: http://localhost:${PORT}`);
  console.log(`   Admin:    http://localhost:${PORT}/admin`);
  console.log(`   Data loaded: ${dataLoaded}`);
});
