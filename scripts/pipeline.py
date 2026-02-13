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
# Indicator calculations
# ---------------------------------------------------------------------------
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
    for t in valid:
        r5 = close[t].iloc[-1] / close[t].iloc[-5] - 1 if len(close) >= 5 else 0
        r20 = close[t].iloc[-1] / close[t].iloc[-20] - 1 if len(close) >= 20 else 0
        ret_5d[t] = float(r5) if not np.isnan(r5) else 0.0
        ret_20d[t] = float(r20) if not np.isnan(r20) else 0.0
        residuals_5d[t] = ret_5d[t] - betas[t] * bench_5d

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

        # Momentum phase — 4 RRG quadrants
        if rs_ratio >= 100 and rs_mom >= 100:
            phase = "leading"
        elif rs_ratio < 100 and rs_mom >= 100:
            phase = "improving"
        elif rs_ratio >= 100 and rs_mom < 100:
            phase = "weakening"
        else:
            phase = "lagging"

        # Phase value 0-100 — composite of RS-Ratio + RS-Momentum
        phase_value = float(np.clip(((rs_ratio - 95) + (rs_mom - 95)) / 20 * 100, 0, 100))

        # Phase trend: delta vs 5 days ago
        phase_value_prev = float(np.clip(((rs_ratio_prev - 95) + (rs_mom_prev - 95)) / 20 * 100, 0, 100))
        phase_delta = round(phase_value - phase_value_prev, 1)

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
        })

    # --- Pairwise rotation scoring ---
    # 20-day residual return correlation
    beta_adj = pd.DataFrame(
        bench_returns.values.reshape(-1, 1) * np.array([betas[t] for t in valid]).reshape(1, -1),
        index=returns.index, columns=valid,
    )
    resid_returns = returns[valid] - beta_adj
    corr_window = min(20, len(resid_returns) - 1)
    recent_resid = resid_returns.tail(corr_window)

    rotations = []
    for i, src in enumerate(valid):
        for tgt in valid[i + 1:]:
            # Determine direction: who outperforms over the week
            ret_div = residuals_5d[tgt] - residuals_5d[src]
            if abs(ret_div) < 0.01:
                continue  # Need at least 1% divergence over 5 days

            # Always orient from source (underperformer) to target (outperformer)
            if ret_div < 0:
                src_t, tgt_t = tgt, src
                ret_div = -ret_div
            else:
                src_t, tgt_t = src, tgt

            # --- Confirmation filters ---
            tgt_cmf = indicators[tgt_t]["cmf"]
            src_cmf = indicators[src_t]["cmf"]
            # CMF: target must have positive buying pressure
            cmf_confirms = tgt_cmf > 0 and tgt_cmf > src_cmf
            # Volume: at least one sector must be above average
            vol_tgt = vol_ratio_all[tgt_t]
            vol_src = vol_ratio_all[src_t]
            vol_confirms = max(vol_tgt, vol_src) >= 1.0

            # Must have at least one confirmation
            if not cmf_confirms and not vol_confirms:
                continue

            # Composite score
            mfi_div = (indicators[tgt_t]["mfi"] - indicators[src_t]["mfi"]) / 100
            cmf_div = tgt_cmf - src_cmf
            vol_conf = (vol_tgt + vol_src) / 2
            score = (
                ret_div * 100 * 0.35 +
                (max(0, cmf_div) * 0.30 if cmf_confirms else 0) +
                max(0, mfi_div) * 0.20 +
                (vol_conf * 0.15 if vol_confirms else 0)
            )
            if score <= 0.5:
                continue  # Only strong, confirmed signals

            # Correlation
            if src_t in recent_resid.columns and tgt_t in recent_resid.columns:
                corr = recent_resid[src_t].corr(recent_resid[tgt_t])
                corr = float(corr) if not np.isnan(corr) else 0
            else:
                corr = 0

            rotations.append({
                "source": src_t,
                "target": tgt_t,
                "source_name": SECTOR_ETFS[src_t]["name"],
                "target_name": SECTOR_ETFS[tgt_t]["name"],
                "score": round(score, 3),
                "return_divergence": round(ret_div * 100, 2),
                "volume_confirmed": vol_confirms,
                "cmf_confirmed": cmf_confirms,
                "correlation": round(corr, 3),
            })

    rotations.sort(key=lambda x: x["score"], reverse=True)
    rotations = rotations[:8]  # Keep only the strongest confirmed signals

    # Market state
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

    # Narrative
    narrative = _generate_narrative(nodes, rotations, market_state, avg_corr)

    return {
        "metadata": {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "market_state": market_state,
            "avg_correlation": round(avg_corr, 3),
            "total_sectors": len(valid),
            "significant_rotations": len(rotations),
            "benchmark_return": round(float(latest_bench), 5),
            "narrative": narrative,
        },
        "nodes": nodes,
        "rotations": rotations,
    }


def _generate_narrative(nodes, rotations, market_state, avg_corr):
    """Generate a simple, factual sentence."""
    if market_state == "high_correlation":
        return "Tous les secteurs bougent ensemble — pas de rotation notable."

    parts = []

    # Top confirmed rotation
    if rotations:
        r = rotations[0]
        parts.append(f"{r['target_name']} surperforme {r['source_name']} cette semaine")
        confirms = []
        if r.get("volume_confirmed"):
            confirms.append("volumes")
        if r.get("cmf_confirmed"):
            confirms.append("flux acheteurs")
        if confirms:
            parts[-1] += f", confirme par les {' et '.join(confirms)}"

    # Overall picture
    gaining = sorted([n for n in nodes if n["return_5d"] > 0.01],
                     key=lambda x: -x["return_5d"])
    losing = sorted([n for n in nodes if n["return_5d"] < -0.01],
                    key=lambda x: x["return_5d"])

    if gaining and not rotations:
        names = " et ".join(n["name"] for n in gaining[:2])
        parts.append(f"{names} en hausse cette semaine")
    if losing:
        names = " et ".join(n["name"] for n in losing[:2])
        parts.append(f"{names} en baisse")

    if not parts:
        return "Semaine calme, pas de rotation sectorielle notable."

    return ". ".join(parts) + "."


# ---------------------------------------------------------------------------
# Sample data (for testing without API)
# ---------------------------------------------------------------------------
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

    # Build rotations from biased data (with confirmation filters)
    rotations = []
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            ni, nj = nodes[i], nodes[j]
            ret_div = nj["residual_return"] - ni["residual_return"]
            if abs(ret_div) < 0.01:
                continue
            if ret_div < 0:
                src, tgt = nj, ni
                ret_div = -ret_div
            else:
                src, tgt = ni, nj

            cmf_confirms = tgt["cmf"] > 0 and tgt["cmf"] > src["cmf"]
            vol_confirms = max(src["volume_ratio"], tgt["volume_ratio"]) >= 1.0
            if not cmf_confirms and not vol_confirms:
                continue

            mfi_div = (tgt["mfi"] - src["mfi"]) / 100
            cmf_div = tgt["cmf"] - src["cmf"]
            vol_conf = (src["volume_ratio"] + tgt["volume_ratio"]) / 2
            corr = float(rng.uniform(-0.5, 0.3))
            score = (
                ret_div * 100 * 0.35 +
                (max(0, cmf_div) * 0.30 if cmf_confirms else 0) +
                max(0, mfi_div) * 0.20 +
                (vol_conf * 0.15 if vol_confirms else 0)
            )
            if score > 0.5:
                rotations.append({
                    "source": src["id"],
                    "target": tgt["id"],
                    "source_name": src["name"],
                    "target_name": tgt["name"],
                    "score": round(score, 3),
                    "return_divergence": round(ret_div * 100, 2),
                    "volume_confirmed": vol_confirms,
                    "cmf_confirmed": cmf_confirms,
                    "correlation": round(corr, 3),
                })

    rotations.sort(key=lambda x: x["score"], reverse=True)
    rotations = rotations[:8]

    narrative = _generate_narrative(nodes, rotations, "normal", 0.35)

    return {
        "metadata": {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "market_state": "normal",
            "avg_correlation": 0.35,
            "total_sectors": len(nodes),
            "significant_rotations": len(rotations),
            "benchmark_return": bench_ret,
            "narrative": narrative,
        },
        "nodes": nodes,
        "rotations": rotations,
    }


# ---------------------------------------------------------------------------
# Sector detail — individual stock phases
# ---------------------------------------------------------------------------
def compute_sector_detail(etf, data_all):
    """Compute phases for individual stocks vs SPY (market), with sector-relative indicator."""
    holdings = SECTOR_HOLDINGS.get(etf, [])
    if not holdings:
        return None

    meta = SECTOR_ETFS[etf]
    spy = data_all["Close"][BENCHMARK]          # phases vs SPY
    sector_close = data_all["Close"][etf]       # for leader/laggard

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

        # RS-Ratio/Momentum vs SPY (market)
        rs_ratio, rs_mom, rs_ratio_prev, rs_mom_prev = compute_rs(c, spy)

        # Phase — 4 RRG quadrants
        if rs_ratio >= 100 and rs_mom >= 100:
            phase = "leading"
        elif rs_ratio < 100 and rs_mom >= 100:
            phase = "improving"
        elif rs_ratio >= 100 and rs_mom < 100:
            phase = "weakening"
        else:
            phase = "lagging"

        phase_value = float(np.clip(((rs_ratio - 95) + (rs_mom - 95)) / 20 * 100, 0, 100))

        phase_value_prev = float(np.clip(((rs_ratio_prev - 95) + (rs_mom_prev - 95)) / 20 * 100, 0, 100))
        phase_delta = round(phase_value - phase_value_prev, 1)

        # Days in current phase: compute phase series for last 30 days
        days_in_phase = 0
        if len(c) >= 60:
            _rs = c / spy.reindex(c.index)
            _rs_sma = _rs.rolling(20).mean()
            _rr = (_rs / _rs_sma) * 100
            _rm = (_rr / _rr.shift(20)) * 100
            _phases = pd.Series("lagging", index=_rr.index)
            _phases[(_rr >= 100) & (_rm >= 100)] = "leading"
            _phases[(_rr >= 100) & (_rm < 100)] = "weakening"
            _phases[(_rr < 100) & (_rm >= 100)] = "improving"
            _phases = _phases.dropna().tail(30).values
            if len(_phases) > 1:
                current = _phases[-1]
                count = 0
                for k in range(len(_phases) - 1, -1, -1):
                    if _phases[k] == current:
                        count += 1
                    else:
                        break
                days_in_phase = count
        previous_phase = None
        if len(c) >= 60 and len(_phases) > 1:
            # Find the phase before the current streak
            current = _phases[-1]
            for k in range(len(_phases) - days_in_phase - 1, -1, -1):
                if _phases[k] != current:
                    previous_phase = _phases[k]
                    break

        # Leader/laggard vs sector ETF
        sector_relative = "leader" if r5 > sector_r5 else "laggard"

        # Volume ratio
        v_avg = volume[ticker].rolling(20).mean().iloc[-1] if ticker in volume.columns else 1
        v_now = volume[ticker].iloc[-1] if ticker in volume.columns else 1
        vol_ratio = float(v_now / v_avg) if v_avg > 0 and not np.isnan(v_avg) else 1.0

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

    # Compute full phase series + RS-Momentum for each stock
    phase_series = {}
    rm_series = {}
    for ticker in all_tickers:
        c = close[ticker].dropna()
        if len(c) < 40:
            continue
        common = c.index.intersection(spy.index)
        c = c.loc[common]
        s = spy.loc[common]
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
                if rm_val < 101:
                    continue
                if ticker not in active_signals and ticker in close.columns:
                    stock_price = float(close[ticker].loc[day])
                    if not np.isnan(stock_price):
                        etf = ticker_sector[ticker]
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
        if sig.get("rs_momentum", 100) < 101:
            continue
        ticker = sig["ticker"]
        if ticker in existing_active:
            continue
        if ticker not in close.columns or np.isnan(close[ticker].iloc[-1]):
            continue

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
        data = fetch_ohlcv()
        print("Computing rotation signals...")
        result = detect_rotations(data)

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
            sector_df = data[field]
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
    print(f"  Sectors: {meta['total_sectors']} | Rotations: {meta['significant_rotations']}")
    print(f"  {meta.get('narrative', '')}")
    print(f"  Output: {output_path}")


if __name__ == "__main__":
    main()
