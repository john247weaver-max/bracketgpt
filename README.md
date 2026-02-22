# BracketGPT
March Madness AI bracket advisor. 3-model ensemble, 76% accuracy.

Set Railway env vars: `LLM_API_KEY`, `LLM_PROVIDER`, `ADMIN_PASSWORD`.

## Production quickstart (Railway)
1. Connect this repo in Railway.
2. Set env vars:
   - `LLM_API_KEY`
   - `LLM_PROVIDER` (`deepseek` / `claude` / `gemini`)
   - `ADMIN_PASSWORD`
   - Optional: `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`
3. Deploy using start command: `node backend/server.js`.
4. Validate deployment:
   - `GET /health` should return `{ ok: true, ... }`
   - `GET /api/ready` should return readiness + loaded data summary.
5. Upload JSON artifacts from `/admin` and confirm readiness flips to true for prediction sets.

## Workflow to improve logical answer quality (2025 backtest -> 2026 production)
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

## Robust seed-bucket pipeline (anti-hallucination)

Use `POST /api/seed-bucket-analysis` for deterministic bracket seed analysis.

Pipeline:
1. Stage 1 (deterministic): parses `bracket_2025.json` (fallback `bracket_predictions.json`) and builds canonical `seed_1` through `seed_16` buckets.
2. Stage 2 (LLM, temperature=0): model gets only canonical buckets + matched team profiles + historical seed matchup summaries.
3. Validator + repair loop: narrative sections are checked so teams only appear in their canonical seed section. Violations trigger automatic correction re-prompt.

Normalization used for team matching:
- case-insensitive
- strips apostrophes/periods
- `&` -> `and`
- `saint` -> `st`
- `state` -> `st`
- collapses repeated whitespace
