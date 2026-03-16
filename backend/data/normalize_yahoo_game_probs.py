from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

ROUND_LABELS = {
    "64": "R64",
    "32": "R32",
    "16": "S16",
    "8": "E8",
    "4": "F4",
}

SEED_ORDER = [1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15]

ALIASES = {
    "Connecticut": "UConn",
    "Iowa St.": "Iowa State",
    "Kennesaw St.": "Kennesaw",
    "Miami (FL)": "Miami",
    "Michigan St.": "Michigan State",
    "N. Carolina": "North Carolina",
    "N. Dak. St.": "N Dakota St",
    "Ohio St.": "Ohio State",
    "Pennsylvania": "Penn",
    "Queens University": "Queens NC",
    "Saint Louis": "St Louis",
    "St. John's": "St John's",
    "St. Mary's": "Saint Mary's",
    "Tennessee St.": "Tennessee State",
    "Utah St.": "Utah State",
    "Wright St.": "Wright State",
    "California Baptist": "Cal Baptist",
    # Play-in placeholders from Yahoo export.
    "MOH/SMU": "SMU",
    "TX/NCST": "NC State",
    "PV/LEH": "Lehigh",
    "UMBC/HOW": "Howard",
}


@dataclass(frozen=True)
class TeamInfo:
    team: str
    region: str
    seed: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Normalize Yahoo pick percentages so each round pod sums to 1."
    )
    parser.add_argument("--yahoo-csv", required=True)
    parser.add_argument("--enriched-json", required=True)
    parser.add_argument("--output-csv", required=True)
    return parser.parse_args()


def load_team_info(enriched_json: Path) -> Dict[str, TeamInfo]:
    data = json.loads(enriched_json.read_text(encoding="utf-8"))
    out: Dict[str, TeamInfo] = {}
    for team, stats in data["team_stats"].items():
        out[team] = TeamInfo(team=team, region=stats["region"], seed=int(stats["seed"]))
    return out


def round_groups(round_value: str) -> List[Tuple[str, List[int]]]:
    if round_value == "64":
        return [
            ("G1", [1, 16]),
            ("G2", [8, 9]),
            ("G3", [5, 12]),
            ("G4", [4, 13]),
            ("G5", [6, 11]),
            ("G6", [3, 14]),
            ("G7", [7, 10]),
            ("G8", [2, 15]),
        ]
    if round_value == "32":
        return [
            ("G1", [1, 16, 8, 9]),
            ("G2", [5, 12, 4, 13]),
            ("G3", [6, 11, 3, 14]),
            ("G4", [7, 10, 2, 15]),
        ]
    if round_value == "16":
        return [
            ("G1", [1, 16, 8, 9, 5, 12, 4, 13]),
            ("G2", [6, 11, 3, 14, 7, 10, 2, 15]),
        ]
    if round_value == "8":
        return [("G1", SEED_ORDER[:])]
    if round_value == "4":
        return [("G1", SEED_ORDER[:])]
    raise ValueError(f"Unsupported round: {round_value}")


def canonical_name(raw: str) -> str:
    return ALIASES.get(raw, raw)


def load_yahoo_probabilities(yahoo_csv: Path) -> Dict[Tuple[str, str], float]:
    probs: Dict[Tuple[str, str], float] = {}
    with yahoo_csv.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            team = canonical_name(row["team"].strip())
            round_value = row["round"].strip()
            probs[(team, round_value)] = float(row["pct_picked"]) / 100.0
    return probs


def collect_region_teams(team_info: Dict[str, TeamInfo]) -> Dict[str, Dict[int, str]]:
    out: Dict[str, Dict[int, str]] = defaultdict(dict)
    for team, info in team_info.items():
        out[info.region][info.seed] = team
    return out


def build_rows(
    team_info: Dict[str, TeamInfo],
    yahoo_probs: Dict[Tuple[str, str], float],
) -> Tuple[List[dict], List[str]]:
    rows: List[dict] = []
    warnings: List[str] = []

    region_seed_team = collect_region_teams(team_info)

    rounds = ["64", "32", "16", "8", "4"]

    # Round of 4 is grouped by semifinal sides instead of per-region.
    semifinal_sides = {
        "SF1": ["East", "West"],
        "SF2": ["South", "Midwest"],
    }

    for round_value in rounds:
        if round_value == "4":
            for game_id, regions in semifinal_sides.items():
                teams: List[str] = []
                for region in regions:
                    seeds = round_groups(round_value)[0][1]
                    teams.extend(
                        region_seed_team[region][seed]
                        for seed in seeds
                        if seed in region_seed_team[region]
                    )

                raw_total = 0.0
                for team in teams:
                    raw_total += yahoo_probs.get((team, round_value), 0.0)

                if raw_total <= 0:
                    warnings.append(f"No probability mass for round {round_value} {game_id}")
                    continue

                for team in teams:
                    raw_prob = yahoo_probs.get((team, round_value), 0.0)
                    rows.append(
                        {
                            "round": round_value,
                            "round_key": ROUND_LABELS[round_value],
                            "region": "/".join(regions),
                            "game_id": game_id,
                            "team": team,
                            "seed": team_info[team].seed,
                            "raw_prob": f"{raw_prob:.8f}",
                            "normalized_prob": f"{(raw_prob / raw_total):.8f}",
                        }
                    )
            continue

        for region, seed_map in region_seed_team.items():
            for game_id, seeds in round_groups(round_value):
                teams = [seed_map[s] for s in seeds if s in seed_map]
                raw_total = sum(yahoo_probs.get((team, round_value), 0.0) for team in teams)

                if raw_total <= 0:
                    warnings.append(f"No probability mass for round {round_value} {region} {game_id}")
                    continue

                for team in teams:
                    raw_prob = yahoo_probs.get((team, round_value), 0.0)
                    rows.append(
                        {
                            "round": round_value,
                            "round_key": ROUND_LABELS[round_value],
                            "region": region,
                            "game_id": game_id,
                            "team": team,
                            "seed": team_info[team].seed,
                            "raw_prob": f"{raw_prob:.8f}",
                            "normalized_prob": f"{(raw_prob / raw_total):.8f}",
                        }
                    )

    csv_team_set = {team for team, _round in yahoo_probs.keys()}
    missing = sorted(t for t in csv_team_set if t not in team_info)
    for team in missing:
        warnings.append(f"Team not found in enriched JSON and skipped: {team}")

    return rows, warnings


def write_output(output_csv: Path, rows: Iterable[dict]) -> None:
    fields = [
        "round",
        "round_key",
        "region",
        "game_id",
        "team",
        "seed",
        "raw_prob",
        "normalized_prob",
    ]
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    with output_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def validate(rows: List[dict]) -> List[str]:
    sums: Dict[Tuple[str, str, str], float] = defaultdict(float)
    for row in rows:
        key = (row["round"], row["region"], row["game_id"])
        sums[key] += float(row["normalized_prob"])

    bad: List[str] = []
    for key, val in sorted(sums.items()):
        if abs(val - 1.0) > 1e-6:
            bad.append(f"{key} sum={val:.8f}")
    return bad


def main() -> None:
    args = parse_args()
    team_info = load_team_info(Path(args.enriched_json))
    yahoo_probs = load_yahoo_probabilities(Path(args.yahoo_csv))
    rows, warnings = build_rows(team_info, yahoo_probs)
    write_output(Path(args.output_csv), rows)

    bad = validate(rows)
    print(f"Wrote {len(rows)} rows to {args.output_csv}")
    if warnings:
        print("Warnings:")
        for w in warnings:
            print(f"- {w}")
    if bad:
        print("Validation failed:")
        for b in bad:
            print(f"- {b}")
    else:
        print("Validation passed: every game group sums to 1.")


if __name__ == "__main__":
    main()
