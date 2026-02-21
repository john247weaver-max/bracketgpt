const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(__dirname, 'config.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// ensure tmp subdir exists for file uploads
const DATA_TMP = path.join(DATA_DIR, 'tmp');
if (!fs.existsSync(DATA_TMP)) fs.mkdirSync(DATA_TMP, { recursive: true });

// Default config
const DEFAULT_CONFIG = {
  adminPassword: 'changeme2025',
  brandName: 'BracketGPT',
  tagline: '3-MODEL ENSEMBLE · ESPN 320 OPTIMIZER',
  provider: 'deepseek',
  apiKey: '',
  model: '',
  temperature: 0.7,
  maxTokens: 800,
  weights: { baseWeight: 0.5, upsetWeight: 0.3, floorWeight: 0.2 },
  features: {
    showTeamProfiles: true,
    showMatchupData: true,
    showOptimizerData: true,
    showUpsetPicks: true,
    showSafetyScores: true,
    includeHistoricalContext: true
  },
  activeSeason: null,
  messagesPerMinute: 60
};

let config = DEFAULT_CONFIG;
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    config = Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
} catch (err) {
  console.error('Could not load config, using defaults', err);
}

// In-memory data store loaded from backend/data/
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
        const raw = fs.readFileSync(p, 'utf8');
        dataStore[key] = JSON.parse(raw);
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

// Global safety: prevent unexpected process exit on uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

// Simple rate limiter by IP
const rateMap = new Map();
function checkRateLimit(ip) {
  const limit = config.messagesPerMinute || 60;
  const windowMs = 60 * 1000;
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start >= windowMs) {
    entry = { count: 0, start: now };
  }
  if (entry.count >= limit) {
    rateMap.set(ip, entry);
    return false;
  }
  entry.count++;
  rateMap.set(ip, entry);
  return true;
}

// Admin auth middleware
function requireAdmin(req, res, next) {
  const pw = req.header('x-admin-password') || '';
  if (!pw || pw !== config.adminPassword) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Helper: persist config
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save config', e);
    return false;
  }
}

// Build system prompt
function buildSystemPrompt() {
  const base = dataStore.chatbot_predictions_base || {};
  const upset = dataStore.chatbot_predictions_upset || {};
  const floor = dataStore.chatbot_predictions_floor || {};
  const preds = base.predictions || [];

  let prompt = `You are BracketGPT, an elite March Madness bracket advisor powered by a 3-model stacked ensemble (XGBoost + LightGBM + meta-learner) trained on 20+ years of tournament data with KenPom efficiency ratings.

You provide advice using three strategy lenses:
- SAFE: High-floor picks that protect your bracket
- BALANCED: Best expected value picks
- CONTRARIAN: Differentiation picks for pools

ESPN scoring: 10-20-40-80-160-320 per round.`;

  if (preds.length > 0) {
    prompt += '\n\nYou have access to ' + preds.length + ' historical predictions from the model.';
    prompt += '\nModel version: ' + (base.model_version || 'unknown');
    if (base.model_stats) {
      prompt += '\nAvg Brier score: ' + (base.model_stats.avg_brier || 'N/A');
      prompt += '\nEnsemble: ' + (base.model_stats.ensemble || 'XGB+LGB stacked');
    }
  }

  return prompt;
}

// Build context by searching team names in loaded data
function buildContextFromQuery(queryText) {
  const context = [];
  const lc = String(queryText || '').toLowerCase();

  // Search team profiles (coerce to array safely)
  let teams = [];
  if (Array.isArray(dataStore.team_profiles)) {
    teams = dataStore.team_profiles;
  } else if (dataStore.team_profiles && Array.isArray(dataStore.team_profiles.profiles)) {
    teams = dataStore.team_profiles.profiles;
  } else if (dataStore.team_profiles && Array.isArray(dataStore.team_profiles.teams)) {
    teams = dataStore.team_profiles.teams;
  }
  if (Array.isArray(teams)) {
    for (const t of teams) {
      const name = (t.name || t.school || t.TeamName || '').toLowerCase();
      if (name && lc.includes(name)) {
        context.push({ type: 'team_profile', team: t });
      }
    }
  }

  // Search predictions for mentioned teams or seeds
  const basePreds = dataStore.chatbot_predictions_base?.predictions || [];
  for (const p of basePreds) {
    const t1 = (p.t1_name || '').toLowerCase();
    const t2 = (p.t2_name || '').toLowerCase();
    if ((t1 && lc.includes(t1)) || (t2 && lc.includes(t2))) {
      context.push({ type: 'prediction', item: p });
    }
    // Check for seed references like "12 seed" or "5 vs 12"
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

  // Add optimizer results if asking about bracket strategy
  if (lc.includes('bracket') || lc.includes('optim') || lc.includes('strategy') || lc.includes('pool')) {
    const opt = dataStore.bracket_optimizer_results?.results || [];
    for (const o of opt.slice(0, 5)) {
      context.push({ type: 'optimizer', item: o });
    }
  }

  // If user asks about upsets generally
  if (lc.includes('upset') || lc.includes('cinderella') || lc.includes('underdog')) {
    for (const p of basePreds) {
      if (p.upset_flag && p.upset_flag.includes('upset')) {
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
  }).slice(0, 15);
}

// Provider callers (DeepSeek / Claude / Gemini)
async function sendToProvider(provider, payload) {
  const key = config.apiKey;
  if (!key) return 'Error: No API key set. Go to /admin to add your API key.';

  const systemPrompt = payload.system;
  const messages = payload.messages || [];
  const contextStr = (payload.context || []).map(c => {
    if (c.type === 'team_profile') return 'Team: ' + JSON.stringify(c.team);
    if (c.type === 'prediction') return 'Prediction: ' + JSON.stringify(c.item);
    if (c.type === 'optimizer') return 'Optimizer: ' + JSON.stringify(c.item);
    return '';
  }).filter(Boolean).join('\n');

  const fullSystem = systemPrompt + (contextStr ? '\n\nRELEVANT DATA:\n' + contextStr : '');

  if (provider === 'deepseek') {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages: [{ role: 'system', content: fullSystem }, ...messages],
        temperature: payload.temperature || 0.7,
        max_tokens: payload.maxTokens || 800,
      })
    });
    const data = await res.json();
    if (data.error) return 'API Error: ' + (data.error.message || JSON.stringify(data.error));
    return data.choices?.[0]?.message?.content || 'No response';
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
        max_tokens: payload.maxTokens || 800,
        system: fullSystem,
        messages: messages,
      })
    });
    const data = await res.json();
    if (data.error) return 'API Error: ' + (data.error.message || JSON.stringify(data.error));
    return data.content?.[0]?.text || 'No response';
  }

  if (provider === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + (config.model || 'gemini-pro') + ':generateContent?key=' + key, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullSystem + '\n\n' + messages.map(m => m.role + ': ' + m.content).join('\n') }] }],
        generationConfig: { temperature: payload.temperature || 0.7, maxOutputTokens: payload.maxTokens || 800 }
      })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
  }

  return 'Unknown provider: ' + provider;
}

// Public GET /api/config (limited)
app.get('/api/config', (req, res) => {
  res.json({ brandName: config.brandName, tagline: config.tagline, dataLoaded: !!dataLoaded, activeSeason: config.activeSeason });
});

// Public POST /api/chat
app.post('/api/chat', async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Rate limit exceeded' });
    const body = req.body || {};
    const messages = body.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages required' });
    const system = buildSystemPrompt();
    const context = buildContextFromQuery(messages.map(m=>m.content).join(' '));
    const payload = {
      system,
      messages,
      context,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      model: config.model,
    };
    const reply = await sendToProvider(config.provider || 'deepseek', payload);
    res.json({ reply });
  } catch (err) {
    console.error('chat error', err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Admin routes
app.get('/admin/config', requireAdmin, (req, res) => {
  res.json(config);
});

app.post('/admin/config', requireAdmin, (req, res) => {
  const incoming = req.body || {};
  // merge allowed fields
  const allow = ['provider','apiKey','model','temperature','maxTokens','weights','features','branding','brandName','tagline','activeSeason','messagesPerMinute','adminPassword'];
  for (const k of Object.keys(incoming)) {
    if (k in config) {
      config[k] = incoming[k];
    } else if (k === 'brandName' || k === 'tagline' || k === 'activeSeason') {
      config[k] = incoming[k];
    } else if (k === 'weights' && typeof incoming.weights === 'object') {
      config.weights = incoming.weights;
    } else if (k === 'features' && typeof incoming.features === 'object') {
      config.features = incoming.features;
    }
  }
  const ok = saveConfig();
  if (!ok) return res.status(500).json({ error: 'failed to save' });
  res.json({ ok: true, config });
});

// Change admin password
app.post('/admin/password', requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword and newPassword required' });
  if (oldPassword !== config.adminPassword) return res.status(403).json({ error: 'invalid old password' });
  config.adminPassword = newPassword;
  saveConfig();
  res.json({ ok: true });
});

// File uploads for data (use ensured tmp path)
const upload = multer({ dest: DATA_TMP });
app.post('/admin/upload', requireAdmin, upload.single('file'), (req, res) => {
  const t = req.body.type;
  const allowed = ['teams','base','upset','floor','optimizer'];
  if (!t || !allowed.includes(t)) return res.status(400).json({ error: 'invalid type' });
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const mapping = {
    teams: 'team_profiles.json',
    base: 'chatbot_predictions_base.json',
    upset: 'chatbot_predictions_upset.json',
    floor: 'chatbot_predictions_floor.json',
    optimizer: 'bracket_optimizer_results.json'
  };
  const destName = mapping[t];
  const destPath = path.join(DATA_DIR, destName);
  try {
    const raw = fs.readFileSync(req.file.path, 'utf8');
    // validate JSON
    JSON.parse(raw);
    fs.writeFileSync(destPath, raw);
    // remove tmp file
    fs.unlinkSync(req.file.path);
    // reload data
    loadDataFiles();
    res.json({ ok: true, savedAs: destName });
  } catch (e) {
    console.error('upload error', e);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: 'invalid json or write failed' });
  }
});

// Admin panel HTML
app.get('/admin', (req, res) => {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BracketGPT Admin</title>
  <style>body{font-family:Arial,Helvetica,sans-serif;background:#0b1020;color:#e6eef8;padding:18px}label{display:block;margin:8px 0;font-size:13px}input,select{padding:8px;border-radius:6px;border:1px solid #334155;background:#0f1724;color:#e6eef8;width:100%}button{padding:8px 12px;background:#ff7a18;border:none;border-radius:6px;color:#041018;cursor:pointer;margin-top:8px}section{max-width:980px;margin:0 auto}</style>
  </head><body>
  <section>
  <h1>BracketGPT Admin Panel</h1>
  <div>
    <label>Provider<select id="provider"><option value="deepseek">DeepSeek</option><option value="claude">Anthropic Claude</option><option value="gemini">Google Gemini</option></select></label>
    <label>API Key<input id="apiKey" placeholder="provider api key"></label>
    <label>Model<input id="model" placeholder="model name"></label>
    <label>Temperature<input id="temperature" type="number" step="0.01" min="0" max="2"></label>
    <label>Max Tokens<input id="maxTokens" type="number" min="1"></label>
    <div style="display:flex;gap:12px"><div style="flex:1"><label>Base Weight<input id="baseWeight" type="number" step="0.01" min="0" max="1"></label></div><div style="flex:1"><label>Upset Weight<input id="upsetWeight" type="number" step="0.01" min="0" max="1"></label></div><div style="flex:1"><label>Floor Weight<input id="floorWeight" type="number" step="0.01" min="0" max="1"></label></div></div>
    <label>Features</label>
    <div><label><input id="showTeamProfiles" type="checkbox"> Show Team Profiles</label></div>
    <div><label><input id="showMatchupData" type="checkbox"> Show Matchup Data</label></div>
    <div><label><input id="showOptimizerData" type="checkbox"> Show Optimizer Data</label></div>
    <div><label><input id="showUpsetPicks" type="checkbox"> Show Upset Picks</label></div>
    <div><label><input id="showSafetyScores" type="checkbox"> Show Safety Scores</label></div>
    <div><label><input id="includeHistoricalContext" type="checkbox"> Include Historical Context</label></div>
    <label>Branding: <input id="brandName"></label>
    <label>Tagline: <input id="tagline"></label>
    <label>Active Season: <input id="activeSeason"></label>
    <label>Messages Per Minute Rate Limit<input id="messagesPerMinute" type="number" min="1"></label>
    <button id="save">Save Config</button>
  </div>
  <hr>
  <h2>Upload Data</h2>
  <label>Type<select id="dataType"><option value="teams">teams</option><option value="base">base</option><option value="upset">upset</option><option value="floor">floor</option><option value="optimizer">optimizer</option></select></label>
  <label>JSON File<input id="dataFile" type="file" accept="application/json"></label>
  <button id="upload">Upload</button>
  <div id="uploadStatus" style="margin-top:8px;color:#9aa4b2"></div>

  <hr>
  <h2>Change Admin Password</h2>
  <label>Old Password<input id="oldPassword" type="password"></label>
  <label>New Password<input id="newPassword" type="password"></label>
  <button id="changePw">Change Password</button>
  <div id="pwStatus" style="margin-top:8px;color:#9aa4b2"></div>

  </section>
  <script>
    const authHeader = { headers: { 'x-admin-password': prompt('Enter admin password for panel access (not stored)') || '' } };
    async function load(){
      try{
        const r = await fetch('/admin/config', authHeader);
        if(!r.ok) throw new Error('auth failed');
        const cfg = await r.json();
        document.getElementById('provider').value = cfg.provider || '';
        document.getElementById('apiKey').value = cfg.apiKey || '';
        document.getElementById('model').value = cfg.model || '';
        document.getElementById('temperature').value = cfg.temperature || 0.7;
        document.getElementById('maxTokens').value = cfg.maxTokens || 800;
        document.getElementById('baseWeight').value = cfg.weights?.baseWeight || 0.5;
        document.getElementById('upsetWeight').value = cfg.weights?.upsetWeight || 0.3;
        document.getElementById('floorWeight').value = cfg.weights?.floorWeight || 0.2;
        document.getElementById('showTeamProfiles').checked = !!cfg.features?.showTeamProfiles;
        document.getElementById('showMatchupData').checked = !!cfg.features?.showMatchupData;
        document.getElementById('showOptimizerData').checked = !!cfg.features?.showOptimizerData;
        document.getElementById('showUpsetPicks').checked = !!cfg.features?.showUpsetPicks;
        document.getElementById('showSafetyScores').checked = !!cfg.features?.showSafetyScores;
        document.getElementById('includeHistoricalContext').checked = !!cfg.features?.includeHistoricalContext;
        document.getElementById('brandName').value = cfg.brandName || '';
        document.getElementById('tagline').value = cfg.tagline || '';
        document.getElementById('activeSeason').value = cfg.activeSeason || '';
        document.getElementById('messagesPerMinute').value = cfg.messagesPerMinute || 60;
      }catch(e){
        alert('Failed to load admin config: '+e.message);
      }
    }
    document.getElementById('save').addEventListener('click', async ()=>{
      const payload = {
        provider: document.getElementById('provider').value,
        apiKey: document.getElementById('apiKey').value,
        model: document.getElementById('model').value,
        temperature: Number(document.getElementById('temperature').value),
        maxTokens: Number(document.getElementById('maxTokens').value),
        weights: {
          baseWeight: Number(document.getElementById('baseWeight').value),
          upsetWeight: Number(document.getElementById('upsetWeight').value),
          floorWeight: Number(document.getElementById('floorWeight').value)
        },
        features: {
          showTeamProfiles: document.getElementById('showTeamProfiles').checked,
          showMatchupData: document.getElementById('showMatchupData').checked,
          showOptimizerData: document.getElementById('showOptimizerData').checked,
          showUpsetPicks: document.getElementById('showUpsetPicks').checked,
          showSafetyScores: document.getElementById('showSafetyScores').checked,
          includeHistoricalContext: document.getElementById('includeHistoricalContext').checked
        },
        brandName: document.getElementById('brandName').value,
        tagline: document.getElementById('tagline').value,
        activeSeason: document.getElementById('activeSeason').value,
        messagesPerMinute: Number(document.getElementById('messagesPerMinute').value)
      };
      try{
        const r = await fetch('/admin/config', Object.assign({method:'POST',headers:Object.assign({'Content-Type':'application/json'}, authHeader.headers),body:JSON.stringify(payload)}));
        if(!r.ok) throw new Error(await r.text());
        alert('Saved');
      }catch(e){alert('Save failed: '+e.message)}
    });

    document.getElementById('upload').addEventListener('click', async ()=>{
      const fileEl = document.getElementById('dataFile');
      const type = document.getElementById('dataType').value;
      if(!fileEl.files.length) return alert('Choose a file');
      const fd = new FormData();
      fd.append('file', fileEl.files[0]);
      fd.append('type', type);
      try{
        const r = await fetch('/admin/upload', Object.assign({method:'POST', body: fd}, {headers: authHeader.headers}));
        const j = await r.json();
        document.getElementById('uploadStatus').textContent = JSON.stringify(j);
      }catch(e){document.getElementById('uploadStatus').textContent = 'Upload failed: '+e.message}
    });

    document.getElementById('changePw').addEventListener('click', async ()=>{
      const oldPassword = document.getElementById('oldPassword').value;
      const newPassword = document.getElementById('newPassword').value;
      try{
        const r = await fetch('/admin/password', Object.assign({method:'POST',headers:Object.assign({'Content-Type':'application/json'}, authHeader.headers),body:JSON.stringify({oldPassword,newPassword})}));
        const j = await r.json();
        document.getElementById('pwStatus').textContent = j.ok ? 'Password changed' : JSON.stringify(j);
      }catch(e){document.getElementById('pwStatus').textContent = 'Error: '+e.message}
    });

    load();
  </script>
  </body></html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Serve frontend static assets
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, '..', 'frontend', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('Failed to send index.html', err);
      if (!res.headersSent) res.status(404).send('Not Found');
    }
  });
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BracketGPT server listening on port ${PORT}`);
});
