"""
BRACKETGPT SEED VALIDATOR
==========================
Single source of truth: bracket JSON (bracket_2025.json / bracket_predictions_2025.json)

This module:
  1. Extracts the canonical seed/region/team mapping from the bracket JSON
  2. Validates any downstream data file (CSV, JSON) against it
  3. Auto-corrects mismatched seeds/regions
  4. Logs every fix so you know what changed

Usage:
  # Standalone â€” validate everything in backend/data/
  python seed_validator.py --bracket backend/data/bracket_2025.json --data-dir backend/data/

  # In pipeline â€” import and use
  from seed_validator import SeedValidator
  validator = SeedValidator('bracket_2025.json')
  fixed_csv = validator.fix_csv('public_ownership_2025.csv')
  fixed_json = validator.fix_json('pool_strategy_2025.json')

  # In server.js startup â€” call via child_process
  # const { execSync } = require('child_process');
  # execSync('python3 seed_validator.py --bracket backend/data/bracket_2025.json --data-dir backend/data/');
"""

import json
import csv
import os
import sys
import re
import argparse
from datetime import datetime
from collections import defaultdict
from difflib import SequenceMatcher


class SeedValidator:
    """Validates and corrects seed data across all BracketGPT files."""

    def __init__(self, bracket_path):
        self.bracket_path = bracket_path
        self.truth = {}          # canonical: { team_name: {seed, region} }
        self.aliases = {}        # lowercase/normalized â†’ canonical name
        self.play_in_teams = {}  # teams that only appear in First Four
        self.fixes = []          # log of all corrections made
        self.shared_alias_map = self._load_shared_alias_map()
        self._load_bracket()

    def _load_shared_alias_map(self):
        """Load optional shared alias mapping from team_name_mapping_2026.json."""
        mapping_path = os.path.join(os.path.dirname(__file__), 'team_name_mapping_2026.json')
        try:
            if not os.path.exists(mapping_path):
                return {}
            with open(mapping_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            alias_map = data.get('team_alias_mapping', {})
            return alias_map if isinstance(alias_map, dict) else {}
        except Exception as e:
            print(f"⚠️  Could not load shared alias map ({mapping_path}): {e}")
            return {}

    def _load_bracket(self):
        """Extract canonical seed/region from bracket JSON."""
        with open(self.bracket_path) as f:
            data = json.load(f)

        games = data.get('bracketGames', data.get('games', []))
        if not games:
            raise ValueError(f"No bracketGames found in {self.bracket_path}")

        # Pass 1: R64 games (most authoritative for seed + region)
        for g in games:
            if g.get('round') != 'Round of 64':
                continue
            for p in ['1', '2']:
                name = g.get(f'team{p}', '')
                seed = g.get(f'seed{p}')
                region = g.get('region', '')
                if name and seed is not None:
                    self.truth[name] = {'seed': int(seed), 'region': region}
                    self._register_aliases(name)

        # Pass 2: First Four games (play-in teams not in R64)
        # First, build seedâ†’region mapping from R64 for reference
        seed_region_map = defaultdict(list)
        for name, info in self.truth.items():
            seed_region_map[(info['seed'], info['region'])].append(name)

        for g in games:
            rd = g.get('round', '')
            if 'First' not in rd and 'Play' not in rd:
                continue
            for p in ['1', '2']:
                name = g.get(f'team{p}', '')
                seed = g.get(f'seed{p}')
                region = g.get('region', '')
                if name and seed is not None and name not in self.truth:
                    # Use the game's region field if available; otherwise check
                    # what region the opponent (who IS in R64) is in
                    other_p = '2' if p == '1' else '1'
                    other_name = g.get(f'team{other_p}', '')
                    if other_name in self.truth:
                        region = self.truth[other_name]['region']
                    elif region:
                        pass  # use game-level region
                    else:
                        region = self._find_playin_region(name, seed, games)
                    
                    self.truth[name] = {'seed': int(seed), 'region': region}
                    self.play_in_teams[name] = True
                    self._register_aliases(name)

        if len(self.truth) < 64:
            print(f"âš ï¸  Only found {len(self.truth)} teams (expected 64-68)")

    def _register_aliases(self, name):
        """Register common name variations for fuzzy matching."""
        self.aliases[name.lower()] = name
        self.aliases[self._normalize(name)] = name

        # Common abbreviation patterns
        ALIAS_MAP = {
            'Michigan St': ['michigan state', 'mich st', 'msu'],
            'Iowa St': ['iowa state'],
            'Mississippi St': ['mississippi state', 'miss st', 'miss state'],
            'Texas A&M': ['texas a&m', 'texas am', 'tamu'],
            "St John's": ["st. john's", 'saint johns', "saint john's", 'st johns'],
            "St Mary's CA": ["saint mary's", 'st marys', "saint mary's ca", 'st. marys'],
            'Connecticut': ['uconn', 'conn'],
            'Mississippi': ['ole miss'],
            "Mt St Mary's": ["mount st. mary's", "mount st mary's", 'mt st marys'],
            'McNeese St': ['mcneese', 'mcneese state'],
            'Colorado St': ['colorado state', 'colo st', 'csu'],
            'Utah St': ['utah state'],
            'UC San Diego': ['ucsd'],
            'NE Omaha': ['nebraska omaha', 'uno'],
            'St Francis PA': ['st. francis', 'saint francis'],
            'SIUE': ['siu edwardsville', 'southern illinois edwardsville'],
            'Alabama St': ['alabama state'],
            'UNC Wilmington': ['unc wilmington', 'uncw'],
            'North Carolina': ['unc', 'north carolina'],
            'San Diego St': ['san diego state', 'sdsu'],
        }
        merged_alias_map = dict(ALIAS_MAP)
        for canonical_name, alias_list in self.shared_alias_map.items():
            if isinstance(alias_list, list):
                merged_alias_map[canonical_name] = alias_list

        if name in merged_alias_map:
            for alias in merged_alias_map[name]:
                if len(self._normalize(alias)) <= 2:
                    continue
                self.aliases[alias.lower()] = name
                self.aliases[self._normalize(alias)] = name

    def _normalize(self, name):
        """Normalize a team name for matching."""
        s = name.lower().strip()
        s = re.sub(r'[.\'\-]', '', s)
        s = re.sub(r'\s+', ' ', s)
        return s

    def _find_playin_region(self, team_name, seed, games):
        """Find what region a play-in team feeds into."""
        for g in games:
            if g.get('round') != 'Round of 64':
                continue
            for p in ['1', '2']:
                if g.get(f'seed{p}') == seed:
                    # Check if this R64 slot could be a play-in destination
                    # (the team name won't match since it's a play-in game)
                    pass
        # Fallback: look at which region has that seed
        for g in games:
            if g.get('round') == 'Round of 64':
                for p in ['1', '2']:
                    if g.get(f'seed{p}') == seed:
                        return g.get('region', 'Unknown')
        return 'Unknown'

    def resolve(self, name):
        """
        Resolve a team name to canonical form + seed/region.
        Returns (canonical_name, seed, region) or (None, None, None).
        """
        # Direct match
        if name in self.truth:
            t = self.truth[name]
            return name, t['seed'], t['region']

        # Alias match
        low = name.lower().strip()
        if low in self.aliases:
            canonical = self.aliases[low]
            t = self.truth[canonical]
            return canonical, t['seed'], t['region']

        # Normalized match
        norm = self._normalize(name)
        if norm in self.aliases:
            canonical = self.aliases[norm]
            t = self.truth[canonical]
            return canonical, t['seed'], t['region']

        # Fuzzy match (last resort)
        best_match = None
        best_score = 0
        for canonical_name in self.truth:
            score = SequenceMatcher(None, norm, self._normalize(canonical_name)).ratio()
            if score > best_score:
                best_score = score
                best_match = canonical_name
        if best_score >= 0.75:
            t = self.truth[best_match]
            return best_match, t['seed'], t['region']

        return None, None, None

    def validate_seed(self, team_name, claimed_seed, claimed_region=None):
        """
        Check if a team's seed (and optionally region) is correct.
        Returns: {
            'valid': bool,
            'team': canonical name,
            'claimed_seed': int,
            'actual_seed': int,
            'claimed_region': str,
            'actual_region': str,
        }
        """
        canonical, actual_seed, actual_region = self.resolve(team_name)

        if canonical is None:
            return {
                'valid': False,
                'team': team_name,
                'error': 'team_not_found',
                'claimed_seed': claimed_seed,
                'actual_seed': None,
            }

        result = {
            'valid': True,
            'team': canonical,
            'claimed_seed': int(claimed_seed),
            'actual_seed': actual_seed,
            'claimed_region': claimed_region,
            'actual_region': actual_region,
        }

        if int(claimed_seed) != actual_seed:
            result['valid'] = False
            result['error'] = 'wrong_seed'

        if claimed_region and claimed_region != actual_region and actual_region != 'Unknown':
            # Allow "Final Four" as a valid region for later-round references
            if claimed_region != 'Final Four':
                result['valid'] = False
                result['error'] = result.get('error', '') + ' wrong_region'

        return result

    # â”€â”€ File Fixers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    def fix_csv(self, csv_path, output_path=None):
        """
        Validate and fix a CSV file with team/seed/region columns.
        Auto-detects column names.
        Returns: (fixed_rows, fix_log)
        """
        output_path = output_path or csv_path
        fixes = []

        with open(csv_path, 'r') as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames
            rows = list(reader)

        # Auto-detect column names
        team_col = next((c for c in fieldnames if c.lower() in ('team', 'name', 'school', 'team_name')), None)
        seed_col = next((c for c in fieldnames if c.lower() in ('seed', 'team_seed')), None)
        region_col = next((c for c in fieldnames if c.lower() in ('region', 'team_region')), None)

        if not team_col or not seed_col:
            return rows, [f"Could not find team/seed columns in {csv_path}. Columns: {fieldnames}"]

        fixed_rows = []
        for row in rows:
            team_name = row[team_col].strip()
            claimed_seed = int(row[seed_col])
            claimed_region = row.get(region_col, '').strip() if region_col else None

            canonical, actual_seed, actual_region = self.resolve(team_name)

            if canonical is None:
                fixes.append(f"âš ï¸  {team_name}: not found in bracket (removing)")
                continue

            if claimed_seed != actual_seed:
                fixes.append(f"ðŸ”§ {team_name}: seed {claimed_seed} â†’ {actual_seed}")
                row[seed_col] = str(actual_seed)

            if region_col and claimed_region and claimed_region != actual_region and actual_region != 'Unknown':
                fixes.append(f"ðŸ”§ {team_name}: region '{claimed_region}' â†’ '{actual_region}'")
                row[region_col] = actual_region

            # Also fix team name to canonical form
            if team_name != canonical:
                fixes.append(f"ðŸ“ {team_name} â†’ {canonical}")
                row[team_col] = canonical

            fixed_rows.append(row)

        # Check for missing teams
        csv_team_names = {r[team_col].strip() for r in fixed_rows}
        for canonical_name, info in self.truth.items():
            if canonical_name not in csv_team_names:
                # Don't add play-in losers unless they were already in the file
                if canonical_name in self.play_in_teams:
                    continue
                fixes.append(f"âž• {canonical_name} (seed {info['seed']}, {info['region']}): missing from CSV")

        # Write fixed file
        with open(output_path, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(fixed_rows)

        self.fixes.extend(fixes)
        return fixed_rows, fixes

    def fix_json(self, json_path, output_path=None):
        """
        Validate and fix a JSON file that contains team seed/region data.
        Handles: pool_strategy, chatbot_predictions, team_profiles, bracket_ev.
        Returns: (fixed_data, fix_log)
        """
        output_path = output_path or json_path
        fixes = []

        with open(json_path) as f:
            data = json.load(f)

        data, fixes = self._fix_json_recursive(data, fixes, path='root')

        with open(output_path, 'w') as f:
            json.dump(data, f, indent=2)

        self.fixes.extend(fixes)
        return data, fixes

    def _fix_json_recursive(self, obj, fixes, path=''):
        """Recursively walk JSON and fix any seed/region mismatches."""

        if isinstance(obj, dict):
            # Check if this dict has team + seed fields
            team_name = (obj.get('team') or obj.get('name') or obj.get('school')
                         or obj.get('t1_name') or obj.get('t2_name') or '')
            
            # Fix t1 fields
            if obj.get('t1_name'):
                canonical, seed, region = self.resolve(obj['t1_name'])
                if canonical:
                    if obj.get('t1_seed') is not None and int(obj['t1_seed']) != seed:
                        fixes.append(f"ðŸ”§ {path}.t1 {obj['t1_name']}: seed {obj['t1_seed']} â†’ {seed}")
                        obj['t1_seed'] = seed
                    if obj.get('t1_name') != canonical:
                        obj['t1_name'] = canonical

            # Fix t2 fields
            if obj.get('t2_name'):
                canonical, seed, region = self.resolve(obj['t2_name'])
                if canonical:
                    if obj.get('t2_seed') is not None and int(obj['t2_seed']) != seed:
                        fixes.append(f"ðŸ”§ {path}.t2 {obj['t2_name']}: seed {obj['t2_seed']} â†’ {seed}")
                        obj['t2_seed'] = seed
                    if obj.get('t2_name') != canonical:
                        obj['t2_name'] = canonical

            # Fix single-team records
            if team_name and not obj.get('t1_name') and not obj.get('t2_name'):
                canonical, seed, region = self.resolve(team_name)
                if canonical:
                    # Fix seed
                    for seed_key in ['seed', 'team_seed']:
                        if seed_key in obj and obj[seed_key] is not None:
                            if int(obj[seed_key]) != seed:
                                fixes.append(f"ðŸ”§ {path}.{team_name}: seed {obj[seed_key]} â†’ {seed}")
                                obj[seed_key] = seed

                    # Fix region
                    for region_key in ['region', 'team_region']:
                        if region_key in obj and obj[region_key]:
                            if obj[region_key] != region and region != 'Unknown':
                                if obj[region_key] != 'Final Four':
                                    fixes.append(f"ðŸ”§ {path}.{team_name}: region '{obj[region_key]}' â†’ '{region}'")
                                    obj[region_key] = region

                    # Fix team name
                    for name_key in ['team', 'name', 'school']:
                        if name_key in obj and obj[name_key] != canonical:
                            obj[name_key] = canonical

            # Recurse into all values
            for key, val in obj.items():
                obj[key], fixes = self._fix_json_recursive(val, fixes, path=f"{path}.{key}")

        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                obj[i], fixes = self._fix_json_recursive(item, fixes, path=f"{path}[{i}]")

        return obj, fixes

    def validate_all(self, data_dir):
        """Validate all data files in a directory. Returns summary report."""
        report = {
            'timestamp': datetime.now().isoformat(),
            'bracket_source': self.bracket_path,
            'teams_in_bracket': len(self.truth),
            'files_checked': [],
            'total_fixes': 0,
            'all_valid': True,
        }

        for filename in sorted(os.listdir(data_dir)):
            filepath = os.path.join(data_dir, filename)

            if filename.endswith('.csv'):
                _, fixes = self.fix_csv(filepath)
                report['files_checked'].append({
                    'file': filename, 'type': 'csv',
                    'fixes': len(fixes), 'details': fixes,
                })
                if fixes:
                    report['all_valid'] = False
                    report['total_fixes'] += len(fixes)

            elif filename.endswith('.json') and filename != os.path.basename(self.bracket_path):
                try:
                    _, fixes = self.fix_json(filepath)
                    report['files_checked'].append({
                        'file': filename, 'type': 'json',
                        'fixes': len(fixes), 'details': fixes,
                    })
                    if fixes:
                        report['all_valid'] = False
                        report['total_fixes'] += len(fixes)
                except Exception as e:
                    report['files_checked'].append({
                        'file': filename, 'type': 'json',
                        'error': str(e),
                    })

        return report

    def get_truth_table(self):
        """Return the canonical team â†’ seed/region mapping as a dict."""
        return dict(self.truth)

    def print_truth(self):
        """Pretty-print the canonical seed chart."""
        print(f"\n{'='*50}")
        print(f"BRACKET TRUTH TABLE â€” {len(self.truth)} teams")
        print(f"Source: {self.bracket_path}")
        print(f"{'='*50}")
        for name, info in sorted(self.truth.items(), key=lambda x: (x[1]['seed'], x[0])):
            playin = ' (play-in)' if name in self.play_in_teams else ''
            print(f"  {info['seed']:>2}  {info['region']:>10}  {name}{playin}")


def main():
    parser = argparse.ArgumentParser(description='BracketGPT Seed Validator')
    parser.add_argument('--bracket', required=True, help='Path to bracket JSON (source of truth)')
    parser.add_argument('--data-dir', help='Directory of data files to validate/fix')
    parser.add_argument('--file', help='Single file to validate/fix')
    parser.add_argument('--print-truth', action='store_true', help='Print canonical seed table')
    parser.add_argument('--dry-run', action='store_true', help='Report errors without fixing')
    args = parser.parse_args()

    validator = SeedValidator(args.bracket)
    print(f"âœ… Loaded {len(validator.truth)} teams from bracket")

    if args.print_truth:
        validator.print_truth()
        return

    if args.file:
        filepath = args.file
        if filepath.endswith('.csv'):
            if args.dry_run:
                _, fixes = validator.fix_csv(filepath, output_path='/dev/null')
            else:
                _, fixes = validator.fix_csv(filepath)
        elif filepath.endswith('.json'):
            if args.dry_run:
                _, fixes = validator.fix_json(filepath, output_path='/dev/null')
            else:
                _, fixes = validator.fix_json(filepath)
        else:
            print(f"Unsupported file type: {filepath}")
            return

        if fixes:
            print(f"\n{'âŒ' if args.dry_run else 'ðŸ”§'} {len(fixes)} {'issues found' if args.dry_run else 'fixes applied'}:")
            for fix in fixes:
                print(f"  {fix}")
        else:
            print(f"âœ… {filepath}: all seeds correct")
        return

    if args.data_dir:
        report = validator.validate_all(args.data_dir)
        print(f"\n{'='*50}")
        print(f"VALIDATION REPORT")
        print(f"{'='*50}")
        print(f"Files checked: {len(report['files_checked'])}")
        print(f"Total fixes: {report['total_fixes']}")
        print(f"Status: {'âœ… ALL VALID' if report['all_valid'] else 'ðŸ”§ FIXES APPLIED'}")

        for fc in report['files_checked']:
            status = 'âœ…' if fc.get('fixes', 0) == 0 and 'error' not in fc else 'ðŸ”§'
            if 'error' in fc:
                status = 'âŒ'
                print(f"\n  {status} {fc['file']}: ERROR â€” {fc['error']}")
            elif fc['fixes'] > 0:
                print(f"\n  {status} {fc['file']}: {fc['fixes']} fixes")
                for detail in fc['details'][:10]:
                    print(f"      {detail}")
                if len(fc['details']) > 10:
                    print(f"      ... and {len(fc['details']) - 10} more")
            else:
                print(f"  {status} {fc['file']}: clean")

        # Write report
        report_path = os.path.join(args.data_dir, 'seed_validation_report.json')
        with open(report_path, 'w') as f:
            json.dump(report, f, indent=2)
        print(f"\nReport saved to {report_path}")
        return

    # No action specified
    parser.print_help()


if __name__ == '__main__':
    main()

