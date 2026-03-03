"""
BRACKETGPT POOL STRATEGY GENERATOR
====================================
Takes public_ownership_2025.csv + team model data and computes
leverage-optimized bracket picks for different pool sizes.

Output: pool_strategy_2025.json — upload to Railway admin as 'optimizer'

Core formula:
  Leverage(team, round, pool_size) = 
    model_prob_to_reach_round × espn_points × (1 - ownership^(pool_size - 1))

  The (1 - ownership^(N-1)) term = probability that NOT everyone else
  in your pool also picked this team to this round. High leverage = 
  you're likely the only one with this pick AND the model thinks it hits.

Pool tiers:
  Small  (2-15):   Maximize floor. Chalk. Best team = champ.
  Medium (16-50):  1-2 upsets in R32/S16. Slightly contrarian champ.
  Large  (51-250): Differentiated F4. Low-ownership 1-seed as champ. 2-3 upsets in S16/E8.
  Mega   (250+):   Full contrarian. 3-4 seed champ with clean path. Chalk early, wild late.
"""

import csv
import json
import math
from collections import defaultdict
from datetime import datetime

# ── ESPN Scoring ──────────────────────────────────────────────
ESPN_SCORING = {
    'r64': 10, 'r32': 20, 's16': 40, 'e8': 80, 'f4': 160, 'champion': 320
}

ROUND_KEYS = ['r64', 'r32', 's16', 'e8', 'f4', 'champion']
ROUND_LABELS = {
    'r64': 'Round of 64', 'r32': 'Round of 32', 's16': 'Sweet 16',
    'e8': 'Elite 8', 'f4': 'Final Four', 'champion': 'Champion'
}

POOL_TIERS = {
    'small':  {'label': 'Small Pool', 'range': [2, 15],   'description': 'Office pools, friend groups. Win by not losing.'},
    'medium': {'label': 'Medium Pool', 'range': [16, 50],  'description': 'Larger office or league pools. Need 1-2 smart upsets.'},
    'large':  {'label': 'Large Pool', 'range': [51, 250],  'description': 'Big contests. Need a differentiated Final Four + champion.'},
    'mega':   {'label': 'Mega Pool', 'range': [251, 10000], 'description': 'ESPN/Yahoo massive pools. Must be contrarian to win.'},
}

# Representative pool size for each tier (used for EV calculations)
TIER_POOL_SIZES = {'small': 10, 'medium': 30, 'large': 100, 'mega': 500}


def load_ownership(csv_path):
    """Load public ownership CSV into list of dicts."""
    teams = []
    with open(csv_path, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            teams.append({
                'team': row['team'].strip(),
                'seed': int(row['seed']),
                'region': row['region'].strip(),
                'ownership': {
                    'r64': float(row['r64_ownership']),
                    'r32': float(row['r32_ownership']),
                    's16': float(row['s16_ownership']),
                    'e8': float(row['e8_ownership']),
                    'f4': float(row['f4_ownership']),
                    'champion': float(row['champion_ownership']),
                },
                'source': row.get('source', '').strip(),
            })
    return teams


def leverage_factor(ownership, pool_size):
    """
    Probability that you're the ONLY person in your pool with this pick.
    
    P(unique) = (1 - ownership)^(pool_size - 1)
    
    But what matters for winning is the inverse — how much does this pick
    separate you from the field? We use:
    
    leverage = 1 - ownership^(pool_size - 1)
    
    This is the probability that at least one OTHER person DOESN'T have this pick,
    meaning it has differentiation value. When ownership is 0.95 and pool is 100,
    leverage ≈ 0.994 — everyone has it, no edge. Wait, that's wrong.
    
    Actually: the value of a correct pick is inversely related to how many
    others also have it. The right metric is:
    
    uniqueness = (1 - ownership)^(pool_size - 1) = prob YOU are the only one
    
    But we also care about the pick being correct. So:
    
    EV_leverage = model_prob × points × (1 / (1 + ownership × (pool_size - 1)))
    
    The denominator approximates expected number of people sharing the pick.
    If 5 people share a correct 320-point pick, each "gains" 320 but so do 4 others.
    If you're the only one, you gain 320 and everyone else gets 0.
    
    Simplified leverage score:
    leverage = 1 / (1 + ownership × (pool_size - 1))
    """
    expected_others_with_pick = ownership * (pool_size - 1)
    return 1.0 / (1.0 + expected_others_with_pick)


def compute_team_ev(team, pool_size):
    """
    Compute expected leverage-adjusted points per round for a team.
    
    We use ownership as a proxy for "model prob to reach that round" from
    the public's perspective. Our model prob would be better, but since we're
    generating this from the ownership CSV alone, we use a simple heuristic:
    
    For the ownership CSV, the values already represent the fraction of
    public brackets picking that team to reach each round. We treat
    our model's probability as the "true" probability — approximated here
    by a seed-adjusted version of ownership (we trust the public roughly
    on chalk but think they over/undervalue certain teams).
    
    In practice, when the full pipeline runs, model_prob should come from
    the Monte Carlo expected finishes. For now we use ownership as the
    baseline and layer leverage on top.
    """
    results = {}
    for rnd in ROUND_KEYS:
        own = team['ownership'][rnd]
        pts = ESPN_SCORING[rnd]
        lev = leverage_factor(own, pool_size)
        
        # Model-implied probability: we slightly adjust ownership based on seed
        # Higher seeds are under-picked by public relative to true strength
        # Lower seeds are over-picked due to narrative/brand bias
        seed = team['seed']
        if seed <= 2:
            # Public slightly over-picks 1-2 seeds for champion but about right for early rounds
            model_prob = own * 1.02 if rnd in ('r64', 'r32') else own * 0.95
        elif seed <= 4:
            model_prob = own * 1.05  # slightly under-picked
        elif seed <= 8:
            model_prob = own * 1.08  # more under-picked
        elif seed <= 12:
            model_prob = own * 1.10
        else:
            model_prob = own * 0.90  # over-picked (Cinderella hype)
        
        model_prob = min(model_prob, 0.99)
        
        # Raw EV = model_prob × points (what you'd compute without leverage)
        raw_ev = model_prob * pts
        
        # Leverage EV = raw_ev × leverage (the "pool-adjusted" value)
        lev_ev = raw_ev * lev
        
        # Edge = how much better this pick is vs chalk
        # Chalk EV assumes everyone has this pick (leverage → 0 for big pools)
        chalk_lev = leverage_factor(own, pool_size)
        
        results[rnd] = {
            'ownership': round(own, 4),
            'model_prob': round(model_prob, 4),
            'espn_points': pts,
            'leverage': round(lev, 4),
            'raw_ev': round(raw_ev, 2),
            'leverage_ev': round(lev_ev, 2),
        }
    
    # Total leverage EV across all rounds
    total_lev_ev = sum(r['leverage_ev'] for r in results.values())
    total_raw_ev = sum(r['raw_ev'] for r in results.values())
    
    return {
        'rounds': results,
        'total_leverage_ev': round(total_lev_ev, 2),
        'total_raw_ev': round(total_raw_ev, 2),
        'leverage_edge': round(total_lev_ev - total_raw_ev * leverage_factor(
            team['ownership']['champion'], pool_size), 2),
    }


def generate_tier_strategy(teams, tier_name, pool_size):
    """Generate optimal picks + reasoning for a specific pool tier."""
    
    # Compute EVs for all teams at this pool size
    team_evs = []
    for t in teams:
        ev = compute_team_ev(t, pool_size)
        team_evs.append({**t, 'ev': ev})
    
    # ── Champion Pick ──
    # Rank by champion leverage EV, with a pool-size-dependent "contrarian boost"
    # In mega pools, uniqueness matters way more than raw probability
    # We compute: score = leverage_ev × (1 + contrarian_weight × (1 - ownership))
    contrarian_weight = {
        'small': 0.0,    # don't care about uniqueness
        'medium': 0.5,   # slight bonus for being different
        'large': 2.0,    # strong bonus
        'mega': 5.0,     # massive bonus — uniqueness is everything
    }.get(tier_name, 1.0)
    
    def champ_score(t):
        lev_ev = t['ev']['rounds']['champion']['leverage_ev']
        own = t['ownership']['champion']
        # Boost for low-ownership picks
        uniqueness_bonus = 1 + contrarian_weight * (1 - own)
        return lev_ev * uniqueness_bonus
    
    champ_ranked = sorted(team_evs, key=champ_score, reverse=True)
    
    # ── Upset Picks ──
    # Find where leverage × model_prob is highest for lower seeds
    upset_picks = []
    for t in team_evs:
        if t['seed'] >= 7:  # only consider 7+ seeds as "upsets"
            for rnd in ['r32', 's16', 'e8']:
                r = t['ev']['rounds'][rnd]
                if r['model_prob'] > 0.05:  # at least 5% chance
                    upset_picks.append({
                        'team': t['team'],
                        'seed': t['seed'],
                        'region': t['region'],
                        'round': rnd,
                        'round_label': ROUND_LABELS[rnd],
                        'ownership': r['ownership'],
                        'model_prob': r['model_prob'],
                        'leverage': r['leverage'],
                        'leverage_ev': r['leverage_ev'],
                        'raw_ev': r['raw_ev'],
                    })
    
    upset_picks.sort(key=lambda x: x['leverage_ev'], reverse=True)
    
    # ── Value Picks (mid-seeds undervalued by public) ──
    value_picks = []
    for t in team_evs:
        if 3 <= t['seed'] <= 6:
            # Look at S16+ where leverage matters most
            deep_lev_ev = sum(t['ev']['rounds'][r]['leverage_ev'] for r in ['s16', 'e8', 'f4', 'champion'])
            deep_raw_ev = sum(t['ev']['rounds'][r]['raw_ev'] for r in ['s16', 'e8', 'f4', 'champion'])
            
            value_picks.append({
                'team': t['team'],
                'seed': t['seed'],
                'region': t['region'],
                'deep_leverage_ev': round(deep_lev_ev, 2),
                'deep_raw_ev': round(deep_raw_ev, 2),
                'leverage_edge_deep': round(deep_lev_ev - deep_raw_ev * 0.5, 2),
                'champion_ownership': t['ownership']['champion'],
                'f4_ownership': t['ownership']['f4'],
            })
    
    value_picks.sort(key=lambda x: x['deep_leverage_ev'], reverse=True)
    
    # ── Chalk Locks (high-confidence early picks) ──
    chalk_locks = []
    for t in team_evs:
        if t['seed'] <= 3:
            r64 = t['ev']['rounds']['r64']
            r32 = t['ev']['rounds']['r32']
            if r64['model_prob'] > 0.85:
                chalk_locks.append({
                    'team': t['team'],
                    'seed': t['seed'],
                    'region': t['region'],
                    'r64_prob': r64['model_prob'],
                    'r32_prob': r32['model_prob'],
                    'early_ev': round(r64['raw_ev'] + r32['raw_ev'], 2),
                })
    
    chalk_locks.sort(key=lambda x: x['early_ev'], reverse=True)
    
    # ── Fade Candidates (popular teams to avoid) ──
    fade_candidates = []
    for t in team_evs:
        for rnd in ['f4', 'champion']:
            r = t['ev']['rounds'][rnd]
            # High ownership + low leverage = everyone picks them, no edge
            if r['ownership'] > 0.15 and r['leverage'] < 0.15:
                fade_candidates.append({
                    'team': t['team'],
                    'seed': t['seed'],
                    'region': t['region'],
                    'round': rnd,
                    'round_label': ROUND_LABELS[rnd],
                    'ownership': r['ownership'],
                    'leverage': r['leverage'],
                    'reason': f"Picked by {r['ownership']:.0%} of public to reach {ROUND_LABELS[rnd]}. "
                              f"Even if correct, {1/r['leverage']:.0f} others likely share this pick in your pool.",
                })
    
    fade_candidates.sort(key=lambda x: x['ownership'], reverse=True)
    
    # ── Strategy Summary ──
    tier_cfg = POOL_TIERS[tier_name]
    
    # Build upset budget by tier
    if tier_name == 'small':
        upset_budget = 0
        upset_rounds = []
        champ_strategy = "Pick the highest-probability champion. In small pools, you win by not busting."
    elif tier_name == 'medium':
        upset_budget = 2
        upset_rounds = ['r32', 's16']
        champ_strategy = "Pick a 1 or 2 seed that fewer people in your pool will have. Avoid the most popular 1-seed."
    elif tier_name == 'large':
        upset_budget = 3
        upset_rounds = ['r32', 's16', 'e8']
        champ_strategy = "Target the 1-seed with lowest public ownership, or a strong 2-seed. You need to be different."
    else:  # mega
        upset_budget = 4
        upset_rounds = ['s16', 'e8', 'f4']
        champ_strategy = "Go contrarian. A 2-4 seed with strong model metrics and sub-5% champion ownership. Chalk early rounds — no leverage in R64 uniqueness."
    
    # Pick the recommended champion per tier
    if tier_name == 'small':
        # Highest raw EV champion
        rec_champ = sorted(team_evs, 
                           key=lambda x: x['ev']['rounds']['champion']['raw_ev'],
                           reverse=True)[:3]
    else:
        # Highest leverage EV champion
        rec_champ = champ_ranked[:5]
    
    recommended_champion = [{
        'team': c['team'],
        'seed': c['seed'],
        'region': c['region'],
        'champion_ownership': c['ownership']['champion'],
        'champion_leverage_ev': c['ev']['rounds']['champion']['leverage_ev'],
        'champion_raw_ev': c['ev']['rounds']['champion']['raw_ev'],
        'total_leverage_ev': c['ev']['total_leverage_ev'],
    } for c in rec_champ]
    
    # Pick recommended upsets for this tier
    tier_upsets = [u for u in upset_picks if u['round'] in upset_rounds][:upset_budget * 2]
    
    return {
        'tier': tier_name,
        'label': tier_cfg['label'],
        'pool_size_range': tier_cfg['range'],
        'representative_pool_size': pool_size,
        'description': tier_cfg['description'],
        'strategy': {
            'champion_approach': champ_strategy,
            'upset_budget': upset_budget,
            'upset_target_rounds': [ROUND_LABELS[r] for r in upset_rounds],
            'core_principle': {
                'small': "Maximize floor. Don't get cute. Pick the best teams and hope for chaos elsewhere.",
                'medium': "Calculated risks. 1-2 upsets where your model has edge. Slightly contrarian champion.",
                'large': "Differentiate or die. Your Final Four must look different from the public's.",
                'mega': "You need to be the only one with your champion. Chalk R64, go wild from S16 on.",
            }[tier_name],
        },
        'recommended_champions': recommended_champion,
        'recommended_upsets': tier_upsets,
        'value_picks': value_picks[:8],
        'chalk_locks': chalk_locks[:10],
        'fade_candidates': fade_candidates[:8],
    }


def generate_full_ev_table(teams, pool_size):
    """Generate complete EV table for every team at a given pool size."""
    rows = []
    for t in teams:
        ev = compute_team_ev(t, pool_size)
        row = {
            'team': t['team'],
            'seed': t['seed'],
            'region': t['region'],
        }
        for rnd in ROUND_KEYS:
            r = ev['rounds'][rnd]
            row[f'{rnd}_ownership'] = r['ownership']
            row[f'{rnd}_leverage_ev'] = r['leverage_ev']
            row[f'{rnd}_raw_ev'] = r['raw_ev']
            row[f'{rnd}_leverage'] = r['leverage']
        row['total_leverage_ev'] = ev['total_leverage_ev']
        row['total_raw_ev'] = ev['total_raw_ev']
        rows.append(row)
    
    rows.sort(key=lambda x: x['total_leverage_ev'], reverse=True)
    return rows


def main():
    import os
    
    # Paths
    ownership_path = '/home/claude/public_ownership_2025_fixed.csv'
    
    # Try alternative paths
    if not os.path.exists(ownership_path):
        ownership_path = os.path.join(os.path.dirname(__file__), 
                                   'bracketgpt', 'backend', 'data', 'public_ownership_2025.csv')
    if not os.path.exists(ownership_path):
        ownership_path = '/home/claude/bracketgpt/backend/data/public_ownership_2025.csv'
    
    print(f"Loading ownership data from: {ownership_path}")
    teams = load_ownership(ownership_path)
    print(f"Loaded {len(teams)} teams")
    
    # ── Build the master JSON ──
    output = {
        'version': 'pool_strategy_v1',
        'generated_at': datetime.now().isoformat(),
        'season': 2025,
        'methodology': {
            'description': 'Leverage-adjusted expected value optimization per pool size tier',
            'formula': 'Leverage_EV = model_prob × ESPN_points × (1 / (1 + ownership × (pool_size - 1)))',
            'explanation': (
                'Standard bracket strategy maximizes raw expected points. But in a pool, '
                'a correct pick only matters if it SEPARATES you from the field. '
                'Leverage EV discounts picks that everyone else also has (low differentiation) '
                'and boosts picks where you might be the only one right (high differentiation). '
                'The optimal strategy changes dramatically by pool size: small pools reward '
                'chalk (minimize risk), mega pools reward contrarian picks (maximize uniqueness).'
            ),
            'espn_scoring': ESPN_SCORING,
            'pool_tiers': POOL_TIERS,
            'data_sources': ['ESPN public bracket data', 'Yahoo public bracket data', 'Seed-historical baselines'],
        },
        'strategies': {},
        'ev_tables': {},
        'quick_reference': {},
    }
    
    # ── Generate strategy per tier ──
    for tier_name, pool_size in TIER_POOL_SIZES.items():
        print(f"\nGenerating {tier_name} strategy (pool_size={pool_size})...")
        strategy = generate_tier_strategy(teams, tier_name, pool_size)
        output['strategies'][tier_name] = strategy
        
        # Full EV table for this tier
        ev_table = generate_full_ev_table(teams, pool_size)
        output['ev_tables'][tier_name] = ev_table
        
        # Quick reference: top 5 by total leverage EV
        top5 = ev_table[:5]
        print(f"  Top 5 leverage EV: {', '.join(f'{t['team']} ({t['total_leverage_ev']})' for t in top5)}")
    
    # ── Quick Reference Card ──
    # One-liner per tier for the chatbot system prompt
    for tier_name in POOL_TIERS:
        s = output['strategies'][tier_name]
        champs = s['recommended_champions'][:3]
        champ_str = ', '.join(f"{c['team']} ({c['seed']}-seed, {c['champion_ownership']:.0%} public)"
                              for c in champs)
        
        upsets = s['recommended_upsets'][:3]
        upset_str = ', '.join(f"{u['team']} ({u['seed']}-seed in {u['round_label']})"
                              for u in upsets) if upsets else 'None — play chalk'
        
        fades = s['fade_candidates'][:2]
        fade_str = ', '.join(f"{f['team']} ({f['round_label']}: {f['ownership']:.0%} owned)"
                             for f in fades) if fades else 'N/A'
        
        output['quick_reference'][tier_name] = {
            'pool_range': f"{POOL_TIERS[tier_name]['range'][0]}-{POOL_TIERS[tier_name]['range'][1]} people",
            'champion_picks': champ_str,
            'upset_picks': upset_str,
            'fades': fade_str,
            'one_liner': s['strategy']['core_principle'],
        }
    
    # ── Ownership Leaderboard (for the value-picks page) ──
    output['ownership_leaderboard'] = {
        'most_owned_champions': sorted(teams, key=lambda t: t['ownership']['champion'], reverse=True)[:10],
        'least_owned_final_four': sorted(
            [t for t in teams if t['ownership']['f4'] > 0.005],
            key=lambda t: t['ownership']['f4']
        )[:10],
        'highest_leverage_champions': sorted(
            teams,
            key=lambda t: compute_team_ev(t, 100)['rounds']['champion']['leverage_ev'],
            reverse=True
        )[:10],
    }
    
    # Clean up the leaderboard entries (remove nested ev objects)
    for key in ['most_owned_champions', 'least_owned_final_four', 'highest_leverage_champions']:
        for entry in output['ownership_leaderboard'][key]:
            entry.pop('source', None)
    
    # ── Write output ──
    output_path = '/home/claude/pool_strategy_2025.json'
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)
    
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\n✅ Written to {output_path} ({size_mb:.2f} MB)")
    
    # ── Auto-validate against bracket JSON ──
    bracket_candidates = [
        os.path.join(os.path.dirname(ownership_path), 'bracket_2025.json'),
        os.path.join(os.path.dirname(ownership_path), '..', '..', 'bracket_2025.json'),
        '/mnt/user-data/uploads/bracket_2025__1_.json',  # dev fallback
    ]
    bracket_path = None
    for bp in bracket_candidates:
        if os.path.exists(bp):
            bracket_path = bp
            break
    
    if bracket_path:
        try:
            # Import validator if available (same directory or backend/data/)
            validator_paths = [
                os.path.join(os.path.dirname(__file__), 'seed_validator.py'),
                os.path.join(os.path.dirname(ownership_path), 'seed_validator.py'),
            ]
            validator_module = None
            for vp in validator_paths:
                if os.path.exists(vp):
                    import importlib.util
                    spec = importlib.util.spec_from_file_location("seed_validator", vp)
                    validator_module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(validator_module)
                    break
            
            if validator_module:
                v = validator_module.SeedValidator(bracket_path)
                _, fixes = v.fix_json(output_path)
                if fixes:
                    print(f"\n🔧 Seed validator auto-corrected {len(fixes)} issues:")
                    for fix in fixes[:15]:
                        print(f"  {fix}")
                    if len(fixes) > 15:
                        print(f"  ... and {len(fixes) - 15} more")
                else:
                    print(f"\n✅ Seed validation passed — all teams match bracket JSON")
            else:
                print(f"\n⚠️  seed_validator.py not found — skipping auto-validation")
        except Exception as e:
            print(f"\n⚠️  Seed validation failed: {e}")
    
    # ── Print summary ──
    print("\n" + "=" * 60)
    print("POOL STRATEGY SUMMARY")
    print("=" * 60)
    
    for tier_name in ['small', 'medium', 'large', 'mega']:
        qr = output['quick_reference'][tier_name]
        print(f"\n{'─' * 40}")
        print(f"  {qr['pool_range'].upper()}")
        print(f"  {qr['one_liner']}")
        print(f"  Champion picks: {qr['champion_picks']}")
        print(f"  Upset picks: {qr['upset_picks']}")
        print(f"  Fades: {qr['fades']}")
    
    return output


if __name__ == '__main__':
    main()
