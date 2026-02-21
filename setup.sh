#!/bin/bash
# ═══════════════════════════════════════════════════════
# BracketGPT — Full Repo Setup
# Run this from inside your cloned bracketgpt/ directory
# ═══════════════════════════════════════════════════════

set -e
echo "🏀 Setting up BracketGPT..."

# Clean everything except .git
find . -maxdepth 1 -not -name '.git' -not -name '.' -exec rm -rf {} +

# Create structure
mkdir -p frontend backend/data scripts models

# ─── .gitignore ───
cat > .gitignore << 'GITIGNORE'
node_modules/
backend/config.json
backend/data/*.json
backend/data/tmp/
.env
.DS_Store
GITIGNORE

# ─── package.json ───
cat > package.json << 'PKG'
{
  "name": "bracketgpt",
  "version": "1.0.0",
  "description": "March Madness AI bracket advisor",
  "main": "backend/server.js",
  "scripts": {
    "start": "node backend/server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1"
  }
}
PKG

# ─── README.md ───
cat > README.md << 'README'
# 🏀 BracketGPT

March Madness AI bracket advisor. 3-model ensemble trained on 20+ years of tournament data.

## Quick Start

```bash
npm install
npm start
# http://localhost:3000 — chat
# http://localhost:3000/admin — admin panel
```

## Railway Deploy

Set these env vars in Railway:
- `LLM_API_KEY` — your DeepSeek/Claude/Gemini key
- `LLM_PROVIDER` — deepseek | claude | gemini
- `ADMIN_PASSWORD` — your admin password

## Stack
- Frontend: Vanilla HTML/CSS/JS (Sleeper-inspired dark theme)
- Backend: Express.js
- ML: XGBoost + LightGBM ensemble, KenPom metrics
- Deploy: Railway (auto from main)

## 2025 Backtest
- **76.1% accuracy** (51/67 games)
- **0.159 Brier score**
README

# ─── backend/server.js ───
cat > backend/server.js << 'SERVERJS'
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const TMP_DIR = path.join(DATA_DIR, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── CONFIG: env vars (Railway) > config.json > defaults ──
const CONFIG_FILE = path.join(__dirname, 'config.json');
let saved = {};
try { if (fs.existsSync(CONFIG_FILE)) saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {}

const config = {
  adminPassword: process.env.ADMIN_PASSWORD || saved.adminPassword || 'changeme2025',
  provider:      process.env.LLM_PROVIDER   || saved.provider || 'deepseek',
  apiKey:        process.env.LLM_API_KEY    || saved.apiKey || '',
  model:         process.env.LLM_MODEL      || saved.model || '',
  temperature:   parseFloat(process.env.LLM_TEMPERATURE || saved.temperature || 0.7),
  maxTokens:     parseInt(process.env.LLM_MAX_TOKENS || saved.maxTokens || 1200),
  brandName:     process.env.BRAND_NAME     || saved.brandName || 'BracketGPT',
  tagline:       saved.tagline || 'AI Bracket Advisor · 2025 Tournament',
  activeSeason:  saved.activeSeason || '2025',
  messagesPerMinute: parseInt(saved.messagesPerMinute || 30),
  weights: saved.weights || { baseWeight: 0.6, upsetWeight: 0.25, floorWeight: 0.15 },
  features: saved.features || {
    showTeamProfiles: true, showMatchupData: true, showOptimizerData: true,
    showUpsetPicks: true, showSafetyScores: true, includeHistoricalContext: true
  },
};

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch(e) {}
}
saveConfig();

// ── DATA ──
const store = { teams: null, base: null, upset: null, floor: null, optimizer: null };
const FILES = {
  teams: 'team_profiles.json', base: 'chatbot_predictions_base.json',
  upset: 'chatbot_predictions_upset.json', floor: 'chatbot_predictions_floor.json',
  optimizer: 'bracket_optimizer_results.json'
};

function loadData() {
  let any = false;
  for (const [k, f] of Object.entries(FILES)) {
    const p = path.join(DATA_DIR, f);
    try { if (fs.existsSync(p)) { store[k] = JSON.parse(fs.readFileSync(p, 'utf8')); any = true; } else store[k] = null; }
    catch(e) { store[k] = null; }
  }
  return any;
}
const hasData = loadData();

// ── SYSTEM PROMPT ──
function sysPrompt() {
  const n = (store.base?.predictions || []).length;
  return `You are BracketGPT — a sharp, fun March Madness bracket advisor. Talk like a knowledgeable friend who watches way too much college basketball. Confident, opinionated, backed by data.

HOW TO TALK:
- Casual. Contractions. No corporate speak.
- NEVER say "based on my analysis" or "the model suggests" — just give your take.
- Use basketball language: "chalk pick," "live dog," "fade," "value play," "cinderella."
- Lead with your pick, THEN explain. Keep it to 2-4 short paragraphs.
- Bold team names. Don't over-format.

WRONG: "Based on our ensemble model's prediction of 73.2% win probability, Duke appears stronger."
RIGHT: "**Duke** takes this. Their defense is suffocating — top 5 in adjusted efficiency — and they've got an 80+ Elo edge. Around 73% to win. Lock it in."

CONFIDENCE:
- 85%+ → "Lock it in" / "Don't overthink this"
- 70-85% → "Solid pick" / "I like them here"
- 55-70% → "Slight lean" / "Could go either way but..."
- 50-55% → "Coin flip" / "Go with your gut"

STRATEGY: ESPN scoring 10-20-40-80-160-320. Small pools = chalk. Big pools = need upsets for differentiation.

DATA: ${n} matchup predictions from 3-model ensemble (XGBoost + LightGBM) on 2003-2024 data. 76% accuracy.`;
}

// ── CONTEXT SEARCH ──
function findCtx(q) {
  const ctx = [], lc = (q||'').toLowerCase();
  const profiles = store.teams?.profiles || store.teams?.teams || (Array.isArray(store.teams) ? store.teams : []);
  for (const t of profiles) {
    const n = (t.name||t.school||'').toLowerCase();
    if (n && lc.includes(n)) ctx.push({type:'team',data:t});
  }
  for (const model of ['base','upset','floor']) {
    for (const p of (store[model]?.predictions||[])) {
      const t1=(p.t1_name||'').toLowerCase(), t2=(p.t2_name||'').toLowerCase();
      let hit = (t1&&lc.includes(t1))||(t2&&lc.includes(t2));
      if (!hit) { const m=lc.match(/(\d+)\s*(?:seed|vs|versus)/); if(m&&(p.t1_seed===+m[1]||p.t2_seed===+m[1])) hit=true; }
      if (hit) ctx.push({type:'pred',model,data:p});
    }
  }
  if (/upset|cinderella|underdog|dark.?horse|sleeper/.test(lc))
    for (const p of (store.base?.predictions||[])) if (p.upset_flag==='upset') ctx.push({type:'pred',model:'base',data:p});
  if (/bracket|strateg|pool|optim/.test(lc))
    for (const o of (store.optimizer?.results||[]).slice(0,5)) ctx.push({type:'opt',data:o});
  if (/final.four|champ|win.it.all|natty/.test(lc))
    for (const p of (store.base?.predictions||[])) if (p.t1_seed<=2&&p.t2_seed<=2) ctx.push({type:'pred',model:'base',data:p});
  const seen=new Set();
  return ctx.filter(c=>{const k=JSON.stringify(c);if(seen.has(k))return false;seen.add(k);return true}).slice(0,20);
}

function fmtCtx(ctx) {
  return ctx.map(c=>{
    if(c.type==='team') return 'TEAM: '+JSON.stringify(c.data);
    if(c.type==='pred'){const p=c.data;return `[${c.model}] (${p.t1_seed})${p.t1_name} vs (${p.t2_seed})${p.t2_name} → ${p.predicted_winner_name} ${(Math.max(p.model_win_prob,1-p.model_win_prob)*100).toFixed(0)}% ${p.confidence} ${p.upset_flag||''}`;}
    if(c.type==='opt') return 'OPT: '+JSON.stringify(c.data);
    return '';
  }).filter(Boolean).join('\n');
}

// ── LLM ──
async function callLLM(messages, ctxStr) {
  const key = config.apiKey;
  if (!key) return "I need an API key to work! Admin: go to /admin or set LLM_API_KEY in Railway env vars.";
  const sys = sysPrompt() + (ctxStr ? '\n\n── DATA ──\n'+ctxStr : '');
  try {
    if (config.provider==='deepseek') {
      const r=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model:config.model||'deepseek-chat',messages:[{role:'system',content:sys},...messages],temperature:config.temperature,max_tokens:config.maxTokens})});
      const d=await r.json(); if(d.error)return 'API error: '+(d.error.message||JSON.stringify(d.error)); return d.choices?.[0]?.message?.content||'No response.';
    }
    if (config.provider==='claude') {
      const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:config.model||'claude-sonnet-4-20250514',max_tokens:config.maxTokens,system:sys,messages})});
      const d=await r.json(); if(d.error)return 'API error: '+(d.error.message||JSON.stringify(d.error)); return d.content?.[0]?.text||'No response.';
    }
    if (config.provider==='gemini') {
      const m=config.model||'gemini-2.0-flash';
      const r=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+m+':generateContent?key='+key,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:sys+'\n\n'+messages.map(m=>m.role+': '+m.content).join('\n')}]}],generationConfig:{temperature:config.temperature,maxOutputTokens:config.maxTokens}})});
      const d=await r.json(); return d.candidates?.[0]?.content?.parts?.[0]?.text||'No response.';
    }
    return 'Unknown provider: '+config.provider;
  } catch(e) { console.error('LLM err:',e); return "Connection issue. Try again."; }
}

// ── RATE LIMIT ──
const rates=new Map();
function rateOk(ip){const now=Date.now();let e=rates.get(ip);if(!e||now-e.t>=60000)e={c:0,t:now};if(e.c>=config.messagesPerMinute){rates.set(ip,e);return false}e.c++;rates.set(ip,e);return true}

function auth(req,res,next){if((req.header('x-admin-password')||'')!==config.adminPassword)return res.status(401).json({error:'Unauthorized'});next()}

// ── PUBLIC ROUTES ──
app.get('/api/config',(req,res)=>res.json({brandName:config.brandName,tagline:config.tagline,activeSeason:config.activeSeason,dataLoaded:hasData}));

app.post('/api/chat',async(req,res)=>{
  try{
    if(!rateOk(req.ip||'x'))return res.status(429).json({error:'Too many messages.'});
    const msgs=req.body?.messages;if(!Array.isArray(msgs)||!msgs.length)return res.status(400).json({error:'No message.'});
    const ctx=findCtx(msgs.map(m=>m.content).join(' '));
    res.json({reply:await callLLM(msgs,fmtCtx(ctx))});
  }catch(e){console.error(e);res.status(500).json({error:'Something broke.'})}
});

// ── ADMIN ROUTES ──
app.get('/admin/config',auth,(req,res)=>{
  const ds={};for(const k of Object.keys(FILES)){const d=store[k];ds[k]=!!(d&&(Array.isArray(d)?d.length:(d.predictions?.length||d.profiles?.length||d.results?.length)))}
  res.json({...config,dataStatus:ds});
});

app.post('/admin/config',auth,(req,res)=>{
  const b=req.body||{};
  for(const k of['provider','apiKey','model','temperature','maxTokens','brandName','tagline','activeSeason','messagesPerMinute'])if(b[k]!==undefined)config[k]=b[k];
  if(b.weights)config.weights=b.weights;if(b.features)config.features=b.features;
  saveConfig();res.json({ok:true});
});

app.post('/admin/password',auth,(req,res)=>{
  const{oldPassword,newPassword}=req.body||{};
  if(!oldPassword||!newPassword)return res.status(400).json({error:'Both required'});
  if(oldPassword!==config.adminPassword)return res.status(403).json({error:'Wrong password'});
  config.adminPassword=newPassword;saveConfig();res.json({ok:true});
});

const up=multer({dest:TMP_DIR});
app.post('/admin/upload',auth,up.single('file'),(req,res)=>{
  const t=req.body.type;if(!t||!FILES[t])return res.status(400).json({success:false,error:'Bad type'});
  if(!req.file)return res.status(400).json({success:false,error:'No file'});
  try{const raw=fs.readFileSync(req.file.path,'utf8');JSON.parse(raw);fs.writeFileSync(path.join(DATA_DIR,FILES[t]),raw);fs.unlinkSync(req.file.path);loadData();res.json({success:true})}
  catch(e){if(fs.existsSync(req.file.path))fs.unlinkSync(req.file.path);res.status(400).json({success:false,error:'Bad JSON'})}
});

// ── SERVE FRONTEND ──
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'..','frontend','admin.html'),e=>{if(e&&!res.headersSent)res.status(404).send('Not found')}));
app.use(express.static(path.join(__dirname,'..','frontend')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'..','frontend','index.html'),e=>{if(e&&!res.headersSent)res.status(404).send('Not found')}));

process.on('uncaughtException',e=>console.error('Uncaught:',e));
process.on('unhandledRejection',e=>console.error('Unhandled:',e));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`🏀 BracketGPT on :${PORT} | ${config.provider} | key:${config.apiKey?'✅':'❌'} | data:${hasData?'✅':'❌'}`));
SERVERJS

# ─── frontend/index.html ───
cat > frontend/index.html << 'INDEXHTML'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>BracketGPT</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0D1117;--surface:#161B22;--card:#1C2128;--elevated:#252C35;
  --border:rgba(139,148,158,.12);--border-f:rgba(56,189,248,.3);
  --text:#E6EDF3;--text2:#8B949E;--muted:#484F58;
  --green:#3FB950;--green-s:rgba(63,185,80,.12);
  --blue:#58A6FF;--orange:#F0883E;--red:#F85149;--purple:#BC8CFF;
  --ubg:#1A3A2A;--r:14px;
}
html{height:100%}
body{height:100%;overflow:hidden;font-family:'DM Sans',-apple-system,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
.app{display:flex;flex-direction:column;height:100%;max-width:780px;margin:0 auto}
.hdr{display:flex;align-items:center;gap:11px;padding:12px 18px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;z-index:5}
.hdr-i{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--green),#238636);display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 0 16px rgba(63,185,80,.12);flex-shrink:0}
.hdr h1{font-size:15px;font-weight:700;letter-spacing:-.02em;line-height:1}
.hdr .sub{font-size:10.5px;font-weight:500;color:var(--text2);margin-top:2px}
.hdr .live{margin-left:auto;padding:3px 9px;border-radius:20px;background:var(--green-s);color:var(--green);font-size:10px;font-weight:600;letter-spacing:.04em;display:flex;align-items:center;gap:5px}
.hdr .live::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--green);animation:pulse 2s ease infinite}
.msgs{flex:1 1 0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;padding:16px 14px;display:flex;flex-direction:column}
.msgs::-webkit-scrollbar{width:4px}.msgs::-webkit-scrollbar-thumb{background:var(--muted);border-radius:2px}
.spc{flex:1 1 auto;min-height:0}.pad{flex-shrink:0;height:80px}
.welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:20px;text-align:center;animation:fadeUp .5s ease}
.welcome .ico{width:60px;height:60px;border-radius:18px;background:linear-gradient(145deg,var(--green),#238636);display:flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:16px;box-shadow:0 6px 28px rgba(63,185,80,.16)}
.welcome h2{font-size:21px;font-weight:700;letter-spacing:-.03em;margin-bottom:5px}
.welcome p{font-size:13px;color:var(--text2);max-width:330px;line-height:1.5;margin-bottom:22px}
.qp{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;max-width:460px}
.qp button{padding:8px 13px;border-radius:9px;background:var(--card);border:1px solid var(--border);color:var(--text2);font-size:12px;font-weight:500;font-family:inherit;cursor:pointer;transition:all .15s}
.qp button:hover{background:var(--elevated);color:var(--text);border-color:var(--border-f);transform:translateY(-1px)}
.m{display:flex;gap:9px;max-width:88%;margin-bottom:12px;animation:msgIn .3s ease}
.m.u{margin-left:auto;flex-direction:row-reverse}
.m .av{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;margin-top:2px}
.m.b .av{background:linear-gradient(135deg,var(--green),#238636)}.m.u .av{background:var(--elevated)}
.m .bd{padding:10px 14px;border-radius:var(--r);font-size:13.5px;line-height:1.55;word-wrap:break-word;overflow-wrap:break-word}
.m.u .bd{background:var(--ubg);border:1px solid rgba(63,185,80,.12);border-bottom-right-radius:4px}
.m.b .bd{background:var(--card);border:1px solid var(--border);border-bottom-left-radius:4px}
.m.b .bd p{margin-bottom:8px}.m.b .bd p:last-child{margin-bottom:0}
.m.b .bd strong{color:var(--green);font-weight:600}
.m.b .bd em{color:var(--blue);font-style:normal;font-weight:500}
.m.b .bd ul,.m.b .bd ol{margin:6px 0 8px 18px;font-size:13px}.m.b .bd li{margin-bottom:3px}
.badge{display:inline-block;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;vertical-align:middle}
.badge-lock{background:rgba(63,185,80,.15);color:var(--green)}.badge-confident{background:rgba(88,166,255,.12);color:var(--blue)}
.badge-lean{background:rgba(240,136,62,.12);color:var(--orange)}.badge-slight{background:rgba(188,140,255,.12);color:var(--purple)}
.badge-tossup{background:rgba(248,81,73,.12);color:var(--red)}
.typing{display:none;gap:9px;max-width:88%;margin-bottom:12px}.typing.on{display:flex}
.dots{display:flex;gap:4px;padding:14px;background:var(--card);border-radius:var(--r);border:1px solid var(--border);border-bottom-left-radius:4px}
.dots span{width:6px;height:6px;border-radius:50%;background:var(--muted);animation:blink 1.4s infinite both}
.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}
.iw{flex-shrink:0;padding:10px 14px 16px;background:var(--bg);border-top:1px solid var(--border)}
.ir{display:flex;align-items:center;gap:7px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:4px 4px 4px 14px;transition:border-color .2s}
.ir:focus-within{border-color:var(--border-f);box-shadow:0 0 0 3px rgba(56,189,248,.05)}
.ir input{flex:1;background:none;border:none;outline:none;color:var(--text);font-size:13.5px;font-family:inherit;padding:8px 0;min-width:0}
.ir input::placeholder{color:var(--muted)}
.snd{width:36px;height:36px;border-radius:9px;border:none;cursor:pointer;background:var(--elevated);color:var(--muted);display:flex;align-items:center;justify-content:center;transition:all .2s;flex-shrink:0}
.snd.on{background:var(--green);color:#fff;box-shadow:0 2px 10px rgba(63,185,80,.25)}
.hint{text-align:center;margin-top:6px;font-size:10px;color:var(--muted)}
@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes msgIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes blink{0%,80%,100%{opacity:.3}40%{opacity:1}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media(max-width:600px){.m{max-width:92%}.hdr{padding:10px 12px}.welcome h2{font-size:18px}.iw{padding:8px 10px 12px}.msgs{padding:12px 10px}}
</style>
</head>
<body>
<div class="app">
  <div class="hdr">
    <div class="hdr-i">🏀</div>
    <div><h1 id="an">BracketGPT</h1><div class="sub" id="at">AI Bracket Advisor</div></div>
    <span class="live">LIVE</span>
  </div>
  <div class="msgs" id="msgs">
    <div class="spc"></div>
    <div class="welcome" id="wel">
      <div class="ico">🏀</div>
      <h2>Your bracket starts here.</h2>
      <p>Ask about any matchup, upset picks, or bracket strategy. 20 years of data crunched so you don't have to.</p>
      <div class="qp">
        <button onclick="go('Who wins Duke vs Houston?')">Duke vs Houston?</button>
        <button onclick="go('Best upset picks this year?')">Best upset picks?</button>
        <button onclick="go('Which 12-seed has the best shot?')">12-seed dark horse?</button>
        <button onclick="go('Compare the four 1-seeds')">Compare 1-seeds</button>
        <button onclick="go('Build me a contrarian Final Four')">Contrarian Final Four</button>
        <button onclick="go('Big pool strategy?')">Big pool strategy</button>
      </div>
    </div>
    <div class="typing" id="typ"><div class="av" style="background:linear-gradient(135deg,var(--green),#238636)">🏀</div><div class="dots"><span></span><span></span><span></span></div></div>
    <div class="pad"></div>
  </div>
  <div class="iw">
    <div class="ir"><input type="text" id="inp" placeholder="Ask about any matchup…" autocomplete="off" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();go()}"><button class="snd" id="btn" onclick="go()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div>
    <div class="hint">3-model ensemble · 76% historical accuracy</div>
  </div>
</div>
<script>
const $=s=>document.getElementById(s),msgs=$('msgs'),inp=$('inp'),btn=$('btn'),typ=$('typ');
let hist=[],busy=false;
(async()=>{try{const r=await fetch('/api/config');if(r.ok){const c=await r.json();if(c.brandName){$('an').textContent=c.brandName;document.title=c.brandName}if(c.tagline)$('at').textContent=c.tagline}}catch(e){}})();
inp.addEventListener('input',()=>btn.classList.toggle('on',inp.value.trim().length>0));
function scroll(){msgs.scrollTop=msgs.scrollHeight}
function add(w,t){const e=$('wel');if(e)e.remove();const d=document.createElement('div');d.className='m '+(w==='u'?'u':'b');d.innerHTML=`<div class="av">${w==='u'?'👤':'🏀'}</div><div class="bd">${w==='u'?esc(t):fmt(t)}</div>`;msgs.insertBefore(d,typ);scroll();return d}
function fmt(t){let s=t.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>').replace(/`([^`]+)`/g,'<code style="background:var(--elevated);padding:1px 5px;border-radius:4px;font-size:12px">$1</code>').replace(/\[LOCK\]/gi,'<span class="badge badge-lock">🔒 lock</span>').replace(/\[CONFIDENT\]/gi,'<span class="badge badge-confident">confident</span>').replace(/\[LEAN\]/gi,'<span class="badge badge-lean">lean</span>').replace(/\[SLIGHT\]/gi,'<span class="badge badge-slight">slight</span>').replace(/\[TOSS.?UP\]/gi,'<span class="badge badge-tossup">toss-up</span>');const blocks=s.split(/\n{2,}/);let h='';for(const b of blocks){const tr=b.trim();if(!tr)continue;const lines=tr.split('\n');const isList=lines.length>1&&lines.filter(l=>l.trim()).every(l=>/^\s*[-*•]\s|^\s*\d+[.)]\s/.test(l));if(isList){h+='<ul>'+lines.filter(l=>l.trim()).map(l=>'<li>'+l.replace(/^\s*[-*•]\s*/,'').replace(/^\s*\d+[.)]\s*/,'')+'</li>').join('')+'</ul>'}else{h+='<p>'+tr.replace(/\n/g,'<br>')+'</p>'}}return h||'<p>'+s+'</p>'}
function esc(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML}
async function go(text){const msg=text||inp.value.trim();if(!msg||busy)return;inp.value='';btn.classList.remove('on');busy=true;hist.push({role:'user',content:msg});add('u',msg);typ.classList.add('on');scroll();try{const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:hist})});const d=await r.json();typ.classList.remove('on');const reply=d.reply||d.error||'Something went wrong.';hist.push({role:'assistant',content:reply});add('b',reply)}catch(e){typ.classList.remove('on');add('b','Lost connection — try again.')}busy=false;inp.focus()}
</script>
</body>
</html>
INDEXHTML

# ─── frontend/admin.html ───
cat > frontend/admin.html << 'ADMINHTML'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BracketGPT Admin</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0D1117;--surface:#161B22;--card:#1C2128;--elevated:#252C35;--border:rgba(139,148,158,.12);--text:#E6EDF3;--text2:#8B949E;--muted:#484F58;--green:#3FB950;--green-s:rgba(63,185,80,.1);--blue:#58A6FF;--blue-s:rgba(88,166,255,.08);--orange:#F0883E;--red:#F85149;--r:12px;--mono:'JetBrains Mono',monospace}
html,body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased}
.wrap{max-width:860px;margin:0 auto;padding:20px 16px 60px}
.head{display:flex;align-items:center;gap:12px;margin-bottom:24px;padding-bottom:14px;border-bottom:1px solid var(--border)}
.head .ic{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--green),#238636);display:flex;align-items:center;justify-content:center;font-size:19px}
.head h1{font-size:18px;font-weight:700}.head p{font-size:11px;color:var(--text2)}
.head .tag{margin-left:auto;padding:3px 10px;border-radius:7px;font-size:10.5px;font-weight:600}
.sec{background:var(--surface);border-radius:var(--r);border:1px solid var(--border);padding:18px;margin-bottom:14px}
.sec-t{font-size:13px;font-weight:700;margin-bottom:2px;display:flex;align-items:center;gap:6px}
.sec-t .d{width:6px;height:6px;border-radius:50%;background:var(--green)}
.sec-d{font-size:11px;color:var(--text2);margin-bottom:12px}
.f{margin-bottom:12px}.f:last-child{margin-bottom:0}
.f label{display:block;font-size:10.5px;font-weight:600;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em}
.f input,.f select{width:100%;padding:8px 11px;background:var(--card);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:12.5px;font-family:inherit;outline:none;transition:border-color .2s}
.f input:focus,.f select:focus{border-color:rgba(88,166,255,.4)}
.f select{cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238B949E' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
.row{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px}
.sl{display:flex;align-items:center;gap:9px}
.sl input[type="range"]{flex:1;-webkit-appearance:none;height:4px;background:var(--card);border-radius:2px;border:none;padding:0}
.sl input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:var(--green);cursor:pointer;border:2px solid var(--bg)}
.sl .v{min-width:34px;text-align:right;font-family:var(--mono);font-size:11.5px;font-weight:500;color:var(--green)}
.tr{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)}.tr:last-child{border-bottom:none}
.tr span{font-size:12.5px;font-weight:500}
.tog{width:38px;height:20px;border-radius:10px;background:var(--muted);position:relative;cursor:pointer;transition:background .2s;border:none}
.tog.on{background:var(--green)}.tog::after{content:'';position:absolute;width:14px;height:14px;border-radius:50%;background:#fff;top:3px;left:3px;transition:transform .2s}.tog.on::after{transform:translateX(18px)}
.btn{padding:8px 16px;border-radius:7px;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;border:none;transition:all .15s}
.btn-g{background:var(--green);color:#fff}.btn-g:hover{background:#2ea043}
.btn-r{background:rgba(248,81,73,.1);color:var(--red)}
.sg{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px;margin-top:8px}
.st{padding:7px 10px;border-radius:7px;background:var(--card);border:1px solid var(--border);font-size:11px;font-weight:500}
.st.ok{border-color:rgba(63,185,80,.2);background:rgba(63,185,80,.06)}
.st i{display:inline-block;width:5px;height:5px;border-radius:50%;margin-right:5px;background:var(--muted)}.st.ok i{background:var(--green)}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:7px;background:var(--green);color:#fff;font-size:11.5px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.3);transform:translateY(80px);opacity:0;transition:all .3s;z-index:99}.toast.show{transform:translateY(0);opacity:1}
.login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:100}
.lbox{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:26px;width:320px;max-width:90vw;text-align:center}
.lbox .ic{width:48px;height:48px;border-radius:13px;background:linear-gradient(135deg,var(--green),#238636);display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 12px}
.lbox h2{font-size:16px;margin-bottom:3px}.lbox p{font-size:11.5px;color:var(--text2);margin-bottom:14px}
.lbox input{width:100%;padding:9px 13px;border-radius:7px;background:var(--card);border:1px solid var(--border);color:var(--text);font-size:12.5px;font-family:inherit;outline:none;margin-bottom:9px;text-align:center}
.lbox .btn{width:100%}
</style>
</head>
<body>
<div class="login" id="login"><div class="lbox"><div class="ic">🏀</div><h2>BracketGPT Admin</h2><p>Enter admin password</p><input type="password" id="lpw" placeholder="Password" onkeydown="if(event.key==='Enter')auth()"><button class="btn btn-g" onclick="auth()">Sign In</button></div></div>
<div class="wrap" id="panel" style="display:none">
  <div class="head"><div class="ic">🏀</div><div><h1>Admin Panel</h1><p>Manage your bracket advisor</p></div><span class="tag" id="tag" style="background:var(--blue-s);color:var(--blue)">Connecting…</span></div>
  <div class="sec"><div class="sec-t"><span class="d"></span>LLM Configuration</div><div class="sec-d">AI provider and model settings</div>
    <div class="row"><div class="f"><label>Provider</label><select id="provider"><option value="deepseek">DeepSeek ($)</option><option value="claude">Claude ($$)</option><option value="gemini">Gemini ($)</option></select></div><div class="f"><label>Model</label><input id="model" placeholder="deepseek-chat"></div></div>
    <div class="f"><label>API Key</label><input type="password" id="apiKey" placeholder="sk-…"></div>
    <div class="row"><div class="f"><label>Temperature</label><div class="sl"><input type="range" id="temp" min="0" max="1" step=".05" value=".7" oninput="V('tv',this.value)"><span class="v" id="tv">0.7</span></div></div><div class="f"><label>Max Tokens</label><input id="tokens" value="1200"></div></div>
  </div>
  <div class="sec"><div class="sec-t"><span class="d"></span>Model Weights</div><div class="sec-d">Influence of each model on answers</div>
    <div class="f"><label>Base (balanced)</label><div class="sl"><input type="range" id="wb" min="0" max="100" value="60" oninput="V('wbv',this.value+'%')"><span class="v" id="wbv">60%</span></div></div>
    <div class="f"><label>Upset (cinderella)</label><div class="sl"><input type="range" id="wu" min="0" max="100" value="25" oninput="V('wuv',this.value+'%')"><span class="v" id="wuv">25%</span></div></div>
    <div class="f"><label>Floor (chalk)</label><div class="sl"><input type="range" id="wf" min="0" max="100" value="15" oninput="V('wfv',this.value+'%')"><span class="v" id="wfv">15%</span></div></div>
  </div>
  <div class="sec"><div class="sec-t"><span class="d"></span>Features</div><div class="sec-d">Toggle chatbot capabilities</div>
    <div class="tr"><span>Team Profiles</span><button class="tog on" id="ftp" onclick="this.classList.toggle('on')"></button></div>
    <div class="tr"><span>Matchup Data</span><button class="tog on" id="fmd" onclick="this.classList.toggle('on')"></button></div>
    <div class="tr"><span>Optimizer</span><button class="tog on" id="fod" onclick="this.classList.toggle('on')"></button></div>
    <div class="tr"><span>Upset Picks</span><button class="tog on" id="fup" onclick="this.classList.toggle('on')"></button></div>
    <div class="tr"><span>Safety Scores</span><button class="tog on" id="fss" onclick="this.classList.toggle('on')"></button></div>
    <div class="tr"><span>Historical Context</span><button class="tog on" id="fhc" onclick="this.classList.toggle('on')"></button></div>
  </div>
  <div class="sec"><div class="sec-t"><span class="d"></span>Branding</div>
    <div class="row3"><div class="f"><label>Name</label><input id="bn" value="BracketGPT"></div><div class="f"><label>Tagline</label><input id="tl"></div><div class="f"><label>Season</label><input id="sn" value="2025"></div></div>
    <div class="f"><label>Rate Limit (msgs/min)</label><input id="rl" value="30"></div>
  </div>
  <div class="sec"><div class="sec-t"><span class="d"></span>Data</div><div class="sec-d">Upload prediction files</div>
    <div class="sg" id="dsg"><div class="st" id="ds-teams"><i></i>Teams</div><div class="st" id="ds-base"><i></i>Base</div><div class="st" id="ds-upset"><i></i>Upset</div><div class="st" id="ds-floor"><i></i>Floor</div><div class="st" id="ds-optimizer"><i></i>Optimizer</div></div>
    <div style="margin-top:10px"><div class="row"><div class="f"><label>Type</label><select id="ut"><option value="teams">Teams</option><option value="base">Base</option><option value="upset">Upset</option><option value="floor">Floor</option><option value="optimizer">Optimizer</option></select></div><div class="f"><label>File</label><input type="file" id="uf" accept=".json" style="padding:6px"></div></div><button class="btn btn-g" onclick="upload()">Upload</button></div>
  </div>
  <div class="sec"><div class="sec-t"><span class="d" style="background:var(--orange)"></span>Security</div>
    <div class="row"><div class="f"><label>Old Password</label><input type="password" id="op"></div><div class="f"><label>New Password</label><input type="password" id="np"></div></div>
    <button class="btn btn-r" onclick="chpw()">Change Password</button>
  </div>
  <button class="btn btn-g" onclick="save()" style="width:100%;margin-top:6px;padding:11px">💾 Save All Settings</button>
</div>
<div class="toast" id="toast"></div>
<script>
const $=s=>document.getElementById(s),V=(id,v)=>$(id).textContent=v;let pw='';
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500)}
const H=()=>({headers:{'x-admin-password':pw}});
async function auth(){pw=$('lpw').value;try{const r=await fetch('/admin/config',H());if(r.ok){$('login').style.display='none';$('panel').style.display='block';fill(await r.json());$('tag').textContent='Connected';$('tag').style.background='rgba(63,185,80,.1)';$('tag').style.color='#3FB950'}else toast('Wrong password')}catch(e){toast('Connection error')}}
function fill(c){
  if(c.provider)$('provider').value=c.provider;if(c.model)$('model').value=c.model;if(c.apiKey)$('apiKey').value=c.apiKey;
  if(c.temperature!=null){$('temp').value=c.temperature;V('tv',c.temperature)}
  if(c.maxTokens)$('tokens').value=c.maxTokens;
  const w=c.weights||{};if(w.baseWeight!=null){$('wb').value=w.baseWeight*100;V('wbv',Math.round(w.baseWeight*100)+'%')}
  if(w.upsetWeight!=null){$('wu').value=w.upsetWeight*100;V('wuv',Math.round(w.upsetWeight*100)+'%')}
  if(w.floorWeight!=null){$('wf').value=w.floorWeight*100;V('wfv',Math.round(w.floorWeight*100)+'%')}
  const f=c.features||{};
  if(f.showTeamProfiles!=null)$('ftp').classList.toggle('on',f.showTeamProfiles);
  if(f.showMatchupData!=null)$('fmd').classList.toggle('on',f.showMatchupData);
  if(f.showOptimizerData!=null)$('fod').classList.toggle('on',f.showOptimizerData);
  if(f.showUpsetPicks!=null)$('fup').classList.toggle('on',f.showUpsetPicks);
  if(f.showSafetyScores!=null)$('fss').classList.toggle('on',f.showSafetyScores);
  if(f.includeHistoricalContext!=null)$('fhc').classList.toggle('on',f.includeHistoricalContext);
  if(c.brandName)$('bn').value=c.brandName;if(c.tagline)$('tl').value=c.tagline;
  if(c.activeSeason)$('sn').value=c.activeSeason;if(c.messagesPerMinute)$('rl').value=c.messagesPerMinute;
  const ds=c.dataStatus||{};for(const[k,v]of Object.entries(ds)){const el=$('ds-'+k);if(el)el.classList.toggle('ok',!!v)}
}
async function save(){
  const cfg={provider:$('provider').value,model:$('model').value,apiKey:$('apiKey').value,temperature:parseFloat($('temp').value),maxTokens:parseInt($('tokens').value),
    weights:{baseWeight:parseInt($('wb').value)/100,upsetWeight:parseInt($('wu').value)/100,floorWeight:parseInt($('wf').value)/100},
    features:{showTeamProfiles:$('ftp').classList.contains('on'),showMatchupData:$('fmd').classList.contains('on'),showOptimizerData:$('fod').classList.contains('on'),showUpsetPicks:$('fup').classList.contains('on'),showSafetyScores:$('fss').classList.contains('on'),includeHistoricalContext:$('fhc').classList.contains('on')},
    brandName:$('bn').value,tagline:$('tl').value,activeSeason:$('sn').value,messagesPerMinute:parseInt($('rl').value)};
  const r=await fetch('/admin/config',{method:'POST',headers:{'Content-Type':'application/json','x-admin-password':pw},body:JSON.stringify(cfg)});
  toast(r.ok?'Saved!':'Failed');
}
async function upload(){const t=$('ut').value,f=$('uf').files[0];if(!f)return toast('Pick a file');const fd=new FormData();fd.append('file',f);fd.append('type',t);const r=await fetch('/admin/upload',{method:'POST',headers:{'x-admin-password':pw},body:fd});const d=await r.json();if(d.success){toast(t+' uploaded!');const el=$('ds-'+t);if(el)el.classList.add('ok')}else toast('Upload failed')}
async function chpw(){const r=await fetch('/admin/password',{method:'POST',headers:{'Content-Type':'application/json','x-admin-password':pw},body:JSON.stringify({oldPassword:$('op').value,newPassword:$('np').value})});if(r.ok){pw=$('np').value;toast('Password changed!')}else toast('Check old password')}
</script>
</body>
</html>
ADMINHTML

echo ""
echo "✅ All files created. Now run:"
echo "   npm install"
echo "   git add -A"
echo "   git commit -m 'clean rebuild: sleeper UI + env var config'"
echo "   git push"
echo ""
echo "Then in Railway → Variables tab, add:"
echo "   LLM_API_KEY=your-key-here"
echo "   LLM_PROVIDER=deepseek"
echo "   ADMIN_PASSWORD=your-password"
