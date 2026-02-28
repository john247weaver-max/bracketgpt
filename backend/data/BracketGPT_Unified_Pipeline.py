"""
BRACKETGPT UNIFIED PIPELINE — 2 STEPS, ALL OUTPUTS
====================================================
Combines model_v4 (stacked ensemble) + data pipeline (injuries/on-off)
into one Colab file that outputs every JSON the Railway server needs.

STEP 1: Train XGBoost + LightGBM + Leaf-Logistic → Meta-Learner
         Outputs: chatbot_predictions_base.json, team_profiles.json
STEP 2: Fetch player on/off (Barttorvik) + injuries (ESPN)
         Patches predictions + profiles with injury/depth data
         Outputs: chatbot_predictions_base.json (patched), team_profiles.json (patched)

FINAL OUTPUTS (upload to Railway backend/data/):
  ├── chatbot_predictions_base.json    ← main predictions + injury-adjusted
  ├── team_profiles.json               ← team stats + archetypes + on/off + injuries
  ├── bracket_2025.json                ← bracket structure (copy from your file)
  └── archetype_summary.json           ← archetype matchup matrix

HOW TO USE IN COLAB:
  1. Upload to Drive or Colab
  2. Cell 1: Mount Drive + install deps
  3. Cell 2: Configure paths
  4. Cell 3: RUN STEP 1 (model training + predictions)
  5. Cell 4: RUN STEP 2 (injuries + patching)
  6. Cell 5: Final summary + upload checklist

USAGE (single command):
  !pip install -q xgboost lightgbm statsmodels beautifulsoup4
  !python BracketGPT_Unified_Pipeline.py \\
    --data-dir "/content/drive/MyDrive/march madness/data" \\
    --kenpom-path "/content/drive/MyDrive/march madness/outputs/kenpom_master.csv" \\
    --output-dir "/content/drive/MyDrive/march madness/outputs" \\
    --backtest 2025
"""

import os, gc, json, warnings, argparse, time
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from datetime import datetime

import numpy as np
import pandas as pd
import requests

try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False
    print("⚠️ XGBoost not found. Install: pip install xgboost")

try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False
    print("⚠️ LightGBM not found. Using RF fallback.")

try:
    import statsmodels.api as sm
except ImportError:
    pass

from scipy.stats import norm
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import brier_score_loss, log_loss, accuracy_score
from sklearn.cluster import KMeans

warnings.filterwarnings("ignore")
np.random.seed(42)

HEADERS = {"User-Agent": "Mozilla/5.0 (BracketGPT/2.0 research)"}


# =============================================================================
# CONFIGURATION
# =============================================================================
class Config:
    DATA_DIR = Path("./data")
    OUTPUT_DIR = Path("./outputs")
    KENPOM_PATH = None
    MIN_SEASON = 2003
    BACKTEST_SEASON = 2025

    XGB_PARAMS = {
        'eval_metric': 'mae',
        'eta': 0.025,
        'subsample': 0.35,
        'colsample_bytree': 0.7,
        'num_parallel_tree': 10,
        'min_child_weight': 40,
        'max_depth': 4,
        'gamma': 10,
    }
    XGB_ROUNDS = 250

    ELO_BASE = 1000
    ELO_WIDTH = 400
    ELO_K = 100
    ELO_DECAY = 0.33

    SIGMA = 11.0
    ESPN_SCORING = {1: 10, 2: 20, 3: 40, 4: 80, 5: 160, 6: 320}

    SEED_WIN_RATES = {
        (1, 16): 0.993, (2, 15): 0.943, (3, 14): 0.851, (4, 13): 0.793,
        (5, 12): 0.649, (6, 11): 0.627, (7, 10): 0.609, (8, 9): 0.519,
        (1, 8): 0.794, (1, 9): 0.862, (2, 7): 0.667, (2, 10): 0.714,
        (3, 6): 0.571, (3, 11): 0.657, (4, 5): 0.545, (4, 12): 0.667,
        (1, 4): 0.714, (1, 5): 0.800, (2, 3): 0.545, (2, 6): 0.667,
        (1, 2): 0.556, (1, 3): 0.650,
    }

    # Barttorvik team name spellings for 2025 tournament
    TOURNAMENT_TEAMS = [
        "Duke", "Auburn", "Iowa St.", "Florida", "Tennessee", "Michigan St.",
        "Texas Tech", "Alabama", "Ole Miss", "Missouri", "Kentucky", "Arizona",
        "Oregon", "Clemson", "Kansas", "Virginia", "New Mexico", "McNeese",
        "San Diego St.", "Saint Mary's", "Vanderbilt", "Yale", "Baylor",
        "Illinois", "Georgia", "Mississippi St.", "Marquette", "North Carolina",
        "UCLA", "Michigan", "Colorado", "Louisville", "Purdue", "Oklahoma",
        "BYU", "Wake Forest", "Dayton", "Memphis", "Kansas St.", "Texas A&M",
        "Arkansas", "UConn", "St. John's", "Creighton", "Wisconsin", "Oregon St.",
        "VCU", "Nebraska", "Texas", "West Virginia", "Notre Dame", "Utah St.",
        "High Point", "Bryant", "Lipscomb", "Montana", "SIUE", "American",
        "Robert Morris", "Norfolk St.", "Wofford", "Omaha", "Stetson",
        "Longwood", "SIU Edwardsville", "Akron", "Stephen F. Austin",
    ]


# =============================================================================
# HELPERS
# =============================================================================
def prefix_rename(df: pd.DataFrame, prefix: str,
                  id_col: str = 'TeamID', keep_cols: list = None) -> pd.DataFrame:
    """Rename team-level df for T1/T2 merge. Bulletproof."""
    if keep_cols is None:
        keep_cols = ['Season']
    out = df.copy()
    rename_map = {}
    for c in out.columns:
        if c in keep_cols:
            continue
        elif c == id_col:
            rename_map[c] = f'{prefix}_TeamID'
        else:
            rename_map[c] = f'{prefix}_{c}'
    return out.rename(columns=rename_map)


class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, (np.integer,)):
            return int(obj)
        if isinstance(obj, (np.floating,)):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, (pd.Timestamp, datetime)):
            return obj.isoformat()
        return super().default(obj)


# =============================================================================
# ARCHETYPE SYSTEM
# =============================================================================
class ArchetypeEngine:
    ARCHETYPE_MAP = {
        ('Elite', 'Elite', 'Fast'): 'The Juggernaut',
        ('Elite', 'Elite', 'Slow'): 'The Fortress',
        ('Elite', 'Elite', 'Medium'): 'The Powerhouse',
        ('Elite', 'Good', 'Fast'): 'The Sharpshooter',
        ('Elite', 'Good', 'Slow'): 'The Sniper',
        ('Elite', 'Good', 'Medium'): 'The Sniper',
        ('Elite', 'Average', 'Fast'): 'The Gunslinger',
        ('Elite', 'Average', 'Slow'): 'The Gunslinger',
        ('Elite', 'Average', 'Medium'): 'The Gunslinger',
        ('Elite', 'Below Average', 'Fast'): 'The Glass Cannon',
        ('Elite', 'Below Average', 'Slow'): 'The Glass Cannon',
        ('Elite', 'Below Average', 'Medium'): 'The Glass Cannon',
        ('Elite', 'Weak', 'Fast'): 'The Glass Cannon',
        ('Elite', 'Weak', 'Slow'): 'The Glass Cannon',
        ('Elite', 'Weak', 'Medium'): 'The Glass Cannon',
        ('Good', 'Elite', 'Fast'): 'The Crusher',
        ('Good', 'Elite', 'Slow'): 'The Wall',
        ('Good', 'Elite', 'Medium'): 'The Wall',
        ('Average', 'Elite', 'Fast'): 'The Lockdown',
        ('Average', 'Elite', 'Slow'): 'The Lockdown',
        ('Average', 'Elite', 'Medium'): 'The Lockdown',
        ('Below Average', 'Elite', 'Fast'): 'The Grinder',
        ('Below Average', 'Elite', 'Slow'): 'The Grinder',
        ('Below Average', 'Elite', 'Medium'): 'The Grinder',
        ('Weak', 'Elite', 'Fast'): 'The Brick House',
        ('Weak', 'Elite', 'Slow'): 'The Brick House',
        ('Weak', 'Elite', 'Medium'): 'The Brick House',
        ('Good', 'Good', 'Fast'): 'The Balanced Threat',
        ('Good', 'Good', 'Slow'): 'The Fundamentals',
        ('Good', 'Good', 'Medium'): 'The All-Arounder',
        ('Good', 'Average', 'Fast'): 'The Run-and-Gun',
        ('Good', 'Average', 'Slow'): 'The Half-Court Hero',
        ('Good', 'Average', 'Medium'): 'The Scorer',
        ('Good', 'Below Average', 'Fast'): 'The Run-and-Gun',
        ('Good', 'Below Average', 'Slow'): 'The Half-Court Hero',
        ('Good', 'Below Average', 'Medium'): 'The Scorer',
        ('Good', 'Weak', 'Fast'): 'The Run-and-Gun',
        ('Good', 'Weak', 'Slow'): 'The Half-Court Hero',
        ('Good', 'Weak', 'Medium'): 'The Scorer',
        ('Average', 'Good', 'Fast'): 'The Pressure Cooker',
        ('Average', 'Good', 'Slow'): 'The Suffocator',
        ('Average', 'Good', 'Medium'): 'The Defender',
        ('Below Average', 'Good', 'Fast'): 'The Pressure Cooker',
        ('Below Average', 'Good', 'Slow'): 'The Suffocator',
        ('Below Average', 'Good', 'Medium'): 'The Defender',
        ('Weak', 'Good', 'Fast'): 'The Defense-First',
        ('Weak', 'Good', 'Slow'): 'The Defense-First',
        ('Weak', 'Good', 'Medium'): 'The Defense-First',
        ('Average', 'Average', 'Fast'): 'The Scrappy Squad',
        ('Average', 'Average', 'Slow'): 'The Plodder',
        ('Average', 'Average', 'Medium'): 'The Mid-Pack',
        ('Average', 'Below Average', 'Fast'): 'The Offensive Minded',
        ('Average', 'Below Average', 'Slow'): 'The Offensive Minded',
        ('Average', 'Below Average', 'Medium'): 'The Offensive Minded',
        ('Below Average', 'Average', 'Fast'): 'The Defensive Minded',
        ('Below Average', 'Average', 'Slow'): 'The Defensive Minded',
        ('Below Average', 'Average', 'Medium'): 'The Defensive Minded',
        ('Below Average', 'Below Average', 'Fast'): 'The Underdog',
        ('Below Average', 'Below Average', 'Slow'): 'The Underdog',
        ('Below Average', 'Below Average', 'Medium'): 'The Underdog',
    }

    ARCHETYPE_DESCRIPTIONS = {
        'The Juggernaut': 'Elite offense + Elite defense + Fast tempo. Historically dominant.',
        'The Fortress': 'Elite offense + Elite defense + Slow tempo. Grind you down.',
        'The Powerhouse': 'Elite on both ends, medium tempo. Complete team.',
        'The Sharpshooter': 'Elite offense + Good defense + Fast. Explosive.',
        'The Sniper': 'Elite offense + Good defense + Slow/Med. Methodical killer.',
        'The Gunslinger': 'Elite offense + Average defense. Live by the sword.',
        'The Glass Cannon': 'Elite offense + Weak defense. High ceiling, low floor.',
        'The Crusher': 'Good offense + Elite defense + Fast. Suffocating and athletic.',
        'The Wall': 'Good offense + Elite defense + Slow. Classic grinder.',
        'The Lockdown': 'Average offense + Elite defense. Defense wins championships?',
        'The Grinder': 'Below Avg offense + Elite defense. Ugly wins.',
        'The Brick House': 'Weak offense + Elite defense. Can only win low-scoring.',
        'The Balanced Threat': 'Good-Good + Fast. Dangerous and versatile.',
        'The Fundamentals': 'Good-Good + Slow. Sound basketball.',
        'The All-Arounder': 'Good-Good + Medium. No weaknesses, no dominance.',
        'The Run-and-Gun': 'Good offense + Fast. Fun to watch, can get exposed.',
        'The Half-Court Hero': 'Good offense + Slow. Half-court execution.',
        'The Scorer': 'Good offense + Medium. Offense-first identity.',
        'The Pressure Cooker': 'Average/BelowAvg offense + Good defense + Fast. Trapping.',
        'The Suffocator': 'Average offense + Good defense + Slow. Drains the clock.',
        'The Defender': 'Average offense + Good defense + Medium. Solid D identity.',
        'The Scrappy Squad': 'Average-Average + Fast. Hustle team.',
        'The Plodder': 'Average-Average + Slow. Nothing special.',
        'The Mid-Pack': 'Average-Average + Medium. Median team.',
        'The Offensive Minded': 'Average offense + Below Avg defense. Score to survive.',
        'The Defensive Minded': 'Below Avg offense + Average defense. Survive to score.',
        'The Underdog': 'Below Average on both ends. Cinderella needs magic.',
        'The Cinderella Hopeful': 'Weak on both ends. Maximum longshot.',
        'The Defense-First': 'Weak offense + Good defense. One-dimensional.',
        'The Offense-Only': 'Good+ offense + Weak defense. Shootout merchant.',
    }

    @staticmethod
    def get_tier(rank: float, thresholds: dict) -> str:
        if pd.isna(rank):
            return 'Average'
        if rank <= thresholds.get('elite', 25):
            return 'Elite'
        elif rank <= thresholds.get('good', 75):
            return 'Good'
        elif rank <= thresholds.get('average', 150):
            return 'Average'
        elif rank <= thresholds.get('below_avg', 250):
            return 'Below Average'
        return 'Weak'

    @staticmethod
    def get_tempo(rank: float) -> str:
        if pd.isna(rank):
            return 'Medium'
        if rank <= 100:
            return 'Fast'
        elif rank <= 250:
            return 'Medium'
        return 'Slow'

    @classmethod
    def assign_archetype(cls, row, oe_col='RankAdjOE', de_col='RankAdjDE',
                         tempo_col='RankAdjTempo') -> str:
        off_tier = cls.get_tier(row.get(oe_col, np.nan),
                                {'elite': 25, 'good': 75, 'average': 150, 'below_avg': 250})
        def_tier = cls.get_tier(row.get(de_col, np.nan),
                                {'elite': 25, 'good': 75, 'average': 150, 'below_avg': 250})
        tempo = cls.get_tempo(row.get(tempo_col, np.nan))
        key = (off_tier, def_tier, tempo)
        name = cls.ARCHETYPE_MAP.get(key)
        if name:
            return name
        if 'Weak' in [off_tier, def_tier]:
            if off_tier == 'Weak' and def_tier == 'Weak':
                return 'The Cinderella Hopeful'
            elif off_tier == 'Weak':
                return 'The Defense-First'
            else:
                return 'The Offense-Only'
        return 'The Unknown'

    @classmethod
    def assign_archetypes_to_df(cls, df, oe_col='RankAdjOE', de_col='RankAdjDE',
                                 tempo_col='RankAdjTempo'):
        out = df.copy()
        out['Off_Tier'] = out[oe_col].apply(
            lambda x: cls.get_tier(x, {'elite': 25, 'good': 75, 'average': 150, 'below_avg': 250}))
        out['Def_Tier'] = out[de_col].apply(
            lambda x: cls.get_tier(x, {'elite': 25, 'good': 75, 'average': 150, 'below_avg': 250}))
        out['Tempo_Style'] = out[tempo_col].apply(cls.get_tempo)
        out['Archetype'] = out.apply(
            lambda r: cls.assign_archetype(r, oe_col, de_col, tempo_col), axis=1)
        return out

    @staticmethod
    def build_matchup_matrix(tourney_df):
        matrix = defaultdict(lambda: {'wins': 0, 'total': 0})
        for _, row in tourney_df.iterrows():
            a1 = row.get('T1_Archetype', 'The Unknown')
            a2 = row.get('T2_Archetype', 'The Unknown')
            won = row.get('T1_won', 0)
            matrix[(a1, a2)]['total'] += 1
            matrix[(a1, a2)]['wins'] += int(won)
            matrix[(a2, a1)]['total'] += 1
            matrix[(a2, a1)]['wins'] += int(1 - won)
        result = {}
        for key, val in matrix.items():
            val['win_rate'] = val['wins'] / val['total'] if val['total'] > 0 else 0.5
            result[f"{key[0]}__vs__{key[1]}"] = val
        return result


# #############################################################################
#                        STEP 1: MODEL TRAINING + PREDICTIONS
# #############################################################################

# =============================================================================
# DATA LOADING
# =============================================================================
def load_data(data_dir: Path):
    print("📂 Loading Kaggle data...")
    t0 = time.time()
    data = {}
    for f in data_dir.glob("*.csv"):
        try:
            data[f.stem] = pd.read_csv(f)
        except Exception:
            pass

    M_regular = data.get('MRegularSeasonDetailedResults', pd.DataFrame())
    M_tourney = data.get('MNCAATourneyDetailedResults', pd.DataFrame())
    seeds = data.get('MNCAATourneySeeds', pd.DataFrame())
    teams = data.get('MTeams', pd.DataFrame())

    if not seeds.empty and 'Seed' in seeds.columns:
        seeds['SeedNum'] = seeds['Seed'].str.extract(r'(\d+)').astype(int)
        seeds['Region'] = seeds['Seed'].str.extract(r'([WXYZ])')

    print(f"   Regular season: {len(M_regular):,} games")
    print(f"   Tournament:     {len(M_tourney):,} games")
    print(f"   Seeds:          {len(seeds):,}")
    print(f"   Teams:          {len(teams):,}")
    print(f"   ⏱️ {time.time()-t0:.1f}s")
    return M_regular, M_tourney, seeds, teams


def load_kenpom(kenpom_path):
    if kenpom_path and Path(kenpom_path).exists():
        print(f"📊 Loading KenPom from {kenpom_path}")
        kp = pd.read_csv(kenpom_path)
        print(f"   KenPom: {len(kp)} team-seasons, {len(kp.columns)} columns")
        return kp
    print("ℹ️ No KenPom data — using box score features only.")
    return None


# =============================================================================
# FEATURE ENGINEERING
# =============================================================================
def compute_elo(regular, backtest_season):
    print("⚡ Computing Elo ratings...")
    elo = defaultdict(lambda: Config.ELO_BASE)
    season_elos = []

    seasons = sorted(regular['Season'].unique())
    for season in seasons:
        if season >= backtest_season:
            break
        for team in list(elo.keys()):
            elo[team] = Config.ELO_BASE + Config.ELO_DECAY * (elo[team] - Config.ELO_BASE)

        games = regular[regular['Season'] == season].sort_values('DayNum')
        for _, g in games.iterrows():
            w, l = g['WTeamID'], g['LTeamID']
            ew = 1.0 / (1.0 + 10 ** ((elo[l] - elo[w]) / Config.ELO_WIDTH))
            mov_mult = np.log(abs(g['WScore'] - g['LScore']) + 1)
            update = Config.ELO_K * mov_mult * (1 - ew)
            elo[w] += update
            elo[l] -= update

        for team, rating in elo.items():
            season_elos.append({'Season': season, 'TeamID': team, 'elo': rating})

    for team in list(elo.keys()):
        decayed = Config.ELO_BASE + Config.ELO_DECAY * (elo[team] - Config.ELO_BASE)
        season_elos.append({'Season': backtest_season, 'TeamID': team, 'elo': decayed})

    return pd.DataFrame(season_elos)


def compute_season_stats(regular):
    print("📊 Computing season stats...")
    records = []
    for (season, team), grp in regular.groupby(['Season', 'WTeamID']):
        records.append({
            'Season': season, 'TeamID': team,
            'W_games': len(grp), 'W_score': grp['WScore'].mean(),
            'W_fgm': grp['WFGM'].mean() if 'WFGM' in grp else 0,
            'W_fga': grp['WFGA'].mean() if 'WFGA' in grp else 0,
            'W_fgm3': grp['WFGM3'].mean() if 'WFGM3' in grp else 0,
            'W_fga3': grp['WFGA3'].mean() if 'WFGA3' in grp else 0,
            'W_ftm': grp['WFTM'].mean() if 'WFTM' in grp else 0,
            'W_fta': grp['WFTA'].mean() if 'WFTA' in grp else 0,
            'W_or': grp['WOR'].mean() if 'WOR' in grp else 0,
            'W_dr': grp['WDR'].mean() if 'WDR' in grp else 0,
            'W_ast': grp['WAst'].mean() if 'WAst' in grp else 0,
            'W_to': grp['WTO'].mean() if 'WTO' in grp else 0,
            'W_stl': grp['WStl'].mean() if 'WStl' in grp else 0,
            'W_blk': grp['WBlk'].mean() if 'WBlk' in grp else 0,
            'W_pf': grp['WPF'].mean() if 'WPF' in grp else 0,
            'opp_score': grp['LScore'].mean(),
        })
    for (season, team), grp in regular.groupby(['Season', 'LTeamID']):
        records.append({
            'Season': season, 'TeamID': team,
            'L_games': len(grp), 'L_score': grp['LScore'].mean(),
            'L_fgm': grp['LFGM'].mean() if 'LFGM' in grp else 0,
            'L_fga': grp['LFGA'].mean() if 'LFGA' in grp else 0,
            'L_fgm3': grp['LFGM3'].mean() if 'LFGM3' in grp else 0,
            'L_fga3': grp['LFGA3'].mean() if 'LFGA3' in grp else 0,
            'L_ftm': grp['LFTM'].mean() if 'LFTM' in grp else 0,
            'L_fta': grp['LFTA'].mean() if 'LFTA' in grp else 0,
            'L_or': grp['LOR'].mean() if 'LOR' in grp else 0,
            'L_dr': grp['LDR'].mean() if 'LDR' in grp else 0,
            'L_ast': grp['LAst'].mean() if 'LAst' in grp else 0,
            'L_to': grp['LTO'].mean() if 'LTO' in grp else 0,
            'L_stl': grp['LStl'].mean() if 'LStl' in grp else 0,
            'L_blk': grp['LBlk'].mean() if 'LBlk' in grp else 0,
            'L_pf': grp['LPF'].mean() if 'LPF' in grp else 0,
            'opp_score_L': grp['WScore'].mean(),
        })

    df = pd.DataFrame(records)
    agg = df.groupby(['Season', 'TeamID']).agg('mean').reset_index()

    agg['wins'] = agg.get('W_games', 0)
    agg['losses'] = agg.get('L_games', 0)
    total_games = agg['wins'] + agg['losses']
    agg['win_pct'] = np.where(total_games > 0, agg['wins'] / total_games, 0.5)

    ppg = agg.get('W_score', 70)
    opp_ppg = agg.get('opp_score', 70)
    agg['ppg'] = ppg
    agg['opp_ppg'] = opp_ppg
    agg['point_diff'] = ppg - opp_ppg

    agg['pyth'] = np.where(ppg + opp_ppg > 0, ppg**8 / (ppg**8 + opp_ppg**8), 0.5)

    fga = agg.get('W_fga', 50)
    fgm = agg.get('W_fgm', 20)
    fga3 = agg.get('W_fga3', 15)
    fgm3 = agg.get('W_fgm3', 5)
    fta = agg.get('W_fta', 15)
    ftm = agg.get('W_ftm', 10)
    to = agg.get('W_to', 12)
    oreb = agg.get('W_or', 10)
    dreb = agg.get('W_dr', 25)

    possessions = fga - oreb + to + 0.475 * fta
    agg['possessions'] = possessions
    agg['off_eff'] = np.where(possessions > 0, ppg / possessions * 100, 100)
    agg['def_eff'] = np.where(possessions > 0, opp_ppg / possessions * 100, 100)
    agg['net_eff'] = agg['off_eff'] - agg['def_eff']
    agg['efg_pct'] = np.where(fga > 0, (fgm + 0.5 * fgm3) / fga, 0.45)
    agg['to_rate'] = np.where(possessions > 0, to / possessions, 0.15)
    agg['ft_rate'] = np.where(fga > 0, fta / fga, 0.30)
    agg['oreb_pct'] = np.where(oreb + dreb > 0, oreb / (oreb + dreb), 0.30)
    agg['three_rate'] = np.where(fga > 0, fga3 / fga, 0.30)
    agg['ast_rate'] = agg.get('W_ast', 12)
    agg['blk_rate'] = agg.get('W_blk', 3)
    agg['stl_rate'] = agg.get('W_stl', 6)
    agg['tempo'] = possessions

    return agg


def build_matchup_features(tourney, team_stats, elo_df, seeds, kenpom, backtest_season):
    print("🔧 Building matchup features...")
    rows = []
    for _, g in tourney.iterrows():
        w, l = g['WTeamID'], g['LTeamID']
        t1, t2 = min(w, l), max(w, l)
        row = {
            'Season': g['Season'],
            'T1_TeamID': t1, 'T2_TeamID': t2,
            'PointDiff': g['WScore'] - g['LScore'] if t1 == w else g['LScore'] - g['WScore'],
            'T1_won': 1 if t1 == w else 0,
        }
        if 'DayNum' in g:
            row['DayNum'] = g['DayNum']
        rows.append(row)
    td = pd.DataFrame(rows)

    if 'DayNum' in td.columns:
        def infer_round(day):
            if pd.isna(day): return 0
            d = int(day)
            if d <= 135: return 1
            elif d <= 137: return 2
            elif d <= 139: return 3
            elif d <= 141: return 4
            elif d <= 143: return 5
            else: return 6
        td['Round'] = td['DayNum'].apply(infer_round)
    else:
        td['Round'] = 0

    # Merge seeds
    s1 = seeds[['Season', 'TeamID', 'SeedNum', 'Region']].rename(
        columns={'TeamID': 'T1_TeamID', 'SeedNum': 'T1_seed', 'Region': 'T1_region'})
    s2 = seeds[['Season', 'TeamID', 'SeedNum', 'Region']].rename(
        columns={'TeamID': 'T2_TeamID', 'SeedNum': 'T2_seed', 'Region': 'T2_region'})
    td = td.merge(s1, on=['Season', 'T1_TeamID'], how='left')
    td = td.merge(s2, on=['Season', 'T2_TeamID'], how='left')
    td['seed_diff'] = td['T1_seed'].fillna(8) - td['T2_seed'].fillna(8)

    # Merge team stats
    ts1 = prefix_rename(team_stats, 'T1')
    ts2 = prefix_rename(team_stats, 'T2')
    td = td.merge(ts1, on=['Season', 'T1_TeamID'], how='left')
    td = td.merge(ts2, on=['Season', 'T2_TeamID'], how='left')

    # Merge Elo
    e1 = elo_df.rename(columns={'TeamID': 'T1_TeamID', 'elo': 'T1_elo'})
    e2 = elo_df.rename(columns={'TeamID': 'T2_TeamID', 'elo': 'T2_elo'})
    td = td.merge(e1, on=['Season', 'T1_TeamID'], how='left')
    td = td.merge(e2, on=['Season', 'T2_TeamID'], how='left')
    td['elo_diff'] = td['T1_elo'].fillna(1000) - td['T2_elo'].fillna(1000)

    # Merge KenPom
    if kenpom is not None:
        kp_cols = [c for c in kenpom.columns if c not in ['Season', 'TeamID', 'TeamName']]
        kp = kenpom[['Season', 'TeamID'] + kp_cols].copy()
        kp1 = prefix_rename(kp, 'T1')
        kp2 = prefix_rename(kp, 'T2')
        td = td.merge(kp1, on=['Season', 'T1_TeamID'], how='left')
        td = td.merge(kp2, on=['Season', 'T2_TeamID'], how='left')

        for stat in ['KP_ORtg', 'KP_DRtg', 'KP_NetRtg', 'KP_AdjTempo']:
            c1, c2 = f'T1_{stat}', f'T2_{stat}'
            if c1 in td.columns and c2 in td.columns:
                td[f'{stat}_diff'] = td[c1].fillna(0) - td[c2].fillna(0)
        if 'T1_KP_ORtg' in td.columns and 'T2_KP_DRtg' in td.columns:
            td['T1_off_vs_T2_def'] = td['T1_KP_ORtg'].fillna(100) - td['T2_KP_DRtg'].fillna(100)
            td['T2_off_vs_T1_def'] = td['T2_KP_ORtg'].fillna(100) - td['T1_KP_DRtg'].fillna(100)
            td['matchup_edge'] = td['T1_off_vs_T2_def'] - td['T2_off_vs_T1_def']
        if 'T1_KP_AdjTempo' in td.columns and 'T2_KP_AdjTempo' in td.columns:
            td['tempo_mismatch'] = abs(td['T1_KP_AdjTempo'].fillna(67) - td['T2_KP_AdjTempo'].fillna(67))

    # Archetypes
    if kenpom is not None and 'RankAdjOE' in kenpom.columns:
        archetype_base = kenpom[['Season', 'TeamID']].copy()
        for col in ['RankAdjOE', 'RankAdjDE', 'RankAdjTempo']:
            archetype_base[col] = kenpom[col] if col in kenpom.columns else 150
    else:
        archetype_base = team_stats[['Season', 'TeamID']].copy()
        for col, stat in [('RankAdjOE', 'off_eff'), ('RankAdjDE', 'def_eff'), ('RankAdjTempo', 'tempo')]:
            if stat in team_stats.columns:
                ascending = (col == 'RankAdjDE')
                archetype_base[col] = team_stats.groupby('Season')[stat].rank(
                    ascending=ascending, method='min')
            else:
                archetype_base[col] = 150

    archetype_base = ArchetypeEngine.assign_archetypes_to_df(
        archetype_base, 'RankAdjOE', 'RankAdjDE', 'RankAdjTempo')

    a1 = archetype_base[['Season', 'TeamID', 'Archetype']].rename(
        columns={'TeamID': 'T1_TeamID', 'Archetype': 'T1_Archetype'})
    a2 = archetype_base[['Season', 'TeamID', 'Archetype']].rename(
        columns={'TeamID': 'T2_TeamID', 'Archetype': 'T2_Archetype'})
    td = td.merge(a1, on=['Season', 'T1_TeamID'], how='left')
    td = td.merge(a2, on=['Season', 'T2_TeamID'], how='left')
    td['T1_Archetype'] = td['T1_Archetype'].fillna('The Unknown')
    td['T2_Archetype'] = td['T2_Archetype'].fillna('The Unknown')

    train_mask = td['Season'] < backtest_season
    arch_matrix = ArchetypeEngine.build_matchup_matrix(td[train_mask])

    def get_arch_edge(row):
        key = f"{row['T1_Archetype']}__vs__{row['T2_Archetype']}"
        entry = arch_matrix.get(key, {'win_rate': 0.5, 'total': 0})
        return entry['win_rate'], entry['total']

    td['arch_matchup_wr'], td['arch_matchup_n'] = zip(*td.apply(get_arch_edge, axis=1))
    td['arch_matchup_edge'] = td['arch_matchup_wr'] - 0.5

    le = LabelEncoder()
    all_archetypes = pd.concat([td['T1_Archetype'], td['T2_Archetype']]).unique()
    le.fit(all_archetypes)
    td['T1_arch_encoded'] = le.transform(td['T1_Archetype'])
    td['T2_arch_encoded'] = le.transform(td['T2_Archetype'])

    def get_seed_prob(row):
        s1, s2 = int(row.get('T1_seed', 8)), int(row.get('T2_seed', 8))
        key = (min(s1, s2), max(s1, s2))
        base_prob = Config.SEED_WIN_RATES.get(key, 0.5)
        return base_prob if s1 <= s2 else 1 - base_prob

    td['seed_implied_prob'] = td.apply(get_seed_prob, axis=1)

    for stat in ['off_eff', 'def_eff', 'net_eff', 'efg_pct', 'to_rate', 'ft_rate',
                 'oreb_pct', 'three_rate', 'pyth', 'win_pct', 'point_diff', 'tempo']:
        c1, c2 = f'T1_{stat}', f'T2_{stat}'
        if c1 in td.columns and c2 in td.columns:
            td[f'{stat}_diff'] = td[c1].fillna(0) - td[c2].fillna(0)

    print(f"   Matchup features: {td.shape[1]} columns, {len(td)} matchups")
    return td, arch_matrix, le, archetype_base


# =============================================================================
# MODEL TRAINING — STACKED ENSEMBLE
# =============================================================================
def train_model(td, backtest_season):
    print(f"\n🧠 Training stacked ensemble (backtest={backtest_season})...")

    train = td[td['Season'] < backtest_season].copy()
    test = td[td['Season'] == backtest_season].copy()

    if len(test) == 0:
        print(f"⚠️ No test data for {backtest_season}. Using last available season.")
        last_season = train['Season'].max()
        test = train[train['Season'] == last_season].copy()
        train = train[train['Season'] < last_season].copy()

    exclude = {'Season', 'T1_TeamID', 'T2_TeamID', 'PointDiff', 'T1_won',
               'T1_Archetype', 'T2_Archetype', 'T1_region', 'T2_region',
               'T1_name', 'T2_name', 'DayNum'}
    features = [c for c in td.columns if c not in exclude
                and td[c].dtype in ['float64', 'int64', 'float32', 'int32']]
    print(f"   Features: {len(features)}")

    X_train = train[features].fillna(0)
    X_test = test[features].fillna(0)
    y_train_margin = train['PointDiff']
    y_train_binary = train['T1_won']
    y_test_binary = test['T1_won']

    # --- Model 1: XGBoost Margin Predictor ---
    print("   Training XGBoost margin predictor...")
    dtrain = xgb.DMatrix(X_train, label=y_train_margin)
    dtest = xgb.DMatrix(X_test, label=test['PointDiff'])
    xgb_model = xgb.train(Config.XGB_PARAMS, dtrain, Config.XGB_ROUNDS,
                           evals=[(dtest, 'test')], verbose_eval=False,
                           early_stopping_rounds=30)
    xgb_margin_pred = xgb_model.predict(dtest)
    xgb_prob = norm.cdf(xgb_margin_pred / Config.SIGMA)

    # --- Model 2: LightGBM / RF Classifier ---
    if HAS_LGB:
        print("   Training LightGBM classifier...")
        lgb_model = lgb.LGBMClassifier(
            n_estimators=300, max_depth=5, learning_rate=0.05,
            subsample=0.7, colsample_bytree=0.7, random_state=42, verbose=-1)
        lgb_model.fit(X_train, y_train_binary)
        lgb_prob = lgb_model.predict_proba(X_test)[:, 1]
    else:
        print("   Training RF classifier (LGB fallback)...")
        rf_model = RandomForestClassifier(n_estimators=300, max_depth=8, random_state=42)
        rf_model.fit(X_train, y_train_binary)
        lgb_prob = rf_model.predict_proba(X_test)[:, 1]

    # --- Model 3: XGB Leaf → Logistic ---
    print("   Training leaf-logistic model...")
    dtrain_full = xgb.DMatrix(X_train)
    dtest_full = xgb.DMatrix(X_test)
    leaves_train = xgb_model.predict(dtrain_full, pred_leaf=True)
    leaves_test = xgb_model.predict(dtest_full, pred_leaf=True)
    leaf_str_train = [' '.join(map(str, row)) for row in leaves_train]
    leaf_str_test = [' '.join(map(str, row)) for row in leaves_test]
    tfidf = TfidfVectorizer(max_features=500)
    X_leaf_train = tfidf.fit_transform(leaf_str_train)
    X_leaf_test = tfidf.transform(leaf_str_test)
    leaf_lr = LogisticRegression(max_iter=1000, C=1.0)
    leaf_lr.fit(X_leaf_train, y_train_binary)
    leaf_prob = leaf_lr.predict_proba(X_leaf_test)[:, 1]

    # --- Meta-Learner ---
    print("   Training meta-learner...")
    base_model_2 = lgb_model if HAS_LGB else rf_model
    meta_train_preds = np.column_stack([
        norm.cdf(xgb_model.predict(dtrain) / Config.SIGMA),
        base_model_2.predict_proba(X_train)[:, 1],
        leaf_lr.predict_proba(X_leaf_train)[:, 1],
    ])
    meta_test_preds = np.column_stack([xgb_prob, lgb_prob, leaf_prob])

    meta_lr = LogisticRegression(max_iter=500)
    meta_lr.fit(meta_train_preds, y_train_binary)
    final_prob = meta_lr.predict_proba(meta_test_preds)[:, 1]

    # --- Evaluate ---
    print(f"\n📈 BACKTEST RESULTS ({backtest_season}):")
    print(f"   {'Model':<25} {'Brier':>8} {'Accuracy':>10} {'LogLoss':>10}")
    print(f"   {'-'*55}")
    for name, prob in [('XGBoost Margin', xgb_prob), ('LightGBM/RF', lgb_prob),
                        ('Leaf-Logistic', leaf_prob), ('⭐ STACKED ENSEMBLE', final_prob)]:
        brier = brier_score_loss(y_test_binary, prob)
        acc = accuracy_score(y_test_binary, (prob > 0.5).astype(int))
        ll = log_loss(y_test_binary, np.clip(prob, 0.01, 0.99))
        print(f"   {name:<25} {brier:>8.4f} {acc:>9.1%} {ll:>10.4f}")

    test = test.copy()
    test['model_prob'] = final_prob
    test['predicted_margin'] = xgb_margin_pred
    test['value_score'] = final_prob - test['seed_implied_prob']

    return {
        'test_data': test,
        'features': features,
        'xgb_model': xgb_model,
        'meta_lr': meta_lr,
        'final_prob': final_prob,
        'brier': brier_score_loss(y_test_binary, final_prob),
        'accuracy': accuracy_score(y_test_binary, (final_prob > 0.5).astype(int)),
    }


# =============================================================================
# CHATBOT JSON + TEAM PROFILES EXPORT (STEP 1 OUTPUT)
# =============================================================================
def get_confidence_tier(prob):
    p = max(prob, 1 - prob)
    if p >= 0.85: return 'LOCK'
    elif p >= 0.72: return 'STRONG'
    elif p >= 0.60: return 'LEAN'
    elif p >= 0.52: return 'TOSS-UP'
    return 'COIN FLIP'


def get_upset_flag(s1, s2, prob):
    favorite_seed = min(s1, s2)
    underdog_seed = max(s1, s2)
    favorite_prob = prob if s1 < s2 else 1 - prob
    if favorite_prob < 0.50:
        return f'🚨 UPSET ALERT: {underdog_seed}-seed favored!'
    elif favorite_prob < 0.60:
        return f'⚠️ UPSET WATCH: {underdog_seed}-seed has a real shot'
    elif underdog_seed - favorite_seed >= 4 and favorite_prob < 0.70:
        return f'👀 SLEEPER: {underdog_seed}-seed dangerous'
    return 'chalk'


def generate_chatbot_responses(entry, arch_matrix):
    t1 = entry.get('t1_name', 'Team 1')
    t2 = entry.get('t2_name', 'Team 2')
    s1 = entry.get('t1_seed', 0)
    s2 = entry.get('t2_seed', 0)
    prob = entry.get('model_win_prob', 0.5)
    margin = entry.get('predicted_margin', 0)
    value = entry.get('value_score', 0)
    a1 = entry.get('archetype_matchup', {}).get('t1_arch', 'Unknown')
    a2 = entry.get('archetype_matchup', {}).get('t2_arch', 'Unknown')

    fav = t1 if prob > 0.5 else t2
    fav_prob = max(prob, 1 - prob)
    fav_seed = s1 if prob > 0.5 else s2
    arch_key = f"{a1}__vs__{a2}"
    arch_info = arch_matrix.get(arch_key, {'win_rate': 0.5, 'total': 0})

    return {
        'quick': f"Lean {fav} ({fav_seed}-seed) at {fav_prob:.0%}. "
                 f"{'Chalk.' if abs(s1 - s2) >= 4 and fav_seed == min(s1, s2) else 'Competitive.'}",
        'value': (f"VALUE PICK: {'+' if value > 0 else ''}{value:.0%} edge over chalk. "
                  if abs(value) > 0.05 else "Consensus pick — model agrees with seed."),
        'stats': (f"{t1} ({a1}): Elo {entry.get('key_factors', {}).get('t1_elo', 'N/A')}, "
                  f"Pyth {entry.get('key_factors', {}).get('t1_pyth', 'N/A'):.3f} | "
                  f"{t2} ({a2}): Elo {entry.get('key_factors', {}).get('t2_elo', 'N/A')}, "
                  f"Pyth {entry.get('key_factors', {}).get('t2_pyth', 'N/A'):.3f}"),
        'upset': get_upset_flag(s1, s2, prob) if get_upset_flag(s1, s2, prob) != 'chalk' else 'Chalk should hold here.',
        'archetype': (f"{a1} vs {a2}: Historically {arch_info['win_rate']:.0%} win rate "
                      f"for the {a1} type ({arch_info['total']} matchups)."
                      if arch_info['total'] >= 3 else
                      f"{a1} vs {a2}: Limited historical matchup data."),
    }


def export_step1_json(result, teams, arch_matrix, archetype_base, team_stats, kenpom, output_dir):
    """Export chatbot_predictions_base.json and team_profiles.json from Step 1."""
    print("\n💾 STEP 1 EXPORT: Predictions + Team Profiles...")
    output_dir.mkdir(parents=True, exist_ok=True)

    preds = result['test_data'].copy()

    # Merge team names
    if not teams.empty:
        t1_names = teams.rename(columns={'TeamID': 'T1_TeamID', 'TeamName': 'T1_name'})
        t2_names = teams.rename(columns={'TeamID': 'T2_TeamID', 'TeamName': 'T2_name'})
        preds = preds.merge(t1_names[['T1_TeamID', 'T1_name']], on='T1_TeamID', how='left')
        preds = preds.merge(t2_names[['T2_TeamID', 'T2_name']], on='T2_TeamID', how='left')

    # --- chatbot_predictions_base.json ---
    chatbot_data = {
        'model_version': 'v5_unified_pipeline',
        'generated_at': datetime.now().isoformat(),
        'backtest_season': int(preds['Season'].iloc[0]) if len(preds) > 0 else 0,
        'model_accuracy': float(result['accuracy']),
        'model_brier': float(result['brier']),
        'features_used': result['features'],
        'archetype_matchup_matrix': {k: {kk: float(vv) if isinstance(vv, (float, np.floating)) else vv
                                          for kk, vv in v.items()}
                                     for k, v in arch_matrix.items()},
        'espn_scoring': Config.ESPN_SCORING,
        'predictions': [],
    }

    for _, row in preds.iterrows():
        t1_seed = int(row.get('T1_seed', 0))
        t2_seed = int(row.get('T2_seed', 0))
        model_prob = float(row.get('model_prob', 0.5))

        pred_entry = {
            'season': int(row['Season']),
            't1_id': int(row['T1_TeamID']),
            't2_id': int(row['T2_TeamID']),
            't1_name': str(row.get('T1_name', 'Unknown')),
            't2_name': str(row.get('T2_name', 'Unknown')),
            't1_seed': t1_seed,
            't2_seed': t2_seed,
            't1_archetype': str(row.get('T1_Archetype', 'Unknown')),
            't2_archetype': str(row.get('T2_Archetype', 'Unknown')),
            'model_win_prob': model_prob,
            'predicted_margin': float(row.get('predicted_margin', 0)),
            'value_score': float(row.get('value_score', 0)),
            'seed_implied_prob': float(row.get('seed_implied_prob', 0.5)),
            'actual_margin': float(row.get('PointDiff', 0)),
            'actual_winner': 't1' if row.get('PointDiff', 0) > 0 else 't2',
            'confidence': get_confidence_tier(model_prob),
            'upset_flag': get_upset_flag(t1_seed, t2_seed, model_prob),
            'model_agrees_with_seed': bool((model_prob > 0.5) == (t1_seed < t2_seed)),
            'predicted_winner_name': str(row.get('T1_name', 'Unknown')) if model_prob > 0.5 else str(row.get('T2_name', 'Unknown')),
            'predicted_winner_seed': t1_seed if model_prob > 0.5 else t2_seed,
            'archetype_matchup': {
                't1_arch': str(row.get('T1_Archetype', 'Unknown')),
                't2_arch': str(row.get('T2_Archetype', 'Unknown')),
                'historical_wr': float(row.get('arch_matchup_wr', 0.5)),
                'historical_n': int(row.get('arch_matchup_n', 0)),
                'arch_edge': float(row.get('arch_matchup_edge', 0)),
            },
            'key_factors': {
                'elo_diff': float(row.get('elo_diff', 0)),
                't1_elo': float(row.get('T1_elo', 1000)),
                't2_elo': float(row.get('T2_elo', 1000)),
                't1_pyth': float(row.get('T1_pyth', 0.5)),
                't2_pyth': float(row.get('T2_pyth', 0.5)),
                't1_off_eff': float(row.get('T1_off_eff', 100)),
                't2_off_eff': float(row.get('T2_off_eff', 100)),
                't1_def_eff': float(row.get('T1_def_eff', 100)),
                't2_def_eff': float(row.get('T2_def_eff', 100)),
                't1_net_eff': float(row.get('T1_net_eff', 0)),
                't2_net_eff': float(row.get('T2_net_eff', 0)),
                't1_efg': float(row.get('T1_efg_pct', 0.45)),
                't2_efg': float(row.get('T2_efg_pct', 0.45)),
                't1_to_rate': float(row.get('T1_to_rate', 0.15)),
                't2_to_rate': float(row.get('T2_to_rate', 0.15)),
            },
            'kenpom': {
                't1_ortg': float(row.get('T1_KP_ORtg', 0)),
                't2_ortg': float(row.get('T2_KP_ORtg', 0)),
                't1_drtg': float(row.get('T1_KP_DRtg', 0)),
                't2_drtg': float(row.get('T2_KP_DRtg', 0)),
                't1_net': float(row.get('T1_KP_NetRtg', 0)),
                't2_net': float(row.get('T2_KP_NetRtg', 0)),
                't1_tempo': float(row.get('T1_KP_AdjTempo', 0)),
                't2_tempo': float(row.get('T2_KP_AdjTempo', 0)),
                'matchup_edge': float(row.get('matchup_edge', 0)),
                'tempo_mismatch': float(row.get('tempo_mismatch', 0)),
            },
        }
        pred_entry['responses'] = generate_chatbot_responses(pred_entry, arch_matrix)
        chatbot_data['predictions'].append(pred_entry)

    pred_path = output_dir / 'chatbot_predictions_base.json'
    with open(pred_path, 'w') as f:
        json.dump(chatbot_data, f, indent=2, cls=NumpyEncoder)

    preds.to_csv(output_dir / 'full_predictions.csv', index=False)

    # --- team_profiles.json ---
    season = Config.BACKTEST_SEASON
    season_stats = team_stats[team_stats['Season'] == season].copy() if season in team_stats['Season'].values else team_stats[team_stats['Season'] == team_stats['Season'].max()].copy()
    season_archetypes = archetype_base[archetype_base['Season'] == season].copy() if season in archetype_base['Season'].values else archetype_base[archetype_base['Season'] == archetype_base['Season'].max()].copy()

    profiles = []
    for _, row in season_stats.iterrows():
        team_id = int(row['TeamID'])
        team_name = 'Unknown'
        if not teams.empty:
            match = teams[teams['TeamID'] == team_id]
            if len(match) > 0:
                team_name = match.iloc[0]['TeamName']

        # Get archetype
        arch_row = season_archetypes[season_archetypes['TeamID'] == team_id]
        archetype = str(arch_row['Archetype'].iloc[0]) if len(arch_row) > 0 else 'The Unknown'

        # Get KenPom stats
        kp_stats = {}
        if kenpom is not None:
            kp_row = kenpom[(kenpom['Season'] == season) & (kenpom['TeamID'] == team_id)]
            if len(kp_row) > 0:
                kp_row = kp_row.iloc[0]
                for col in kenpom.columns:
                    if col not in ['Season', 'TeamID', 'TeamName']:
                        val = kp_row[col]
                        kp_stats[col] = float(val) if pd.notna(val) else 0

        profile = {
            'team_id': team_id,
            'name': team_name,
            'season': int(season),
            'archetype': archetype,
            'archetype_description': ArchetypeEngine.ARCHETYPE_DESCRIPTIONS.get(archetype, ''),
            'stats': {
                'win_pct': float(row.get('win_pct', 0.5)),
                'ppg': float(row.get('ppg', 70)),
                'opp_ppg': float(row.get('opp_ppg', 70)),
                'point_diff': float(row.get('point_diff', 0)),
                'pyth': float(row.get('pyth', 0.5)),
                'off_eff': float(row.get('off_eff', 100)),
                'def_eff': float(row.get('def_eff', 100)),
                'net_eff': float(row.get('net_eff', 0)),
                'efg_pct': float(row.get('efg_pct', 0.45)),
                'to_rate': float(row.get('to_rate', 0.15)),
                'ft_rate': float(row.get('ft_rate', 0.30)),
                'oreb_pct': float(row.get('oreb_pct', 0.30)),
                'three_rate': float(row.get('three_rate', 0.30)),
                'tempo': float(row.get('tempo', 65)),
            },
            'kenpom': kp_stats,
        }
        profiles.append(profile)

    profiles_data = {
        'description': f'Team profiles for {season} season — auto-generated by BracketGPT pipeline',
        'generated_at': datetime.now().isoformat(),
        'season': int(season),
        'profiles': profiles,
    }

    profiles_path = output_dir / 'team_profiles.json'
    with open(profiles_path, 'w') as f:
        json.dump(profiles_data, f, indent=2, cls=NumpyEncoder)

    # --- archetype_summary.json ---
    arch_summary = {
        'archetype_descriptions': ArchetypeEngine.ARCHETYPE_DESCRIPTIONS,
        'matchup_matrix': {k: v for k, v in arch_matrix.items() if v.get('total', 0) >= 3},
    }
    arch_path = output_dir / 'archetype_summary.json'
    with open(arch_path, 'w') as f:
        json.dump(arch_summary, f, indent=2, cls=NumpyEncoder)

    upsets = sum(1 for p in chatbot_data['predictions'] if p['upset_flag'] != 'chalk')
    print(f"   ✅ {len(chatbot_data['predictions'])} predictions → {pred_path.name}")
    print(f"   ✅ {len(profiles)} team profiles → {profiles_path.name}")
    print(f"   ✅ Archetype summary → {arch_path.name}")
    print(f"   ✅ Upset alerts: {upsets}")

    return chatbot_data, profiles_data


# #############################################################################
#                        STEP 2: INJURIES + ON/OFF PATCHING
# #############################################################################

def fetch_player_stats(year):
    """Pull player stats from Barttorvik for BPM-based on/off proxies."""
    url = f"https://barttorvik.com/playerstat.php?year={year}&json=1"
    print(f"   Fetching player stats ({year}) from Barttorvik...")

    try:
        resp = requests.get(url, headers=HEADERS, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"   ⚠️ Barttorvik fetch failed: {e}")
        print("   → Using empty player data. On/off features will be skipped.")
        return pd.DataFrame(), pd.DataFrame()

    columns = [
        "player", "team", "conf", "gp", "min_pct", "ortg", "usg",
        "efg", "ts_pct", "orb_pct", "drb_pct", "ast_pct", "to_pct",
        "blk_pct", "stl_pct", "ftr", "three_par", "yr", "ht", "num",
        "porpag", "adjoe", "pfr", "year", "rec_rank", "ast_tov",
        "rim_fg_pct", "mid_fg_pct", "dunks", "close_2", "far_2",
        "three_att", "dunk_att", "sos", "bpm", "obpm", "dbpm", "gbpm",
        "mpg", "ppg", "apg", "rpg",
    ]
    n = len(data[0]) if data else len(columns)
    df = pd.DataFrame(data, columns=columns[:n])
    df["year"] = year

    for col in ["bpm", "obpm", "dbpm", "min_pct", "usg", "ppg", "mpg", "ortg"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    # Compute weighted BPM + team dependency
    df["weighted_bpm"] = df["bpm"] * (df["min_pct"] / 100)

    team_rows = []
    for team, grp in df.groupby("team"):
        s = grp.sort_values("weighted_bpm", ascending=False)
        pos = s[s["weighted_bpm"] > 0]
        total = pos["weighted_bpm"].sum()
        top1 = float(s["weighted_bpm"].iloc[0]) if len(s) > 0 else 0
        top2 = float(s["weighted_bpm"].iloc[:2].sum()) if len(s) > 1 else top1

        team_rows.append({
            "team": team,
            "team_total_bpm": round(total, 3),
            "star_player": s["player"].iloc[0] if len(s) > 0 else "",
            "star_player_bpm": round(top1, 3),
            "star_player_usg": round(float(s["usg"].iloc[0]), 1) if len(s) > 0 else 0,
            "star_player_ppg": round(float(s["ppg"].iloc[0]), 1) if len(s) > 0 else 0,
            "star_dependency_pct": round((top1 / total * 100) if total > 0 else 50, 1),
            "top2_dependency_pct": round((top2 / total * 100) if total > 0 else 50, 1),
        })

    team_dep = pd.DataFrame(team_rows)
    df = df.merge(team_dep, on="team", how="left")
    print(f"   → {len(df):,} players, {len(team_dep)} teams loaded")
    return df, team_dep


def fetch_injuries_espn():
    """Fetch current injuries from ESPN's unofficial API."""
    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/injuries"
    print("   Fetching injuries from ESPN...")
    records = []

    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        for team_entry in data.get("injuries", []):
            team_name = team_entry.get("team", {}).get("displayName", "")
            team_abbr = team_entry.get("team", {}).get("abbreviation", "")
            for inj in team_entry.get("injuries", []):
                ath = inj.get("athlete", {})
                details = inj.get("details", {})
                records.append({
                    "team_espn": team_name,
                    "team_abbr": team_abbr,
                    "player": ath.get("displayName", ""),
                    "position": ath.get("position", {}).get("abbreviation", ""),
                    "injury_status": inj.get("status", ""),
                    "injury_type": details.get("type", ""),
                    "injury_detail": details.get("detail", ""),
                    "return_date": details.get("returnDate", ""),
                    "short_comment": inj.get("shortComment", ""),
                })
    except Exception as e:
        print(f"   ⚠️ ESPN API failed: {e}")
        print("   → Continuing with empty injury data.")

    cols = ["team_espn", "team_abbr", "player", "position", "injury_status",
            "injury_type", "injury_detail", "return_date", "short_comment"]
    df = pd.DataFrame(records) if records else pd.DataFrame(columns=cols)
    severity_map = {"Out": 3, "Doubtful": 2, "Questionable": 2, "Day-To-Day": 1, "GTD": 1}
    df["severity"] = df["injury_status"].map(severity_map).fillna(1).astype(int)

    print(f"   → {len(df)} injured players found")
    return df


def merge_injury_impact(player_df, injury_df):
    df = player_df.copy()
    df["player_norm"] = df["player"].str.lower().str.strip()

    if not injury_df.empty:
        inj = injury_df.copy()
        inj["player_norm"] = inj["player"].str.lower().str.strip()
        df = df.merge(
            inj[["player_norm", "injury_status", "severity", "injury_type"]],
            on="player_norm", how="left"
        )
    else:
        df["injury_status"] = ""
        df["severity"] = 0
        df["injury_type"] = ""

    df["is_injured"] = df["severity"].notna() & (df["severity"] > 0)
    df["injury_severity"] = df["severity"].fillna(0).astype(int)
    df["injury_status"] = df["injury_status"].fillna("")

    sev_weight = {3: 1.0, 2: 0.5, 1: 0.2, 0: 0.0}
    df["injury_bpm_impact"] = df.apply(
        lambda r: round(r["weighted_bpm"] * sev_weight.get(r["injury_severity"], 0), 4)
        if r["is_injured"] else 0.0, axis=1
    )
    return df


def build_team_summary(merged, tournament_teams):
    records = []
    for team, grp in merged.groupby("team"):
        injured = grp[grp["is_injured"] == True]
        top = grp.sort_values("weighted_bpm", ascending=False)
        star = top.iloc[0] if len(top) > 0 else None
        star_injured = bool(star is not None and star["is_injured"])

        records.append({
            "team": team,
            "star_player": str(grp["star_player"].iloc[0]) if "star_player" in grp.columns else "",
            "star_player_bpm": float(grp["star_player_bpm"].iloc[0]) if "star_player_bpm" in grp.columns else 0,
            "star_player_usg": float(grp["star_player_usg"].iloc[0]) if "star_player_usg" in grp.columns else 0,
            "star_player_ppg": float(grp["star_player_ppg"].iloc[0]) if "star_player_ppg" in grp.columns else 0,
            "star_dependency_pct": float(grp["star_dependency_pct"].iloc[0]) if "star_dependency_pct" in grp.columns else 50,
            "top2_dependency_pct": float(grp["top2_dependency_pct"].iloc[0]) if "top2_dependency_pct" in grp.columns else 50,
            "team_total_bpm": float(grp["team_total_bpm"].iloc[0]) if "team_total_bpm" in grp.columns else 0,
            "star_is_injured": star_injured,
            "n_injured": len(injured),
            "n_out": len(injured[injured["injury_severity"] == 3]),
            "n_questionable": len(injured[injured["injury_severity"] == 2]),
            "team_total_injury_bpm": round(float(injured["injury_bpm_impact"].sum()), 4),
            "star_injury_bpm": round(float(
                injured[injured["player"] == (str(star["player"]) if star is not None else "")
                        ]["injury_bpm_impact"].sum()), 4) if star_injured else 0.0,
            "injured_players_list": ", ".join(injured["player"].tolist()),
            "injured_statuses": ", ".join(
                f"{r['player']} ({r['injury_status']})" for _, r in injured.iterrows()),
        })

    df = pd.DataFrame(records)
    df["upset_vulnerability"] = (
        (df["star_dependency_pct"] * 0.4) +
        (df["team_total_injury_bpm"] * 10).clip(0, 30) +
        (df["star_is_injured"].astype(int) * 30)
    ).clip(0, 100).round(1)

    return df[df["team"].isin(tournament_teams)].copy().reset_index(drop=True)


def compute_injury_adj(row):
    if row is None:
        return 0.0
    adj = 0.0
    if row.get("star_is_injured", False):
        dep = float(row.get("star_dependency_pct", 50)) / 100
        bpm = float(row.get("star_player_bpm", 0))
        bpm_factor = min(bpm / 4.0, 1.0)
        scale = 0.12 if dep >= 0.50 else 0.07
        adj -= scale * bpm_factor * dep
    total_inj = float(row.get("team_total_injury_bpm", 0))
    total_bpm = float(row.get("team_total_bpm", 1)) or 1
    adj -= 0.08 * min(total_inj / total_bpm, 0.5)
    return round(float(np.clip(adj, -0.15, 0.0)), 4)


def get_confidence(prob):
    p = max(prob, 1 - prob)
    if p >= 0.85: return "lock"
    elif p >= 0.72: return "strong"
    elif p >= 0.60: return "lean"
    elif p >= 0.52: return "toss-up"
    return "coin-flip"


def compute_upset_flag_v2(s1, s2, prob, t1_ctx, t2_ctx):
    gap = abs(int(s1) - int(s2))
    fav_prob = prob if int(s1) <= int(s2) else 1 - prob
    dog = max(int(s1), int(s2))
    if t2_ctx.get("star_is_injured") and gap >= 3:
        return f"🚨 INJURY UPSET: {t2_ctx.get('team','')} missing {t2_ctx.get('star_player','star')}"
    if t1_ctx.get("star_is_injured") and gap >= 3:
        return f"⚠️ INJURY RISK: {t1_ctx.get('team','')} missing {t1_ctx.get('star_player','star')}"
    if fav_prob < 0.50:
        return f"🚨 UPSET ALERT: {dog}-seed favored!"
    elif fav_prob < 0.60 and gap >= 3:
        return f"⚠️ UPSET WATCH: {dog}-seed has a real shot"
    elif gap >= 4 and fav_prob < 0.72:
        return f"👀 SLEEPER: {dog}-seed dangerous"
    return "chalk"


def depth_label(dep):
    if dep >= 60: return "One-Man Show — very star dependent"
    elif dep >= 45: return "Star-Led — above average dependency"
    elif dep >= 30: return "Balanced — shared offensive load"
    return "Deep — distributed throughout roster"


def build_injury_ctx(row, team_name):
    if row is None:
        return {"team": team_name, "has_injuries": False, "star_is_injured": False,
                "n_injured": 0, "upset_vulnerability": 0, "injured_players": []}
    inj_list = [s.strip() for s in str(row.get("injured_statuses", "")).split(",") if s.strip()]
    return {
        "team": team_name,
        "has_injuries": bool(row.get("n_injured", 0) > 0),
        "star_is_injured": bool(row.get("star_is_injured", False)),
        "star_player": str(row.get("star_player", "")),
        "star_player_bpm": float(row.get("star_player_bpm", 0)),
        "star_dependency_pct": float(row.get("star_dependency_pct", 50)),
        "n_injured": int(row.get("n_injured", 0)),
        "n_out": int(row.get("n_out", 0)),
        "team_injury_bpm_lost": float(row.get("team_total_injury_bpm", 0)),
        "upset_vulnerability": float(row.get("upset_vulnerability", 0)),
        "injured_players": inj_list,
    }


def build_injury_response(t1, t2, t1_ctx, t2_ctx, base, adj):
    lines = []
    if t1_ctx.get("star_is_injured"):
        lines.append(f"🚑 {t1}'s {t1_ctx.get('star_player','star')} is injured — "
                     f"model drops win prob {base:.0%} → {adj:.0%}.")
    elif t1_ctx.get("has_injuries"):
        lines.append(f"⚠️ {t1} dealing with {t1_ctx['n_injured']} injury concern(s).")
    if t2_ctx.get("star_is_injured"):
        lines.append(f"🚑 {t2}'s {t2_ctx.get('star_player','star')} is injured — "
                     f"boosts {t1} to {adj:.0%}.")
    elif t2_ctx.get("has_injuries"):
        lines.append(f"⚠️ {t2} has injury concerns — slight boost to {t1}.")
    return " ".join(lines) if lines else "No significant injury factors for this matchup."


def run_step2(chatbot_data, profiles_data, output_dir, year):
    """
    STEP 2: Fetch player on/off + injuries, patch predictions + profiles.
    Re-run this daily during tournament to refresh injury data.
    """
    print("\n" + "=" * 70)
    print("🏥 STEP 2: PLAYER ON/OFF + INJURY PATCHING")
    print("=" * 70)

    # Fetch external data
    player_df, team_dep = fetch_player_stats(year)
    injury_df = fetch_injuries_espn()

    if player_df.empty:
        print("   ⚠️ No player data — skipping Step 2 patching.")
        return chatbot_data, profiles_data

    # Merge + summarize
    merged_df = merge_injury_impact(player_df, injury_df)
    team_summary = build_team_summary(merged_df, Config.TOURNAMENT_TEAMS)

    # Save intermediate CSVs
    player_df.to_csv(output_dir / f'player_onoff_{year}.csv', index=False)
    injury_df.to_csv(output_dir / f'injuries_{year}.csv', index=False)
    team_summary.to_csv(output_dir / f'team_injury_summary_{year}.csv', index=False)

    print(f"\n   📊 {len(team_summary)} tournament teams with on/off data")
    injured_teams = team_summary[team_summary["n_injured"] > 0]
    print(f"   🚑 {len(injured_teams)} teams with active injuries")

    # --- Patch predictions ---
    predictions = chatbot_data.get("predictions", [])
    lookup = {row["team"].lower().strip(): row for _, row in team_summary.iterrows()}

    patched_n = flipped_n = 0
    for pred in predictions:
        t1 = pred.get("t1_name", "").lower().strip()
        t2 = pred.get("t2_name", "").lower().strip()
        r1 = lookup.get(t1)
        r2 = lookup.get(t2)

        t1_adj = compute_injury_adj(r1)
        t2_adj = compute_injury_adj(r2)
        base = float(pred.get("model_win_prob", 0.5))
        adj = round(float(np.clip(base + t1_adj - t2_adj, 0.02, 0.98)), 5)

        t1_ctx = build_injury_ctx(r1, pred.get("t1_name", ""))
        t2_ctx = build_injury_ctx(r2, pred.get("t2_name", ""))

        pred["model_win_prob_original"] = base
        pred["model_win_prob"] = adj
        pred["injury_adjusted"] = (t1_adj != 0.0 or t2_adj != 0.0)
        pred["t1_injury_adj"] = t1_adj
        pred["t2_injury_adj"] = t2_adj
        pred["t1_injury"] = t1_ctx
        pred["t2_injury"] = t2_ctx
        pred["upset_flag"] = compute_upset_flag_v2(
            pred.get("t1_seed", 8), pred.get("t2_seed", 8), adj, t1_ctx, t2_ctx)
        pred["confidence"] = get_confidence(adj)

        flipped = (adj > 0.5) != (base > 0.5)
        pred["pick_flipped_by_injury"] = flipped
        if flipped:
            pred["predicted_winner_name"] = pred.get("t1_name") if adj > 0.5 else pred.get("t2_name")
            flipped_n += 1

        if pred.get("injury_adjusted"):
            pred.setdefault("responses", {})["injury"] = build_injury_response(
                pred.get("t1_name", ""), pred.get("t2_name", ""), t1_ctx, t2_ctx, base, adj)
            patched_n += 1

        # Add on/off depth info to responses
        if r1 is not None or r2 is not None:
            dep_lines = []
            if r1 is not None:
                dep_lines.append(f"{pred.get('t1_name','T1')}: {depth_label(float(r1.get('star_dependency_pct',50)))} "
                                f"(star: {r1.get('star_player','?')} — {r1.get('star_player_ppg',0):.1f} ppg)")
            if r2 is not None:
                dep_lines.append(f"{pred.get('t2_name','T2')}: {depth_label(float(r2.get('star_dependency_pct',50)))} "
                                f"(star: {r2.get('star_player','?')} — {r2.get('star_player_ppg',0):.1f} ppg)")
            pred.setdefault("responses", {})["depth"] = " | ".join(dep_lines)

    chatbot_data["injury_data_included"] = True
    chatbot_data["predictions"] = predictions

    # --- Patch team profiles ---
    profiles = profiles_data.get("profiles", [])
    for profile in profiles:
        name = profile.get("name", "").lower().strip()
        row = lookup.get(name)

        if row is not None:
            dep = float(row.get("star_dependency_pct", 50))
            profile["onoff"] = {
                "star_player": str(row.get("star_player", "")),
                "star_player_bpm": float(row.get("star_player_bpm", 0)),
                "star_player_usg": float(row.get("star_player_usg", 0)),
                "star_player_ppg": float(row.get("star_player_ppg", 0)),
                "star_dependency_pct": dep,
                "top2_dependency_pct": float(row.get("top2_dependency_pct", 50)),
                "team_total_bpm": float(row.get("team_total_bpm", 0)),
                "depth_label": depth_label(dep),
            }
            profile["injuries"] = {
                "has_injuries": bool(row.get("n_injured", 0) > 0),
                "star_is_injured": bool(row.get("star_is_injured", False)),
                "n_injured": int(row.get("n_injured", 0)),
                "n_out": int(row.get("n_out", 0)),
                "injured_players": str(row.get("injured_statuses", "")),
                "team_injury_bpm_lost": float(row.get("team_total_injury_bpm", 0)),
                "upset_vulnerability": float(row.get("upset_vulnerability", 0)),
            }
        else:
            profile["onoff"] = {"star_player": "", "star_dependency_pct": 50, "depth_label": "Unknown"}
            profile["injuries"] = {"has_injuries": False, "star_is_injured": False, "n_injured": 0}

    profiles_data["profiles"] = profiles
    profiles_data["injury_data_included"] = True

    # Save patched versions
    with open(output_dir / 'chatbot_predictions_base.json', 'w') as f:
        json.dump(chatbot_data, f, indent=2, cls=NumpyEncoder)

    with open(output_dir / 'team_profiles.json', 'w') as f:
        json.dump(profiles_data, f, indent=2, cls=NumpyEncoder)

    print(f"\n   ✅ {patched_n} predictions adjusted for injuries")
    print(f"   ✅ {flipped_n} picks FLIPPED by injury adjustment")
    print(f"   ✅ Patched files saved to {output_dir}/")

    # Print injury summary
    if len(injured_teams) > 0:
        print(f"\n   🚑 Injured tournament teams:")
        for _, r in injured_teams.sort_values("upset_vulnerability", ascending=False).head(10).iterrows():
            star_flag = "⭐ STAR" if r["star_is_injured"] else "      "
            print(f"      {star_flag}  {r['team']:<25} vuln={r['upset_vulnerability']:.0f}  "
                  f"→ {r['injured_statuses']}")

    return chatbot_data, profiles_data


# #############################################################################
#                              MAIN
# #############################################################################
def main():
    t0 = time.time()

    parser = argparse.ArgumentParser(description='BracketGPT Unified Pipeline v5')
    parser.add_argument('--data-dir', default='./data')
    parser.add_argument('--backtest', type=int, default=2025)
    parser.add_argument('--output-dir', default='./outputs')
    parser.add_argument('--kenpom-path', default=None)
    parser.add_argument('--skip-step1', action='store_true', help='Skip model training, load existing predictions')
    parser.add_argument('--skip-step2', action='store_true', help='Skip injury/on-off patching')
    args = parser.parse_args()

    Config.DATA_DIR = Path(args.data_dir)
    Config.OUTPUT_DIR = Path(args.output_dir)
    Config.BACKTEST_SEASON = args.backtest
    Config.KENPOM_PATH = args.kenpom_path

    Config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 70)
    print("🏀 BRACKETGPT UNIFIED PIPELINE v5")
    print("   STEP 1: XGBoost + LightGBM + Leaf-Logistic → Meta-Learner")
    print("   STEP 2: Player On/Off + Injuries → Patched JSONs")
    print(f"   Backtest: {args.backtest}")
    print(f"   KenPom: {'✅' if args.kenpom_path else '❌'}")
    print(f"   Step 1: {'SKIP' if args.skip_step1 else 'RUN'}")
    print(f"   Step 2: {'SKIP' if args.skip_step2 else 'RUN'}")
    print("=" * 70)

    chatbot_data = None
    profiles_data = None
    team_stats = None
    kenpom = None

    # ===========================
    # STEP 1: MODEL + PREDICTIONS
    # ===========================
    if not args.skip_step1:
        print("\n" + "=" * 70)
        print("📊 STEP 1: MODEL TRAINING + PREDICTION EXPORT")
        print("=" * 70)

        regular, tourney, seeds, teams = load_data(Config.DATA_DIR)
        kenpom = load_kenpom(args.kenpom_path)

        elo_df = compute_elo(regular, args.backtest)
        team_stats = compute_season_stats(regular)

        td, arch_matrix, arch_encoder, archetype_base = build_matchup_features(
            tourney, team_stats, elo_df, seeds, kenpom, args.backtest)

        if 'T1_Archetype' in td.columns:
            print(f"\n🎭 ARCHETYPE DISTRIBUTION (Training Data):")
            train_archs = td[td['Season'] < args.backtest]
            all_archs = pd.concat([train_archs['T1_Archetype'], train_archs['T2_Archetype']])
            for arch, count in all_archs.value_counts().head(15).items():
                print(f"   {arch:<25} {count:>5} appearances")

        result = train_model(td, args.backtest)

        chatbot_data, profiles_data = export_step1_json(
            result, teams, arch_matrix, archetype_base, team_stats, kenpom, Config.OUTPUT_DIR)
    else:
        # Load existing predictions from disk
        pred_path = Config.OUTPUT_DIR / 'chatbot_predictions_base.json'
        prof_path = Config.OUTPUT_DIR / 'team_profiles.json'
        if pred_path.exists():
            with open(pred_path) as f:
                chatbot_data = json.load(f)
            print(f"   📂 Loaded existing predictions: {len(chatbot_data.get('predictions', []))} matchups")
        else:
            print(f"   ⚠️ No existing predictions at {pred_path}")
            return
        if prof_path.exists():
            with open(prof_path) as f:
                profiles_data = json.load(f)
            print(f"   📂 Loaded existing profiles: {len(profiles_data.get('profiles', []))} teams")
        else:
            profiles_data = {"profiles": []}

    # ===========================
    # STEP 2: INJURIES + ON/OFF
    # ===========================
    if not args.skip_step2 and chatbot_data is not None:
        chatbot_data, profiles_data = run_step2(
            chatbot_data, profiles_data, Config.OUTPUT_DIR, args.backtest)

    # ===========================
    # FINAL SUMMARY
    # ===========================
    elapsed = time.time() - t0
    print("\n" + "=" * 70)
    print("  ✅  BRACKETGPT PIPELINE COMPLETE")
    print("=" * 70)

    # File sizes
    for fname in ['chatbot_predictions_base.json', 'team_profiles.json',
                   'archetype_summary.json', 'full_predictions.csv']:
        fpath = Config.OUTPUT_DIR / fname
        if fpath.exists():
            kb = fpath.stat().st_size / 1024
            print(f"  📄 {fname:<45} {kb:>7.1f} KB")

    print(f"\n  ⏱️ Total time: {elapsed:.0f}s ({elapsed/60:.1f} min)")

    print(f"""
{'─'*70}
📤  UPLOAD TO RAILWAY (backend/data/):

   1. chatbot_predictions_base.json    ← predictions + injuries
   2. team_profiles.json               ← team stats + on/off + injuries
   3. archetype_summary.json           ← archetype matchup matrix
   4. bracket_2025.json                ← bracket structure (copy manually)

🔁  DURING TOURNAMENT — re-run with --skip-step1 to refresh injuries only:
   !python BracketGPT_Unified_Pipeline.py \\
     --output-dir "..." --backtest 2025 --skip-step1
{'─'*70}
""")


if __name__ == "__main__":
    main()
