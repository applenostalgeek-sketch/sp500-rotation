/* ---------- Gold Position Tracker — active trades on Days Held × P&L chart ---------- */

class RRGView {
    constructor(canvasEl) {
        this.canvas = canvasEl;
        this.ctx = canvasEl.getContext("2d");
        this.dpr = window.devicePixelRatio || 1;
        this.data = null;
        this.nodeData = null;
        this.currentIdx = 0;
        this.trailLength = 10;
        this.width = 0;
        this.height = 0;
        this.active = false;
        this.hovered = null; // ticker string or null

        /* kept for app.js compatibility */
        this.hiddenSectors = new Set();

        /* Position tracker data (set via setTradeData) */
        this._tradeLog = [];
        this._stockHistories = {};
        this._posCache = null;
        this._posCacheIdx = -1;

        /* Axes range */
        this.xMin = -1; this.xMax = 20;
        this.yMin = -0.10; this.yMax = 0.08;

        this._resizeHandler = () => {
            if (this.active) { this._resize(); this.draw(); }
        };
        window.addEventListener("resize", this._resizeHandler);
        this._setupInteraction();
    }

    /* ---- Data loading ---- */

    async loadData() {
        if (this.data) return this.data;
        try {
            const resp = await fetch(`data/history.json?t=${Date.now()}`);
            if (!resp.ok) throw new Error("Not found");
            this.data = await resp.json();
            this._computeTradeStates();
            return this.data;
        } catch (err) {
            console.error("History fetch error:", err);
            return null;
        }
    }

    setNodeData(nodes) {
        if (!nodes) return;
        this.nodeData = {};
        for (const n of nodes) this.nodeData[n.id] = n;
    }

    setTradeData(tradeLog, stockHistories) {
        this._tradeLog = tradeLog || [];
        this._stockHistories = stockHistories || {};
        this._posCache = null;
        this._posCacheIdx = -1;
        this._computeRange();
    }

    /* ---- Lifecycle ---- */

    activate() {
        this.active = true;
        this._resize();
        this.draw();
    }

    deactivate() {
        this.active = false;
    }

    setIndex(idx) {
        this.currentIdx = idx;
        this._posCache = null;
        this._posCacheIdx = -1;
        if (this.active) {
            this._computeRange();
            this.draw();
        }
    }

    getDateCount() { return this.data ? this.data.dates.length : 0; }

    getDateLabel(idx) {
        if (!this.data || !this.data.dates[idx]) return "";
        const d = new Date(this.data.dates[idx] + "T12:00:00");
        return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    }

    /* ---- Trade state tracking ---- */

    _computeTradeStates() {
        if (!this.data) return;
        this._tradeStates = {};
        for (const etf in this.data.sectors) {
            const s = this.data.sectors[etf];
            const states = new Array(this.data.dates.length);
            let inTrade = false;
            let maxStreak = 0;

            for (let i = 0; i < this.data.dates.length; i++) {
                const streak = this._computeStreak(etf, i);
                const ma50 = s.ma50 && s.ma50[i] != null ? s.ma50[i] : null;
                const belowMA50 = ma50 !== null && ma50 < 0;
                const cmf = s.c && s.c[i] != null ? s.c[i] : 0;

                if (inTrade) {
                    if (!belowMA50) {
                        inTrade = false;
                        maxStreak = 0;
                        states[i] = null;
                    } else {
                        if (streak > maxStreak) maxStreak = streak;
                        states[i] = { inTrade: true, maxStreak };
                    }
                } else {
                    if (streak >= 10 && cmf <= -0.15 && belowMA50) {
                        inTrade = true;
                        maxStreak = streak;
                        states[i] = { inTrade: true, maxStreak };
                    } else {
                        states[i] = null;
                    }
                }
            }
            this._tradeStates[etf] = states;
        }
    }

    _computeStreak(etf, idx) {
        const s = this.data && this.data.sectors[etf];
        if (!s || !s.c) return 0;
        let streak = 0;
        for (let i = idx; i >= 0; i--) {
            if (s.c[i] != null && s.c[i] < 0) streak++;
            else break;
        }
        return streak;
    }

    _isSignalActif(etf, idx) {
        const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][idx];
        if (ts && ts.inTrade) return true;
        const streak = this._computeStreak(etf, idx);
        if (streak < 10) return false;
        const s = this.data.sectors[etf];
        const cmf = s.c && s.c[idx] != null ? s.c[idx] : 0;
        if (cmf > -0.15) return false;
        const ma50 = s.ma50 && s.ma50[idx] != null ? s.ma50[idx] : null;
        return ma50 !== null && ma50 < 0;
    }

    _signalStage(etf, idx) {
        const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][idx];
        if (ts && ts.inTrade) return "actif";

        const streak = this._computeStreak(etf, idx);
        const s = this.data.sectors[etf];
        const cmf = s.c && s.c[idx] != null ? s.c[idx] : 0;
        const ma50 = s.ma50 && s.ma50[idx] != null ? s.ma50[idx] : null;
        const belowMA50 = ma50 !== null && ma50 < 0;

        if (streak >= 10 && cmf <= -0.15 && belowMA50) return "actif";
        if (streak >= 10) return "construction";
        if (streak >= 3) return "surveillance";
        return null;
    }

    getSignals(idx, minDays) {
        if (!this.data) return [];
        const min = minDays || 3;
        const signals = [];
        for (const etf in this.data.sectors) {
            const s = this.data.sectors[etf];
            const streak = this._computeStreak(etf, idx);
            const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][idx];
            const inTrade = ts && ts.inTrade;
            if (streak >= min || inTrade) {
                const ma50 = s.ma50 && s.ma50[idx] != null ? s.ma50[idx] : null;
                signals.push({
                    etf,
                    name: s.name,
                    streak: inTrade ? ts.maxStreak : streak,
                    cmf: s.c ? s.c[idx] : 0,
                    color: s.color,
                    stage: this._signalStage(etf, idx),
                    belowMA50: ma50 !== null && ma50 < 0,
                    inTrade: !!inTrade,
                });
            }
        }
        signals.sort((a, b) => b.streak - a.streak);
        return signals;
    }

    /* ---- Position data ---- */

    _getActivePositions() {
        if (this._posCacheIdx === this.currentIdx && this._posCache) {
            return this._posCache;
        }
        const idx = this.currentIdx;
        const positions = [];
        for (const t of this._tradeLog) {
            if (t.entryIdx > idx) continue;
            if (t.exitIdx !== null && t.exitIdx <= idx) continue;
            const sh = this._stockHistories[t.etf];
            const sd = sh && sh.stocks[t.ticker];
            const price = sd && sd.close ? sd.close[idx] : null;
            if (price == null || t.entryPrice <= 0) continue;
            positions.push({
                ticker: t.ticker,
                etf: t.etf,
                color: t.color,
                sectorName: t.name,
                entryPrice: t.entryPrice,
                entryDate: t.entryDate,
                entryIdx: t.entryIdx,
                daysHeld: idx - t.entryIdx,
                currentPrice: price,
                pnl: price / t.entryPrice - 1,
                rsi: sd.rsi ? sd.rsi[idx] : null,
                isNew: (idx - t.entryIdx) <= 1,
            });
        }
        this._posCache = positions;
        this._posCacheIdx = idx;
        return positions;
    }

    _getRecentlyClosedTrades() {
        const idx = this.currentIdx;
        const closed = [];
        for (const t of this._tradeLog) {
            if (t.exitIdx == null) continue;
            if (idx - t.exitIdx > 1 || idx - t.exitIdx < 0) continue;
            closed.push({
                ticker: t.ticker,
                etf: t.etf,
                color: t.color,
                sectorName: t.name,
                entryPrice: t.entryPrice,
                exitPrice: t.exitPrice,
                entryDate: t.entryDate,
                exitDate: t.exitDate,
                entryIdx: t.entryIdx,
                exitIdx: t.exitIdx,
                days: t.exitIdx - t.entryIdx,
                pnl: t.ret,
            });
        }
        return closed;
    }

    getWatchingStocks() {
        const idx = this.currentIdx;
        if (!this.data || !this._stockHistories) return [];
        const activeTickers = new Set(this._getActivePositions().map(p => p.ticker));
        const watching = [];
        for (const etf in this.data.sectors) {
            const stage = this._signalStage(etf, idx);
            if (stage !== "surveillance" && stage !== "construction") continue;
            const sh = this._stockHistories[etf];
            if (!sh) continue;
            for (const [ticker, sd] of Object.entries(sh.stocks)) {
                if (activeTickers.has(ticker)) continue;
                if (!sd.ma50 || sd.ma50[idx] == null) continue;
                if (sd.ma50[idx] > -0.08) continue;
                const close = sd.close ? sd.close[idx] : null;
                watching.push({
                    ticker,
                    etf,
                    color: sh.sector_color,
                    ma50Pct: sd.ma50[idx] * 100,
                    price: close,
                    sectorName: sh.sector_name,
                    stage,
                });
            }
        }
        watching.sort((a, b) => a.ma50Pct - b.ma50Pct);
        return watching;
    }

    /* ---- Range ---- */

    _computeRange() {
        const positions = this._getActivePositions();
        if (positions.length === 0) {
            this.xMin = -1; this.xMax = 20;
            this.yMin = -0.10; this.yMax = 0.08;
            return;
        }
        let maxDH = 0, minPnl = 0, maxPnl = 0;
        for (const p of positions) {
            if (p.daysHeld > maxDH) maxDH = p.daysHeld;
            if (p.pnl < minPnl) minPnl = p.pnl;
            if (p.pnl > maxPnl) maxPnl = p.pnl;
        }
        this.xMin = -1;
        this.xMax = Math.max(15, maxDH + 5);
        this.yMin = Math.min(-0.05, minPnl - 0.05);
        this.yMax = Math.max(0.08, maxPnl + 0.03);
    }

    /* ---- Layout ---- */

    _resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;
        this.canvas.width = rect.width * this.dpr;
        this.canvas.height = rect.height * this.dpr;
        this.canvas.style.width = rect.width + "px";
        this.canvas.style.height = rect.height + "px";

        const m = this._isMobile();
        const pad = m
            ? { t: 52, r: 14, b: 86, l: 44 }
            : { t: 58, r: 36, b: 92, l: 56 };
        this.plotX = pad.l;
        this.plotY = pad.t;
        this.plotW = this.width - pad.l - pad.r;
        this.plotH = this.height - pad.t - pad.b;
    }

    _isMobile() { return this.width < 600; }

    _toScreen(xVal, yVal) {
        const x = this.plotX + ((xVal - this.xMin) / (this.xMax - this.xMin)) * this.plotW;
        const y = this.plotY + (1 - (yVal - this.yMin) / (this.yMax - this.yMin)) * this.plotH;
        return { x, y };
    }

    /* ---- Interaction ---- */

    _setupInteraction() {
        const tooltip = document.getElementById("chart-tooltip");

        this.canvas.addEventListener("mousemove", (e) => {
            if (!this.active) return;
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            const hit = this._hitTest(mx, my);
            if (hit !== this.hovered) { this.hovered = hit; this.draw(); }
            if (hit && tooltip) this._showTooltip(tooltip, hit, e.clientX, e.clientY);
            else if (tooltip) tooltip.classList.remove("visible");
            this.canvas.style.cursor = hit ? "pointer" : "default";
        });

        this.canvas.addEventListener("mouseleave", () => {
            if (this.hovered) { this.hovered = null; this.draw(); }
            if (tooltip) tooltip.classList.remove("visible");
        });

        this.canvas.addEventListener("touchstart", (e) => {
            if (!this.active) return;
            const t = e.touches[0];
            const rect = this.canvas.getBoundingClientRect();
            this.hovered = this._hitTest(t.clientX - rect.left, t.clientY - rect.top);
            this.draw();
            if (this.hovered && tooltip) this._showTooltip(tooltip, this.hovered, t.clientX, t.clientY);
            else if (tooltip) tooltip.classList.remove("visible");
        });
    }

    _hitTest(mx, my) {
        const positions = this._getActivePositions();
        const threshold = this._isMobile() ? 22 : 26;
        let closest = null, closestD = threshold;
        for (const p of positions) {
            const scr = this._toScreen(p.daysHeld, p.pnl);
            const d = Math.hypot(mx - scr.x, my - scr.y);
            if (d < closestD) { closestD = d; closest = p.ticker; }
        }
        return closest;
    }

    /* ---- Tooltip ---- */

    _showTooltip(tooltip, ticker, cx, cy) {
        const positions = this._getActivePositions();
        const p = positions.find(pos => pos.ticker === ticker);
        if (!p) { tooltip.classList.remove("visible"); return; }

        const pnlPct = (p.pnl * 100).toFixed(1);
        const pnlColor = p.pnl >= 0 ? "#22c55e" : "#ef4444";
        const pnlSign = p.pnl >= 0 ? "+" : "";

        const fmtDate = (str) => {
            const d = new Date(str + "T12:00:00");
            return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
        };

        const row = (label, val) =>
            `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">${label}</span><span style="font-weight:500">${val}</span></div>`;

        let html = `<div style="font-weight:700;font-size:13px;margin-bottom:6px"><span style="color:${p.color}">${p.ticker}</span> <span style="font-weight:400;font-size:11px;color:#64748b">${p.sectorName} \u00B7 ${p.etf}</span></div>`;

        html += `<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:2px"><span style="color:#64748b">P&L</span><span style="font-weight:700;font-size:14px;color:${pnlColor}">${pnlSign}${pnlPct}%</span></div>`;
        html += row("Jours en position", `${p.daysHeld}j`);
        html += row("Prix d'entr\u00e9e", `$${p.entryPrice.toFixed(2)}`);
        html += row("Prix actuel", `$${p.currentPrice.toFixed(2)}`);
        html += row("Date d'entr\u00e9e", fmtDate(p.entryDate));

        if (p.rsi != null) {
            const rsiVal = p.rsi.toFixed(0);
            const rsiColor = p.rsi < 30 ? "#3b82f6" : p.rsi > 70 ? "#f97316" : "#64748b";
            html += `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">RSI</span><span style="font-weight:600;color:${rsiColor}">${rsiVal}</span></div>`;
        }

        html += `<div style="border-top:1px solid rgba(255,255,255,0.06);margin:6px 0"></div>`;
        html += `<div style="font-size:9px;color:#fbbf2480">Take profit : +5% | Backtest : 91% WR, +5.2% moy, 29j</div>`;

        tooltip.innerHTML = html;
        tooltip.classList.add("visible");
        tooltip.style.left = Math.min(cx + 12, window.innerWidth - 260) + "px";
        tooltip.style.top = Math.min(cy - 8, window.innerHeight - 220) + "px";
    }

    /* ---- Drawing ---- */

    draw() {
        if (!this.active) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);

        this._drawGoldZones(ctx);
        this._drawGoldAxes(ctx);
        this._drawGoldTrails(ctx);
        this._drawGoldDots(ctx);

        ctx.restore();
    }

    _drawGoldZones(ctx) {
        const tl = { x: this.plotX, y: this.plotY };
        const br = { x: this.plotX + this.plotW, y: this.plotY + this.plotH };
        const m = this._isMobile();

        // Take Profit zone (above +5%)
        const yTP = this._toScreen(0, 0.05).y;
        if (yTP > tl.y) {
            const grad = ctx.createLinearGradient(0, tl.y, 0, yTP);
            grad.addColorStop(0, "rgba(34, 197, 94, 0.08)");
            grad.addColorStop(1, "rgba(34, 197, 94, 0.02)");
            ctx.fillStyle = grad;
            ctx.fillRect(tl.x, tl.y, br.x - tl.x, yTP - tl.y);
        }

        // +5% Take Profit dashed line
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "rgba(34, 197, 94, 0.50)";
        ctx.lineWidth = 1.5;
        ctx.moveTo(tl.x, yTP);
        ctx.lineTo(br.x, yTP);
        ctx.stroke();
        ctx.setLineDash([]);

        // TP label
        ctx.font = `600 ${m ? 8 : 10}px -apple-system, sans-serif`;
        ctx.textAlign = "right";
        ctx.fillStyle = "rgba(34, 197, 94, 0.6)";
        ctx.fillText("Take Profit +5%", br.x - 6, yTP - (m ? 4 : 6));

        // Entry line (0%)
        const y0 = this._toScreen(0, 0).y;
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1;
        ctx.moveTo(tl.x, y0);
        ctx.lineTo(br.x, y0);
        ctx.stroke();
        ctx.setLineDash([]);

        // Entry label
        ctx.font = `500 ${m ? 7 : 9}px -apple-system, sans-serif`;
        ctx.textAlign = "right";
        ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
        ctx.fillText("Prix d'entr\u00e9e", br.x - 6, y0 - (m ? 3 : 5));

        // Deep drawdown zone (below -20%)
        if (this.yMin < -0.20) {
            const yDD = this._toScreen(0, -0.20).y;
            if (yDD < br.y) {
                ctx.fillStyle = "rgba(239, 68, 68, 0.04)";
                ctx.fillRect(tl.x, yDD, br.x - tl.x, br.y - yDD);

                // -20% dashed line
                ctx.beginPath();
                ctx.setLineDash([3, 4]);
                ctx.strokeStyle = "rgba(239, 68, 68, 0.20)";
                ctx.lineWidth = 1;
                ctx.moveTo(tl.x, yDD);
                ctx.lineTo(br.x, yDD);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
    }

    _drawGoldAxes(ctx) {
        const tl = { x: this.plotX, y: this.plotY };
        const br = { x: this.plotX + this.plotW, y: this.plotY + this.plotH };
        const m = this._isMobile();

        // Y-axis: P&L percentage ticks
        const yTickFs = m ? 8 : 9;
        ctx.font = `500 ${yTickFs}px -apple-system, sans-serif`;
        ctx.textAlign = "right";

        const yRange = this.yMax - this.yMin;
        let yStep = 0.05;
        if (yRange > 0.4) yStep = 0.10;
        if (yRange < 0.15) yStep = 0.02;

        const yStart = Math.ceil(this.yMin / yStep) * yStep;
        for (let v = yStart; v <= this.yMax + 0.001; v += yStep) {
            const p = this._toScreen(0, v);
            if (p.y < tl.y - 5 || p.y > br.y + 5) continue;

            // Skip if too close to zone lines (0% and 5%)
            const skipGrid = (Math.abs(v) < 0.001) || (Math.abs(v - 0.05) < 0.001);

            if (!skipGrid) {
                ctx.beginPath();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
                ctx.lineWidth = 1;
                ctx.moveTo(tl.x, p.y);
                ctx.lineTo(br.x, p.y);
                ctx.stroke();
            }

            // Label
            const pct = Math.round(v * 100);
            const sign = pct > 0 ? "+" : "";
            const color = pct > 0 ? "rgba(34,197,94,0.5)" : pct < 0 ? "rgba(239,68,68,0.5)" : "rgba(255,255,255,0.4)";
            ctx.fillStyle = color;
            ctx.fillText(`${sign}${pct}%`, tl.x - (m ? 4 : 6), p.y + 3);
        }

        // X-axis: Days held ticks
        const xTickFs = m ? 7 : 9;
        ctx.font = `400 ${xTickFs}px -apple-system, sans-serif`;
        ctx.textAlign = "center";

        const xRange = this.xMax - this.xMin;
        let xStep = 5;
        if (xRange > 60) xStep = 10;
        if (xRange > 120) xStep = 20;

        for (let v = 0; v <= this.xMax; v += xStep) {
            const p = this._toScreen(v, 0);
            if (p.x < tl.x - 5 || p.x > br.x + 5) continue;

            // Grid line
            ctx.beginPath();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
            ctx.lineWidth = 1;
            ctx.moveTo(p.x, tl.y);
            ctx.lineTo(p.x, br.y);
            ctx.stroke();

            // Label
            ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
            ctx.fillText(v === 0 ? "0" : `${v}j`, p.x, br.y + (m ? 12 : 16));
        }

        // Axis labels
        const labelFs = m ? 8 : 10;
        ctx.font = `500 ${labelFs}px -apple-system, sans-serif`;
        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        ctx.textAlign = "center";
        ctx.fillText("Jours en position \u2192", (tl.x + br.x) / 2, br.y + (m ? 28 : 34));

        // Y axis label (vertical)
        ctx.save();
        ctx.translate(tl.x - (m ? 32 : 42), (tl.y + br.y) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = `500 ${labelFs}px -apple-system, sans-serif`;
        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        ctx.textAlign = "center";
        ctx.fillText("P&L %", 0, 0);
        ctx.restore();

        // Plot border (left + bottom)
        ctx.beginPath();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
        ctx.lineWidth = 1;
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tl.x, br.y);
        ctx.lineTo(br.x, br.y);
        ctx.stroke();
    }

    _drawGoldTrails(ctx) {
        const idx = this.currentIdx;
        const positions = this._getActivePositions();

        for (const p of positions) {
            const sh = this._stockHistories[p.etf];
            const sd = sh && sh.stocks[p.ticker];
            if (!sd || !sd.close) continue;

            const isH = this.hovered === p.ticker;
            const dimmed = this.hovered && !isH;
            const startDay = Math.max(p.entryIdx, idx - this.trailLength);

            // Draw trail line
            ctx.beginPath();
            let started = false;
            for (let d = startDay; d <= idx; d++) {
                const price = sd.close[d];
                if (price == null || p.entryPrice <= 0) continue;
                const dh = d - p.entryIdx;
                const pnl = price / p.entryPrice - 1;
                const scr = this._toScreen(dh, pnl);
                if (!started) { ctx.moveTo(scr.x, scr.y); started = true; }
                else ctx.lineTo(scr.x, scr.y);
            }
            if (started) {
                ctx.strokeStyle = dimmed ? (p.color + "15") : isH ? (p.color + "88") : (p.color + "44");
                ctx.lineWidth = isH ? 2.5 : dimmed ? 0.5 : 1.5;
                ctx.stroke();

                // Trail dots
                for (let d = startDay; d < idx; d++) {
                    const price = sd.close[d];
                    if (price == null) continue;
                    const dh = d - p.entryIdx;
                    const pnl = price / p.entryPrice - 1;
                    const scr = this._toScreen(dh, pnl);
                    const age = (idx - d) / this.trailLength;
                    const alpha = dimmed ? 0.04 : Math.max(0.08, 0.4 * (1 - age));
                    ctx.beginPath();
                    ctx.arc(scr.x, scr.y, 1.5, 0, Math.PI * 2);
                    ctx.fillStyle = p.color + Math.round(alpha * 255).toString(16).padStart(2, "0");
                    ctx.fill();
                }
            }
        }
    }

    _drawGoldDots(ctx) {
        const positions = this._getActivePositions();
        const m = this._isMobile();
        const dotR = m ? 6 : 8;
        const hoverR = m ? 9 : 12;

        for (const p of positions) {
            const scr = this._toScreen(p.daysHeld, p.pnl);
            const isH = this.hovered === p.ticker;
            const dimmed = this.hovered && !isH;
            const r = isH ? hoverR : dotR;

            // Gold glow (static, no animation)
            if (!dimmed) {
                const glowR = r + (m ? 10 : 14);
                const grad = ctx.createRadialGradient(scr.x, scr.y, r, scr.x, scr.y, glowR);
                grad.addColorStop(0, "rgba(251,191,36,0.15)");
                grad.addColorStop(1, "rgba(251,191,36,0)");
                ctx.beginPath();
                ctx.arc(scr.x, scr.y, glowR, 0, Math.PI * 2);
                ctx.fillStyle = grad;
                ctx.fill();
            }

            // Dot fill (sector color)
            ctx.beginPath();
            ctx.arc(scr.x, scr.y, r, 0, Math.PI * 2);
            ctx.fillStyle = p.color + (dimmed ? "44" : isH ? "ff" : "cc");
            ctx.fill();

            // Gold border (2px)
            ctx.strokeStyle = dimmed ? "rgba(251,191,36,0.15)" : isH ? "#fbbf24" : "rgba(251,191,36,0.7)";
            ctx.lineWidth = isH ? 3 : 2;
            ctx.stroke();

            if (!dimmed) {
                // Ticker label above dot
                const tickerFs = m ? 8 : 10;
                ctx.font = `700 ${tickerFs}px -apple-system, sans-serif`;
                ctx.textAlign = "center";
                ctx.fillStyle = isH ? "#fff" : "rgba(255,255,255,0.85)";
                ctx.fillText(p.ticker, scr.x, scr.y - r - (m ? 4 : 5));

                // P&L badge to the right
                const pnlPct = (p.pnl * 100).toFixed(1);
                const pnlSign = p.pnl >= 0 ? "+" : "";
                const pnlText = `${pnlSign}${pnlPct}%`;
                const badgeFs = m ? 7 : 8;
                ctx.font = `600 ${badgeFs}px -apple-system, sans-serif`;
                const tw = ctx.measureText(pnlText).width;
                const bx = scr.x + r + 4;
                const by = scr.y + badgeFs / 2 - 1;

                // Badge background
                const bgColor = p.pnl >= 0 ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)";
                const bw = tw + 6, bh = badgeFs + 4;
                const brr = 3;
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(bx - 3, by - badgeFs + 1, bw, bh, brr);
                } else {
                    ctx.rect(bx - 3, by - badgeFs + 1, bw, bh);
                }
                ctx.fillStyle = bgColor;
                ctx.fill();

                // Badge text
                ctx.textAlign = "left";
                ctx.fillStyle = p.pnl >= 0 ? "#22c55e" : "#ef4444";
                ctx.fillText(pnlText, bx, by);
            }
        }

        // Empty state
        if (positions.length === 0) {
            ctx.font = `400 ${m ? 12 : 14}px -apple-system, sans-serif`;
            ctx.textAlign = "center";
            ctx.fillStyle = "rgba(255,255,255,0.2)";
            ctx.fillText("Aucune position active", this.plotX + this.plotW / 2, this.plotY + this.plotH / 2);
        }
    }
}
