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
  return `You are BracketGPT, a March Madness bracket advisor that uses a 3-model ensemble (base, upset, floor) and an ESPN 10-20-40-80-160-320 scoring framework. Provide recommendations with three strategy lenses: safe, balanced, contrarian. Use available team profiles and optimizer outputs when available.`;
}

// Build context by searching team names in loaded data
function buildContextFromQuery(queryText) {
  const context = [];
  const teams = dataStore.team_profiles || [];
  const lc = String(queryText || '').toLowerCase();
  for (const t of teams) {
    const name = (t.name || t.school || '').toLowerCase();
    if (!name) continue;
    if (lc.includes(name) || lc.includes((t.nickname || '').toLowerCase())) {
      context.push({ type: 'team_profile', team: t });
    }
  }
  // add optimizer snippets if relevant
  const optimizer = dataStore.bracket_optimizer_results || [];
  for (const opt of optimizer.slice(0, 10)) {
    if (JSON.stringify(opt).toLowerCase().includes(lc)) {
      context.push({ type: 'optimizer', item: opt });
    }
  }
  return context;
}

// Stubbed provider callers (replace with real API calls as needed)
async function sendToProvider(provider, payload) {
  // payload: {system, messages, temperature, maxTokens, model}
  // This function returns a simple synthetic reply for demo/testing
  const base = buildSystemPrompt();
  const userMsg = (payload.messages && payload.messages.length) ? payload.messages[payload.messages.length - 1].content : '';
  const ctxSummary = (payload.context || []).slice(0,3).map(c=>c.type==='team_profile'?`Profile:${c.team.name||c.team.school}`:c.type).join(', ');
  const reply = `Provider(${provider}) response using model ${payload.model||config.model||'default'}:\nStrategy suggestions (safe/balanced/contrarian) for: ${userMsg}\nContext: ${ctxSummary}`;
  return reply;
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

// File uploads for data
const upload = multer({ dest: path.join(DATA_DIR, 'tmp') });
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
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BracketGPT server listening on port ${PORT}`);
});
