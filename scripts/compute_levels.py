#!/usr/bin/env python3
"""
compute_levels.py - Compute support/resistance levels for stocks in GOLD position.

Scans sector history files to find stocks below -20% of MA50 (GOLD position),
downloads OHLCV data, computes technical levels using 7 methods, scores them,
and saves results to data/levels.json.
"""

import json
import os
import glob
import numpy as np
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECTORS_DIR = os.path.join(BASE_DIR, "data", "sectors")
OUTPUT_FILE = os.path.join(BASE_DIR, "data", "levels.json")

GOLD_THRESHOLD = -0.20  # ma50 <= -20%


# ---------------------------------------------------------------------------
# 1. Find GOLD stocks
# ---------------------------------------------------------------------------

def find_gold_stocks():
    """
    Scan all sector history files and replay the same entry/exit logic as app.js:
    - Entry: stock goes below -20% of MA50
    - Exit: Take Profit +5% from entry price
    Returns tickers that are currently in an active GOLD trade.
    """
    gold = {}
    for path in sorted(glob.glob(os.path.join(SECTORS_DIR, "*_history.json"))):
        with open(path) as f:
            data = json.load(f)
        sector = data.get("sector_name", os.path.basename(path).replace("_history.json", ""))
        dates = data.get("dates", [])
        for ticker, info in data.get("stocks", {}).items():
            ma50_list = info.get("ma50", [])
            close_list = info.get("close", [])
            rsi_list = info.get("rsi", [])
            if not ma50_list or not close_list:
                continue

            # Replay trade logic (same as app.js)
            in_trade = False
            entry_price = None
            for i in range(len(ma50_list)):
                if in_trade:
                    # Exit: TP +5%
                    cur = close_list[i] if i < len(close_list) else None
                    if cur is not None and entry_price and cur >= entry_price * 1.05:
                        in_trade = False
                        entry_price = None
                else:
                    # Entry: below -20% of MA50
                    m = ma50_list[i]
                    if m is not None and m < GOLD_THRESHOLD:
                        in_trade = True
                        entry_price = close_list[i] if i < len(close_list) else None

            if in_trade:
                last_ma50 = ma50_list[-1] if ma50_list[-1] is not None else 0
                gold[ticker] = {
                    "sector": sector,
                    "ma50_pct": round(last_ma50 * 100, 2),
                    "last_close": close_list[-1] if close_list else None,
                    "last_rsi": rsi_list[-1] if rsi_list else None,
                    "last_date": dates[-1] if dates else None,
                }
    return gold


# ---------------------------------------------------------------------------
# 2. Download OHLCV
# ---------------------------------------------------------------------------

def download_ohlcv(tickers, period="1y"):
    """Download 1 year of daily OHLCV for a list of tickers (batch of 10 max)."""
    all_data = {}
    batch_size = 10
    for i in range(0, len(tickers), batch_size):
        batch = tickers[i:i + batch_size]
        print(f"  Downloading batch {i // batch_size + 1}: {', '.join(batch)}")
        try:
            raw = yf.download(batch, period=period, group_by="ticker", progress=False)
            for t in batch:
                try:
                    if len(batch) == 1:
                        df = raw.copy()
                    else:
                        df = raw[t].copy()
                    # Flatten multi-level columns if needed
                    if isinstance(df.columns, pd.MultiIndex):
                        df.columns = df.columns.get_level_values(-1)
                    df = df.dropna(subset=["Close"])
                    if len(df) >= 50:
                        all_data[t] = df
                    else:
                        print(f"    {t}: not enough data ({len(df)} rows), skipping")
                except Exception as e:
                    print(f"    {t}: error extracting data - {e}")
        except Exception as e:
            print(f"    Batch download error: {e}")
    return all_data


# ---------------------------------------------------------------------------
# 3. Level detection methods
# ---------------------------------------------------------------------------

def find_swing_levels(df, order=10):
    """Find swing highs and lows of given order."""
    highs = df["High"].values
    lows = df["Low"].values
    n = len(highs)
    levels = []

    for i in range(order, n - order):
        # Swing high
        if highs[i] == max(highs[i - order:i + order + 1]):
            levels.append(highs[i])
        # Swing low
        if lows[i] == min(lows[i - order:i + order + 1]):
            levels.append(lows[i])

    return levels


def cluster_levels(levels, tolerance=0.015):
    """Cluster nearby levels within tolerance (1.5%) and return centroids."""
    if not levels:
        return []
    levels = sorted(levels)
    clusters = [[levels[0]]]
    for lv in levels[1:]:
        if abs(lv - clusters[-1][-1]) / clusters[-1][-1] <= tolerance:
            clusters[-1].append(lv)
        else:
            clusters.append([lv])
    return [np.mean(c) for c in clusters]


def method_swing_levels(df):
    """Method 1: Swing highs/lows at orders 5, 10, 20."""
    all_levels = []
    for order in [5, 10, 20]:
        all_levels.extend(find_swing_levels(df, order=order))
    return cluster_levels(all_levels)


def method_moving_averages(df):
    """Method 2: MA20, MA50, MA100, MA200, EMA21."""
    close = df["Close"]
    levels = []
    for w in [20, 50, 100, 200]:
        if len(close) >= w:
            levels.append(float(close.rolling(w).mean().iloc[-1]))
    if len(close) >= 21:
        levels.append(float(close.ewm(span=21, adjust=False).mean().iloc[-1]))
    return [lv for lv in levels if not np.isnan(lv)]


def method_bollinger(df):
    """Method 3: Bollinger Bands (20-period, 2 std)."""
    close = df["Close"]
    if len(close) < 20:
        return []
    ma20 = close.rolling(20).mean().iloc[-1]
    std20 = close.rolling(20).std().iloc[-1]
    if np.isnan(ma20) or np.isnan(std20):
        return []
    return [float(ma20 - 2 * std20), float(ma20), float(ma20 + 2 * std20)]


def method_fibonacci(df, lookback=120):
    """Method 4: Fibonacci retracement from recent swing high/low."""
    close = df["Close"].values
    recent = close[-lookback:] if len(close) >= lookback else close
    high = float(np.max(recent))
    low = float(np.min(recent))
    diff = high - low
    if diff < 0.01:
        return []
    ratios = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]
    return [high - r * diff for r in ratios]


def method_pivot_points(df):
    """Method 5: Classic pivot points from last close bar."""
    last = df.iloc[-1]
    h, l, c = float(last["High"]), float(last["Low"]), float(last["Close"])
    p = (h + l + c) / 3
    r1 = 2 * p - l
    s1 = 2 * p - h
    r2 = p + (h - l)
    s2 = p - (h - l)
    r3 = h + 2 * (p - l)
    s3 = l - 2 * (h - l)
    return [s3, s2, s1, p, r1, r2, r3]


def method_volume_profile(df, bins=50):
    """Method 6: Volume profile - find price levels with peak volume."""
    close = df["Close"].values
    volume = df["Volume"].values
    if len(close) < 20 or np.sum(volume) == 0:
        return []

    price_min, price_max = np.min(close), np.max(close)
    if price_max - price_min < 0.01:
        return []

    bin_edges = np.linspace(price_min, price_max, bins + 1)
    vol_profile = np.zeros(bins)
    for i in range(len(close)):
        idx = np.searchsorted(bin_edges[1:], close[i])
        idx = min(idx, bins - 1)
        vol_profile[idx] += volume[i]

    # Find peaks: bins higher than both neighbors
    levels = []
    for i in range(1, bins - 1):
        if vol_profile[i] > vol_profile[i - 1] and vol_profile[i] > vol_profile[i + 1]:
            level = (bin_edges[i] + bin_edges[i + 1]) / 2
            levels.append(float(level))
    return levels


def method_round_numbers(df):
    """Method 7: Psychological round number levels near current price."""
    price = float(df["Close"].iloc[-1])
    levels = []

    if price < 10:
        step = 1
    elif price < 50:
        step = 5
    elif price < 200:
        step = 10
    elif price < 500:
        step = 25
    elif price < 1000:
        step = 50
    else:
        step = 100

    # Generate round numbers within +/- 30% of price
    low_bound = price * 0.7
    high_bound = price * 1.3
    start = int(low_bound / step) * step
    lv = start
    while lv <= high_bound:
        if lv > 0:
            levels.append(float(lv))
        lv += step
    return levels


# ---------------------------------------------------------------------------
# 4. Consolidation
# ---------------------------------------------------------------------------

def consolidate_levels(all_method_levels, current_price, merge_pct=0.01):
    """
    Merge levels from all methods within 1% of each other.
    Return supports and resistances with strength counts.
    """
    # Flatten: list of (price, method_id)
    tagged = []
    for method_id, levels in enumerate(all_method_levels):
        for lv in levels:
            if lv > 0 and not np.isnan(lv):
                tagged.append((lv, method_id))

    if not tagged:
        return [], []

    tagged.sort(key=lambda x: x[0])

    # Merge into clusters
    clusters = []
    current_cluster = [tagged[0]]
    for item in tagged[1:]:
        ref_price = np.mean([x[0] for x in current_cluster])
        if abs(item[0] - ref_price) / ref_price <= merge_pct:
            current_cluster.append(item)
        else:
            clusters.append(current_cluster)
            current_cluster = [item]
    clusters.append(current_cluster)

    # Build level objects
    supports = []
    resistances = []
    for cluster in clusters:
        avg_price = round(float(np.mean([x[0] for x in cluster])), 2)
        # Strength = number of distinct methods contributing
        methods = set(x[1] for x in cluster)
        strength = len(methods)
        dist_pct = round((avg_price - current_price) / current_price * 100, 1)

        entry = {"price": avg_price, "dist_pct": dist_pct, "strength": strength}

        # Skip levels too close to price (within 0.1%)
        if abs(dist_pct) < 0.1:
            # Assign to the side with more weight
            resistances.append(entry)
        elif avg_price < current_price:
            supports.append(entry)
        else:
            resistances.append(entry)

    # Sort: supports descending (closest first), resistances ascending (closest first)
    supports.sort(key=lambda x: x["price"], reverse=True)
    resistances.sort(key=lambda x: x["price"])

    return supports, resistances


# ---------------------------------------------------------------------------
# 5. Scoring & verdict
# ---------------------------------------------------------------------------

def compute_trend(df, lookback=20):
    """Determine trend based on recent price action."""
    close = df["Close"].values
    if len(close) < lookback:
        return "Neutre"
    recent = close[-lookback:]
    if recent[-1] > recent[0]:
        return "Hausse"
    else:
        return "Baisse"


def compute_rsi(df, period=14):
    """Compute RSI."""
    close = df["Close"]
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0.0)).rolling(period).mean()
    rs = gain / loss
    rsi = 100 - (100 / (1 + rs))
    val = float(rsi.iloc[-1])
    if np.isnan(val):
        return 50.0
    return round(val, 1)


def compute_score(trend, dist_ma50, dist_ma200, supports, resistances, rsi):
    """
    Score 0-100: quality of the GOLD mean-reversion signal.
    Higher = better bounce opportunity (oversold + strong support + good R/R).
    """
    score = 40  # base — already in GOLD so starts decent

    # RSI: deeply oversold = strong bounce potential
    if rsi < 25:
        score += 20
    elif rsi < 30:
        score += 15
    elif rsi < 35:
        score += 10
    elif rsi < 40:
        score += 5

    # Distance below MA50: sweet spot -20% to -30%
    abs_dist = abs(dist_ma50)
    if 20 <= abs_dist <= 28:
        score += 10  # sweet spot from backtest
    elif 28 < abs_dist <= 35:
        score += 5   # still good
    elif abs_dist > 40:
        score -= 10  # may be in serious trouble

    # Nearest support proximity: close floor = less downside risk
    if supports:
        s_dist = abs(supports[0]["dist_pct"])
        if s_dist <= 2:
            score += 12
        elif s_dist <= 4:
            score += 8
        elif s_dist <= 7:
            score += 4

        # Support strength (confluence)
        s_strength = supports[0]["strength"]
        if s_strength >= 4:
            score += 8
        elif s_strength >= 3:
            score += 5
        elif s_strength >= 2:
            score += 2
    else:
        score -= 5

    # Risk/Reward ratio
    if supports and resistances:
        risk = abs(supports[0]["dist_pct"])
        reward = abs(resistances[0]["dist_pct"])
        if risk > 0:
            rr = reward / risk
            if rr >= 3:
                score += 8
            elif rr >= 2:
                score += 5
            elif rr >= 1:
                score += 2
            else:
                score -= 3

    return max(0, min(100, score))


def get_verdict(score):
    """Return verdict for GOLD signal quality."""
    if score >= 80:
        return "SIGNAL FORT", "Conditions ideales pour un rebond"
    elif score >= 65:
        return "BON SIGNAL", "Bonne configuration pour un rebond"
    elif score >= 50:
        return "SIGNAL CORRECT", "Conditions acceptables"
    elif score >= 35:
        return "SIGNAL FAIBLE", "Peu de catalyseurs pour un rebond"
    else:
        return "PRUDENCE", "Risque eleve malgre la survente"


def rsi_label(rsi):
    if rsi < 30:
        return "Survente"
    elif rsi < 40:
        return "Bas"
    elif rsi > 70:
        return "Surachat"
    elif rsi > 60:
        return "Haut"
    else:
        return "Neutre"


def ma50_label(dist):
    if dist > 5:
        return "Bien au-dessus"
    elif dist > 0:
        return "Au-dessus"
    elif dist > -10:
        return "En-dessous"
    else:
        return "Bien en-dessous"


# ---------------------------------------------------------------------------
# 6. Main pipeline
# ---------------------------------------------------------------------------

def process_stock(ticker, df):
    """Full analysis pipeline for one stock. Returns dict or None."""
    close = df["Close"]
    current_price = float(close.iloc[-1])
    last_date = df.index[-1]

    # All 7 methods
    all_levels = [
        method_swing_levels(df),
        method_moving_averages(df),
        method_bollinger(df),
        method_fibonacci(df),
        method_pivot_points(df),
        method_volume_profile(df),
        method_round_numbers(df),
    ]

    supports, resistances = consolidate_levels(all_levels, current_price)

    # Trim to top 4
    supports = supports[:4]
    resistances = resistances[:4]

    # Trend
    trend = compute_trend(df)

    # RSI
    rsi = compute_rsi(df)

    # MA50 / MA200 distances
    ma50_val = float(close.rolling(50).mean().iloc[-1]) if len(close) >= 50 else current_price
    ma200_val = float(close.rolling(200).mean().iloc[-1]) if len(close) >= 200 else current_price
    dist_ma50 = round((current_price - ma50_val) / ma50_val * 100, 1) if ma50_val else 0
    dist_ma200 = round((current_price - ma200_val) / ma200_val * 100, 1) if ma200_val else 0

    # Swing high/low (120 days)
    lookback = min(120, len(close))
    recent_close = close.values[-lookback:]
    swing_high = round(float(np.max(df["High"].values[-lookback:])), 2)
    swing_low = round(float(np.min(df["Low"].values[-lookback:])), 2)

    # Score
    score = compute_score(trend, dist_ma50, dist_ma200, supports, resistances, rsi)
    verdict, verdict_text = get_verdict(score)

    return {
        "price": round(current_price, 2),
        "date": last_date.strftime("%d/%m/%Y"),
        "score": score,
        "verdict": verdict,
        "verdict_text": verdict_text,
        "trend": trend,
        "swing_high": swing_high,
        "swing_low": swing_low,
        "rsi": rsi,
        "rsi_label": rsi_label(rsi),
        "dist_ma50": dist_ma50,
        "ma50_label": ma50_label(dist_ma50),
        "supports": supports,
        "resistances": resistances,
    }


def main():
    today = datetime.now().strftime("%Y-%m-%d")
    print(f"=== compute_levels.py === {today}")
    print()

    # Step 1: Find GOLD stocks
    print("[1/4] Scanning sector history files for GOLD positions (ma50 <= -20%)...")
    gold_stocks = find_gold_stocks()
    if not gold_stocks:
        print("  No stocks in GOLD position found.")
        # Write empty result
        result = {"date": today, "stocks": {}}
        with open(OUTPUT_FILE, "w") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"\nEmpty result saved to {OUTPUT_FILE}")
        return

    print(f"  Found {len(gold_stocks)} stocks in GOLD position:")
    for t, info in sorted(gold_stocks.items()):
        print(f"    {t:6s}  ma50={info['ma50_pct']:+.1f}%  ({info['sector']})")
    print()

    # Step 2: Download OHLCV
    tickers = sorted(gold_stocks.keys())
    print(f"[2/4] Downloading 1 year of OHLCV data for {len(tickers)} stocks...")
    ohlcv = download_ohlcv(tickers, period="1y")
    print(f"  Successfully downloaded data for {len(ohlcv)}/{len(tickers)} stocks.")
    print()

    # Step 3: Compute levels
    print(f"[3/4] Computing support/resistance levels...")
    results = {}
    for ticker in tickers:
        if ticker not in ohlcv:
            print(f"  {ticker}: skipped (no data)")
            continue
        try:
            entry = process_stock(ticker, ohlcv[ticker])
            if entry:
                results[ticker] = entry
                n_sup = len(entry["supports"])
                n_res = len(entry["resistances"])
                print(f"  {ticker:6s}  price={entry['price']:>8.2f}  score={entry['score']:3d}  "
                      f"verdict={entry['verdict']:12s}  S={n_sup} R={n_res}")
        except Exception as e:
            print(f"  {ticker}: error - {e}")
    print()

    # Step 4: Save
    print(f"[4/4] Saving results...")
    output = {
        "date": today,
        "stocks": results,
    }
    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"  Saved {len(results)} stocks to {OUTPUT_FILE}")
    print()
    print("Done.")


if __name__ == "__main__":
    main()
