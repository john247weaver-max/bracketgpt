"""
Build a bracket_output JSON from per-team round-advance probabilities.

This is intended as a deterministic replacement for Monte Carlo output when
you already have exact (or externally computed) round probabilities.
"""

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_SCORING = {
    "R64": 10,
    "R32": 20,
    "S16": 40,
    "E8": 80,
    "F4": 160,
    "Championship": 320,
}

# Expected CSV canonical order:
# Team,R32,Sweet16,Elite8,Final4,TitleGame,Champion
ROUND_ALIASES = {
    "R32": ("R32",),
    "S16": ("S16", "Sweet16"),
    "E8": ("E8", "Elite8"),
    "F4": ("F4", "Final4"),
    "NCG": ("NCG", "TitleGame"),
    "Championship": ("Championship", "Champion", "Champ"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert round-probabilities CSV into bracket_output JSON."
    )
    parser.add_argument(
        "--prob-csv",
        required=True,
        help="CSV with Team + per-round probabilities.",
    )
    parser.add_argument(
        "--enriched-json",
        default="",
        help="Optional enriched JSON with team_stats for seed/region/metrics.",
    )
    parser.add_argument(
        "--base-output-json",
        default="",
        help="Optional existing bracket_output JSON to preserve strategies from.",
    )
    parser.add_argument(
        "--output-json",
        required=True,
        help="Destination bracket_output JSON path.",
    )
    parser.add_argument(
        "--sims",
        type=int,
        default=0,
        help="Set metadata.mc_sims (0 for deterministic/exact source).",
    )
    parser.add_argument(
        "--strict-checks",
        action="store_true",
        help="Fail if probability mass/monotonic checks fail.",
    )
    return parser.parse_args()


def load_enriched(path: Path) -> dict:
    if not path or not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    stats = data.get("team_stats", {})
    out = {}
    for team, info in stats.items():
        if isinstance(info, dict):
            out[team] = info
    return out


def _pick_col(row: dict, aliases: tuple[str, ...]) -> str:
    for alias in aliases:
        if alias in row:
            return alias
    raise KeyError(f"Missing required column. Expected one of: {aliases}")


def load_prob_rows(path: Path) -> dict:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    if not rows:
        raise ValueError("Probability CSV has no rows.")
    if "Team" not in rows[0]:
        raise KeyError("Probability CSV must contain a Team column.")

    out = {}
    for row in rows:
        team = str(row.get("Team", "")).strip()
        if not team:
            continue
        cols = {k: _pick_col(row, v) for k, v in ROUND_ALIASES.items()}
        out[team] = {
            "R32": float(row[cols["R32"]]),
            "S16": float(row[cols["S16"]]),
            "E8": float(row[cols["E8"]]),
            "F4": float(row[cols["F4"]]),
            "NCG": float(row[cols["NCG"]]),
            "Championship": float(row[cols["Championship"]]),
        }
    return out


def validate_probabilities(team_probs: dict) -> list[str]:
    warnings = []
    totals = {
        "R32": 32.0,
        "S16": 16.0,
        "E8": 8.0,
        "F4": 4.0,
        "NCG": 2.0,
        "Championship": 1.0,
    }
    for key, expected in totals.items():
        total = sum(float(v[key]) for v in team_probs.values())
        if abs(total - expected) > 1e-6:
            warnings.append(
                f"Mass check failed for {key}: total={total:.10f}, expected={expected:.10f}"
            )

    for team, probs in team_probs.items():
        seq = [
            probs["R32"],
            probs["S16"],
            probs["E8"],
            probs["F4"],
            probs["NCG"],
            probs["Championship"],
        ]
        if any(seq[i + 1] > seq[i] + 1e-9 for i in range(len(seq) - 1)):
            warnings.append(f"Monotonicity failed for {team}: {seq}")
    return warnings


def compute_ep(probs: dict, scoring: dict) -> float:
    return round(
        probs["R32"] * scoring["R64"]
        + probs["S16"] * scoring["R32"]
        + probs["E8"] * scoring["S16"]
        + probs["F4"] * scoring["E8"]
        + probs["NCG"] * scoring["F4"]
        + probs["Championship"] * scoring["Championship"],
        4,
    )


def load_base_output(path: Path) -> dict:
    if not path or not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def main() -> int:
    args = parse_args()
    prob_csv = Path(args.prob_csv)
    enriched_json = Path(args.enriched_json) if args.enriched_json else None
    base_output_json = Path(args.base_output_json) if args.base_output_json else None
    output_json = Path(args.output_json)

    team_probs = load_prob_rows(prob_csv)
    warnings = validate_probabilities(team_probs)
    if warnings:
        for w in warnings:
            print(f"WARNING: {w}")
        if args.strict_checks:
            raise ValueError("Strict checks enabled and validation warnings were found.")

    enriched_stats = load_enriched(enriched_json) if enriched_json else {}
    base_output = load_base_output(base_output_json) if base_output_json else {}

    champion_probs = {team: round(float(p["Championship"]), 6) for team, p in team_probs.items()}
    team_ep_rankings = {
        team: compute_ep(p, DEFAULT_SCORING)
        for team, p in team_probs.items()
    }

    team_stats = {}
    for team, probs in team_probs.items():
        extra = dict(enriched_stats.get(team, {}))
        existing_probs = extra.pop("probs", {}) if isinstance(extra.get("probs"), dict) else {}
        team_stats[team] = {
            **extra,
            "ep": team_ep_rankings[team],
            "probs": {
                "R64": round(float(existing_probs.get("R64", 1.0)), 6),
                "R32": round(float(probs["R32"]), 6),
                "S16": round(float(probs["S16"]), 6),
                "E8": round(float(probs["E8"]), 6),
                "F4": round(float(probs["F4"]), 6),
                "NCG": round(float(probs["Championship"]), 6),
            },
        }

    default_strategies = {
        "chalk": {"strategy": "chalk", "rounds": {}, "total_ep": 0, "mc_validation": {"note": "No Monte Carlo run; sourced from exact round probabilities."}},
        "balanced": {"strategy": "balanced", "rounds": {}, "total_ep": 0, "mc_validation": {"note": "No Monte Carlo run; sourced from exact round probabilities."}},
        "upset": {"strategy": "upset", "rounds": {}, "total_ep": 0, "mc_validation": {"note": "No Monte Carlo run; sourced from exact round probabilities."}},
    }

    output = {
        "metadata": {
            "script": "build_bracket_output_from_round_probs.py",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": "exact_round_probabilities_csv",
            "mc_sims": int(args.sims),
            "scoring": DEFAULT_SCORING,
        },
        "team_ep_rankings": dict(sorted(team_ep_rankings.items(), key=lambda kv: kv[1], reverse=True)),
        "bracket_structure": {
            "champion_probs": dict(sorted(champion_probs.items(), key=lambda kv: kv[1], reverse=True)),
        },
        "champion_probs": dict(sorted(champion_probs.items(), key=lambda kv: kv[1], reverse=True)),
        "team_stats": team_stats,
        "strategies": base_output.get("strategies", default_strategies),
    }

    output_json.parent.mkdir(parents=True, exist_ok=True)
    with output_json.open("w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {output_json}")
    print(f"Teams: {len(team_stats)}")
    print(f"Strategies preserved: {len(output['strategies'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
