/* ---------- Flow Map — signal-based scatter with trails + sector zoom ---------- */

class RRGView {
    constructor(canvasEl) {
        this.canvas = canvasEl;
        this.ctx = canvasEl.getContext("2d");
        this.dpr = window.devicePixelRatio || 1;
        this.data = null;
        this.nodeData = null;
        this.sectorMode = null;
        this.currentIdx = 0;
        this.trailLength = 10;
        this.width = 0;
        this.height = 0;
        this.active = false;
        this.hovered = null;
        this._sectorClickCb = null;
        this.hiddenSectors = new Set();

        this.xMin = -10; this.xMax = 30;
        this.yMin = -0.1; this.yMax = 0.1;

        /* Particle animation state */
        this._particles = [];
        this._emitters = [];
        this._animating = false;
        this._animFrame = null;

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
            this._computeRange();
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

    onSectorClick(cb) { this._sectorClickCb = cb; }

    /* ---- Sector mode ---- */

    enterSector(sectorData) {
        this.sectorMode = {
            stocks: sectorData.stocks,
            name: sectorData.sector_name,
            color: sectorData.sector_color,
            etf: sectorData.etf,
        };
        this.hovered = null;
        this._stopRipples();
        this._computeRange();
        this.draw();
    }

    exitSector() {
        this.sectorMode = null;
        this.hovered = null;
        this._computeRange();
        this._maybeStartRipples();
    }

    /* ---- Sector filter ---- */

    _isVisible(etf) {
        return !this.hiddenSectors.has(etf);
    }

    toggleSector(etf) {
        if (this.hiddenSectors.has(etf)) this.hiddenSectors.delete(etf);
        else this.hiddenSectors.add(etf);
        this._initEmitters();
        this._particles = [];
        this.draw();
    }

    showAllSectors() {
        this.hiddenSectors.clear();
        this._initEmitters();
        this._particles = [];
        this.draw();
    }

    /* ---- Lifecycle ---- */

    activate() {
        this.active = true;
        this._resize();
        this._maybeStartRipples();
    }
    deactivate() {
        this.active = false;
        this._stopRipples();
    }

    setIndex(idx) {
        this.currentIdx = idx;
        if (this.active) {
            // Rebuild emitters for new date's CMF values
            this._initEmitters();
            this._particles = [];
            if (this._emitters.length > 0 && !this._animating) {
                this._animating = true;
                this._animLoop();
            } else if (this._emitters.length === 0) {
                this._stopRipples();
                this.draw();
            }
            // If already animating, animLoop will pick up new emitters
        }
    }

    getDateCount() { return this.data ? this.data.dates.length : 0; }

    getDateLabel(idx) {
        if (!this.data || !this.data.dates[idx]) return "";
        const d = new Date(this.data.dates[idx] + "T12:00:00");
        return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    }

    /* ---- Position helpers ---- */

    _sectorX(etf, idx) {
        // Position = real current streak (truth), trade state shown via visuals only
        const streak = this._computeStreak(etf, idx);
        if (streak >= 1) return streak;
        // Inflow: spread left based on CMF magnitude
        const s = this.data.sectors[etf];
        const cmf = s.c && s.c[idx] != null ? s.c[idx] : 0;
        return -Math.max(0, cmf) * 15;
    }

    _sectorY(etf, idx) {
        const s = this.data.sectors[etf];
        return s.ma50 && s.ma50[idx] != null ? s.ma50[idx] : null;
    }

    /* ---- Range ---- */

    _computeRange() {
        if (this.sectorMode) {
            const stocks = this.sectorMode.stocks;
            let allR = [], allM = [];
            for (const s of stocks) {
                if (s.rs_ratio != null) allR.push(s.rs_ratio);
                if (s.rs_momentum != null) allM.push(s.rs_momentum);
            }
            if (allR.length === 0) return;
            const rLo = Math.floor(Math.min(...allR)) - 2;
            const rHi = Math.ceil(Math.max(...allR)) + 2;
            const mLo = Math.floor(Math.min(...allM)) - 2;
            const mHi = Math.ceil(Math.max(...allM)) + 2;
            const rSpan = Math.max(100 - rLo, rHi - 100, 4);
            const mSpan = Math.max(100 - mLo, mHi - 100, 4);
            this.xMin = 100 - rSpan; this.xMax = 100 + rSpan;
            this.yMin = 100 - mSpan; this.yMax = 100 + mSpan;
            return;
        }

        if (!this.data) return;
        // Global view: X = outflow streak (days), Y = distance to MA50
        let maxStreak = 5;
        for (const etf in this.data.sectors) {
            for (let i = 0; i < this.data.dates.length; i++) {
                const streak = this._computeStreak(etf, i);
                if (streak > maxStreak) maxStreak = streak;
            }
        }
        let maxMA50 = 0.05;
        for (const etf in this.data.sectors) {
            const s = this.data.sectors[etf];
            if (s.ma50) for (const v of s.ma50) if (v != null) maxMA50 = Math.max(maxMA50, Math.abs(v));
        }
        maxMA50 = Math.min(maxMA50 * 1.1, 0.20); // cap at ±20%
        this.xMin = -10;
        this.xMax = maxStreak + 4;
        this.yMin = -maxMA50;
        this.yMax = maxMA50;
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
        const pad = m ? { t: 48, r: 14, b: 64, l: 20 } : { t: 58, r: 36, b: 72, l: 24 };
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

    /* ---- Trade state tracking ---- */

    /**
     * Precompute trade states for all sectors across all dates.
     * Trade entry: streak >= 15 AND ma50 < 0
     * Trade exit: ma50 >= 0 (price crosses back above MA50)
     * While in trade, we track maxStreak (for X position) even if CMF goes positive briefly.
     */
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

                if (inTrade) {
                    if (!belowMA50) {
                        // EXIT: MA50 crossed above → trade over
                        inTrade = false;
                        maxStreak = 0;
                        states[i] = null;
                    } else {
                        // Still in trade — update max streak
                        if (streak > maxStreak) maxStreak = streak;
                        states[i] = { inTrade: true, maxStreak };
                    }
                } else {
                    if (streak >= 15 && belowMA50) {
                        // ENTRY: signal triggered
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

    /* ---- Contrarian streak ---- */

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

    _streakParticleRGB(streak) {
        // Red → Amber → Gold based on negative CMF streak length
        if (streak < 5) return "239,68,68";            // red
        if (streak < 10) {
            // Interpolate red → amber
            const t = (streak - 5) / 5;
            const r = Math.round(239 + (245 - 239) * t);
            const g = Math.round(68 + (158 - 68) * t);
            const b = Math.round(68 + (11 - 68) * t);
            return `${r},${g},${b}`;
        }
        if (streak < 15) return "245,158,11";          // amber
        return "250,204,21";                            // gold
    }

    /* Returns true if sector is in Signal Actif — either fresh trigger or ongoing trade */
    _isSignalActif(etf, idx) {
        // In trade = signal actif (even if streak broke temporarily)
        const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][idx];
        if (ts && ts.inTrade) return true;
        // Fresh trigger check
        const streak = this._computeStreak(etf, idx);
        if (streak < 15) return false;
        const s = this.data.sectors[etf];
        const ma50 = s.ma50 && s.ma50[idx] != null ? s.ma50[idx] : null;
        return ma50 !== null && ma50 < 0;
    }

    /* Returns signal stage for a sector: "actif", "construction", "surveillance", or null */
    _signalStage(etf, idx) {
        // In trade = always "actif"
        const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][idx];
        if (ts && ts.inTrade) return "actif";

        const streak = this._computeStreak(etf, idx);
        if (streak >= 15) {
            // streak >= 15 but NOT in trade: either above MA50 or fresh trigger
            const s = this.data.sectors[etf];
            const ma50 = s.ma50 && s.ma50[idx] != null ? s.ma50[idx] : null;
            return (ma50 !== null && ma50 < 0) ? "actif" : "construction";
        }
        if (streak >= 10) return "construction";
        if (streak >= 3) return "surveillance";
        return null;
    }

    /* Returns array of {etf, name, streak, cmf, color, stage, belowMA50, inTrade} for sectors with streak >= minDays or in trade */
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

    /* ---- Dot sizing ---- */

    _dotRadius(etf) {
        const m = this._isMobile();
        const s = this.data && this.data.sectors[etf];
        const base = m ? 6 : 8;
        const w = (s && s.w != null ? s.w : 5) / 10;
        return base * (0.6 + Math.sqrt(w) * 0.5);
    }

    _stockRadius(stock) {
        const m = this._isMobile();
        const w = stock.weight || 1;
        const maxW = this._sectorMaxWeight || 10;
        const minR = m ? 3 : 4;
        const maxR = m ? 9 : 13;
        return minR + (Math.sqrt(w) / Math.sqrt(maxW)) * (maxR - minR);
    }

    _cmfColor(etf) {
        // Try per-date CMF from history first
        const s = this.data && this.data.sectors[etf];
        let cmf = null;
        if (s && s.c && s.c[this.currentIdx] != null) {
            cmf = s.c[this.currentIdx];
        } else if (this.nodeData && this.nodeData[etf]) {
            cmf = this.nodeData[etf].cmf;
        }
        if (cmf == null) return null;
        const intensity = Math.min(Math.abs(cmf) / 0.25, 1.0);
        const alpha = Math.round((0.4 + intensity * 0.6) * 255).toString(16).padStart(2, "0");
        return cmf >= 0 ? "#22c55e" + alpha : "#ef4444" + alpha;
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

        // Click for sector zoom
        this.canvas.addEventListener("click", (e) => {
            if (!this.active || this.sectorMode) return;
            const rect = this.canvas.getBoundingClientRect();
            const hit = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
            if (hit && this._sectorClickCb) this._sectorClickCb(hit);
        });
    }

    _hitTest(mx, my) {
        const threshold = this._isMobile() ? 22 : 26;

        if (this.sectorMode) {
            let closest = null, closestD = threshold;
            for (const s of this.sectorMode.stocks) {
                if (s.rs_ratio == null || s.rs_momentum == null) continue;
                const p = this._toScreen(s.rs_ratio, s.rs_momentum);
                const d = Math.hypot(mx - p.x, my - p.y);
                if (d < closestD) { closestD = d; closest = s.id; }
            }
            return closest;
        }

        if (!this.data) return null;
        const idx = this.currentIdx;
        let closest = null, closestD = threshold;
        for (const etf in this.data.sectors) {
            if (!this._isVisible(etf)) continue;
            const sx = this._sectorX(etf, idx);
            const sy = this._sectorY(etf, idx);
            if (sy == null) continue;
            const p = this._toScreen(sx, sy);
            const d = Math.hypot(mx - p.x, my - p.y);
            if (d < closestD) { closestD = d; closest = etf; }
        }
        return closest;
    }

    /* ---- Tooltips ---- */

    _showTooltip(tooltip, id, cx, cy) {
        if (this.sectorMode) {
            this._showStockTooltip(tooltip, id, cx, cy);
            return;
        }
        this._showSectorTooltip(tooltip, id, cx, cy);
    }

    _showSectorTooltip(tooltip, etf, clientX, clientY) {
        const idx = this.currentIdx;
        const s = this.data.sectors[etf];

        const cmf = s.c && s.c[idx] != null ? s.c[idx] : null;
        const ret = s.ret && s.ret[idx] != null ? s.ret[idx] : null;
        const streak = this._computeStreak(etf, idx);

        const row = (label, val) => `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">${label}</span><span style="font-weight:500">${val}</span></div>`;

        let html = `<div style="font-weight:600;font-size:12px;color:${s.color};margin-bottom:5px">${s.name} <span style="color:#64748b;font-weight:400">${etf}</span></div>`;

        // Signal state (primary info)
        const stage = this._signalStage(etf, idx);
        const ma50 = s.ma50 && s.ma50[idx] != null ? s.ma50[idx] : null;
        const belowMA50 = ma50 !== null && ma50 < 0;
        const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][idx];
        const inTrade = ts && ts.inTrade;
        if (stage === "actif") {
            const tradeLabel = inTrade && streak < 15
                ? `\u26a1 En position \u2014 entr\u00e9e \u00e0 ${ts.maxStreak}j`
                : `\u26a1 Signal actif \u2014 ${streak}j + sous MA50`;
            html += `<div style="margin-bottom:4px;padding:3px 6px;border-radius:4px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.3)"><span style="font-size:10px;color:#fbbf24;font-weight:600">${tradeLabel}</span></div>`;
        } else if (stage === "construction") {
            const extra = streak >= 15 && !belowMA50 ? " (au-dessus MA50)" : "";
            html += `<div style="margin-bottom:4px;padding:3px 6px;border-radius:4px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25)"><span style="font-size:10px;color:#f59e0b;font-weight:600">\u23f3 En construction \u2014 ${streak}j${extra}</span></div>`;
        } else if (stage === "surveillance") {
            html += `<div style="margin-bottom:4px;padding:3px 6px;border-radius:4px;background:rgba(148,163,184,0.08);border:1px solid rgba(148,163,184,0.2)"><span style="font-size:10px;color:#94a3b8;font-weight:500">\ud83d\udce1 Surveillance \u2014 ${streak}j</span></div>`;
        }

        // MA50 distance (primary — it's the Y axis)
        if (ma50 != null) {
            const ma50C = ma50 >= 0 ? "#22c55e" : "#ef4444";
            const ma50Label = ma50 >= 0 ? "Au-dessus MA50" : "Sous MA50";
            html += `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">${ma50Label}</span><span style="font-weight:600;color:${ma50C}">${ma50 >= 0 ? "+" : ""}${(ma50 * 100).toFixed(1)}%</span></div>`;
        }

        // CMF
        if (cmf != null) {
            const cmfC = cmf >= 0 ? "#22c55e" : "#ef4444";
            const cmfL = cmf >= 0 ? "Flux entrant" : "Flux sortant";
            html += `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">${cmfL}</span><span style="font-weight:600;color:${cmfC}">${cmf >= 0 ? "+" : ""}${cmf.toFixed(3)}</span></div>`;
        }

        const isLatest = idx === this.data.dates.length - 1;
        const nd = this.nodeData && this.nodeData[etf];
        if (isLatest && nd) {
            html += `<div style="border-top:1px solid rgba(255,255,255,0.06);margin:5px 0"></div>`;
            html += row("Poids S&P", nd.weight + "%");
            const r5c = nd.return_5d >= 0 ? "#22c55e" : "#ef4444";
            html += `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">1 semaine</span><span style="font-weight:500;color:${r5c}">${nd.return_5d >= 0 ? "+" : ""}${(nd.return_5d * 100).toFixed(1)}%</span></div>`;
        }

        // Backtest note for signal actif / in trade
        if (stage === "actif") {
            const exitHint = inTrade && streak < 15
                ? "Sortie : quand le prix repasse au-dessus de MA50"
                : "Hist: 89% gagnant sur 20 ans (vente au repassage MA50)";
            html += `<div style="margin-top:4px;font-size:9px;color:#fbbf2480">${exitHint}</div>`;
        }

        html += `<div style="margin-top:5px"><span style="font-size:9px;color:#475569">cliquer pour zoomer</span></div>`;

        tooltip.innerHTML = html;
        tooltip.classList.add("visible");
        tooltip.style.left = Math.min(clientX + 12, window.innerWidth - 260) + "px";
        tooltip.style.top = Math.min(clientY - 8, window.innerHeight - 220) + "px";
    }

    _showStockTooltip(tooltip, id, cx, cy) {
        const stock = this.sectorMode.stocks.find(s => s.id === id);
        if (!stock) return;

        let zoneName, zoneColor;
        if (stock.rs_ratio >= 100 && stock.rs_momentum >= 100) { zoneName = "Leader"; zoneColor = "#22c55e"; }
        else if (stock.rs_ratio < 100 && stock.rs_momentum >= 100) { zoneName = "En hausse"; zoneColor = "#eab308"; }
        else if (stock.rs_ratio >= 100 && stock.rs_momentum < 100) { zoneName = "En baisse"; zoneColor = "#f97316"; }
        else { zoneName = "A la traine"; zoneColor = "#ef4444"; }

        const row = (label, val) => `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">${label}</span><span style="font-weight:500">${val}</span></div>`;

        let html = `<div style="font-weight:600;font-size:12px;color:${this.sectorMode.color};margin-bottom:5px">${stock.id}</div>`;
        html += row("RS-Ratio", stock.rs_ratio.toFixed(1));
        html += row("Momentum", stock.rs_momentum.toFixed(1));
        html += `<div style="border-top:1px solid rgba(255,255,255,0.06);margin:5px 0"></div>`;

        const r5c = stock.return_5d >= 0 ? "#22c55e" : "#ef4444";
        const r20c = stock.return_20d >= 0 ? "#22c55e" : "#ef4444";
        html += `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">1 semaine</span><span style="font-weight:500;color:${r5c}">${stock.return_5d >= 0 ? "+" : ""}${(stock.return_5d * 100).toFixed(1)}%</span></div>`;
        html += `<div style="display:flex;justify-content:space-between;gap:12px"><span style="color:#64748b">1 mois</span><span style="font-weight:500;color:${r20c}">${stock.return_20d >= 0 ? "+" : ""}${(stock.return_20d * 100).toFixed(1)}%</span></div>`;
        html += row("RSI", stock.rsi.toFixed(0) + (stock.rsi > 70 ? " <span style='color:#f97316;font-size:9px'>surachat</span>" : stock.rsi < 30 ? " <span style='color:#ef4444;font-size:9px'>survente</span>" : ""));
        html += row("Poids secteur", (stock.weight || 0).toFixed(1) + "%");

        html += `<div style="margin-top:5px"><span style="font-size:9px;font-weight:500;padding:2px 6px;border-radius:3px;border:1px solid ${zoneColor}55;color:${zoneColor}">${zoneName}</span></div>`;

        tooltip.innerHTML = html;
        tooltip.classList.add("visible");
        tooltip.style.left = Math.min(cx + 12, window.innerWidth - 260) + "px";
        tooltip.style.top = Math.min(cy - 8, window.innerHeight - 220) + "px";
    }

    /* ---- Particle animation (flow droplets) ---- */

    _maybeStartRipples() {
        if (!this.sectorMode && this.data) {
            this._initEmitters();
            if (this._emitters.length > 0 && !this._animating) {
                this._animating = true;
                this._particles = [];
                this._animLoop();
                return;
            } else if (this._emitters.length === 0) {
                this._stopRipples();
            }
        } else {
            this._stopRipples();
        }
        this.draw();
    }

    _initEmitters() {
        this._emitters = [];
        if (!this.data) return;

        for (const etf in this.data.sectors) {
            if (!this._isVisible(etf)) continue;
            const s = this.data.sectors[etf];
            // Use per-date CMF from history
            let cmf = 0, weight = 5;
            if (s.c && s.c[this.currentIdx] != null) {
                cmf = s.c[this.currentIdx];
            } else if (this.nodeData && this.nodeData[etf]) {
                // Fallback for latest date only
                const isLatest = this.currentIdx === this.data.dates.length - 1;
                if (isLatest) cmf = this.nodeData[etf].cmf || 0;
            }
            if (s.w != null) weight = s.w;
            else if (this.nodeData && this.nodeData[etf]) weight = this.nodeData[etf].weight || 5;

            if (Math.abs(cmf) < 0.01) continue;

            const cmfAbs = Math.abs(cmf);
            const intensity = Math.min(cmfAbs / 0.20, 1.0);
            const inflow = cmf >= 0;
            const streak = inflow ? 0 : this._computeStreak(etf, this.currentIdx);
            const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][this.currentIdx];
            const inTrade = ts && ts.inTrade;
            // In trade: always gold particles even if CMF briefly positive
            const rgb = (inTrade && !inflow) ? "250,204,21" : inflow ? "34,197,94" : this._streakParticleRGB(streak);
            const wFactor = weight / 10;
            const rate = (0.04 + intensity * 0.14) * Math.max(0.3, wFactor);

            this._emitters.push({ etf, rgb, inflow, intensity, rate, wFactor, streak, accum: Math.random() });
        }
    }

    _spawnParticle(em) {
        const idx = this.currentIdx;
        const sx = this._sectorX(em.etf, idx);
        const sy = this._sectorY(em.etf, idx);
        if (sy == null) return null;

        const p = this._toScreen(sx, sy);
        const dotR = this._dotRadius(em.etf);
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.25 + Math.random() * 0.3;
        const maxDist = dotR + 8 + em.intensity * 16;
        const life = maxDist / speed;
        const sizeMul = Math.min(1.4, 0.7 + (em.wFactor || 1) * 0.3);

        if (em.inflow) {
            // Born far, travel inward
            const dist = maxDist;
            return {
                etf: em.etf,
                x: p.x + Math.cos(angle) * dist,
                y: p.y + Math.sin(angle) * dist,
                vx: -Math.cos(angle) * speed,
                vy: -Math.sin(angle) * speed,
                life, maxLife: life,
                rgb: em.rgb,
                size: (0.8 + Math.random() * 0.8) * sizeMul,
            };
        } else {
            // Born near dot, travel outward
            const dist = dotR + 1 + Math.random() * 2;
            return {
                etf: em.etf,
                x: p.x + Math.cos(angle) * dist,
                y: p.y + Math.sin(angle) * dist,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life, maxLife: life,
                rgb: em.rgb,
                size: (0.8 + Math.random() * 0.8) * sizeMul,
            };
        }
    }

    _stopRipples() {
        this._animating = false;
        this._particles = [];
        this._emitters = [];
        if (this._animFrame) {
            cancelAnimationFrame(this._animFrame);
            this._animFrame = null;
        }
    }

    _animLoop() {
        if (!this._animating) return;

        // Emit new particles
        for (const em of this._emitters) {
            em.accum += em.rate;
            while (em.accum >= 1) {
                em.accum -= 1;
                const pt = this._spawnParticle(em);
                if (pt) this._particles.push(pt);
            }
        }

        // Update particles
        for (let i = this._particles.length - 1; i >= 0; i--) {
            const pt = this._particles[i];
            pt.x += pt.vx;
            pt.y += pt.vy;
            pt.life -= 1;
            if (pt.life <= 0) {
                this._particles.splice(i, 1);
            }
        }

        this.draw();
        this._animFrame = requestAnimationFrame(() => this._animLoop());
    }

    _drawParticles(ctx) {
        if (!this._particles.length) return;

        for (const pt of this._particles) {
            const dimmed = this.hovered && this.hovered !== pt.etf;
            if (dimmed) continue;

            const t = pt.life / pt.maxLife; // 1 = just born, 0 = dead
            // Fade in quickly then fade out slowly
            const alpha = t > 0.8 ? (1 - t) / 0.2 : t / 0.8;
            const a = alpha * 0.55;

            ctx.beginPath();
            ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${pt.rgb},${a})`;
            ctx.fill();
        }
    }

    /* ---- Drawing ---- */

    draw() {
        if (!this.active) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);

        this._drawZones(ctx);
        this._drawAxes(ctx);

        if (this.sectorMode) {
            this._drawStocks(ctx);
        } else if (this.data) {
            this._drawTrails(ctx);
            this._drawParticles(ctx);
            this._drawDots(ctx);
        }

        ctx.restore();
    }

    _drawZones(ctx) {
        const tl = { x: this.plotX, y: this.plotY };
        const br = { x: this.plotX + this.plotW, y: this.plotY + this.plotH };

        if (this.sectorMode) {
            const c = this._toScreen(100, 100);
            // Sector drill-down: original RS quadrants
            ctx.fillStyle = "rgba(34, 197, 94, 0.03)";
            ctx.fillRect(c.x, tl.y, br.x - c.x, c.y - tl.y);
            ctx.fillStyle = "rgba(234, 179, 8, 0.03)";
            ctx.fillRect(tl.x, tl.y, c.x - tl.x, c.y - tl.y);
            ctx.fillStyle = "rgba(239, 68, 68, 0.03)";
            ctx.fillRect(tl.x, c.y, c.x - tl.x, br.y - c.y);
            ctx.fillStyle = "rgba(249, 115, 22, 0.03)";
            ctx.fillRect(c.x, c.y, br.x - c.x, br.y - c.y);

            const m = this._isMobile();
            const fs = m ? 8 : 10;
            ctx.font = `500 ${fs}px -apple-system, sans-serif`;
            ctx.textAlign = "center";
            const a = "44";
            const offY = m ? 16 : 24;

            ctx.fillStyle = "#22c55e" + a;
            ctx.fillText("LEADERS", (c.x + br.x) / 2, tl.y + offY);
            ctx.fillStyle = "#eab308" + a;
            ctx.fillText("EN HAUSSE", (tl.x + c.x) / 2, tl.y + offY);
            ctx.fillStyle = "#ef4444" + a;
            ctx.fillText("A LA TRAINE", (tl.x + c.x) / 2, br.y - offY + 8);
            ctx.fillStyle = "#f97316" + a;
            ctx.fillText("EN BAISSE", (c.x + br.x) / 2, br.y - offY + 8);
        } else {
            // Signal zones — only BELOW MA50 line (Y=0)
            const x0 = this._toScreen(0, 0).x;
            const x3 = this._toScreen(3, 0).x;
            const x10 = this._toScreen(10, 0).x;
            const x15 = this._toScreen(15, 0).x;
            const y0 = this._toScreen(0, 0).y;  // MA50 = 0 line
            const h = br.y - tl.y;
            const hBelow = br.y - y0;  // height of below-MA50 area
            const m = this._isMobile();

            // Subtle tint for above-MA50 area (healthy zone)
            ctx.fillStyle = "rgba(34, 197, 94, 0.015)";
            ctx.fillRect(tl.x, tl.y, br.x - tl.x, y0 - tl.y);

            // Surveillance band — below MA50 only
            ctx.fillStyle = "rgba(148, 163, 184, 0.03)";
            ctx.fillRect(x3, y0, x10 - x3, hBelow);

            // En construction band — below MA50 only
            ctx.fillStyle = "rgba(245, 158, 11, 0.05)";
            ctx.fillRect(x10, y0, x15 - x10, hBelow);

            // Signal actif band — below MA50 only (gold gradient)
            const gradSA = ctx.createLinearGradient(x15, 0, br.x, 0);
            gradSA.addColorStop(0, "rgba(251, 191, 36, 0.06)");
            gradSA.addColorStop(1, "rgba(251, 191, 36, 0.12)");
            ctx.fillStyle = gradSA;
            ctx.fillRect(x15, y0, br.x - x15, hBelow);

            // Sweet spot glow: bottom-right corner
            const gradSweet = ctx.createRadialGradient(br.x, br.y, 0, br.x, br.y, Math.min(br.x - x15, hBelow) * 1.2);
            gradSweet.addColorStop(0, "rgba(251, 191, 36, 0.08)");
            gradSweet.addColorStop(1, "rgba(251, 191, 36, 0)");
            ctx.fillStyle = gradSweet;
            ctx.fillRect(x15, y0, br.x - x15, hBelow);

            // MA50 = 0 horizontal line (the key divider)
            ctx.beginPath();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
            ctx.lineWidth = 1;
            ctx.moveTo(tl.x, y0); ctx.lineTo(br.x, y0);
            ctx.stroke();

            // Vertical zone separators (full height for reference, dashed)
            ctx.beginPath();
            ctx.setLineDash([2, 4]);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
            ctx.lineWidth = 1;
            [x3, x10, x15].forEach(x => {
                ctx.moveTo(x, tl.y); ctx.lineTo(x, br.y);
            });
            ctx.stroke();
            ctx.setLineDash([]);

            // Inflow/outflow separator
            ctx.beginPath();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
            ctx.moveTo(x0, tl.y); ctx.lineTo(x0, br.y);
            ctx.stroke();
            ctx.setLineDash([]);

            // Zone labels — below MA50 only
            const fs = m ? 7 : 9;
            ctx.font = `500 ${fs}px -apple-system, sans-serif`;
            ctx.textAlign = "center";
            const labelY = br.y - (m ? 6 : 8);

            if (x10 - x3 > 40) {
                ctx.fillStyle = "rgba(148, 163, 184, 0.25)";
                ctx.fillText("SURVEILLANCE", (x3 + x10) / 2, labelY);
            }
            if (x15 - x10 > 30) {
                ctx.fillStyle = "rgba(245, 158, 11, 0.35)";
                ctx.fillText("EN CONSTRUCTION", (x10 + x15) / 2, labelY);
            }
            if (br.x - x15 > 50) {
                ctx.fillStyle = "rgba(251, 191, 36, 0.50)";
                ctx.fillText("SIGNAL ACTIF", (x15 + br.x) / 2, labelY);
            }

            // Above MA50 label
            ctx.fillStyle = "rgba(34, 197, 94, 0.20)";
            ctx.font = `400 ${m ? 7 : 8}px -apple-system, sans-serif`;
            ctx.textAlign = "right";
            ctx.fillText("Au-dessus MA50", br.x - 6, y0 - (m ? 4 : 6));

            // MA50 label
            ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
            ctx.font = `500 ${m ? 7 : 8}px -apple-system, sans-serif`;
            ctx.textAlign = "left";
            ctx.fillText("MA50", tl.x + 4, y0 - (m ? 3 : 4));
        }
    }

    _drawAxes(ctx) {
        const tl = { x: this.plotX, y: this.plotY };
        const br = { x: this.plotX + this.plotW, y: this.plotY + this.plotH };
        const m = this._isMobile();

        if (this.sectorMode) {
            const c = this._toScreen(100, 100);
            // Center cross
            ctx.beginPath();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
            ctx.lineWidth = 1;
            ctx.moveTo(c.x, tl.y); ctx.lineTo(c.x, br.y);
            ctx.moveTo(tl.x, c.y); ctx.lineTo(br.x, c.y);
            ctx.stroke();
            ctx.setLineDash([]);

            const fs = m ? 7 : 9;
            ctx.font = `400 ${fs}px -apple-system, sans-serif`;
            ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
            ctx.textAlign = "center";
            ctx.fillText("Force relative \u2192", (tl.x + br.x) / 2, br.y + (m ? 16 : 24));
            ctx.save();
            ctx.translate(tl.x - (m ? 18 : 28), (tl.y + br.y) / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText("Momentum \u2192", 0, 0);
            ctx.restore();
        } else {
            // Tick marks — symmetric around 0
            const tickFs = m ? 7 : 8;
            ctx.font = `400 ${tickFs}px -apple-system, sans-serif`;
            ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
            ctx.textAlign = "center";
            const tickY = br.y + (m ? 10 : 14);

            // Outflow ticks (right side)
            const outTicks = [0, 3, 10, 15];
            if (this.xMax > 22) outTicks.push(25);
            if (this.xMax > 32) outTicks.push(35);
            for (const v of outTicks) {
                if (v > this.xMax) continue;
                const p = this._toScreen(v, 0);
                ctx.fillText(v === 0 ? "0" : v + "j", p.x, tickY);
            }

            // Inflow ticks (left side)
            const inTicks = [5, 10, 15];
            for (const v of inTicks) {
                if (-v < this.xMin) continue;
                const p = this._toScreen(-v, 0);
                ctx.fillText(v + "j", p.x, tickY);
            }

            // Main labels
            const labelFs = m ? 9 : 11;
            ctx.font = `500 ${labelFs}px -apple-system, sans-serif`;
            ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
            ctx.textAlign = "center";
            const x0 = this._toScreen(0, 0).x;
            ctx.fillText("Sorties de capitaux \u2192", (x0 + br.x) / 2, br.y + (m ? 26 : 32));
            ctx.font = `400 ${m ? 8 : 9}px -apple-system, sans-serif`;
            ctx.fillStyle = "rgba(34, 197, 94, 0.30)";
            ctx.fillText("\u2190 Entr\u00e9es de capitaux", (tl.x + x0) / 2, br.y + (m ? 26 : 32));

            // Y axis labels
            const yFs = m ? 7 : 9;
            ctx.font = `500 ${yFs}px -apple-system, sans-serif`;
            ctx.textAlign = "left";
            ctx.fillStyle = "rgba(34, 197, 94, 0.30)";
            ctx.fillText("\u25b2 au-dessus MA50", tl.x + 4, tl.y + (m ? 12 : 16));
            ctx.fillStyle = "rgba(239, 68, 68, 0.30)";
            ctx.fillText("\u25bc sous MA50", tl.x + 4, br.y - (m ? 4 : 6));
        }
    }

    _drawTrails(ctx) {
        const idx = this.currentIdx;
        const start = Math.max(0, idx - this.trailLength);

        for (const etf in this.data.sectors) {
            if (!this._isVisible(etf)) continue;
            const s = this.data.sectors[etf];
            const color = s.color || "#64748b";
            const dimmed = this.hovered && this.hovered !== etf;
            const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][idx];
            const inTrade = ts && ts.inTrade;
            // Golden trail when in trade
            const trailColor = inTrade ? "#fbbf24" : color;

            ctx.beginPath();
            let started = false;
            for (let i = start; i <= idx; i++) {
                const sx = this._sectorX(etf, i);
                const sy = this._sectorY(etf, i);
                if (sy == null) continue;
                const p = this._toScreen(sx, sy);
                if (!started) { ctx.moveTo(p.x, p.y); started = true; }
                else ctx.lineTo(p.x, p.y);
            }
            if (started) {
                ctx.strokeStyle = trailColor + (dimmed ? "18" : inTrade ? "66" : "44");
                ctx.lineWidth = dimmed ? 1 : inTrade ? 2 : 1.5;
                ctx.stroke();

                for (let i = start; i < idx; i++) {
                    const sx = this._sectorX(etf, i);
                    const sy = this._sectorY(etf, i);
                    if (sy == null) continue;
                    const p = this._toScreen(sx, sy);
                    const age = (idx - i) / this.trailLength;
                    const alpha = dimmed ? 0.03 : Math.max(0.06, (inTrade ? 0.50 : 0.35) * (1 - age));
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
                    ctx.fillStyle = trailColor + Math.round(alpha * 255).toString(16).padStart(2, "0");
                    ctx.fill();
                }
            }
        }
    }

    _drawDots(ctx) {
        const idx = this.currentIdx;
        const m = this._isMobile();
        const now = Date.now();

        for (const etf in this.data.sectors) {
            if (!this._isVisible(etf)) continue;
            const s = this.data.sectors[etf];
            const sx = this._sectorX(etf, idx);
            const sy = this._sectorY(etf, idx);
            if (sy == null) continue;

            const p = this._toScreen(sx, sy);
            const color = s.color || "#64748b";
            const isH = this.hovered === etf;
            const dimmed = this.hovered && !isH;

            const dotR = this._dotRadius(etf);
            const haloR = dotR + (m ? 5 : 7);
            const streak = this._computeStreak(etf, idx);
            const ts = this._tradeStates && this._tradeStates[etf] && this._tradeStates[etf][idx];
            const inTrade = ts && ts.inTrade;
            const displayStreak = inTrade ? ts.maxStreak : streak;

            // Contrarian glow (golden radial gradient)
            const isActif = this._isSignalActif(etf, idx);
            if ((streak >= 10 || isActif) && !dimmed) {
                const pulse = Math.sin(now / 500) * 0.5 + 0.5;
                const glowR = dotR + 14 + pulse * (isActif ? 8 : 4);
                const glowAlpha = isActif ? 0.18 + pulse * 0.1 : 0.08 + pulse * 0.05;
                const grad = ctx.createRadialGradient(p.x, p.y, dotR, p.x, p.y, glowR);
                grad.addColorStop(0, `rgba(251,191,36,${glowAlpha})`);
                grad.addColorStop(1, "rgba(251,191,36,0)");
                ctx.beginPath();
                ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
                ctx.fillStyle = grad;
                ctx.fill();
            }

            // Halo
            ctx.beginPath();
            ctx.arc(p.x, p.y, isH ? haloR + 3 : haloR, 0, Math.PI * 2);
            ctx.fillStyle = color + (dimmed ? "06" : isH ? "28" : "12");
            ctx.fill();

            // Dot
            ctx.beginPath();
            ctx.arc(p.x, p.y, isH ? dotR + 2 : dotR, 0, Math.PI * 2);
            ctx.fillStyle = color + (dimmed ? "44" : isH ? "ff" : "cc");
            ctx.fill();

            // Ring — gold for signal actif, amber for construction, else CMF-based
            let ringColor;
            if (isActif) {
                ringColor = "#fbbf24cc";
            } else if (streak >= 10) {
                ringColor = "#f59e0b88";
            } else {
                ringColor = this._cmfColor(etf) || (color + "66");
            }
            ctx.strokeStyle = dimmed ? ringColor.slice(0, 7) + "22" : isH ? ringColor.slice(0, 7) + "cc" : ringColor;
            ctx.lineWidth = isActif ? 3 : streak >= 10 ? 2 : isH ? 2.5 : 1.5;
            ctx.stroke();

            // Label
            const fs = m ? 7 : 9;
            ctx.font = `600 ${fs}px -apple-system, sans-serif`;
            ctx.textAlign = "center";
            ctx.fillStyle = dimmed ? "rgba(255,255,255,0.18)" : isH ? "#fff" : "rgba(255,255,255,0.75)";
            ctx.fillText(s.name || etf, p.x, p.y - dotR - (m ? 4 : 5));

            // Streak badge (for streaks >= 5 days or in trade)
            if ((streak >= 5 || isActif) && !dimmed) {
                const badgeText = (inTrade && streak < 15) ? `\u25c9 ${ts.maxStreak}j` : `${streak}j`;
                const badgeFs = m ? 6 : 7;
                ctx.font = `700 ${badgeFs}px -apple-system, sans-serif`;
                const tw = ctx.measureText(badgeText).width;
                const bx = p.x + dotR + 4;
                const by = p.y + dotR + 2;
                const bw = tw + 6, bh = badgeFs + 4;

                // Badge colors
                let bgColor, textColor;
                if (isActif) { bgColor = "rgba(251,191,36,0.25)"; textColor = "#fbbf24"; }
                else if (streak >= 10) { bgColor = "rgba(245,158,11,0.18)"; textColor = "#f59e0b"; }
                else { bgColor = "rgba(148,163,184,0.12)"; textColor = "#94a3b8"; }

                // Rounded rect background
                const brr = 3;
                const rx = bx - 1, ry2 = by - bh + 1;
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(rx, ry2, bw, bh, brr);
                } else {
                    ctx.moveTo(rx + brr, ry2);
                    ctx.lineTo(rx + bw - brr, ry2);
                    ctx.quadraticCurveTo(rx + bw, ry2, rx + bw, ry2 + brr);
                    ctx.lineTo(rx + bw, ry2 + bh - brr);
                    ctx.quadraticCurveTo(rx + bw, ry2 + bh, rx + bw - brr, ry2 + bh);
                    ctx.lineTo(rx + brr, ry2 + bh);
                    ctx.quadraticCurveTo(rx, ry2 + bh, rx, ry2 + bh - brr);
                    ctx.lineTo(rx, ry2 + brr);
                    ctx.quadraticCurveTo(rx, ry2, rx + brr, ry2);
                    ctx.closePath();
                }
                ctx.fillStyle = bgColor;
                ctx.fill();

                // Text
                ctx.textAlign = "left";
                ctx.fillStyle = textColor;
                ctx.fillText(badgeText, bx + 2, by - 1);
            }
        }
    }

    _drawStocks(ctx) {
        const stocks = this.sectorMode.stocks;
        const color = this.sectorMode.color;
        const m = this._isMobile();

        this._sectorMaxWeight = Math.max(...stocks.map(s => s.weight || 1));

        for (const stock of stocks) {
            const r = stock.rs_ratio, mom = stock.rs_momentum;
            if (r == null || mom == null) continue;

            const p = this._toScreen(r, mom);
            const isH = this.hovered === stock.id;
            const dimmed = this.hovered && !isH;
            const dotR = this._stockRadius(stock);

            // Halo
            ctx.beginPath();
            ctx.arc(p.x, p.y, isH ? dotR + 8 : dotR + 4, 0, Math.PI * 2);
            ctx.fillStyle = color + (dimmed ? "06" : isH ? "28" : "10");
            ctx.fill();

            // Dot
            ctx.beginPath();
            ctx.arc(p.x, p.y, isH ? dotR + 1.5 : dotR, 0, Math.PI * 2);
            ctx.fillStyle = color + (dimmed ? "33" : isH ? "ff" : "aa");
            ctx.fill();

            // Quadrant-based border
            let bc;
            if (r >= 100 && mom >= 100) bc = "#22c55e";
            else if (r < 100 && mom >= 100) bc = "#eab308";
            else if (r >= 100 && mom < 100) bc = "#f97316";
            else bc = "#ef4444";
            ctx.strokeStyle = bc + (dimmed ? "22" : isH ? "bb" : "55");
            ctx.lineWidth = isH ? 2 : 1;
            ctx.stroke();

            // Label
            const fs = m ? 6 : 8;
            ctx.font = `500 ${fs}px -apple-system, sans-serif`;
            ctx.textAlign = "center";
            ctx.fillStyle = dimmed ? "rgba(255,255,255,0.15)" : isH ? "#fff" : "rgba(255,255,255,0.6)";
            ctx.fillText(stock.id, p.x, p.y - dotR - 3);
        }
    }
}
