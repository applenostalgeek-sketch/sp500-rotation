#!/usr/bin/env python3
"""
Backtest: full S&P 500 (500 stocks) vs our 209 selection.
Same method, same RS=20, honest comparison.
"""
import os
import sys
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).parent))
from pipeline import SECTOR_HOLDINGS, BENCHMARK

# ── Get full S&P 500 list from Wikipedia ──
def get_sp500_tickers():
    """Fetch current S&P 500 constituents from Wikipedia."""
    import urllib.request
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        html = resp.read().decode()
    tables = pd.read_html(html)
    df = tables[0]
    tickers = df["Symbol"].str.replace(".", "-", regex=False).tolist()
    return tickers


def compute_phase_series(stock_close, spy_close, period=20):
    """Full phase series for one stock vs SPY."""
    rs = stock_close / spy_close
    rs_sma = rs.rolling(period).mean()
    rr = (rs / rs_sma) * 100
    rm = (rr / rr.shift(period)) * 100
    valid = rm.dropna().index
    if len(valid) == 0:
        return pd.Series(dtype=str)
    rr_v = rr.loc[valid]
    rm_v = rm.loc[valid]
    result = pd.Series("lagging", index=valid)
    result[(rr_v >= 100) & (rm_v >= 100)] = "leading"
    result[(rr_v >= 100) & (rm_v < 100)] = "weakening"
    result[(rr_v < 100) & (rm_v >= 100)] = "improving"
    return result


def run_backfill(close, spy, tickers, label):
    """Run backfill on a set of tickers. Returns history list."""
    # Compute phase series
    phase_series = {}
    skipped = 0
    for ticker in tickers:
        if ticker not in close.columns:
            skipped += 1
            continue
        c = close[ticker].dropna()
        if len(c) < 80:
            skipped += 1
            continue
        common = c.index.intersection(spy.index)
        c = c.loc[common]
        s = spy.loc[common]
        if len(c) < 80:
            skipped += 1
            continue
        ps = compute_phase_series(c, s, 20)
        if len(ps) > 20:
            phase_series[ticker] = ps

    print(f"  {label}: {len(phase_series)} stocks with data, {skipped} skipped")

    # Replay — use all available days after 50-day warmup
    trading_days = spy.dropna().index
    start_idx = max(0, 50)
    replay = trading_days[start_idx:]

    history = []
    active = {}

    for day in replay:
        date_str = day.strftime("%Y-%m-%d")
        spy_price = float(spy.loc[day])

        for ticker in phase_series:
            ps = phase_series[ticker]
            if day not in ps.index:
                continue
            phase_today = ps.loc[day]
            day_pos = ps.index.get_loc(day)
            if day_pos == 0:
                continue
            phase_yesterday = ps.iloc[day_pos - 1]

            # New signal
            if phase_today == "improving" and phase_yesterday != "improving":
                if ticker not in active and ticker in close.columns:
                    price = float(close[ticker].loc[day])
                    if not np.isnan(price):
                        active[ticker] = {
                            "ticker": ticker,
                            "open_date": date_str,
                            "open_price": price,
                            "spy_open": spy_price,
                            "return_abs": 0.0,
                            "return_vs_spy": 0.0,
                            "days": 0,
                            "status": "active",
                            "reason": None,
                        }
                        history.append(active[ticker])

            # Update
            if ticker in active:
                sig = active[ticker]
                price = float(close[ticker].loc[day])
                if not np.isnan(price):
                    sig["return_abs"] = round(price / sig["open_price"] - 1, 5)
                    sig["return_vs_spy"] = round(
                        sig["return_abs"] - (spy_price / sig["spy_open"] - 1), 5
                    )
                open_dt = datetime.strptime(sig["open_date"], "%Y-%m-%d")
                sig["days"] = (day.to_pydatetime().replace(tzinfo=None) - open_dt).days

                if phase_today == "leading":
                    sig["status"] = "closed"
                    sig["reason"] = "confirmed"
                    del active[ticker]
                elif phase_today in ("weakening", "lagging"):
                    sig["status"] = "closed"
                    sig["reason"] = "reversed"
                    del active[ticker]
                elif sig["days"] > 30:
                    sig["status"] = "closed"
                    sig["reason"] = "expired"
                    del active[ticker]

    return history


def print_stats(history, label):
    """Print clean comparison stats."""
    closed = [s for s in history if s["status"] == "closed"]
    act = [s for s in history if s["status"] == "active"]
    if not closed:
        print(f"  {label}: aucun signal clos")
        return

    wins_abs = [s for s in closed if s["return_abs"] > 0]
    wins_spy = [s for s in closed if s["return_vs_spy"] > 0]
    confirmed = [s for s in closed if s["reason"] == "confirmed"]
    reversed_ = [s for s in closed if s["reason"] == "reversed"]

    avg_abs = sum(s["return_abs"] for s in closed) / len(closed) * 100
    avg_spy = sum(s["return_vs_spy"] for s in closed) / len(closed) * 100

    conf_ret = sum(s["return_abs"] for s in confirmed) / max(1, len(confirmed)) * 100
    conf_days = sum(s["days"] for s in confirmed) / max(1, len(confirmed))
    rev_ret = sum(s["return_abs"] for s in reversed_) / max(1, len(reversed_)) * 100
    rev_days = sum(s["days"] for s in reversed_) / max(1, len(reversed_))

    print(f"\n  {'='*55}")
    print(f"  {label}")
    print(f"  {'='*55}")
    print(f"  Signaux: {len(history)} total ({len(act)} actifs, {len(closed)} clos)")
    print(f"  Win rate absolu:   {len(wins_abs):4d}/{len(closed)} = {len(wins_abs)/len(closed)*100:.1f}%")
    print(f"  Win rate vs SPY:   {len(wins_spy):4d}/{len(closed)} = {len(wins_spy)/len(closed)*100:.1f}%")
    print(f"  Return moy abs:    {avg_abs:+.2f}%")
    print(f"  Return moy vs SPY: {avg_spy:+.2f}%")
    print(f"  Confirmed: {len(confirmed)} ({len(confirmed)/len(closed)*100:.0f}%) "
          f"ret {conf_ret:+.2f}% en {conf_days:.1f}j")
    print(f"  Reversed:  {len(reversed_)} ({len(reversed_)/len(closed)*100:.0f}%) "
          f"ret {rev_ret:+.2f}% en {rev_days:.1f}j")


def main():
    import shutil
    cache = os.path.expanduser("~/Library/Caches/py-yfinance")
    if os.path.exists(cache):
        shutil.rmtree(cache)

    # Get tickers
    print("Fetching S&P 500 list from Wikipedia...")
    sp500_all = get_sp500_tickers()
    print(f"  S&P 500: {len(sp500_all)} tickers")

    our_209 = []
    for h_list in SECTOR_HOLDINGS.values():
        our_209.extend(h_list)
    our_209 = list(set(our_209))
    print(f"  Our selection: {len(our_209)} tickers")

    sp500_rest = [t for t in sp500_all if t not in our_209]
    print(f"  Rest (not in our selection): {len(sp500_rest)} tickers")

    # Download ALL
    all_tickers = list(set(sp500_all + our_209 + [BENCHMARK]))
    print(f"\nDownloading {len(all_tickers)} tickers (2 years)...")
    data = yf.download(all_tickers, period="2y", progress=False, auto_adjust=True)
    close = data["Close"]
    spy = close[BENCHMARK]
    print(f"  Data: {len(close.columns)} columns, {len(close)} rows")

    # Run backtests
    print("\n--- Backtest 1: Our 209 stocks ---")
    h_209 = run_backfill(close, spy, our_209, "209 stocks")
    print_stats(h_209, "NOS 209 STOCKS (top 15-20/secteur)")

    print("\n--- Backtest 2: Full S&P 500 ---")
    h_500 = run_backfill(close, spy, sp500_all, "500 stocks")
    print_stats(h_500, "S&P 500 COMPLET (~500 stocks)")

    print("\n--- Backtest 3: Les ~290 qu'on n'a PAS ---")
    h_rest = run_backfill(close, spy, sp500_rest, "rest")
    print_stats(h_rest, "LES ~290 STOCKS QU'ON N'A PAS")


if __name__ == "__main__":
    main()
