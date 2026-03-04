#!/usr/bin/env python3
"""Validate BracketGPT historical output structure and quality gates.

Usage:
  python backend/data/validate_historical_output.py \
    --predictions backend/data/chatbot_predictions_base_2025_historical.json \
    --lookup backend/data/historical/seed_matchup_all_rounds.json
"""

import argparse
import json
import re
import sys
from pathlib import Path

RE_NUMERIC = re.compile(r"\d+(?:\.\d+)?")
RE_SENTENCE_END = re.compile(r"[.!?]")


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def one_sentence(text: str) -> bool:
    if not isinstance(text, str) or not text.strip():
        return False
    return len(RE_SENTENCE_END.findall(text.strip())) == 1


def has_two_numeric_refs(text: str) -> bool:
    if not isinstance(text, str):
        return False
    return len(RE_NUMERIC.findall(text)) >= 2


def check_comp_context(ctx):
    required = [
        "comp_team",
        "comp_year",
        "comp_seed",
        "comp_result",
        "comp_wins",
        "similarity",
        "shared_traits",
        "comp_outcome_explanation",
        "lesson_for_current_team",
        "narrative",
    ]
    for k in required:
        if k not in ctx:
            return False, f"missing '{k}'"

    traits = ctx.get("shared_traits")
    if not isinstance(traits, list) or not (3 <= len(traits) <= 5):
        return False, "shared_traits must be array length 3-5"

    if not str(ctx.get("comp_outcome_explanation", "")).strip():
        return False, "comp_outcome_explanation empty"
    if not str(ctx.get("lesson_for_current_team", "")).strip():
        return False, "lesson_for_current_team empty"
    if not str(ctx.get("narrative", "")).strip():
        return False, "narrative empty"

    return True, ""


def check_arch_entry(entry):
    required = [
        "archetype",
        "upset_rate_as_underdog",
        "deep_run_rate",
        "strength",
        "weakness",
        "notable_runs",
        "trend",
        "sample_size",
        "seed_tier_performance",
    ]
    for k in required:
        if k not in entry:
            return False, f"missing '{k}'"

    if not isinstance(entry["sample_size"], int) or entry["sample_size"] < 1:
        return False, "sample_size must be integer >= 1"

    runs = entry.get("notable_runs")
    if not isinstance(runs, list) or not (2 <= len(runs) <= 4):
        return False, "notable_runs must be array length 2-4"

    stp = entry.get("seed_tier_performance")
    if not isinstance(stp, dict):
        return False, "seed_tier_performance must be object"

    for tier in ("1_to_4", "5_to_8", "9_to_16"):
        if tier not in stp:
            return False, f"seed_tier_performance missing '{tier}'"
        tier_obj = stp[tier]
        if not isinstance(tier_obj, dict):
            return False, f"{tier} must be object"
        if "count" not in tier_obj or "avg_wins" not in tier_obj:
            return False, f"{tier} missing count/avg_wins"

    return True, ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--predictions",
        default="backend/data/chatbot_predictions_base_2025_historical.json",
        help="Path to enriched predictions JSON",
    )
    parser.add_argument(
        "--lookup",
        default="backend/data/historical/seed_matchup_all_rounds.json",
        help="Path to all-round seed matchup lookup JSON",
    )
    parser.add_argument(
        "--allow-null-secondary",
        action="store_true",
        help="Allow null secondary comp fields (warn only)",
    )
    args = parser.parse_args()

    pred_path = Path(args.predictions)
    lookup_path = Path(args.lookup)

    failures = []
    warnings = []

    if not pred_path.exists():
        print(f"ERROR: predictions file not found: {pred_path}")
        return 2

    data = load_json(pred_path)
    predictions = data.get("predictions") if isinstance(data, dict) else None
    if not isinstance(predictions, list) or not predictions:
        print("ERROR: top-level 'predictions' array missing or empty")
        return 2

    non_standard_count = 0
    for i, p in enumerate(predictions):
        pid = f"predictions[{i}]"

        for side in ("t1", "t2"):
            arch_key = f"{side}_archetype_history"
            arch = p.get(arch_key)
            if not isinstance(arch, list) or len(arch) == 0:
                failures.append(f"{pid}.{arch_key}: empty or missing")
            else:
                for j, entry in enumerate(arch):
                    ok, msg = check_arch_entry(entry)
                    if not ok:
                        failures.append(f"{pid}.{arch_key}[{j}]: {msg}")

            comp_key = f"{side}_comp_context"
            comp = p.get(comp_key)
            if not isinstance(comp, dict):
                failures.append(f"{pid}.{comp_key}: missing")
            else:
                ok, msg = check_comp_context(comp)
                if not ok:
                    failures.append(f"{pid}.{comp_key}: {msg}")

            sec_key = f"{side}_secondaryComp"
            sec_ctx_key = f"{side}_secondary_comp_context"
            sec = p.get(sec_key)
            sec_ctx = p.get(sec_ctx_key)

            if sec is None or sec_ctx is None:
                msg = f"{pid}: missing {sec_key}/{sec_ctx_key}"
                if args.allow_null_secondary:
                    warnings.append(msg)
                else:
                    failures.append(msg)
            else:
                if not isinstance(sec, dict):
                    failures.append(f"{pid}.{sec_key}: must be object")
                if not isinstance(sec_ctx, dict):
                    failures.append(f"{pid}.{sec_ctx_key}: must be object")
                else:
                    ok, msg = check_comp_context(sec_ctx)
                    if not ok:
                        failures.append(f"{pid}.{sec_ctx_key}: {msg}")

        rh = p.get("responses", {}).get("historical") if isinstance(p.get("responses"), dict) else None
        if not has_two_numeric_refs(rh):
            failures.append(f"{pid}.responses.historical: needs >=2 numeric references")

        blurb = p.get("historical_blurb")
        if not one_sentence(blurb):
            failures.append(f"{pid}.historical_blurb: must be exactly one sentence")

        hsm = p.get("historical_seed_matchup")
        if isinstance(hsm, dict):
            summary = str(hsm.get("summary", ""))
            if "non-standard" in summary.lower():
                non_standard_count += 1

    if not lookup_path.exists():
        failures.append(f"lookup file missing: {lookup_path}")
    else:
        lookup = load_json(lookup_path)
        for r in ("R64", "R32", "S16", "E8"):
            if r not in lookup:
                failures.append(f"lookup missing round: {r}")

    total = len(predictions)
    print(f"Checked predictions: {total}")
    print(f"Seed-matchup summaries containing 'non-standard': {non_standard_count}/{total}")

    if warnings:
        print("\nWarnings:")
        for w in warnings[:20]:
            print(f"- {w}")
        if len(warnings) > 20:
            print(f"- ... and {len(warnings) - 20} more")

    if failures:
        print("\nFailures:")
        for f in failures[:50]:
            print(f"- {f}")
        if len(failures) > 50:
            print(f"- ... and {len(failures) - 50} more")
        print(f"\nRESULT: FAIL ({len(failures)} issues)")
        return 1

    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
