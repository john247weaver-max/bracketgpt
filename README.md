# BracketGPT

BracketGPT is a local March Madness bracket advisor with a frontend chat UI and an admin panel for configuring LLM providers and uploading bracket data.

## Project Structure

- `frontend/` — static SPA (index.html)
- `backend/` — Express server and persistent config
- `backend/data/` — JSON data files (kept out of git)
- `models/` — placeholder Python model modules
- `package.json` — Node start script and dependencies

## Setup

Requirements: Node 16+ (or compatible). Python files are placeholders and do not require a Python runtime for the server.

Install dependencies and start server:

```bash
npm install
npm start
```

The server listens on `PORT` (default `3000`). Open `http://localhost:3000/` to use the chat UI.

## Admin Panel

Open `http://localhost:3000/admin`. On first load you'll be prompted for the admin password. Default password: `changeme2025`.

Admin panel features:
- Select LLM provider (DeepSeek / Anthropic Claude / Google Gemini)
- Set API key, model, temperature, and max tokens
- Adjust model weights for base/upset/floor models
- Enable/disable advanced features
- Upload JSON data files (teams, base, upset, floor, optimizer)
- Change admin password

Uploaded JSON is stored in `backend/data/` as:

- `team_profiles.json`
- `chatbot_predictions_base.json`
- `chatbot_predictions_upset.json`
- `chatbot_predictions_floor.json`
- `bracket_optimizer_results.json`

These files are ignored by git.

## API

- `GET /api/config` — public, returns limited branding and load state
- `POST /api/chat` — public, accepts `{ messages: [{role, content}] }` and returns `{ reply }`
- Admin routes (require `x-admin-password` header):
  - `GET /admin/config` — full config
  - `POST /admin/config` — update config
  - `POST /admin/upload` — upload JSON data
  - `POST /admin/password` — change admin password

## Deploying to Railway

1. Create a new Railway project and link this repository.
2. Set environment variable `PORT` if needed (Railway usually provides one).
3. Add any provider API keys via Railway project secrets and update the admin config.
4. Ensure `npm install` runs (Railway will run `npm start` to start the server).

Note: For production use wiring real LLM provider integrations is required. The current server includes provider stubs and is intended as a runnable scaffold and admin workflow.
# bracketgpt
mine
