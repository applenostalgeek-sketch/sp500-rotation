#!/usr/bin/env python3
"""
Compute sector rotation signals for 11 S&P 500 sectors.
8 BUY signals (R1, R2, R3, F1, F2, G1, G2, M4) and 3 SELL signals (M1, M2, M3).
Composite score = sum(buy) - sum(sell).
Action: BUY (>=3), AVOID (<=-1), NEUTRAL (between).

Position tracking:
- ENTRY: when composite score >= 3 (BUY) and not already in position
- EXIT: when price crosses back above MA50
- Persisted in data/positions.json between runs

Outputs data/signals.json.
"""

import json
import os
import datetime
import numpy as np
import pandas as pd
import yfinance as yf

SECTORS = {
    "XLK":  "Technologie",
    "XLF":  "Finance",
    "XLV":  "Sante",
    "XLY":  "Conso. Discret.",
    "XLC":  "Communication",
    "XLI":  "Industrie",
    "XLP":  "Conso. Essentiels",
    "XLE":  "Energie",
    "XLU":  "Services Publics",
    "XLB":  "Materiaux",
    "XLRE": "Immobilier",
}

CYCLICALS = {"XLK", "XLI", "XLY", "XLB", "XLV"}
BENCHMARK = "SPY"
ALL_TICKERS = list(SECTORS.keys()) + [BENCHMARK]

# Resolve paths relative to repo root
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(REPO_ROOT, "data")
POSITIONS_FILE = os.path.join(DATA_DIR, "positions.json")
SIGNALS_FILE = os.path.join(DATA_DIR, "signals.json")

SIGNAL_LABELS = {
    "R1": "Underperf Cyclique",
    "R2": "Underperf + RSI bas",
    "R3": "Sous-perf extreme",
    "F1": "CMF oversold",
    "F2": "Flow combo",
    "G1": "Reversion Def/Cyc",
    "G2": "Dispersion extreme",
    "M4": "Momentum oversold",
    "M1": "Dead cat bounce",
    "M2": "Low vol + surperf",
    "M3": "Epuisement momentum",
}


def download_data():
    """Download 1 year of OHLCV data for all sector ETFs + SPY."""
    import shutil
    for _cache_dir in [
        os.path.expanduser("~/Library/Caches/py-yfinance"),
        os.path.expanduser("~/.cache/py-yfinance"),
    ]:
        if os.path.exists(_cache_dir):
            shutil.rmtree(_cache_dir)
    end = datetime.date.today()
    start = end - datetime.timedelta(days=400)
    data = yf.download(ALL_TICKERS, start=start, end=end, auto_adjust=True, progress=False)
    return data


def compute_rsi(series, period=14):
    """RSI via SMA method."""
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(period).mean()
    avg_loss = loss.rolling(period).mean()
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def compute_cmf(high, low, close, volume, period=21):
    """Chaikin Money Flow."""
    mfm = ((close - low) - (high - close)) / (high - low)
    mfm = mfm.replace([np.inf, -np.inf], 0).fillna(0)
    mfv = mfm * volume
    return mfv.rolling(period).sum() / volume.rolling(period).sum()


def compute_outflow_streak(cmf):
    """Consecutive days where CMF < 0."""
    negative = (cmf < 0).astype(int)
    groups = negative.ne(negative.shift()).cumsum()
    return negative.groupby(groups).cumsum()


def load_positions():
    if os.path.exists(POSITIONS_FILE):
        with open(POSITIONS_FILE) as f:
            return json.load(f)
    return {}


def save_positions(positions):
    with open(POSITIONS_FILE, "w") as f:
        json.dump(positions, f, indent=2)


def get_signals(data):
    """Compute all 11 signals for each sector on the latest date."""
    close = data["Close"]
    high = data["High"]
    low = data["Low"]
    volume = data["Volume"]
    spy_close = close[BENCHMARK]

    # Precompute indicators
    rel_ret_20d, rel_ret_60d, rel_ret_120d = {}, {}, {}
    rsi_vals, cmf_vals, outflow_streaks = {}, {}, {}
    ma50_vals, dist_ma50, vol_60d = {}, {}, {}

    spy_ret_20d = spy_close.pct_change(20)
    spy_ret_60d = spy_close.pct_change(60)
    spy_ret_120d = spy_close.pct_change(120)

    for ticker in SECTORS:
        c, h, l, v = close[ticker], high[ticker], low[ticker], volume[ticker]
        rel_ret_20d[ticker] = c.pct_change(20) - spy_ret_20d
        rel_ret_60d[ticker] = c.pct_change(60) - spy_ret_60d
        rel_ret_120d[ticker] = c.pct_change(120) - spy_ret_120d
        rsi_vals[ticker] = compute_rsi(c)
        cmf_vals[ticker] = compute_cmf(h, l, c, v)
        outflow_streaks[ticker] = compute_outflow_streak(cmf_vals[ticker])
        ma50_vals[ticker] = c.rolling(50).mean()
        dist_ma50[ticker] = (c - ma50_vals[ticker]) / ma50_vals[ticker]
        vol_60d[ticker] = c.pct_change().rolling(60).std() * np.sqrt(252) * 100

    # Cross-sector metrics
    all_60d_rets = pd.DataFrame({t: rel_ret_60d[t] for t in SECTORS})
    # Drop rows where all values are NaN to avoid idxmin crash on weekends/holidays
    all_60d_rets = all_60d_rets.dropna(how="all")
    dispersion = all_60d_rets.std(axis=1)
    disp_90pct = dispersion.rolling(min(len(dispersion), 252), min_periods=60).quantile(0.90)
    worst_sector = all_60d_rets.idxmin(axis=1, skipna=True)

    cyc_tickers = [t for t in SECTORS if t in {"XLK", "XLY", "XLI"}]
    def_tickers = [t for t in SECTORS if t in {"XLP", "XLU", "XLV"}]
    cyc_avg = all_60d_rets[cyc_tickers].mean(axis=1)
    def_avg = all_60d_rets[def_tickers].mean(axis=1)

    latest = close.index[-1]
    date_str = latest.strftime("%Y-%m-%d")

    positions = load_positions()
    results = []

    for ticker, name in SECTORS.items():
        signals = {}
        buy_count, sell_count = 0, 0

        rr60 = rel_ret_60d[ticker].iloc[-1]
        rr20 = rel_ret_20d[ticker].iloc[-1]
        rr120 = rel_ret_120d[ticker].iloc[-1]
        rsi = rsi_vals[ticker].iloc[-1]
        cmf = cmf_vals[ticker].iloc[-1]
        streak = outflow_streaks[ticker].iloc[-1]
        dma50 = dist_ma50[ticker].iloc[-1]
        current_price = float(close[ticker].iloc[-1])
        ma50_price = float(ma50_vals[ticker].iloc[-1])
        price_below_ma50 = current_price < ma50_price
        price_above_ma50 = current_price > ma50_price
        vol = vol_60d[ticker].iloc[-1]
        disp_now = dispersion.iloc[-1]
        disp_thresh = disp_90pct.iloc[-1]
        worst_now = worst_sector.iloc[-1]
        def_cyc_spread = def_avg.iloc[-1] - cyc_avg.iloc[-1]

        # --- 8 BUY SIGNALS ---
        r1 = rr60 < -0.10 and ticker in CYCLICALS
        r2 = rr60 < -0.10 and rsi < 40
        r3 = rr60 < -0.15
        f1 = cmf < -0.25 and price_below_ma50
        f2 = cmf <= -0.15 and streak >= 10 and dma50 < -0.08
        g1 = def_cyc_spread > 0.05 and ticker in CYCLICALS
        g2 = disp_now > disp_thresh and worst_now == ticker
        m4 = rsi < 35 and rr20 < -0.05

        for name_sig, val in [("R1",r1),("R2",r2),("R3",r3),("F1",f1),("F2",f2),("G1",g1),("G2",g2),("M4",m4)]:
            signals[name_sig] = val
            if val: buy_count += 1

        # --- 3 SELL SIGNALS ---
        m1 = rr20 > 0 and rr120 < 0
        m2 = not np.isnan(vol) and vol < 15 and rr60 > 0.03
        m3 = rr60 > 0.10

        for name_sig, val in [("M1",m1),("M2",m2),("M3",m3)]:
            signals[name_sig] = val
            if val: sell_count += 1

        composite = buy_count - sell_count
        if composite >= 3:
            action = "BUY"
        elif composite <= -1:
            action = "AVOID"
        else:
            action = "NEUTRAL"

        active_buy = [k for k in ["R1","R2","R3","F1","F2","G1","G2","M4"] if signals[k]]
        active_sell = [k for k in ["M1","M2","M3"] if signals[k]]

        # --- POSITION TRACKING (MA50 exit) ---
        pos = positions.get(ticker)
        position_info = None

        if pos:
            entry_price = pos["entry_price"]
            pnl_pct = (current_price - entry_price) / entry_price * 100
            if price_above_ma50:
                # EXIT
                position_info = {
                    "status": "CLOSED",
                    "entry_date": pos["entry_date"],
                    "entry_price": entry_price,
                    "exit_date": date_str,
                    "exit_price": round(current_price, 2),
                    "pnl_pct": round(pnl_pct, 1),
                    "exit_reason": "MA50 crossover",
                }
                del positions[ticker]
                print(f"  EXIT  {ticker}: {pos['entry_date']} @ ${entry_price:.2f} -> "
                      f"${current_price:.2f} ({pnl_pct:+.1f}%)")
            else:
                # HOLD
                days_held = (datetime.date.fromisoformat(date_str) -
                             datetime.date.fromisoformat(pos["entry_date"])).days
                position_info = {
                    "status": "OPEN",
                    "entry_date": pos["entry_date"],
                    "entry_price": entry_price,
                    "current_price": round(current_price, 2),
                    "pnl_pct": round(pnl_pct, 1),
                    "days_held": days_held,
                    "ma50_price": round(ma50_price, 2),
                    "dist_to_exit_pct": round((ma50_price - current_price) / current_price * 100, 1),
                }
        elif action == "BUY":
            # NEW ENTRY
            positions[ticker] = {
                "entry_date": date_str,
                "entry_price": round(current_price, 2),
                "entry_score": composite,
                "entry_signals": active_buy,
            }
            position_info = {
                "status": "NEW",
                "entry_date": date_str,
                "entry_price": round(current_price, 2),
                "ma50_price": round(ma50_price, 2),
            }
            print(f"  ENTRY {ticker}: score={composite}, ${current_price:.2f}, "
                  f"MA50=${ma50_price:.2f}, signals={active_buy}")

        results.append({
            "ticker": ticker,
            "name": name,
            "score": composite,
            "action": action,
            "buy_signals": active_buy,
            "sell_signals": active_sell,
            "buy_count": buy_count,
            "sell_count": sell_count,
            "rsi": round(rsi, 1) if not np.isnan(rsi) else None,
            "cmf": round(cmf, 3) if not np.isnan(cmf) else None,
            "dist_ma50_pct": round(dma50 * 100, 1) if not np.isnan(dma50) else None,
            "rel_ret_60d_pct": round(rr60 * 100, 1) if not np.isnan(rr60) else None,
            "price": round(current_price, 2),
            "ma50": round(ma50_price, 2),
            "position": position_info,
        })

    # Sort: open positions first, then by score desc
    results.sort(key=lambda x: (
        0 if x.get("position") and x["position"]["status"] == "OPEN" else 1,
        -x["score"]
    ))

    buy_total = sum(1 for r in results if r["action"] == "BUY")
    avoid_total = sum(1 for r in results if r["action"] == "AVOID")
    open_positions = sum(1 for r in results
                         if r.get("position") and r["position"]["status"] in ("OPEN", "NEW"))

    output = {
        "date": date_str,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": {
            "buy_count": buy_total,
            "avoid_count": avoid_total,
            "neutral_count": len(results) - buy_total - avoid_total,
            "open_positions": open_positions,
        },
        "sectors": results,
    }

    save_positions(positions)
    return output


def main():
    print("Downloading sector data...")
    data = download_data()
    print("Computing signals...")
    output = get_signals(data)

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SIGNALS_FILE, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nSignals -> {SIGNALS_FILE}")
    print(f"Date: {output['date']}")
    s = output["summary"]
    print(f"BUY: {s['buy_count']}, AVOID: {s['avoid_count']}, "
          f"NEUTRAL: {s['neutral_count']}, Open: {s['open_positions']}")

    for sec in output["sectors"]:
        active = sec["buy_signals"] + [f"-{x}" for x in sec["sell_signals"]]
        sig_str = ", ".join(active) if active else "-"
        pos_str = ""
        if sec.get("position"):
            p = sec["position"]
            if p["status"] == "OPEN":
                pos_str = f"  [OPEN {p['days_held']}d {p['pnl_pct']:+.1f}%]"
            elif p["status"] == "NEW":
                pos_str = f"  [NEW @ ${p['entry_price']}]"
            elif p["status"] == "CLOSED":
                pos_str = f"  [CLOSED {p['pnl_pct']:+.1f}%]"
        print(f"  {sec['ticker']:5s} {sec['name']:20s} {sec['score']:+d}  "
              f"{sec['action']:7s}  [{sig_str}]{pos_str}")


if __name__ == "__main__":
    main()
