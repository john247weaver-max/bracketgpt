"""
BracketGPT 2025 Prediction Pipeline
====================================
Simulates pre-tournament 2025: trains on 2003-2024, predicts 2025 matchups.
Then separately scores against actual results for backtest validation.

Outputs:
  - chatbot_predictions_base.json  (for BracketGPT admin upload)
  - chatbot_predictions_upset.json
  - chatbot_predictions_floor.json  
  - backtest_scorecard.json        (accuracy metrics - internal only)
"""

import pandas as pd
import numpy as np
import json
import warnings
from itertools import combinations
from sklearn.preprocessing import StandardScaler
import xgboost as xgb
import lightgbm as lgb

warnings.filterwarnings('ignore')

DATA_DIR = '/mnt/user-data/uploads'

# ============================================================
# STEP 1: LOAD DATA
# ============================================================
def load_data():
    print("📂 Loading data...")
    reg = pd.read_csv(f'{DATA_DIR}/MRegularSeasonDetailedResults.csv')
    trn = pd.read_csv(f'{DATA_DIR}/MNCAATourneyDetailedResults.csv')
    seeds = pd.read_csv(f'{DATA_DIR}/MNCAATourneySeeds.csv')
    teams = pd.read_csv(f'{DATA_DIR}/MTeams.csv')
    coaches = pd.read_csv(f'{DATA_DIR}/MTeamCoaches.csv')
    kenpom = pd.read_csv(f'{DATA_DIR}/summary25_pt.csv')
    slots = pd.read_csv(f'{DATA_DIR}/MNCAATourneySlots.csv')
    
    print(f"   Regular season: {len(reg)} games ({reg['Season'].min()}-{reg['Season'].max()})")
    print(f"   Tournament: {len(trn)} games")
    print(f"   2025 reg season: {len(reg[reg['Season']==2025])}")
    print(f"   2025 seeds: {len(seeds[seeds['Season']==2025])}")
    
    return reg, trn, seeds, teams, coaches, kenpom, slots


# ============================================================
# STEP 2: BUILD TEAM FEATURES FROM REGULAR SEASON
# ============================================================
def build_season_features(reg, season):
    """Build team-level features from regular season data for a given season."""
    rs = reg[reg['Season'] == season].copy()
    
    features = {}
    
    # Get all teams that played
    all_teams = set(rs['WTeamID'].unique()) | set(rs['LTeamID'].unique())
    
    for tid in all_teams:
        wins = rs[rs['WTeamID'] == tid]
        losses = rs[rs['LTeamID'] == tid]
        
        n_wins = len(wins)
        n_losses = len(losses)
        n_games = n_wins + n_losses
        if n_games == 0:
            continue
        
        # Scoring
        pts_for = wins['WScore'].sum() + losses['LScore'].sum()
        pts_against = wins['LScore'].sum() + losses['WScore'].sum()
        avg_score = pts_for / n_games
        avg_allowed = pts_against / n_games
        avg_margin = (pts_for - pts_against) / n_games
        
        # Shooting (from wins)
        w_fgm = wins['WFGM'].sum(); w_fga = wins['WFGA'].sum()
        w_fgm3 = wins['WFGM3'].sum(); w_fga3 = wins['WFGA3'].sum()
        w_ftm = wins['WFTM'].sum(); w_fta = wins['WFTA'].sum()
        w_or = wins['WOR'].sum(); w_dr = wins['WDR'].sum()
        w_ast = wins['WAst'].sum(); w_to = wins['WTO'].sum()
        w_stl = wins['WStl'].sum(); w_blk = wins['WBlk'].sum()
        
        # Shooting (from losses - team stats when they lost)
        l_fgm = losses['LFGM'].sum(); l_fga = losses['LFGA'].sum()
        l_fgm3 = losses['LFGM3'].sum(); l_fga3 = losses['LFGA3'].sum()
        l_ftm = losses['LFTM'].sum(); l_fta = losses['LFTA'].sum()
        l_or = losses['LOR'].sum(); l_dr = losses['LDR'].sum()
        l_ast = losses['LAst'].sum(); l_to = losses['LTO'].sum()
        l_stl = losses['LStl'].sum(); l_blk = losses['LBlk'].sum()
        
        # Combined
        tot_fgm = w_fgm + l_fgm; tot_fga = w_fga + l_fga
        tot_fgm3 = w_fgm3 + l_fgm3; tot_fga3 = w_fga3 + l_fga3
        tot_ftm = w_ftm + l_ftm; tot_fta = w_fta + l_fta
        tot_or = w_or + l_or; tot_dr = w_dr + l_dr
        tot_ast = w_ast + l_ast; tot_to = w_to + l_to
        tot_stl = w_stl + l_stl; tot_blk = w_blk + l_blk
        
        # Opponent stats
        opp_fgm = wins['LFGM'].sum() + losses['WFGM'].sum()
        opp_fga = wins['LFGA'].sum() + losses['WFGA'].sum()
        opp_fgm3 = wins['LFGM3'].sum() + losses['WFGM3'].sum()
        opp_fga3 = wins['LFGA3'].sum() + losses['WFGA3'].sum()
        opp_or = wins['LOR'].sum() + losses['WOR'].sum()
        opp_to = wins['LTO'].sum() + losses['WTO'].sum()
        
        # Possessions estimate
        poss = tot_fga - tot_or + tot_to + 0.44 * tot_fta
        opp_poss = opp_fga - opp_or + opp_to + 0.44 * (wins['LFTA'].sum() + losses['WFTA'].sum())
        
        # Advanced metrics
        fg_pct = tot_fgm / max(tot_fga, 1)
        fg3_pct = tot_fgm3 / max(tot_fga3, 1)
        ft_pct = tot_ftm / max(tot_fta, 1)
        efg = (tot_fgm + 0.5 * tot_fgm3) / max(tot_fga, 1)
        opp_efg = (opp_fgm + 0.5 * opp_fgm3) / max(opp_fga, 1)
        to_rate = tot_to / max(poss, 1)
        or_pct = tot_or / max(tot_or + (wins['LDR'].sum() + losses['WDR'].sum()), 1)
        dr_pct = tot_dr / max(tot_dr + opp_or, 1)
        ast_rate = tot_ast / max(tot_fgm, 1)
        ft_rate = tot_fta / max(tot_fga, 1)
        three_rate = tot_fga3 / max(tot_fga, 1)
        blk_stl = (tot_blk + tot_stl) / n_games
        
        # Points per possession
        off_eff = pts_for / max(poss, 1) * 100
        def_eff = pts_against / max(opp_poss, 1) * 100
        
        # Pythagorean win expectation
        pyth_exp = 10.25
        pyth = avg_score**pyth_exp / max(avg_score**pyth_exp + avg_allowed**pyth_exp, 0.001)
        
        # Win ratio
        win_ratio = n_wins / max(n_games, 1)
        
        # Last 14 days form
        if len(rs) > 0:
            max_day = rs['DayNum'].max()
            recent_w = wins[wins['DayNum'] >= max_day - 14]
            recent_l = losses[losses['DayNum'] >= max_day - 14]
            recent_games = len(recent_w) + len(recent_l)
            recent_wr = len(recent_w) / max(recent_games, 1)
        else:
            recent_wr = 0.5
        
        features[tid] = {
            'win_ratio': win_ratio,
            'avg_score': avg_score,
            'avg_allowed': avg_allowed,
            'avg_margin': avg_margin,
            'fg_pct': fg_pct,
            'fg3_pct': fg3_pct,
            'ft_pct': ft_pct,
            'efg': efg,
            'opp_efg': opp_efg,
            'to_rate': to_rate,
            'or_pct': or_pct,
            'dr_pct': dr_pct,
            'ast_rate': ast_rate,
            'ft_rate': ft_rate,
            'three_rate': three_rate,
            'blk_stl': blk_stl,
            'off_eff': off_eff,
            'def_eff': def_eff,
            'net_eff': off_eff - def_eff,
            'pyth': pyth,
            'recent_wr': recent_wr,
            'n_games': n_games,
            'n_wins': n_wins,
        }
    
    return features


# ============================================================
# STEP 3: ELO RATINGS
# ============================================================
def compute_elo(reg, through_season):
    """Compute Elo ratings for all teams through a given season."""
    K = 32
    HOME_ADV = 3
    elo = {}
    
    for season in range(2003, through_season + 1):
        # Season start: regress toward mean
        for tid in elo:
            elo[tid] = elo[tid] * 0.75 + 1500 * 0.25
        
        rs = reg[reg['Season'] == season].sort_values('DayNum')
        for _, g in rs.iterrows():
            w, l = g['WTeamID'], g['LTeamID']
            if w not in elo: elo[w] = 1500
            if l not in elo: elo[l] = 1500
            
            loc = g.get('WLoc', 'N')
            adv = HOME_ADV if loc == 'H' else (-HOME_ADV if loc == 'A' else 0)
            
            expected_w = 1 / (1 + 10 ** ((elo[l] - elo[w] - adv) / 400))
            margin = g['WScore'] - g['LScore']
            mov_mult = np.log(abs(margin) + 1) * (2.2 / (0.001 * (elo[w] - elo[l]) + 2.2))
            
            update = K * mov_mult * (1 - expected_w)
            elo[w] += update
            elo[l] -= update
    
    return elo


# ============================================================
# STEP 4: BUILD MATCHUP FEATURES
# ============================================================
def build_matchup_features(t1_feat, t2_feat, t1_seed, t2_seed, t1_elo, t2_elo, 
                           t1_kp=None, t2_kp=None):
    """Build feature vector for a matchup."""
    
    seed_diff = t1_seed - t2_seed
    elo_diff = t1_elo - t2_elo
    
    # Historical seed win probability
    seed_probs = {
        (1,16): 0.993, (2,15): 0.938, (3,14): 0.881, (4,13): 0.810,
        (5,12): 0.654, (6,11): 0.548, (7,10): 0.597, (8,9): 0.500,
        (1,8): 0.85, (1,9): 0.85, (2,7): 0.64, (2,10): 0.64,
        (3,6): 0.58, (3,11): 0.58, (4,5): 0.55, (4,12): 0.55,
        (1,4): 0.72, (1,5): 0.72, (2,3): 0.55, (2,6): 0.55,
        (1,2): 0.58, (1,3): 0.65,
    }
    
    s1, s2 = int(t1_seed), int(t2_seed)
    key = (min(s1,s2), max(s1,s2))
    base_prob = seed_probs.get(key, 0.5)
    if s1 < s2:
        seed_implied = base_prob
    elif s1 > s2:
        seed_implied = 1 - base_prob
    else:
        seed_implied = 0.5
    
    features = {
        'seed_diff': seed_diff,
        'elo_diff': elo_diff,
        'seed_implied_prob': seed_implied,
        # T1 stats
        't1_win_ratio': t1_feat.get('win_ratio', 0.5),
        't1_avg_margin': t1_feat.get('avg_margin', 0),
        't1_off_eff': t1_feat.get('off_eff', 100),
        't1_def_eff': t1_feat.get('def_eff', 100),
        't1_net_eff': t1_feat.get('net_eff', 0),
        't1_efg': t1_feat.get('efg', 0.45),
        't1_opp_efg': t1_feat.get('opp_efg', 0.45),
        't1_to_rate': t1_feat.get('to_rate', 0.15),
        't1_or_pct': t1_feat.get('or_pct', 0.3),
        't1_dr_pct': t1_feat.get('dr_pct', 0.7),
        't1_ft_rate': t1_feat.get('ft_rate', 0.3),
        't1_three_rate': t1_feat.get('three_rate', 0.35),
        't1_blk_stl': t1_feat.get('blk_stl', 5),
        't1_pyth': t1_feat.get('pyth', 0.5),
        't1_recent_wr': t1_feat.get('recent_wr', 0.5),
        # T2 stats
        't2_win_ratio': t2_feat.get('win_ratio', 0.5),
        't2_avg_margin': t2_feat.get('avg_margin', 0),
        't2_off_eff': t2_feat.get('off_eff', 100),
        't2_def_eff': t2_feat.get('def_eff', 100),
        't2_net_eff': t2_feat.get('net_eff', 0),
        't2_efg': t2_feat.get('efg', 0.45),
        't2_opp_efg': t2_feat.get('opp_efg', 0.45),
        't2_to_rate': t2_feat.get('to_rate', 0.15),
        't2_or_pct': t2_feat.get('or_pct', 0.3),
        't2_dr_pct': t2_feat.get('dr_pct', 0.7),
        't2_ft_rate': t2_feat.get('ft_rate', 0.3),
        't2_three_rate': t2_feat.get('three_rate', 0.35),
        't2_blk_stl': t2_feat.get('blk_stl', 5),
        't2_pyth': t2_feat.get('pyth', 0.5),
        't2_recent_wr': t2_feat.get('recent_wr', 0.5),
        # Differentials
        'margin_diff': t1_feat.get('avg_margin', 0) - t2_feat.get('avg_margin', 0),
        'off_eff_diff': t1_feat.get('off_eff', 100) - t2_feat.get('off_eff', 100),
        'def_eff_diff': t1_feat.get('def_eff', 100) - t2_feat.get('def_eff', 100),
        'net_eff_diff': t1_feat.get('net_eff', 0) - t2_feat.get('net_eff', 0),
        'efg_diff': t1_feat.get('efg', 0.45) - t2_feat.get('efg', 0.45),
        'pyth_diff': t1_feat.get('pyth', 0.5) - t2_feat.get('pyth', 0.5),
    }
    
    # KenPom features if available
    if t1_kp is not None and t2_kp is not None:
        features.update({
            'kp_adjoe_diff': t1_kp.get('AdjOE', 0) - t2_kp.get('AdjOE', 0),
            'kp_adjde_diff': t1_kp.get('AdjDE', 0) - t2_kp.get('AdjDE', 0),
            'kp_adjem_diff': t1_kp.get('AdjEM', 0) - t2_kp.get('AdjEM', 0),
            'kp_tempo_diff': t1_kp.get('AdjTempo', 0) - t2_kp.get('AdjTempo', 0),
            'kp_t1_off_vs_t2_def': t1_kp.get('AdjOE', 100) - t2_kp.get('AdjDE', 100),
            'kp_t2_off_vs_t1_def': t2_kp.get('AdjOE', 100) - t1_kp.get('AdjDE', 100),
            'kp_t1_adjem': t1_kp.get('AdjEM', 0),
            'kp_t2_adjem': t2_kp.get('AdjEM', 0),
            'kp_rank_diff': t1_kp.get('RankAdjEM', 180) - t2_kp.get('RankAdjEM', 180),
        })
    else:
        features.update({
            'kp_adjoe_diff': 0, 'kp_adjde_diff': 0, 'kp_adjem_diff': 0,
            'kp_tempo_diff': 0, 'kp_t1_off_vs_t2_def': 0, 'kp_t2_off_vs_t1_def': 0,
            'kp_t1_adjem': 0, 'kp_t2_adjem': 0, 'kp_rank_diff': 0,
        })
    
    return features


# ============================================================
# STEP 5: BUILD TRAINING DATA (2003-2024)
# ============================================================
def build_training_data(reg, trn, seeds, elo_ratings, season_features_cache, kenpom_by_team):
    """Build training dataset from historical tournament games."""
    
    print("🔧 Building training data (2003-2024)...")
    
    rows = []
    
    for season in range(2003, 2025):
        season_trn = trn[trn['Season'] == season]
        season_seeds = seeds[seeds['Season'] == season]
        seed_map = dict(zip(season_seeds['TeamID'], 
                           season_seeds['Seed'].str.extract(r'(\d+)')[0].astype(int)))
        
        feat = season_features_cache.get(season, {})
        
        for _, g in season_trn.iterrows():
            w, l = g['WTeamID'], g['LTeamID']
            ws = seed_map.get(w, 8)
            ls = seed_map.get(l, 8)
            
            # Convention: T1 has lower TeamID
            if w < l:
                t1, t2 = w, l
                t1_seed, t2_seed = ws, ls
                target = 1  # T1 won
                margin = g['WScore'] - g['LScore']
            else:
                t1, t2 = l, w
                t1_seed, t2_seed = ls, ws
                target = 0  # T1 lost
                margin = g['LScore'] - g['WScore']
            
            t1_feat = feat.get(t1, {})
            t2_feat = feat.get(t2, {})
            t1_elo = elo_ratings.get(t1, 1500)
            t2_elo = elo_ratings.get(t2, 1500)
            
            # KenPom only for 2025 (we only have that year)
            t1_kp = kenpom_by_team.get(t1) if season == 2025 else None
            t2_kp = kenpom_by_team.get(t2) if season == 2025 else None
            
            matchup = build_matchup_features(t1_feat, t2_feat, t1_seed, t2_seed,
                                            t1_elo, t2_elo, t1_kp, t2_kp)
            matchup['target'] = target
            matchup['margin'] = margin
            matchup['season'] = season
            matchup['t1_id'] = t1
            matchup['t2_id'] = t2
            matchup['t1_seed_raw'] = t1_seed
            matchup['t2_seed_raw'] = t2_seed
            
            rows.append(matchup)
    
    df = pd.DataFrame(rows)
    print(f"   Training rows: {len(df)} ({df['season'].min()}-{df['season'].max()})")
    return df


# ============================================================
# STEP 6: GENERATE 2025 PREDICTIONS (PRE-TOURNAMENT)
# ============================================================
def generate_2025_predictions(reg, seeds, teams, elo_ratings, season_features_cache, 
                               kenpom_by_team, models, feature_cols):
    """Generate predictions for all 2025 tournament matchups."""
    
    print("\n🏀 Generating 2025 predictions (pre-tournament simulation)...")
    
    s25 = seeds[seeds['Season'] == 2025]
    seed_map = dict(zip(s25['TeamID'], s25['Seed'].str.extract(r'(\d+)')[0].astype(int)))
    seed_raw = dict(zip(s25['TeamID'], s25['Seed']))
    team_names = dict(zip(teams['TeamID'], teams['TeamName']))
    
    tourney_teams = list(s25['TeamID'].unique())
    feat_2025 = season_features_cache.get(2025, {})
    
    xgb_model, lgb_model, margin_model = models
    
    predictions = []
    
    # Generate prediction for every possible matchup (T1 < T2 convention)
    for t1, t2 in combinations(sorted(tourney_teams), 2):
        t1_seed = seed_map.get(t1, 8)
        t2_seed = seed_map.get(t2, 8)
        t1_feat = feat_2025.get(t1, {})
        t2_feat = feat_2025.get(t2, {})
        t1_elo = elo_ratings.get(t1, 1500)
        t2_elo = elo_ratings.get(t2, 1500)
        t1_kp = kenpom_by_team.get(t1)
        t2_kp = kenpom_by_team.get(t2)
        
        matchup = build_matchup_features(t1_feat, t2_feat, t1_seed, t2_seed,
                                        t1_elo, t2_elo, t1_kp, t2_kp)
        
        X = pd.DataFrame([matchup])[feature_cols]
        
        xgb_prob = float(xgb_model.predict_proba(X)[0][1])
        lgb_prob = float(lgb_model.predict_proba(X)[0][1])
        pred_margin = float(margin_model.predict(X)[0])
        
        # Ensemble
        model_prob = 0.45 * xgb_prob + 0.35 * lgb_prob + 0.20 * matchup['seed_implied_prob']
        
        # Determine confidence
        if abs(model_prob - 0.5) < 0.05:
            confidence = 'tossup'
        elif abs(model_prob - 0.5) < 0.12:
            confidence = 'slight'
        elif abs(model_prob - 0.5) < 0.22:
            confidence = 'lean'
        elif abs(model_prob - 0.5) < 0.35:
            confidence = 'confident'
        else:
            confidence = 'lock'
        
        # Upset detection
        favored_by_seed = t1_seed < t2_seed
        model_picks_t1 = model_prob > 0.5
        
        if t1_seed != t2_seed:
            if (favored_by_seed and not model_picks_t1) or (not favored_by_seed and model_picks_t1):
                upset_flag = 'upset'
            else:
                upset_flag = 'chalk'
        else:
            upset_flag = 'tossup'
        
        value_score = model_prob - matchup['seed_implied_prob']
        
        predicted_winner = team_names.get(t1, str(t1)) if model_prob > 0.5 else team_names.get(t2, str(t2))
        
        # Generate chatbot responses
        t1_name = team_names.get(t1, str(t1))
        t2_name = team_names.get(t2, str(t2))
        higher_seed_team = t1_name if t1_seed < t2_seed else t2_name
        lower_seed_team = t2_name if t1_seed < t2_seed else t1_name
        
        responses = generate_responses(t1_name, t2_name, t1_seed, t2_seed,
                                       model_prob, pred_margin, value_score,
                                       matchup, confidence, upset_flag, t1_kp, t2_kp)
        
        pred = {
            'season': 2025,
            't1_id': int(t1),
            't2_id': int(t2),
            't1_name': t1_name,
            't2_name': t2_name,
            't1_seed': int(t1_seed),
            't2_seed': int(t2_seed),
            'model_win_prob': round(model_prob, 6),
            'xgb_prob': round(xgb_prob, 6),
            'lgb_prob': round(lgb_prob, 6),
            'predicted_margin': round(pred_margin, 2),
            'value_score': round(value_score, 6),
            'seed_implied_prob': round(matchup['seed_implied_prob'], 4),
            'confidence': confidence,
            'upset_flag': upset_flag,
            'model_agrees_with_seed': (model_picks_t1 == favored_by_seed) if t1_seed != t2_seed else True,
            'predicted_winner_name': predicted_winner,
            'key_factors': {
                'elo_diff': round(matchup['elo_diff'], 1),
                't1_pyth': round(matchup['t1_pyth'], 4),
                't2_pyth': round(matchup['t2_pyth'], 4),
                't1_net_eff': round(matchup['t1_net_eff'], 2),
                't2_net_eff': round(matchup['t2_net_eff'], 2),
            },
            'kenpom': {
                't1_adjem': round(t1_kp['AdjEM'], 1) if t1_kp else 0,
                't2_adjem': round(t2_kp['AdjEM'], 1) if t2_kp else 0,
                't1_adjoe': round(t1_kp['AdjOE'], 1) if t1_kp else 0,
                't2_adjoe': round(t2_kp['AdjOE'], 1) if t2_kp else 0,
                't1_adjde': round(t1_kp['AdjDE'], 1) if t1_kp else 0,
                't2_adjde': round(t2_kp['AdjDE'], 1) if t2_kp else 0,
                'net_diff': round(t1_kp['AdjEM'] - t2_kp['AdjEM'], 1) if (t1_kp and t2_kp) else 0,
            },
            'responses': responses,
        }
        predictions.append(pred)
    
    print(f"   Generated {len(predictions)} matchup predictions")
    return predictions


def generate_responses(t1_name, t2_name, t1_seed, t2_seed, model_prob, 
                       pred_margin, value_score, matchup, confidence, upset_flag,
                       t1_kp, t2_kp):
    """Generate natural language chatbot responses."""
    
    winner = t1_name if model_prob > 0.5 else t2_name
    loser = t2_name if model_prob > 0.5 else t1_name
    prob_pct = max(model_prob, 1-model_prob) * 100
    
    # Quick take
    if confidence == 'lock':
        quick = f"{winner} is a strong pick here at {prob_pct:.0f}%. Not much to debate."
    elif confidence == 'confident':
        quick = f"Leaning {winner} at {prob_pct:.0f}%. Solid pick for most brackets."
    elif confidence in ('lean', 'slight'):
        quick = f"Leaning {winner} at {prob_pct:.0f}%, but {loser} has a real shot."
    else:
        quick = f"True toss-up. {winner} at {prob_pct:.0f}% by the slimmest margin."
    
    # Value assessment
    if abs(value_score) < 0.03:
        value = "Fair price — model and seed roughly agree here."
    elif value_score > 0.03:
        value = f"Value on {t1_name} — model sees them as underseeded by about {abs(value_score)*100:.0f}%."
    else:
        value = f"Value on {t2_name} — model sees them as underseeded by about {abs(value_score)*100:.0f}%."
    
    # Stats-based insight
    elo_str = f"Elo edge: {matchup['elo_diff']:+.0f}."
    if t1_kp and t2_kp:
        kp_str = f" KenPom: {t1_name} {t1_kp['AdjEM']:+.1f} vs {t2_name} {t2_kp['AdjEM']:+.1f}."
    else:
        kp_str = ""
    stats = f"{elo_str}{kp_str} Efficiency gap: {matchup['net_eff_diff']:+.1f}."
    
    # Upset insight
    if upset_flag == 'upset':
        upset_msg = f"🚨 Upset alert! Model likes {winner} despite the seed line. This is a contrarian pick worth considering."
    elif t1_seed == t2_seed:
        upset_msg = "Same seed — pick based on matchup, not seed."
    elif abs(t1_seed - t2_seed) <= 3:
        upset_msg = f"Close seed matchup. {loser} could pull this off, but {winner} has the edge."
    else:
        upset_msg = "Chalk should hold. No major upset indicators."
    
    # Bracket strategy
    if confidence in ('lock', 'confident'):
        bracket = f"Go with {winner} in all brackets. Save your upsets for better spots."
    elif upset_flag == 'upset':
        bracket = f"Pick {winner} in your contrarian bracket. Stick with chalk in safe brackets."
    else:
        bracket = f"Go with {winner} in most brackets. Not worth getting cute here."
    
    return {
        'quick': quick,
        'value': value,
        'stats': stats,
        'upset': upset_msg,
        'bracket': bracket,
    }


# ============================================================
# STEP 7: BACKTEST SCORING (INTERNAL ONLY)
# ============================================================
def score_backtest(predictions, trn, teams):
    """Score predictions against actual 2025 results. Internal use only."""
    
    print("\n📊 Scoring backtest against actual 2025 results...")
    
    t25 = trn[trn['Season'] == 2025]
    team_names = dict(zip(teams['TeamID'], teams['TeamName']))
    
    # Build lookup of actual results
    actual = {}
    for _, g in t25.iterrows():
        w, l = g['WTeamID'], g['LTeamID']
        t1, t2 = min(w, l), max(w, l)
        actual[(t1, t2)] = {
            'winner': w,
            'margin': g['WScore'] - g['LScore'],
            'w_score': g['WScore'],
            'l_score': g['LScore'],
        }
    
    correct = 0
    total = 0
    brier_sum = 0
    upsets_detected = 0
    upsets_total = 0
    results_detail = []
    
    for p in predictions:
        key = (p['t1_id'], p['t2_id'])
        if key not in actual:
            continue
        
        total += 1
        result = actual[key]
        t1_won = result['winner'] == p['t1_id']
        model_picks_t1 = p['model_win_prob'] > 0.5
        
        is_correct = model_picks_t1 == t1_won
        if is_correct:
            correct += 1
        
        actual_prob = 1.0 if t1_won else 0.0
        brier_sum += (p['model_win_prob'] - actual_prob) ** 2
        
        # Track upset detection
        if p['t1_seed'] != p['t2_seed']:
            # Did an upset actually happen?
            winner_seed = p['t1_seed'] if t1_won else p['t2_seed']
            loser_seed = p['t2_seed'] if t1_won else p['t1_seed']
            if winner_seed > loser_seed + 2:  # upset = won despite being 3+ seeds worse
                upsets_total += 1
                if p['upset_flag'] == 'upset':
                    upsets_detected += 1
        
        results_detail.append({
            'matchup': f"({p['t1_seed']}) {p['t1_name']} vs ({p['t2_seed']}) {p['t2_name']}",
            'prediction': p['predicted_winner_name'],
            'actual_winner': team_names.get(result['winner'], '?'),
            'correct': is_correct,
            'model_prob': p['model_win_prob'],
            'margin': result['margin'],
        })
    
    accuracy = correct / max(total, 1)
    brier = brier_sum / max(total, 1)
    
    print(f"\n   ✅ Accuracy: {correct}/{total} = {accuracy:.1%}")
    print(f"   📉 Brier Score: {brier:.4f} (lower is better, <0.20 is good)")
    print(f"   🔮 Upsets detected: {upsets_detected}/{upsets_total}")
    
    # Show wrong picks
    wrong = [r for r in results_detail if not r['correct']]
    if wrong:
        print(f"\n   ❌ Wrong picks ({len(wrong)}):")
        for r in wrong:
            print(f"      {r['matchup']} — picked {r['prediction']}, actual: {r['actual_winner']} (margin: {r['margin']})")
    
    # ESPN bracket scoring simulation
    espn_score = compute_espn_score(predictions, actual, team_names)
    
    return {
        'accuracy': round(accuracy, 4),
        'brier': round(brier, 4),
        'total_games': total,
        'correct': correct,
        'upsets_detected': upsets_detected,
        'upsets_total': upsets_total,
        'espn_score': espn_score,
        'wrong_picks': wrong,
    }


def compute_espn_score(predictions, actual, team_names):
    """Simulate ESPN bracket scoring: 10-20-40-80-160-320."""
    # ESPN scoring by round
    round_points = {64: 10, 32: 20, 16: 40, 8: 80, 4: 160, 2: 320}
    
    # For a proper bracket sim, we'd need to simulate the full bracket
    # For now, score just the actual games that were played
    total_points = 0
    max_points = 0
    
    for (t1, t2), result in actual.items():
        # Find prediction
        pred = None
        for p in predictions:
            if p['t1_id'] == t1 and p['t2_id'] == t2:
                pred = p
                break
        if not pred:
            continue
        
        # Rough round estimation based on number of games remaining
        # 32 R64 games, 16 R32 games, 8 S16, 4 E8, 2 FF, 1 NCG
        # We'll use a simplified version
        max_points += 10  # minimum
        
        t1_won = result['winner'] == t1
        model_picks_t1 = pred['model_win_prob'] > 0.5
        if model_picks_t1 == t1_won:
            total_points += 10
    
    return total_points


# ============================================================
# STEP 8: MAP KENPOM TO TEAM IDS
# ============================================================
def map_kenpom_to_ids(kenpom_df, teams_df):
    """Map KenPom team names to Kaggle TeamIDs."""
    
    # Name mapping for mismatches
    name_fixes = {
        "St. John's": "St John's",
        "St. Mary's": "St Mary's CA",
        "UConn": "Connecticut",
        "Ole Miss": "Mississippi",
        "Miami (FL)": "Miami FL",
        "NC State": "North Carolina St",
        "UNC": "North Carolina",
        "USC": "Southern California",
        "UNLV": "Nevada Las Vegas",
        "VCU": "VA Commonwealth",
        "UCF": "Central Florida",
        "BYU": "Brigham Young",
        "SMU": "Southern Methodist",
        "LSU": "Louisiana St",
        "UCSB": "UC Santa Barbara",
        "SIUE": "SIU Edwardsville",
        "UNC Greensboro": "NC Greensboro",
        "UNC Asheville": "NC A&T",
        "FDU": "Fairleigh Dickinson",
        "LIU": "Long Island University",
        "Saint Peter's": "St Peter's",
        "Saint Joseph's": "St Joseph's PA",
        "Saint Louis": "St Louis",
        "UMass": "Massachusetts",
        "UTEP": "Texas El Paso",
        "UTSA": "Texas San Antonio",
        "Michigan St.": "Michigan St",
        "Iowa St.": "Iowa St",
        "Ohio St.": "Ohio St",
        "Penn St.": "Penn St",
        "Oregon St.": "Oregon St",
        "Colorado St.": "Colorado St",
        "Boise St.": "Boise St",
        "Fresno St.": "Fresno St",
        "San Diego St.": "San Diego St",
        "Utah St.": "Utah St",
        "Mississippi St.": "Mississippi St",
        "Kansas St.": "Kansas St",
        "Wichita St.": "Wichita St",
        "Arizona St.": "Arizona St",
        "Murray St.": "Murray St",
        "Sacramento St.": "Sacramento St",
        "Kennesaw St.": "Kennesaw St",
        "Jacksonville St.": "Jacksonville St",
        "Morehead St.": "Morehead St",
        "Appalachian St.": "Appalachian St",
        "Georgia St.": "Georgia St",
        "Weber St.": "Weber St",
        "Portland St.": "Portland St",
        "Norfolk St.": "Norfolk St",
        "N.C. State": "North Carolina St",
        "Connecticut": "Connecticut",
        "Mount St. Mary's": "Mt St Mary's",
        "Loyola Chicago": "Loyola-Chicago",
        "Loyola MD": "Loyola MD",
        "Texas A&M": "Texas A&M",
        "McNeese": "McNeese St",
    }
    
    team_name_to_id = dict(zip(teams_df['TeamName'], teams_df['TeamID']))
    
    kp_by_team = {}
    matched = 0
    unmatched = []
    
    for _, row in kenpom_df.iterrows():
        name = row['TeamName']
        # Try direct match
        tid = team_name_to_id.get(name)
        # Try with fix
        if tid is None and name in name_fixes:
            tid = team_name_to_id.get(name_fixes[name])
        # Try removing trailing period/dot patterns
        if tid is None:
            clean = name.replace('.', '').strip()
            tid = team_name_to_id.get(clean)
        
        if tid is not None:
            kp_by_team[tid] = {
                'AdjOE': row.get('AdjOE', 0) or 0,
                'AdjDE': row.get('AdjDE', 0) or 0,
                'AdjEM': row.get('AdjEM', 0) or 0,
                'AdjTempo': row.get('AdjTempo', 0) or 0,
                'RankAdjEM': row.get('RankAdjEM', 999) or 999,
                'RankAdjOE': row.get('RankAdjOE', 999) or 999,
                'RankAdjDE': row.get('RankAdjDE', 999) or 999,
            }
            matched += 1
        else:
            if str(row.get('seed', '')).strip():
                unmatched.append(name)
    
    print(f"   KenPom mapped: {matched}/{len(kenpom_df)} teams")
    if unmatched:
        print(f"   ⚠️ Unmatched SEEDED teams: {unmatched}")
    
    return kp_by_team


# ============================================================
# MAIN
# ============================================================
def main():
    print("=" * 60)
    print("🏀 BRACKETGPT 2025 PREDICTION PIPELINE")
    print("   Training: 2003-2024 | Predicting: 2025 (pre-tournament)")
    print("=" * 60)
    
    # Load
    reg, trn, seeds, teams, coaches, kenpom, slots = load_data()
    
    # Map KenPom
    print("\n📊 Mapping KenPom data...")
    kenpom_by_team = map_kenpom_to_ids(kenpom, teams)
    
    # Build features for each season
    print("\n🔧 Building season features...")
    season_features = {}
    for season in range(2003, 2026):
        season_features[season] = build_season_features(reg, season)
        if season % 5 == 0 or season == 2025:
            print(f"   {season}: {len(season_features[season])} teams")
    
    # Compute Elo
    print("\n⚡ Computing Elo ratings through 2025...")
    elo = compute_elo(reg, 2025)
    
    # Show top 2025 teams by Elo
    s25 = seeds[seeds['Season'] == 2025]
    team_names = dict(zip(teams['TeamID'], teams['TeamName']))
    tourney_elos = [(team_names.get(tid, '?'), elo.get(tid, 1500)) 
                    for tid in s25['TeamID'].unique()]
    tourney_elos.sort(key=lambda x: -x[1])
    print("   Top 10 by Elo:")
    for name, e in tourney_elos[:10]:
        print(f"      {name:20s} {e:.0f}")
    
    # Training data (ONLY 2003-2024 — model never sees 2025 results)
    trn_train = trn[trn['Season'] < 2025]
    train_df = build_training_data(reg, trn_train, seeds, elo, season_features, kenpom_by_team)
    
    feature_cols = [c for c in train_df.columns if c not in 
                   ['target', 'margin', 'season', 't1_id', 't2_id', 't1_seed_raw', 't2_seed_raw']]
    
    X_train = train_df[feature_cols]
    y_class = train_df['target']
    y_margin = train_df['margin']
    
    # Train XGBoost classifier
    print("\n🎯 Training models...")
    xgb_model = xgb.XGBClassifier(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, reg_alpha=0.1, reg_lambda=1.0,
        random_state=42, eval_metric='logloss', use_label_encoder=False
    )
    xgb_model.fit(X_train, y_class, verbose=False)
    print(f"   ✅ XGBoost classifier trained ({len(feature_cols)} features)")
    
    # Train LightGBM classifier
    lgb_model = lgb.LGBMClassifier(
        n_estimators=300, max_depth=5, learning_rate=0.05,
        subsample=0.8, colsample_bytree=0.8, reg_alpha=0.1, reg_lambda=1.0,
        random_state=42, verbose=-1
    )
    lgb_model.fit(X_train, y_class)
    print(f"   ✅ LightGBM classifier trained")
    
    # Train margin predictor
    margin_model = xgb.XGBRegressor(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        random_state=42
    )
    margin_model.fit(X_train, y_margin, verbose=False)
    print(f"   ✅ Margin predictor trained")
    
    # Feature importance
    importances = pd.Series(xgb_model.feature_importances_, index=feature_cols).sort_values(ascending=False)
    print(f"\n   Top 10 features:")
    for feat, imp in importances.head(10).items():
        print(f"      {feat:25s} {imp:.3f}")
    
    # Generate 2025 predictions
    models = (xgb_model, lgb_model, margin_model)
    predictions = generate_2025_predictions(reg, seeds, teams, elo, season_features,
                                            kenpom_by_team, models, feature_cols)
    
    # Score against actuals (INTERNAL ONLY)
    scorecard = score_backtest(predictions, trn, teams)
    
    # Export chatbot JSON
    output = {
        'model_version': 'v4_bracketgpt_2025',
        'description': 'XGBoost + LightGBM ensemble with KenPom, Elo, efficiency metrics',
        'model_stats': {
            'avg_brier': scorecard['brier'],
            'features_count': len(feature_cols),
            'has_kenpom': True,
            'ensemble': 'XGBoost + LightGBM classifier + margin predictor → weighted ensemble',
        },
        'metrics': {
            '2025': {
                'accuracy': scorecard['accuracy'],
                'brier': scorecard['brier'],
            }
        },
        'predictions': predictions,
    }
    
    # Save
    out_path = '/home/claude/chatbot_predictions_base_2025.json'
    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"\n💾 Saved: {out_path}")
    print(f"   {len(predictions)} predictions for chatbot")
    
    # Save scorecard separately (internal)
    score_path = '/home/claude/backtest_scorecard_2025.json'
    with open(score_path, 'w') as f:
        json.dump(scorecard, f, indent=2, default=str)
    print(f"💾 Saved: {score_path}")
    
    return output, scorecard


if __name__ == '__main__':
    output, scorecard = main()
