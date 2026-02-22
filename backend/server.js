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

const store = { teams: null, base: null, upset: null, floor: null, optimizer: null, bracket: null };
const FILE_MAP = {
  teams: 'team_profiles.json',
  base: 'chatbot_predictions_base.json',
  upset: 'chatbot_predictions_upset.json',
  floor: 'chatbot_predictions_floor.json',
  optimizer: 'bracket_optimizer_results.json',
  bracket: 'bracket_predictions.json',
};

function loadData() {
  let anyLoaded = false;
  for (const [key, fileName] of Object.entries(FILE_MAP)) {
    const p = path.join(DATA_DIR, fileName);
    try {
      if (fs.existsSync(p)) {
        store[key] = JSON.parse(fs.readFileSync(p, 'utf8'));
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

let hasData = loadData();

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
  const c = contextCfg();
  return `You are BracketGPT — a sharp, fun March Madness bracket advisor. Talk like a knowledgeable friend who watches way too much college basketball. Confident, opinionated, backed by data.\n\nHOW TO TALK:\n- Casual. Contractions. No corporate speak.\n- NEVER say "based on my analysis" — just give your take.\n- Use basketball language: "chalk pick," "live dog," "fade," "value play," "cinderella."\n- Lead with your pick, THEN explain. 2-4 short paragraphs max.\n- Bold team names. Don't over-format.\n\nWRONG: "Based on our ensemble model prediction of 73.2% win probability, Duke appears stronger."\nRIGHT: "**Duke** takes this. Defense is suffocating — top 5 adjusted efficiency — 80+ Elo edge. Around 73% to win. Lock it in."\n\nCONFIDENCE:\n- 85%+ → "Lock it in"\n- 70-85% → "Solid pick"\n- 55-70% → "Slight lean"\n- 50-55% → "Coin flip"\n\nSTRATEGY: ESPN scoring 10-20-40-80-160-320. Small pools = chalk. Big pools = need upsets.\n\nDECISION RULES:\n- If model sources disagree, acknowledge disagreement and pick one side with a reason.\n- If confidence is below 55%, call it volatile and avoid lock language.\n- If requested context is missing, say what is missing instead of hallucinating.\n\nDATA: ${n} matchup predictions from 3-model ensemble (XGBoost+LightGBM) on 2003-2024 data. 76% accuracy.\nCONTEXT SETTINGS: maxItems=${c.maxItems}, upsetItems=${c.upsetItems}, optimizerItems=${c.optimizerItems}, titleSeedCutoff=${c.titleSeedCutoff}.`;
}

function findCtx(query) {
  const ctx = [];
  const lc = (query || '').toLowerCase();
  const c = contextCfg();
  const profiles = store.teams?.profiles || store.teams?.teams || (Array.isArray(store.teams) ? store.teams : []);

  if (c.includeTeamProfiles) {
    for (const t of profiles) {
      const name = (t.name || t.school || '').toLowerCase();
      if (name && lc.includes(name)) ctx.push({ type: 'team', data: t });
    }
  }

  for (const model of ['base', 'upset', 'floor']) {
    for (const p of store[model]?.predictions || []) {
      const t1 = (p.t1_name || '').toLowerCase();
      const t2 = (p.t2_name || '').toLowerCase();
      let hit = (t1 && lc.includes(t1)) || (t2 && lc.includes(t2));
      if (!hit) {
        const m = lc.match(/(\d+)\s*(?:seed|vs|versus)/);
        if (m && (p.t1_seed === +m[1] || p.t2_seed === +m[1])) hit = true;
      }
      if (hit) ctx.push({ type: 'pred', model, data: p });
    }
  }

  if (/upset|cinderella|underdog|dark.?horse|sleeper/.test(lc)) {
    let count = 0;
    for (const p of store.base?.predictions || []) {
      if (p.upset_flag === 'upset') {
        ctx.push({ type: 'pred', model: 'base', data: p });
        count += 1;
        if (count >= c.upsetItems) break;
      }
    }
  }

  if (c.includeOptimizer && /bracket|strateg|pool|optim/.test(lc)) {
    for (const o of (store.optimizer?.results || []).slice(0, c.optimizerItems)) {
      ctx.push({ type: 'opt', data: o });
    }
  }

  if (c.includeTitleAngles && /final.four|champ|win.it.all|natty/.test(lc)) {
    for (const p of store.base?.predictions || []) {
      if ((p.t1_seed || 99) <= c.titleSeedCutoff && (p.t2_seed || 99) <= c.titleSeedCutoff) {
        ctx.push({ type: 'pred', model: 'base', data: p });
      }
    }
  }

  const seen = new Set();
  return ctx
    .filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, c.maxItems);
}

function fmtCtx(ctx) {
  return ctx
    .map((item) => {
      if (item.type === 'team') return `TEAM: ${JSON.stringify(item.data)}`;
      if (item.type === 'pred') {
        const p = item.data;
        const wp = normProb(p.model_win_prob);
        const confidence = wp === null ? 'n/a' : `${(Math.max(wp, 1 - wp) * 100).toFixed(0)}%`;
        return `[${item.model}] (${p.t1_seed})${p.t1_name} vs (${p.t2_seed})${p.t2_name} > ${p.predicted_winner_name} ${confidence} ${p.confidence} ${p.upset_flag || ''}`;
      }
      if (item.type === 'opt') return `OPT: ${JSON.stringify(item.data)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function callLLM(messages, ctxStr) {
  const key = cfg.apiKey;
  if (!key) return 'Need an API key! Admin: set LLM_API_KEY in Railway env vars or go to /admin.';
  const system = sysPrompt() + (ctxStr ? `\n\n-- DATA --\n${ctxStr}` : '');

  try {
    if (cfg.provider === 'deepseek') {
      const r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: cfg.model || 'deepseek-chat',
          messages: [{ role: 'system', content: system }, ...messages],
          temperature: cfg.temperature,
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
          generationConfig: { temperature: cfg.temperature, maxOutputTokens: cfg.maxTokens },
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

    const ctx = findCtx(msgs.map((m) => m.content).join(' '));
    return res.json({ reply: await callLLM(msgs, fmtCtx(ctx)) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Something broke.' });
  }
});

app.get('/admin/config', auth, (req, res) => {
  const dataStatus = {};
  for (const key of Object.keys(FILE_MAP)) {
    const d = store[key];
    dataStatus[key] = !!(d && (Array.isArray(d) ? d.length : d.predictions?.length || d.profiles?.length || d.results?.length));
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
  if (!req.file) return res.status(400).json({ success: false, error: 'No file' });

  try {
    const raw = fs.readFileSync(req.file.path, 'utf8');
    JSON.parse(raw);
    fs.writeFileSync(path.join(DATA_DIR, FILE_MAP[type]), raw);
    fs.unlinkSync(req.file.path);
    hasData = loadData();
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
