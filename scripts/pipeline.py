#!/usr/bin/env python3
"""
S&P 500 Sector Rotation Detection Pipeline
Fetches daily OHLCV for 11 GICS sector ETFs, computes rotation signals.
"""
from __future__ import annotations

import json
import sys
import os
import argparse
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

# Heavy imports deferred — only needed for live mode
pd = None
yf = None

# ---------------------------------------------------------------------------
# S&P 500 Sector ETFs (11 GICS sectors)
# ---------------------------------------------------------------------------
SECTOR_ETFS = {
    "XLK":  {"name": "Technologie",             "color": "#3b82f6", "weight": 31.0},
    "XLF":  {"name": "Finance",                  "color": "#f59e0b", "weight": 13.5},
    "XLV":  {"name": "Sante",                    "color": "#22c55e", "weight": 11.5},
    "XLY":  {"name": "Conso. Discretionnaire",   "color": "#f97316", "weight": 10.0},
    "XLC":  {"name": "Communication",            "color": "#ec4899", "weight": 9.0},
    "XLI":  {"name": "Industrie",                "color": "#8b5cf6", "weight": 8.5},
    "XLP":  {"name": "Conso. Essentiels",        "color": "#06b6d4", "weight": 6.0},
    "XLE":  {"name": "Energie",                  "color": "#ef4444", "weight": 3.5},
    "XLU":  {"name": "Services Publics",         "color": "#eab308", "weight": 2.5},
    "XLB":  {"name": "Materiaux",                "color": "#a855f7", "weight": 2.5},
    "XLRE": {"name": "Immobilier",               "color": "#14b8a6", "weight": 2.5},
}

SECTOR_ORDER = list(SECTOR_ETFS.keys())
BENCHMARK = "SPY"

# Top holdings per sector ETF (≈15-20 per sector)
SECTOR_HOLDINGS = {
    "XLK":  ["AAPL","MSFT","NVDA","AVGO","CRM","ADBE","AMD","CSCO","ACN","ORCL",
             "INTC","INTU","TXN","QCOM","AMAT","IBM","NOW","MU","LRCX","ADI"],
    "XLF":  ["BRK-B","JPM","V","MA","BAC","WFC","GS","SPGI","MS","AXP",
             "BLK","C","PGR","CB","MMC","ICE","CME","SCHW","AON","MCO"],
    "XLE":  ["XOM","CVX","COP","EOG","SLB","MPC","PSX","WMB","VLO","OKE",
             "HAL","DVN","FANG","BKR","TRGP","KMI","OXY"],
    "XLV":  ["UNH","JNJ","LLY","ABBV","MRK","TMO","ABT","PFE","DHR","AMGN",
             "BMY","MDT","ELV","ISRG","SYK","GILD","CI","VRTX","ZTS","BSX"],
    "XLI":  ["GE","CAT","HON","UNP","RTX","DE","BA","UPS","LMT","ADP",
             "ETN","WM","EMR","GD","ITW","NSC","PH","TDG","CARR","CTAS"],
    "XLY":  ["AMZN","TSLA","HD","MCD","NKE","LOW","BKNG","SBUX","TJX","CMG",
             "ORLY","MAR","DHI","GM","F","ROST","LEN","YUM","EBAY","APTV"],
    "XLP":  ["PG","KO","PEP","COST","WMT","PM","MDLZ","MO","CL","KMB",
             "GIS","SYY","STZ","ADM","HSY","KHC","KR","CLX","TSN"],
    "XLU":  ["NEE","DUK","SO","D","AEP","SRE","EXC","XEL","ED","WEC",
             "ES","AWK","DTE","PPL","FE","AEE","ETR","CMS","ATO"],
    "XLB":  ["LIN","APD","SHW","ECL","FCX","NEM","NUE","VMC","MLM","DOW",
             "DD","IFF","CF","PPG","CE","ALB","BALL","EMN","AVY"],
    "XLC":  ["META","GOOGL","NFLX","DIS","CMCSA","T","VZ","TMUS","CHTR","EA",
             "WBD","OMC","TTWO","FOX","LYV"],
    "XLRE": ["PLD","AMT","CCI","EQIX","PSA","SPG","O","DLR","WELL","AVB",
             "EQR","VICI","IRM","MAA","ARE","KIM","ESS","UDR","HST","REG"],
}


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------
def fetch_ohlcv(period: str = "2y"):
    """Download OHLCV data for all sector ETFs + SPY benchmark."""
    tickers = list(SECTOR_ETFS.keys()) + [BENCHMARK]
    print(f"Downloading {len(tickers)} ETFs ({period})...")
    data = yf.download(tickers, period=period, progress=False, auto_adjust=True)
    if data.empty:
        raise RuntimeError("yfinance returned empty data")
    return data


# ---------------------------------------------------------------------------
# Phase smoothing (confirmation filter)
# ---------------------------------------------------------------------------
PHASE_CONFIRM_DAYS = 5  # Must stay in new quadrant for N days to confirm

def classify_phase(rs_ratio, rs_momentum):
    """Raw phase from RS-Ratio / RS-Momentum quadrant."""
    if rs_ratio >= 100 and rs_momentum >= 100:
        return "leading"
    elif rs_ratio < 100 and rs_momentum >= 100:
        return "improving"
    elif rs_ratio >= 100 and rs_momentum < 100:
        return "weakening"
    else:
        return "lagging"


def smooth_phase_series(raw_phases, confirm_days=PHASE_CONFIRM_DAYS):
    """Apply N-day confirmation filter to a raw phase series.

    A phase transition is only confirmed when the new phase has been
    observed for `confirm_days` consecutive days. Until confirmed,
    the previous phase is maintained.

    Args:
        raw_phases: list/array of raw phase strings
        confirm_days: number of consecutive days required to confirm

    Returns:
        list of smoothed phase strings (same length)
    """
    if len(raw_phases) == 0:
        return []

    smoothed = [raw_phases[0]]
    confirmed = raw_phases[0]
    pending = None
    pending_count = 0

    for i in range(1, len(raw_phases)):
        raw = raw_phases[i]
        if raw == confirmed:
            pending = None
            pending_count = 0
        elif raw == pending:
            pending_count += 1
            if pending_count >= confirm_days:
                confirmed = pending
                pending = None
                pending_count = 0
        else:
            pending = raw
            pending_count = 1
        smoothed.append(confirmed)

    return smoothed


# ---------------------------------------------------------------------------
# Indicator calculations
# ---------------------------------------------------------------------------
def compute_rsi_series(close, period=14):
    """RSI series for a stock."""
    delta = close.diff()
    gain = delta.where(delta > 0, 0).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def compute_mfi(high, low, close, volume, period=14):
    """Money Flow Index (latest value)."""
    tp = (high + low + close) / 3
    rmf = tp * volume
    delta = tp.diff()
    pos = (rmf * (delta > 0)).rolling(period).sum()
    neg = (rmf * (delta < 0)).abs().rolling(period).sum()
    ratio = pos / neg.replace(0, np.nan)
    mfi = 100 - 100 / (1 + ratio)
    val = mfi.iloc[-1]
    return float(val) if not np.isnan(val) else 50.0


def compute_cmf(high, low, close, volume, period=21):
    """Chaikin Money Flow (latest value)."""
    hl_range = high - low
    hl_range = hl_range.replace(0, np.nan)
    mfm = ((close - low) - (high - close)) / hl_range
    mfv = mfm * volume
    cmf = mfv.rolling(period).sum() / volume.rolling(period).sum()
    val = cmf.iloc[-1]
    return float(val) if not np.isnan(val) else 0.0


def compute_rs(close, benchmark, period=20):
    """JdK RS-Ratio and RS-Momentum. Returns current + 5-day-ago values."""
    rs = close / benchmark
    rs_sma = rs.rolling(period).mean()
    rs_ratio = (rs / rs_sma) * 100
    rs_mom = (rs_ratio / rs_ratio.shift(period)) * 100
    r = rs_ratio.iloc[-1]
    m = rs_mom.iloc[-1]
    # Previous values (5 trading days ago) for trend
    r_prev = rs_ratio.iloc[-6] if len(rs_ratio) >= 6 else r
    m_prev = rs_mom.iloc[-6] if len(rs_mom) >= 6 else m
    return (float(r) if not np.isnan(r) else 100.0,
            float(m) if not np.isnan(m) else 100.0,
            float(r_prev) if not np.isnan(r_prev) else 100.0,
            float(m_prev) if not np.isnan(m_prev) else 100.0)


def compute_trend(close, period=20):
    """Signed R² linear regression on last N days."""
    prices = close.values[-period:]
    n = len(prices)
    if n < 5:
        return 0.0
    x = np.arange(n, dtype=float)
    xm, ym = x.mean(), prices.mean()
    ss_xy = ((x - xm) * (prices - ym)).sum()
    ss_xx = ((x - xm) ** 2).sum()
    if ss_xx == 0:
        return 0.0
    slope = ss_xy / ss_xx
    y_pred = slope * x + (ym - slope * xm)
    ss_res = ((prices - y_pred) ** 2).sum()
    ss_tot = ((prices - ym) ** 2).sum()
    if ss_tot == 0:
        return 0.0
    r2 = max(0.0, 1 - ss_res / ss_tot)
    return float(r2) if slope > 0 else float(-r2)


# ---------------------------------------------------------------------------
# Rotation detection
# ---------------------------------------------------------------------------
def detect_rotations(data):
    """Main rotation detection for 11 sector ETFs."""
    etfs = list(SECTOR_ETFS.keys())

    # Extract data
    close = data["Close"][etfs].dropna(axis=1, how="all")
    high = data["High"][etfs].dropna(axis=1, how="all")
    low = data["Low"][etfs].dropna(axis=1, how="all")
    volume = data["Volume"][etfs].dropna(axis=1, how="all")
    benchmark = data["Close"][BENCHMARK]

    valid = sorted(set(close.columns) & set(high.columns) & set(low.columns) & set(volume.columns))
    close, high, low, volume = close[valid], high[valid], low[valid], volume[valid]
    print(f"  Valid sector ETFs: {len(valid)}")

    # Detect partial trading day
    vol_today = volume.iloc[-1].mean()
    vol_yesterday = volume.iloc[-2].mean() if len(volume) > 1 else vol_today
    partial_day = vol_today < vol_yesterday * 0.5
    if partial_day:
        print("  Partial trading day detected — using yesterday for indicators")

    ind_close = close.iloc[:-1] if partial_day else close
    ind_high = high.iloc[:-1] if partial_day else high
    ind_low = low.iloc[:-1] if partial_day else low
    ind_volume = volume.iloc[:-1] if partial_day else volume
    ind_benchmark = benchmark.iloc[:-1] if partial_day else benchmark

    # Returns
    returns = close.pct_change().iloc[1:]
    bench_returns = benchmark.pct_change().iloc[1:]
    common_idx = returns.index.intersection(bench_returns.index)
    returns = returns.loc[common_idx]
    bench_returns = bench_returns.loc[common_idx]

    # Betas (60-day rolling)
    market_var = bench_returns.rolling(60).var().iloc[-1]
    betas = {}
    for t in valid:
        if market_var == 0 or np.isnan(market_var):
            betas[t] = 1.0
        else:
            cov = returns[t].rolling(60).cov(bench_returns).iloc[-1]
            betas[t] = float(cov / market_var) if not np.isnan(cov) else 1.0

    # Residual returns (daily — kept for tooltip detail)
    latest_returns = returns.iloc[-1]
    latest_bench = bench_returns.iloc[-1]
    residuals_daily = {t: float(latest_returns[t] - betas[t] * latest_bench) for t in valid}

    # Multi-timeframe returns
    ret_5d = {}
    ret_20d = {}
    bench_5d = float(benchmark.iloc[-1] / benchmark.iloc[-5] - 1) if len(benchmark) >= 5 else 0
    bench_20d = float(benchmark.iloc[-1] / benchmark.iloc[-20] - 1) if len(benchmark) >= 20 else 0
    residuals_5d = {}
    residuals_20d = {}
    for t in valid:
        r5 = close[t].iloc[-1] / close[t].iloc[-5] - 1 if len(close) >= 5 else 0
        r20 = close[t].iloc[-1] / close[t].iloc[-20] - 1 if len(close) >= 20 else 0
        ret_5d[t] = float(r5) if not np.isnan(r5) else 0.0
        ret_20d[t] = float(r20) if not np.isnan(r20) else 0.0
        residuals_5d[t] = ret_5d[t] - betas[t] * bench_5d
        residuals_20d[t] = ret_20d[t] - betas[t] * bench_20d

    # Volume ratio
    vol_avg = ind_volume.rolling(20).mean()
    vol_ratio_all = {}
    for t in valid:
        v = ind_volume[t].iloc[-1] / vol_avg[t].iloc[-1]
        vol_ratio_all[t] = float(v) if not np.isnan(v) and np.isfinite(v) else 1.0

    # Per-sector indicators
    nodes = []
    indicators = {}
    for t in valid:
        meta = SECTOR_ETFS[t]
        mfi = compute_mfi(ind_high[t], ind_low[t], ind_close[t], ind_volume[t])
        cmf = compute_cmf(ind_high[t], ind_low[t], ind_close[t], ind_volume[t])
        rs_ratio, rs_mom, rs_ratio_prev, rs_mom_prev = compute_rs(close[t], benchmark)
        trend = compute_trend(ind_close[t], period=20)

        indicators[t] = {"mfi": mfi, "cmf": cmf, "rs_ratio": rs_ratio, "rs_momentum": rs_mom}

        # Phase value 0-100 — composite of RS-Ratio + RS-Momentum
        phase_value = float(np.clip(((rs_ratio - 95) + (rs_mom - 95)) / 20 * 100, 0, 100))

        # Phase trend: delta vs 5 days ago
        phase_value_prev = float(np.clip(((rs_ratio_prev - 95) + (rs_mom_prev - 95)) / 20 * 100, 0, 100))
        phase_delta = round(phase_value - phase_value_prev, 1)

        # Smoothed phase: compute raw phase series, then apply confirmation filter
        days_in_phase = 0
        previous_phase = None
        _rs = close[t] / benchmark
        _rs_sma = _rs.rolling(20).mean()
        _rr = (_rs / _rs_sma) * 100
        _rm = (_rr / _rr.shift(20)) * 100
        _raw_phases = []
        _valid_idx = _rm.dropna().index
        for _day in _valid_idx:
            _raw_phases.append(classify_phase(float(_rr.loc[_day]), float(_rm.loc[_day])))

        # Apply smoothing on last 90 days (enough context for confirmation)
        _raw_tail = _raw_phases[-90:] if len(_raw_phases) > 90 else _raw_phases
        _smoothed = smooth_phase_series(_raw_tail)
        phase = _smoothed[-1] if _smoothed else classify_phase(rs_ratio, rs_mom)

        if len(_smoothed) > 1:
            current = _smoothed[-1]
            count = 0
            for k in range(len(_smoothed) - 1, -1, -1):
                if _smoothed[k] == current:
                    count += 1
                else:
                    break
            days_in_phase = count
            for k in range(len(_smoothed) - days_in_phase - 1, -1, -1):
                if _smoothed[k] != current:
                    previous_phase = _smoothed[k]
                    break

        nodes.append({
            "id": t,
            "name": meta["name"],
            "color": meta["color"],
            "weight": meta.get("weight", 5.0),
            "daily_return": round(float(latest_returns[t]), 5),
            "return_5d": round(ret_5d[t], 5),
            "return_20d": round(ret_20d[t], 5),
            "residual_return": round(residuals_5d[t], 5),
            "volume_ratio": round(vol_ratio_all[t], 2),
            "mfi": round(mfi, 1),
            "cmf": round(cmf, 3),
            "trend": round(trend, 3),
            "momentum_phase": phase,
            "phase_value": round(phase_value, 1),
            "phase_delta": phase_delta,
            "rs_ratio": round(rs_ratio, 1),
            "rs_momentum": round(rs_mom, 1),
            "days_in_phase": days_in_phase,
            "previous_phase": previous_phase,
        })

    # Market state — inter-sector correlation
    beta_adj = pd.DataFrame(
        bench_returns.values.reshape(-1, 1) * np.array([betas[t] for t in valid]).reshape(1, -1),
        index=returns.index, columns=valid,
    )
    resid_returns = returns[valid] - beta_adj
    recent_resid = resid_returns.tail(min(20, len(resid_returns) - 1))

    if len(recent_resid.columns) > 1:
        corr_matrix = recent_resid.corr()
        mask = np.triu(np.ones_like(corr_matrix, dtype=bool), k=1)
        upper = corr_matrix.where(mask).stack()
        avg_corr = float(upper.mean()) if len(upper) > 0 else 0.0
        if np.isnan(avg_corr):
            avg_corr = 0.0
    else:
        avg_corr = 0.0
    market_state = "high_correlation" if avg_corr > 0.7 else "normal"

    # Narrative + regime
    regime, regime_label, regime_confidence, narrative = \
        _generate_narrative(nodes, [], market_state, avg_corr)

    return {
        "metadata": {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "market_state": market_state,
            "avg_correlation": round(avg_corr, 3),
            "total_sectors": len(valid),
            "benchmark_return": round(float(latest_bench), 5),
            "regime": regime,
            "regime_label": regime_label,
            "regime_confidence": regime_confidence,
            "narrative": narrative,
        },
        "nodes": nodes,
    }


# ---------------------------------------------------------------------------
# Market regime detection (Fidelity business cycle framework)
# ---------------------------------------------------------------------------
REGIME_PROFILES = {
    "early_cycle": {
        "leaders": {"XLF", "XLY", "XLI", "XLRE"},
        "laggers": {"XLU", "XLV", "XLP"},
        "label": "Cycliques en tete",
        "context": "un schema typique de reprise economique",
    },
    "mid_cycle": {
        "leaders": {"XLK", "XLC", "XLI", "XLY"},
        "laggers": {"XLE", "XLU", "XLRE"},
        "label": "Croissance en tete",
        "context": "une configuration classique de phase d'expansion",
    },
    "late_cycle": {
        "leaders": {"XLE", "XLV", "XLP", "XLU"},
        "laggers": {"XLK", "XLY", "XLC"},
        "label": "Defensives en tete",
        "context": "un positionnement historiquement associe aux fins de cycle",
    },
    "contraction": {
        "leaders": {"XLU", "XLV", "XLP"},
        "laggers": {"XLF", "XLI", "XLY", "XLK", "XLE"},
        "label": "Mode prudence",
        "context": "un repli vers les valeurs refuges",
    },
}


def _detect_regime(nodes):
    """Infer market regime from sector rotation pattern."""
    actual_leaders = {n["id"] for n in nodes
                      if n["momentum_phase"] in ("leading", "improving")}
    actual_laggers = {n["id"] for n in nodes
                      if n["momentum_phase"] in ("lagging", "weakening")}

    best_regime = None
    best_score = -999
    best_confidence = 0.0

    for regime, profile in REGIME_PROFILES.items():
        expected_leaders = profile["leaders"]
        expected_laggers = profile["laggers"]
        total = len(expected_leaders) + len(expected_laggers)

        leader_matches = len(actual_leaders & expected_leaders)
        lagger_matches = len(actual_laggers & expected_laggers)
        leader_contra = len(actual_laggers & expected_leaders)
        lagger_contra = len(actual_leaders & expected_laggers)

        score = leader_matches + lagger_matches - 0.5 * (leader_contra + lagger_contra)
        confidence = score / total if total > 0 else 0

        if score > best_score:
            best_score = score
            best_regime = regime
            best_confidence = confidence

    if best_confidence < 0.3:
        return "mixed", "Marche mixte", 0.0

    profile = REGIME_PROFILES[best_regime]
    return best_regime, profile["label"], round(best_confidence, 2)


def _generate_narrative(nodes, rotations, market_state, avg_corr):
    """Generate concise narrative: one sentence for the bar, context as second sentence."""
    PHASE_LABELS = {
        "leading": "Surperformance",
        "improving": "Rebond",
        "weakening": "Essoufflement",
        "lagging": "Sous pression",
    }

    regime, regime_label, confidence = _detect_regime(nodes)

    # High correlation — everything moves together
    if market_state == "high_correlation":
        return (regime, regime_label, confidence,
                "Les secteurs évoluent de concert, peu de rotation.")

    # 1) Phase transitions — most newsworthy, grouped by target phase
    transitions = [n for n in nodes
                   if n.get("previous_phase")
                   and n["previous_phase"] != n["momentum_phase"]
                   and n.get("days_in_phase", 0) <= 5]

    if transitions:
        by_phase = {}
        for n in transitions:
            by_phase.setdefault(n["momentum_phase"], []).append(n["name"])

        parts = []
        for phase, names in by_phase.items():
            label = PHASE_LABELS[phase]
            if len(names) == 1:
                parts.append(f"{names[0]} passe en {label}")
            else:
                joined = " et ".join(names[:3])
                parts.append(f"{joined} passent en {label}")

        headline = ", ".join(parts[:2])
    else:
        # 2) No transitions — show leaders vs laggers
        leaders = sorted(
            [n for n in nodes if n["momentum_phase"] == "leading"],
            key=lambda x: -x["rs_momentum"])
        laggers = sorted(
            [n for n in nodes if n["momentum_phase"] == "lagging"],
            key=lambda x: x["rs_momentum"])

        if leaders and laggers:
            tops = " et ".join(n["name"] for n in leaders[:2])
            bots = " et ".join(n["name"] for n in laggers[:2])
            headline = f"{tops} mènent, {bots} décrochent"
        elif leaders:
            tops = " et ".join(n["name"] for n in leaders[:3])
            headline = f"{tops} en tête du marché"
        elif laggers:
            bots = " et ".join(n["name"] for n in laggers[:3])
            headline = f"Pression sur {bots}"
        else:
            headline = "Positions stables, pas de mouvement notable"

    # Build full narrative: headline + optional context as second sentence
    narrative = headline + "."
    if confidence >= 0.4 and regime != "mixed":
        context = REGIME_PROFILES[regime]["context"]
        narrative += f" {context[0].upper()}{context[1:]}."

    return (regime, regime_label, confidence, narrative)


# ---------------------------------------------------------------------------
# Sample data (for testing without API)
# ---------------------------------------------------------------------------
def generate_sector_history(data, days=90):
    """Generate historical RS-Ratio/RS-Momentum snapshots for RRG playback."""
    etfs = list(SECTOR_ETFS.keys())
    close = data["Close"][etfs].dropna(axis=1, how="all")
    high = data["High"][etfs].dropna(axis=1, how="all")
    low = data["Low"][etfs].dropna(axis=1, how="all")
    volume = data["Volume"][etfs].dropna(axis=1, how="all")
    benchmark = data["Close"][BENCHMARK]
    valid = sorted(set(close.columns) & set(high.columns) & set(low.columns) & set(volume.columns))

    # Compute full RS series per sector
    rs_full = {}
    for t in valid:
        rs = close[t] / benchmark
        rs_sma = rs.rolling(20).mean()
        rr = (rs / rs_sma) * 100
        rm = (rr / rr.shift(20)) * 100
        rs_full[t] = {"rr": rr, "rm": rm}

    # Compute full CMF series per sector (21-day rolling)
    cmf_full = {}
    for t in valid:
        hl_range = high[t] - low[t]
        hl_range = hl_range.replace(0, np.nan)
        mfm = ((close[t] - low[t]) - (high[t] - close[t])) / hl_range
        mfv = mfm * volume[t]
        cmf_series = mfv.rolling(21).sum() / volume[t].rolling(21).sum()
        cmf_full[t] = cmf_series

    # Compute 20-day return per sector (for Flow Map Y-axis)
    ret_full = {}
    for t in valid:
        ret_full[t] = close[t].pct_change(20)

    # Compute distance to 50-day MA per sector (for Signal Actif condition)
    ma50_full = {}
    for t in valid:
        ma50 = close[t].rolling(50).mean()
        ma50_full[t] = (close[t] / ma50) - 1  # negative = below MA50

    trading_days = benchmark.dropna().index[-days:]
    dates = [d.strftime("%Y-%m-%d") for d in trading_days]

    sectors = {}
    for t in valid:
        rr = rs_full[t]["rr"]
        rm = rs_full[t]["rm"]
        cmf_s = cmf_full[t]
        ret_s = ret_full[t]
        ma50_s = ma50_full[t]
        r_vals = []
        m_vals = []
        c_vals = []
        ret_vals = []
        ma50_vals = []
        raw_phases = []
        for day in trading_days:
            r = float(rr.loc[day]) if day in rr.index and not np.isnan(rr.loc[day]) else None
            m = float(rm.loc[day]) if day in rm.index and not np.isnan(rm.loc[day]) else None
            c = float(cmf_s.loc[day]) if day in cmf_s.index and not np.isnan(cmf_s.loc[day]) else 0.0
            ret = float(ret_s.loc[day]) if day in ret_s.index and not np.isnan(ret_s.loc[day]) else None
            ma50d = float(ma50_s.loc[day]) if day in ma50_s.index and not np.isnan(ma50_s.loc[day]) else None
            r_vals.append(round(r, 2) if r is not None else None)
            m_vals.append(round(m, 2) if m is not None else None)
            c_vals.append(round(c, 3))
            ret_vals.append(round(ret, 4) if ret is not None else None)
            ma50_vals.append(round(ma50d, 4) if ma50d is not None else None)
            if r is not None and m is not None:
                raw_phases.append(classify_phase(r, m))
            elif raw_phases:
                raw_phases.append(raw_phases[-1])  # carry forward
            else:
                raw_phases.append("lagging")

        # Smooth phases with confirmation, but use full history for warmup
        # Get raw phases for the full RS series (not just last N days)
        full_raw = []
        for day in rr.dropna().index:
            if day in rm.index and not np.isnan(rm.loc[day]):
                full_raw.append(classify_phase(float(rr.loc[day]), float(rm.loc[day])))
        full_smoothed = smooth_phase_series(full_raw)
        # Extract the last `days` smoothed values (aligned with trading_days)
        p_vals = full_smoothed[-len(trading_days):] if len(full_smoothed) >= len(trading_days) else raw_phases

        sectors[t] = {
            "r": r_vals, "m": m_vals, "p": p_vals, "c": c_vals, "ret": ret_vals,
            "ma50": ma50_vals,
            "w": SECTOR_ETFS[t]["weight"],
            "name": SECTOR_ETFS[t]["name"], "color": SECTOR_ETFS[t]["color"],
        }

    return {"dates": dates, "sectors": sectors}


def _generate_sample_history(days=90):
    """Generate synthetic sector history for --sample mode."""
    rng = np.random.default_rng(99)
    dates = [(datetime.now() - timedelta(days=days - i)).strftime("%Y-%m-%d")
             for i in range(days)]

    # Each sector starts at a random RS position and drifts
    sectors = {}
    for etf, meta in SECTOR_ETFS.items():
        r_base = 98 + rng.normal(0, 2)
        m_base = 98 + rng.normal(0, 2)
        drift_r = rng.normal(0.02, 0.01)
        drift_m = rng.normal(0.01, 0.015)
        r_vals, m_vals = [], []
        for i in range(days):
            r_base += drift_r + rng.normal(0, 0.15)
            m_base += drift_m + rng.normal(0, 0.2)
            r_vals.append(round(float(np.clip(r_base, 94, 106)), 2))
            m_vals.append(round(float(np.clip(m_base, 94, 106)), 2))
        raw_phases = [classify_phase(r, m) for r, m in zip(r_vals, m_vals)]
        p_vals = smooth_phase_series(raw_phases)
        sectors[etf] = {
            "r": r_vals, "m": m_vals, "p": p_vals,
            "name": meta["name"], "color": meta["color"],
        }

    return {"dates": dates, "sectors": sectors}


def generate_sample_data():
    """Generate synthetic sector rotation data."""
    rng = np.random.default_rng(42)

    # Simulate: Tech/Comm selling off, Energy/Healthcare rallying
    biases = {
        "XLK": -0.018, "XLC": -0.012, "XLY": -0.005,
        "XLF": 0.003, "XLI": 0.005, "XLP": 0.008,
        "XLV": 0.015, "XLE": 0.020, "XLU": 0.010,
        "XLB": 0.002, "XLRE": 0.006,
    }

    bench_ret = -0.003
    nodes = []
    for etf, meta in SECTOR_ETFS.items():
        bias = biases.get(etf, 0)
        dr = bias + rng.normal(0, 0.005)
        residual = dr - 1.0 * bench_ret
        mfi = float(np.clip(50 + residual * 1500 + rng.normal(0, 5), 15, 85))
        cmf = float(np.clip(residual * 4 + rng.normal(0, 0.08), -0.5, 0.5))
        trend = float(np.clip(bias * 15 + rng.normal(0, 0.1), -1, 1))
        vol_ratio = round(0.7 + rng.exponential(0.4), 2)
        rs_ratio = round(100 + residual * 200 + rng.normal(0, 1), 1)
        rs_mom = round(100 + residual * 150 + rng.normal(0, 1.5), 1)
        ret_5d = bias * 3 + rng.normal(0, 0.008)
        ret_20d = bias * 10 + rng.normal(0, 0.015)

        if rs_ratio >= 100 and rs_mom >= 100:
            phase = "leading"
        elif rs_ratio < 100 and rs_mom >= 100:
            phase = "improving"
        elif rs_ratio >= 100 and rs_mom < 100:
            phase = "weakening"
        else:
            phase = "lagging"
        phase_value = float(np.clip(((rs_ratio - 95) + (rs_mom - 95)) / 20 * 100, 0, 100))

        nodes.append({
            "id": etf,
            "name": meta["name"],
            "color": meta["color"],
            "weight": meta.get("weight", 5.0),
            "daily_return": round(dr, 5),
            "return_5d": round(ret_5d, 5),
            "return_20d": round(ret_20d, 5),
            "residual_return": round(residual, 5),
            "volume_ratio": vol_ratio,
            "mfi": round(mfi, 1),
            "cmf": round(cmf, 3),
            "trend": round(trend, 3),
            "momentum_phase": phase,
            "phase_value": round(phase_value, 1),
            "rs_ratio": rs_ratio,
            "rs_momentum": rs_mom,
        })

    regime, regime_label, regime_confidence, narrative = \
        _generate_narrative(nodes, [], "normal", 0.35)

    return {
        "metadata": {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "market_state": "normal",
            "avg_correlation": 0.35,
            "total_sectors": len(nodes),
            "benchmark_return": bench_ret,
            "regime": regime,
            "regime_label": regime_label,
            "regime_confidence": regime_confidence,
            "narrative": narrative,
        },
        "nodes": nodes,
    }


# ---------------------------------------------------------------------------
# Sector detail — individual stock phases
# ---------------------------------------------------------------------------
def compute_sector_detail(etf, data_all):
    """Compute phases for individual stocks vs their sector ETF."""
    holdings = SECTOR_HOLDINGS.get(etf, [])
    if not holdings:
        return None

    meta = SECTOR_ETFS[etf]
    sector_close = data_all["Close"][etf]       # benchmark = sector ETF
    spy = data_all["Close"][BENCHMARK]           # for leader/laggard vs market

    close = data_all["Close"]
    volume = data_all["Volume"]

    available = [h for h in holdings if h in close.columns and close[h].dropna().shape[0] > 30]
    if not available:
        return None

    spy_returns = spy.pct_change().dropna()

    # Sector 5d return for leader/laggard comparison
    sector_r5 = float(sector_close.iloc[-1] / sector_close.iloc[-5] - 1) if len(sector_close) >= 5 else 0.0

    stocks = []
    for ticker in available:
        c = close[ticker].dropna()
        if len(c) < 30:
            continue

        returns = c.pct_change().dropna()
        common_idx = returns.index.intersection(spy_returns.index)
        if len(common_idx) < 20:
            continue

        # 5d and 20d returns
        r5 = float(c.iloc[-1] / c.iloc[-5] - 1) if len(c) >= 5 else 0.0
        r20 = float(c.iloc[-1] / c.iloc[-20] - 1) if len(c) >= 20 else 0.0
        if np.isnan(r5): r5 = 0.0
        if np.isnan(r20): r20 = 0.0

        # RS-Ratio/Momentum vs sector ETF
        rs_ratio, rs_mom, rs_ratio_prev, rs_mom_prev = compute_rs(c, sector_close)

        phase_value = float(np.clip(((rs_ratio - 95) + (rs_mom - 95)) / 20 * 100, 0, 100))

        phase_value_prev = float(np.clip(((rs_ratio_prev - 95) + (rs_mom_prev - 95)) / 20 * 100, 0, 100))
        phase_delta = round(phase_value - phase_value_prev, 1)

        # Smoothed phase: compute raw series then apply confirmation filter
        days_in_phase = 0
        previous_phase = None
        phase = classify_phase(rs_ratio, rs_mom)  # fallback
        if len(c) >= 60:
            _rs = c / sector_close.reindex(c.index)
            _rs_sma = _rs.rolling(20).mean()
            _rr = (_rs / _rs_sma) * 100
            _rm = (_rr / _rr.shift(20)) * 100
            _raw_phases = []
            for _day in _rm.dropna().index:
                _raw_phases.append(classify_phase(float(_rr.loc[_day]), float(_rm.loc[_day])))
            _smoothed = smooth_phase_series(_raw_phases[-60:])
            if _smoothed:
                phase = _smoothed[-1]
                current = _smoothed[-1]
                count = 0
                for k in range(len(_smoothed) - 1, -1, -1):
                    if _smoothed[k] == current:
                        count += 1
                    else:
                        break
                days_in_phase = count
                for k in range(len(_smoothed) - days_in_phase - 1, -1, -1):
                    if _smoothed[k] != current:
                        previous_phase = _smoothed[k]
                        break

        # Leader/laggard vs sector ETF
        sector_relative = "leader" if r5 > sector_r5 else "laggard"

        # Volume ratio
        v_avg = volume[ticker].rolling(20).mean().iloc[-1] if ticker in volume.columns else 1
        v_now = volume[ticker].iloc[-1] if ticker in volume.columns else 1
        vol_ratio = float(v_now / v_avg) if v_avg > 0 and not np.isnan(v_avg) else 1.0

        # RSI
        rsi_val = 50.0
        if len(c) >= 14:
            rsi_s = compute_rsi_series(c)
            rv = rsi_s.iloc[-1]
            if not np.isnan(rv):
                rsi_val = round(float(rv), 1)

        # Market weight proxy: price * avg daily volume (dollar volume)
        price = float(c.iloc[-1]) if len(c) > 0 else 0
        avg_vol = float(volume[ticker].rolling(20).mean().iloc[-1]) if ticker in volume.columns else 0
        dollar_vol = price * avg_vol if not np.isnan(price * avg_vol) else 0

        stocks.append({
            "id": ticker,
            "name": ticker,
            "return_5d": round(r5, 5),
            "return_20d": round(r20, 5),
            "volume_ratio": round(vol_ratio, 2),
            "momentum_phase": phase,
            "phase_value": round(phase_value, 1),
            "phase_delta": phase_delta,
            "rs_ratio": round(rs_ratio, 1),
            "rs_momentum": round(rs_mom, 1),
            "rsi": rsi_val,
            "sector_relative": sector_relative,
            "days_in_phase": days_in_phase,
            "previous_phase": previous_phase,
            "_dollar_vol": dollar_vol,
        })

    # Compute relative weight (normalize to 0-100)
    if stocks:
        max_dv = max(s["_dollar_vol"] for s in stocks) or 1
        for s in stocks:
            s["weight"] = round(s["_dollar_vol"] / max_dv * 100, 1)
            del s["_dollar_vol"]

    # Sort by phase then phase_value
    phase_order = {"leading": 0, "improving": 1, "weakening": 2, "lagging": 3}
    stocks.sort(key=lambda s: (phase_order.get(s["momentum_phase"], 2), -s["phase_value"]))

    # Pairwise return correlations between stocks (20-day)
    correlations = []
    stock_tickers = [s["id"] for s in stocks]
    if len(stock_tickers) >= 2:
        returns_df = close[stock_tickers].pct_change().tail(20).dropna()
        if len(returns_df) >= 10:
            corr_matrix = returns_df.corr()
            for i, t1 in enumerate(stock_tickers):
                for t2 in stock_tickers[i + 1:]:
                    if t1 in corr_matrix.columns and t2 in corr_matrix.columns:
                        c = float(corr_matrix.loc[t1, t2])
                        if not np.isnan(c) and abs(c) > 0.4:
                            correlations.append({
                                "source": t1,
                                "target": t2,
                                "correlation": round(c, 3),
                            })
        correlations.sort(key=lambda x: abs(x["correlation"]), reverse=True)
        correlations = correlations[:20]

    return {
        "etf": etf,
        "sector_name": meta["name"],
        "sector_color": meta["color"],
        "date": datetime.now().strftime("%Y-%m-%d"),
        "stocks": stocks,
        "correlations": correlations,
    }


# ---------------------------------------------------------------------------
# Signal history — backfill + daily tracking
# ---------------------------------------------------------------------------
def backfill_signal_history(data_all):
    """Replay 90 days of price data to build full signal history."""
    close = data_all["Close"]
    spy = close[BENCHMARK]

    # Build ticker → sector mapping
    ticker_sector = {}
    for etf, holdings in SECTOR_HOLDINGS.items():
        for t in holdings:
            if t in close.columns:
                ticker_sector[t] = etf

    all_tickers = list(ticker_sector.keys())

    # Compute full phase series + RS-Momentum + RSI for each stock vs sector ETF
    phase_series = {}
    rm_series = {}
    rsi_series = {}
    for ticker in all_tickers:
        c = close[ticker].dropna()
        if len(c) < 40:
            continue
        etf = ticker_sector[ticker]
        sector_close = close[etf].dropna()
        common = c.index.intersection(sector_close.index)
        c = c.loc[common]
        s = sector_close.loc[common]
        if len(c) < 40:
            continue

        rs = c / s
        rs_sma = rs.rolling(20).mean()
        rr = (rs / rs_sma) * 100
        rm = (rr / rr.shift(20)) * 100

        phases = pd.Series(np.nan, index=rr.index)
        valid = rm.dropna().index
        phases.loc[valid] = "lagging"
        mask_rr = rr.loc[valid]
        mask_rm = rm.loc[valid]
        phases.loc[valid[(mask_rr >= 100) & (mask_rm >= 100)]] = "leading"
        phases.loc[valid[(mask_rr >= 100) & (mask_rm < 100)]] = "weakening"
        phases.loc[valid[(mask_rr < 100) & (mask_rm >= 100)]] = "improving"
        phase_series[ticker] = phases.dropna()
        rm_series[ticker] = rm
        rsi_series[ticker] = compute_rsi_series(close[ticker].dropna())

    # Get trading days — use all available after RS warmup (~40 days)
    trading_days = spy.dropna().index
    # RS needs 20d SMA + 20d shift = 40 days warmup, leave 50 for safety
    start_idx = max(0, 50)
    replay_days = trading_days[start_idx:]

    history = []
    active_signals = {}  # ticker → signal dict

    for i, day in enumerate(replay_days):
        date_str = day.strftime("%Y-%m-%d")
        spy_price = float(spy.loc[day])

        for ticker in phase_series:
            ps = phase_series[ticker]
            if day not in ps.index:
                continue

            phase_today = ps.loc[day]

            # Find yesterday's phase
            day_pos = ps.index.get_loc(day)
            if day_pos == 0:
                continue
            phase_yesterday = ps.iloc[day_pos - 1]

            # Check for new signal: entering improving with strong momentum
            if phase_today == "improving" and phase_yesterday != "improving":
                # Filter: RS-Momentum must be >= 101 (not just barely crossing 100)
                rm_val = rm_series[ticker].loc[day] if day in rm_series[ticker].index else 100
                if rm_val < 103:
                    continue
                if ticker not in active_signals and ticker in close.columns:
                    stock_price = float(close[ticker].loc[day])
                    if not np.isnan(stock_price):
                        etf = ticker_sector[ticker]
                        rsi_val = 50.0
                        if ticker in rsi_series and day in rsi_series[ticker].index:
                            rv = rsi_series[ticker].loc[day]
                            if not np.isnan(rv):
                                rsi_val = round(float(rv), 0)
                        sig = {
                            "ticker": ticker,
                            "sector": etf,
                            "sector_name": SECTOR_ETFS[etf]["name"],
                            "open_date": date_str,
                            "open_price": stock_price,
                            "spy_open_price": spy_price,
                            "current_phase": "improving",
                            "days_active": 0,
                            "return_vs_spy": 0.0,
                            "return_abs": 0.0,
                            "rsi": rsi_val,
                            "status": "active",
                            "close_date": None,
                            "close_reason": None,
                        }
                        active_signals[ticker] = sig
                        history.append(sig)

            # Update active signals
            if ticker in active_signals:
                sig = active_signals[ticker]
                stock_price = float(close[ticker].loc[day]) if ticker in close.columns else np.nan
                if not np.isnan(stock_price):
                    stock_ret = stock_price / sig["open_price"] - 1
                    spy_ret = spy_price / sig["spy_open_price"] - 1
                    sig["return_vs_spy"] = round(stock_ret - spy_ret, 5)
                    sig["return_abs"] = round(stock_ret, 5)
                sig["current_phase"] = phase_today
                open_date = datetime.strptime(sig["open_date"], "%Y-%m-%d")
                sig["days_active"] = (day.to_pydatetime().replace(tzinfo=None) - open_date).days

                # Close conditions
                if phase_today == "leading":
                    sig["status"] = "closed"
                    sig["close_date"] = date_str
                    sig["close_reason"] = "confirmed"
                    del active_signals[ticker]
                elif phase_today in ("weakening", "lagging"):
                    sig["status"] = "closed"
                    sig["close_date"] = date_str
                    sig["close_reason"] = "reversed"
                    del active_signals[ticker]
                elif sig["days_active"] > 30:
                    sig["status"] = "closed"
                    sig["close_date"] = date_str
                    sig["close_reason"] = "expired"
                    del active_signals[ticker]

    # Sort: active first (newest first), then closed by close_date descending (most recent first)
    history.sort(key=lambda s: (
        0 if s["status"] == "active" else 1,
        s.get("close_date") or s.get("open_date") or "",
    ), reverse=False)
    # Reverse within each group: active newest first, closed newest first
    active_sigs = [s for s in history if s["status"] == "active"]
    closed_sigs = [s for s in history if s["status"] == "closed"]
    active_sigs.sort(key=lambda s: s.get("open_date", ""), reverse=True)
    closed_sigs.sort(key=lambda s: s.get("close_date", ""), reverse=True)
    history = active_sigs + closed_sigs

    active = [s for s in history if s["status"] == "active"]
    closed = [s for s in history if s["status"] == "closed"]
    wins = [s for s in closed if s.get("return_vs_spy", 0) > 0]
    print(f"  Backfill: {len(history)} signals ({len(active)} active, "
          f"{len(closed)} closed, {len(wins)}/{len(closed)} wins)")

    return history


def update_signal_history(result, data_all, history_path):
    """Track signals: open on Accélération entry, close on Confirmé or failure."""
    history = []
    if history_path.exists():
        with open(history_path) as f:
            try:
                history = json.load(f)
            except json.JSONDecodeError:
                history = []

    today = result["metadata"]["date"]
    close = data_all["Close"]
    spy_close = float(close[BENCHMARK].iloc[-1])

    # Build phase lookup from current signals + sector detail files
    phase_lookup = {}
    sectors_dir = history_path.parent / "sectors"
    for etf in SECTOR_ETFS:
        sector_file = sectors_dir / f"{etf}.json"
        if sector_file.exists():
            with open(sector_file) as f:
                sector_data = json.load(f)
            for s in sector_data["stocks"]:
                phase_lookup[s["id"]] = s["momentum_phase"]

    # Update existing active signals
    for sig in history:
        if sig["status"] != "active":
            continue

        ticker = sig["ticker"]
        if ticker not in close.columns or np.isnan(close[ticker].iloc[-1]):
            continue

        current_price = float(close[ticker].iloc[-1])
        stock_return = current_price / sig["open_price"] - 1
        spy_return = spy_close / sig["spy_open_price"] - 1
        sig["return_vs_spy"] = round(stock_return - spy_return, 5)
        sig["return_abs"] = round(stock_return, 5)
        sig["current_phase"] = phase_lookup.get(ticker, sig.get("current_phase", "improving"))
        sig["days_active"] = (datetime.strptime(today, "%Y-%m-%d") - datetime.strptime(sig["open_date"], "%Y-%m-%d")).days

        # Close conditions
        if sig["current_phase"] == "leading":
            sig["status"] = "closed"
            sig["close_date"] = today
            sig["close_reason"] = "confirmed"
        elif sig["current_phase"] in ("weakening", "lagging"):
            sig["status"] = "closed"
            sig["close_date"] = today
            sig["close_reason"] = "reversed"
        elif sig["days_active"] > 30:
            sig["status"] = "closed"
            sig["close_date"] = today
            sig["close_reason"] = "expired"

    # Find new signals: stocks entering improving with strong momentum (RS-Mom >= 101)
    existing_active = {s["ticker"] for s in history if s["status"] == "active"}
    for sig in result.get("signals", []):
        if sig["phase"] != "improving" or sig["days_in_phase"] > 2:
            continue
        if sig.get("rs_momentum", 100) < 103:
            continue
        ticker = sig["ticker"]
        if ticker in existing_active:
            continue
        if ticker not in close.columns or np.isnan(close[ticker].iloc[-1]):
            continue

        rsi_val = 50.0
        c = close[ticker].dropna()
        if len(c) >= 14:
            rsi_s = compute_rsi_series(c)
            rv = rsi_s.iloc[-1]
            if not np.isnan(rv):
                rsi_val = round(float(rv), 0)

        history.append({
            "ticker": ticker,
            "sector": sig["sector"],
            "sector_name": sig["sector_name"],
            "open_date": today,
            "open_price": float(close[ticker].iloc[-1]),
            "spy_open_price": spy_close,
            "current_phase": "improving",
            "days_active": 0,
            "return_vs_spy": 0.0,
            "return_abs": 0.0,
            "rsi": rsi_val,
            "status": "active",
            "close_date": None,
            "close_reason": None,
        })

    # Purge signals older than 60 days (keep active regardless)
    cutoff = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=60)).strftime("%Y-%m-%d")
    history = [s for s in history if s["status"] == "active" or s["open_date"] >= cutoff]

    # Sort: active first (newest first), then closed by close_date descending (most recent first)
    active_sigs = [s for s in history if s["status"] == "active"]
    closed_sigs = [s for s in history if s["status"] == "closed"]
    active_sigs.sort(key=lambda s: s.get("open_date", ""), reverse=True)
    closed_sigs.sort(key=lambda s: s.get("close_date", ""), reverse=True)
    history = active_sigs + closed_sigs

    with open(history_path, "w") as f:
        json.dump(history, f, indent=2)

    return history


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="S&P 500 Sector Rotation Pipeline")
    parser.add_argument("--sample", action="store_true",
                        help="Generate sample data (no yfinance needed)")
    parser.add_argument("--output", default=None,
                        help="Output JSON path (default: data/latest.json)")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    output_path = Path(args.output) if args.output else project_root / "data" / "latest.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if args.sample:
        print("Generating sample data...")
        result = generate_sample_data()
        data_all = None
        data_etf = None
    else:
        global pd, yf
        import shutil as _shutil
        _cache = os.path.expanduser("~/Library/Caches/py-yfinance")
        if os.path.exists(_cache):
            _shutil.rmtree(_cache)
        import pandas as _pd
        import yfinance as _yf
        pd = _pd
        yf = _yf

        # Fetch sector ETFs + benchmark
        data_etf = fetch_ohlcv()
        print("Computing rotation signals...")
        result = detect_rotations(data_etf)

        # Fetch individual holdings for sector detail
        all_holdings = []
        for h_list in SECTOR_HOLDINGS.values():
            all_holdings.extend(h_list)
        all_holdings = list(set(all_holdings))
        print(f"Downloading {len(all_holdings)} individual stocks for sector detail...")
        data_stocks = yf.download(all_holdings, period="2y", progress=False, auto_adjust=True)

        # Merge sector ETF data + stock data
        data_all = {}
        for field in ["Close", "High", "Low", "Volume"]:
            sector_df = data_etf[field]
            stock_df = data_stocks[field] if field in data_stocks else _pd.DataFrame()
            data_all[field] = _pd.concat([sector_df, stock_df], axis=1)
            # Remove duplicate columns
            data_all[field] = data_all[field].loc[:, ~data_all[field].columns.duplicated()]

    # Generate sector detail files + collect signals
    signals = []
    if data_all is not None:
        sectors_dir = output_path.parent / "sectors"
        sectors_dir.mkdir(exist_ok=True)
        for etf in SECTOR_ETFS:
            detail = compute_sector_detail(etf, data_all)
            if detail:
                with open(sectors_dir / f"{etf}.json", "w") as f:
                    json.dump(detail, f, indent=2)
                print(f"  {etf}: {len(detail['stocks'])} stocks")

                # Collect fresh signals (days_in_phase <= 5)
                sector_name = SECTOR_ETFS[etf]["name"]
                for s in detail["stocks"]:
                    dip = s.get("days_in_phase", 99)
                    phase = s["momentum_phase"]
                    prev = s.get("previous_phase")
                    if dip <= 5 and phase in ("improving", "leading"):
                        signals.append({
                            "ticker": s["id"],
                            "sector": etf,
                            "sector_name": sector_name,
                            "phase": phase,
                            "previous_phase": prev,
                            "days_in_phase": dip,
                            "return_5d": s["return_5d"],
                            "phase_value": s["phase_value"],
                            "rs_momentum": s.get("rs_momentum", 100),
                        })
            else:
                print(f"  {etf}: no data")

    # Sort signals: improving first, then by days_in_phase
    signals.sort(key=lambda s: (0 if s["phase"] == "improving" else 1, s["days_in_phase"]))
    result["signals"] = signals
    print(f"  Signals: {len([s for s in signals if s['phase'] == 'improving'])} acceleration, "
          f"{len([s for s in signals if s['phase'] == 'leading'])} confirme")

    # Signal history: backfill on first run, then daily update
    history_path = output_path.parent / "signals_history.json"
    if data_all is not None:
        needs_backfill = not history_path.exists()
        if not needs_backfill:
            try:
                with open(history_path) as f:
                    existing = json.load(f)
                needs_backfill = len(existing) == 0 or all(
                    s.get("days_active", 0) == 0 for s in existing
                )
            except (json.JSONDecodeError, KeyError):
                needs_backfill = True

        if needs_backfill:
            print("  Backfilling signal history from 2 years of data...")
            history = backfill_signal_history(data_all)
            with open(history_path, "w") as f:
                json.dump(history, f, indent=2)
        else:
            history = update_signal_history(result, data_all, history_path)
            active = [s for s in history if s["status"] == "active"]
            closed = [s for s in history if s["status"] == "closed"]
            wins = [s for s in closed if s.get("return_vs_spy", 0) > 0]
            print(f"  Signal history: {len(active)} active, {len(closed)} closed "
                  f"({len(wins)}/{len(closed)} wins)")

        # Load final history for output
        with open(history_path) as f:
            result["signals_history"] = json.load(f)
    else:
        result["signals_history"] = []

    # Generate sector history for RRG playback
    rrg_history_path = output_path.parent / "history.json"
    if data_etf is not None:
        print("Generating sector history for RRG playback...")
        rrg_history = generate_sector_history(data_etf, days=252)
        with open(rrg_history_path, "w") as f:
            json.dump(rrg_history, f)
        print(f"  History: {len(rrg_history['dates'])} days, {len(rrg_history['sectors'])} sectors")
    else:
        # Sample mode
        rrg_history = _generate_sample_history(days=90)
        with open(rrg_history_path, "w") as f:
            json.dump(rrg_history, f)

    # Re-write with signals included
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)

    js_path = output_path.parent / "data.js"
    with open(js_path, "w") as f:
        f.write("window.ROTATION_DATA = ")
        json.dump(result, f, indent=2)
        f.write(";\n")

    meta = result["metadata"]
    print(f"\nDone! {meta['date']}")
    print(f"  Market state: {meta['market_state']} (avg corr: {meta['avg_correlation']})")
    print(f"  Sectors: {meta['total_sectors']}")
    print(f"  {meta.get('narrative', '')}")
    print(f"  Output: {output_path}")


if __name__ == "__main__":
    main()
