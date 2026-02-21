# BracketGPT
March Madness AI bracket advisor. 3-model ensemble, 76% accuracy.

Set Railway env vars: `LLM_API_KEY`, `LLM_PROVIDER`, `ADMIN_PASSWORD`.

## Production quickstart (Railway)

### Deploy
1. Connect this repo in Railway.
2. Set env vars:
   - `LLM_API_KEY`
   - `LLM_PROVIDER` (`deepseek` / `claude` / `gemini`)
   - `ADMIN_PASSWORD`
   - Optional: `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`
3. Deploy using start command: `node backend/server.js`.
### Validate

4. Validate deployment:
   - `GET /health` should return `{ ok: true, ... }`
   - `GET /api/ready` should return readiness + loaded data summary.
5. Upload JSON artifacts from `/admin` and confirm readiness flips to true for prediction sets.

## Workflow to improve logical answer quality (2025 backtest -> 2026 production)

### Retrieval-first iteration loop
1. **Upload and verify model artifacts**
   - Upload team/base/upset/floor/optimizer JSON files in Admin.
   - Confirm `/admin/config` shows data status loaded.
2. **Tune retrieval context (no code changes needed)**
   - Update `context` settings via `POST /admin/config`:
     - `maxItems`: total context rows passed to LLM.
     - `upsetItems`: cap on upset examples.
     - `optimizerItems`: cap on optimizer examples.
     - `titleSeedCutoff`: restrict title-angle context by seed.
     - `includeTeamProfiles`, `includeOptimizer`, `includeTitleAngles`.
3. **Debug context before prompt tuning**
   - Use `POST /admin/context-preview` with a sample user query.
   - Inspect `contextPreview` and `formattedContext` to ensure relevant rows are selected.
4. **Run structured eval set each retrain**
   - Keep a fixed set of matchup/upset/strategy prompts.
   - Score outputs for: winner correctness, confidence calibration, contradiction rate, and rationale quality.
5. **Only then tune prompt/model**
   - If logic is off but retrieval is correct, adjust system prompt/model settings.
   - If retrieval is wrong, adjust context settings or upstream feature engineering first.


### Season sanity check
- `activeSeason` is the target bracket year in config (for example `2025`).
- Uploaded JSON files should include season/year fields (like `season`, `season_year`, `year`, or `tournament_year`) so the backend can verify the prediction season.
- Use `GET /api/ready` to confirm `predictionSeason` matches `activeSeason` before trusting outputs.
