# 🏀 BracketGPT

March Madness AI bracket advisor. 3-model ensemble trained on 20+ years of tournament data.

**Live:** [bracketgpt-production.up.railway.app](https://bracketgpt-production.up.railway.app)

## Stack

- **Frontend:** Vanilla HTML/CSS/JS — Sleeper-inspired dark theme
- **Backend:** Express.js — serves chat API, admin panel, data management
- **ML Pipeline:** XGBoost + LightGBM ensemble with KenPom efficiency metrics
- **Deploy:** Railway (auto-deploys from `main`)

## Local Setup

```bash
npm install
npm start
# → http://localhost:3000 (chat)
# → http://localhost:3000/admin (admin panel, default pw: changeme2025)
```

## Admin Panel

Set your LLM provider (DeepSeek/Claude/Gemini), upload prediction JSONs, tune model weights, toggle features. All at `/admin`.

## Architecture

```
bracketgpt/
├── frontend/
│   ├── index.html        # User chat interface
│   └── admin.html        # Admin dashboard
├── backend/
│   ├── server.js         # Express API + LLM routing
│   ├── config.json       # Settings (gitignored)
│   └── data/             # Prediction JSONs (gitignored)
├── models/               # Python ML training scripts
├── scripts/              # Data pipeline utilities
└── package.json
```

## 2025 Backtest

Trained on 2003–2024, predicted 2025 pre-tournament:
- **76.1% accuracy** (51/67 games)
- **0.159 Brier score**
- Correctly picked Florida as champion

## Models

| Model | Purpose | Weight |
|-------|---------|--------|
| Base | Balanced picks, best EV | 60% |
| Upset | 3x weight on Cinderellas | 25% |
| Floor | Chalk-boosted safety | 15% |
