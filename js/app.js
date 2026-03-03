/* ---------- Main application ---------- */

let chartView = null;
let appData = null;
let timelinePlaying = false;
let timelineInterval = null;
let timelineReady = false;

let tradeLog = [];
let tradeLogReady = false;
let allStockHistories = {};
let levelsData = null; // from data/levels.json

function loadData() {
    if (window.ROTATION_DATA) return window.ROTATION_DATA;
    return fetch("data/latest.json").then(r => r.ok ? r.json() : null).catch(() => null);
}

/* ---------- Summary (top bar: GOLD count + Watching count) ---------- */
function updateSummary() {
    if (!chartView) return;
    const positions = chartView._getActivePositions();
    const watching = chartView.getWatchingStocks();

    const goldEl = document.getElementById("gold-count");
    const watchEl = document.getElementById("watching-count");

    if (goldEl) {
        goldEl.innerHTML = `<span style="color:#fbbf24;font-weight:700">${positions.length}</span> <span style="color:#94a3b8">GOLD</span>`;
    }
    if (watchEl) {
        if (watching.length > 0) {
            watchEl.innerHTML = `<span style="color:#f97316;font-weight:600">${watching.length}</span> <span style="color:#94a3b8">Watching</span>`;
            watchEl.style.display = "";
            const sep = document.getElementById("summary-sep");
            if (sep) sep.style.display = "";
        } else {
            watchEl.style.display = "none";
            const sep = document.getElementById("summary-sep");
            if (sep) sep.style.display = "none";
        }
    }
}

/* ---------- Watching Bar ---------- */
function updateWatchingBar() {
    const bar = document.getElementById("watching-bar");
    if (!bar || !chartView) { if (bar) bar.style.display = "none"; return; }
    const watching = chartView.getWatchingStocks();
    if (watching.length === 0) {
        bar.style.display = "none";
        return;
    }

    let html = '<span class="watching-label">WATCHING</span>';
    for (let i = 0; i < watching.length; i++) {
        const w = watching[i];
        if (i > 0) html += '<span class="watching-sep">\u00B7</span>';
        const pct = w.ma50Pct.toFixed(1);
        html += `<span class="watching-item" title="${w.sectorName} \u00B7 ${w.etf}\nSous MA50 : ${pct}%${w.price != null ? '\nPrix : $' + w.price.toFixed(0) : ''}\nStatut : ${w.stage}">${w.ticker} ${pct}%</span>`;
    }

    bar.innerHTML = html;
    bar.style.display = "";
}

/* ---------- Load Stock Histories ---------- */
async function loadAllStockHistories() {
    if (!chartView || !chartView.data) return;
    const etfs = Object.keys(chartView.data.sectors);
    const histories = await Promise.all(etfs.map(etf =>
        fetch(`data/sectors/${etf}_history.json?t=${Date.now()}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
    ));
    allStockHistories = {};
    for (let i = 0; i < etfs.length; i++) {
        if (histories[i]) allStockHistories[etfs[i]] = histories[i];
    }
}

/* ---------- Compute Trade Log ---------- */
function computeTradeLogSync() {
    tradeLog = [];
    if (!chartView || !chartView.data || !chartView._tradeStates) return;

    const etfs = Object.keys(chartView.data.sectors);

    for (const etf of etfs) {
        const states = chartView._tradeStates[etf];
        const sh = allStockHistories[etf];
        if (!states || !sh) continue;

        for (const [ticker, sd] of Object.entries(sh.stocks)) {
            if (!sd.close || !sd.ma50) continue;
            let inTrade = false;
            let entryIdx = null;
            let entryPrice = null;

            for (let i = 0; i < sd.ma50.length; i++) {
                if (inTrade) {
                    // Exit: Take Profit +5% (backtest: 91% WR, Sharpe 1.32)
                    const curPrice = sd.close[i];
                    if (curPrice != null && entryPrice > 0 && curPrice >= entryPrice * 1.05) {
                        tradeLog.push({
                            ticker, etf,
                            name: sh.sector_name, color: sh.sector_color,
                            signalIdx: entryIdx - 1,
                            entryIdx, exitIdx: i,
                            entryDate: sh.dates[entryIdx],
                            exitDate: sh.dates[i],
                            entryPrice, exitPrice: curPrice,
                            ret: curPrice / entryPrice - 1,
                            days: i - entryIdx,
                        });
                        inTrade = false;
                        entryIdx = null;
                    }
                } else {
                    // Entry: stock < -20% below MA50 (backtest: 91% WR, no sector gate)
                    if (sd.ma50[i] != null && sd.ma50[i] < -0.20) {
                        inTrade = true;
                        entryIdx = i;
                        entryPrice = sd.close[i];
                    }
                }
            }

            if (inTrade && entryIdx != null) {
                tradeLog.push({
                    ticker, etf,
                    name: sh.sector_name, color: sh.sector_color,
                    signalIdx: entryIdx - 1,
                    entryIdx, exitIdx: null,
                    entryDate: sh.dates[entryIdx],
                    exitDate: null,
                    entryPrice, exitPrice: null,
                    ret: null, days: null, ongoing: true,
                });
            }
        }
    }

    tradeLog.sort((a, b) => a.signalIdx - b.signalIdx);
    tradeLogReady = true;
}

/* ---------- Timeline ---------- */
async function setupTimeline() {
    const slider = document.getElementById("timeline-slider");
    const dateLabel = document.getElementById("timeline-date");
    const playBtn = document.getElementById("timeline-play");
    const bar = document.getElementById("timeline-bar");
    if (!slider || !bar) return;

    chartView = new RRGView(document.getElementById("chart-canvas"));
    const historyData = await chartView.loadData();
    if (!historyData) return;

    const dateCount = chartView.getDateCount();
    if (dateCount === 0) return;

    slider.min = 0;
    slider.max = dateCount - 1;
    slider.value = dateCount - 1;
    timelineReady = true;

    bar.classList.add("visible");
    dateLabel.textContent = chartView.getDateLabel(dateCount - 1);
    chartView.setIndex(dateCount - 1);

    if (appData && appData.nodes) {
        chartView.setNodeData(appData.nodes);
    }

    // Load stock histories and compute trades
    await loadAllStockHistories();
    computeTradeLogSync();
    chartView.setTradeData(tradeLog, allStockHistories);

    chartView.activate();
    updateSummary();
    updateWatchingBar();

    // Trail slider
    const trailSlider = document.getElementById("trail-slider");
    const trailVal = document.getElementById("trail-val");
    if (trailSlider) {
        trailSlider.addEventListener("input", () => {
            chartView.trailLength = parseInt(trailSlider.value);
            if (trailVal) trailVal.textContent = trailSlider.value + "j";
            chartView.draw();
        });
    }

    // Timeline slider
    slider.addEventListener("input", () => {
        const idx = parseInt(slider.value);
        chartView.setIndex(idx);
        if (dateLabel) dateLabel.textContent = chartView.getDateLabel(idx);
        updateSummary();
        updateWatchingBar();
        updateOpenPanels();
    });

    if (playBtn) playBtn.addEventListener("click", togglePlay);

    // Panel toggles
    const panelToggle = document.getElementById("panel-toggle");
    if (panelToggle) panelToggle.addEventListener("click", toggleGoldPanel);
    const panelClose = document.getElementById("panel-close");
    if (panelClose) panelClose.addEventListener("click", toggleGoldPanel);

    const sectorToggle = document.getElementById("sector-toggle");
    if (sectorToggle) sectorToggle.addEventListener("click", toggleSectorPanel);
    const sectorClose = document.getElementById("sector-close");
    if (sectorClose) sectorClose.addEventListener("click", toggleSectorPanel);
}

function togglePlay() {
    const playBtn = document.getElementById("timeline-play");
    const slider = document.getElementById("timeline-slider");
    if (!timelineReady || !slider) return;

    if (timelinePlaying) { stopPlay(); return; }

    timelinePlaying = true;
    if (playBtn) playBtn.innerHTML = "&#9646;&#9646;";

    if (parseInt(slider.value) >= parseInt(slider.max)) {
        slider.value = 0;
        chartView.setIndex(0);
    }

    timelineInterval = setInterval(() => {
        const cur = parseInt(slider.value);
        const max = parseInt(slider.max);
        if (cur >= max) { stopPlay(); return; }
        slider.value = cur + 1;
        chartView.setIndex(cur + 1);
        const dateLabel = document.getElementById("timeline-date");
        if (dateLabel) dateLabel.textContent = chartView.getDateLabel(cur + 1);
        updateSummary();
        updateWatchingBar();
        updateOpenPanels();
    }, 150);
}

function stopPlay() {
    timelinePlaying = false;
    const playBtn = document.getElementById("timeline-play");
    if (playBtn) playBtn.innerHTML = "&#9654;";
    if (timelineInterval) { clearInterval(timelineInterval); timelineInterval = null; }
}

/* ---------- Panel refresh ---------- */
function updateOpenPanels() {
    if (document.getElementById("gold-panel").classList.contains("open")) buildGoldPanel();
    if (document.getElementById("sector-panel").classList.contains("open")) buildSectorPanel();
}

/* ---------- Portfolio (localStorage) ---------- */
const PORTFOLIO_KEY = "wtf_portfolio";
const DEFAULT_AMOUNT_KEY = "wtf_default_amount";

function getDefaultAmount() {
    return parseFloat(localStorage.getItem(DEFAULT_AMOUNT_KEY)) || 200;
}

function setDefaultAmount(val) {
    const n = parseFloat(val);
    if (n > 0) localStorage.setItem(DEFAULT_AMOUNT_KEY, n);
}

function loadPortfolio() {
    try { return JSON.parse(localStorage.getItem(PORTFOLIO_KEY)) || {}; }
    catch { return {}; }
}

function savePortfolio(pf) {
    localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(pf));
}

function addToPortfolio(ticker, buyPrice, amount, tpPct, currency) {
    const pf = loadPortfolio();
    pf[ticker] = {
        buyPrice: parseFloat(buyPrice),
        amount: parseFloat(amount),
        tpPct: parseFloat(tpPct),
        currency: currency || "EUR",
        date: new Date().toISOString().slice(0, 10),
    };
    savePortfolio(pf);
}

function removeFromPortfolio(ticker) {
    const pf = loadPortfolio();
    delete pf[ticker];
    savePortfolio(pf);
}

function calcSellPrice(buyPrice, amount, tpPct) {
    // prixVente = prixAchat × (montant + montant×TP/100 + 2) / montant
    // The +2 accounts for TR fees: 1€ buy + 1€ sell
    return buyPrice * (amount + amount * tpPct / 100 + 2) / amount;
}

function exportPortfolio() {
    const pf = loadPortfolio();
    const json = JSON.stringify(pf, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "portefeuille.json";
    a.click();
    URL.revokeObjectURL(url);
}

function importPortfolio() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const imported = JSON.parse(ev.target.result);
                const current = loadPortfolio();
                Object.assign(current, imported);
                savePortfolio(current);
                buildGoldPanel();
            } catch { alert("Fichier JSON invalide"); }
        };
        reader.readAsText(file);
    };
    input.click();
}

/* ---------- Gold Panel ---------- */
let goldPanelSort = "name"; // "name" | "recent" | "pnl" | "portfolio"
let goldPanelCurrency = "EUR"; // "EUR" | "USD"
let goldPanelFilter = ""; // ticker search filter
let eurUsdRate = null; // fetched once on load

function fetchEurUsdRate() {
    fetch("https://api.exchangerate-api.com/v4/latest/USD")
        .then(r => r.json())
        .then(d => { eurUsdRate = d.rates && d.rates.EUR ? d.rates.EUR : null; })
        .catch(() => { eurUsdRate = null; });
}

function buildGoldPanel() {
    const list = document.getElementById("gold-panel-list");
    if (!list || !chartView) return;

    const positions = chartView._getActivePositions();
    const closed = chartView._getRecentlyClosedTrades();

    const pfCount = Object.keys(loadPortfolio()).length;
    if (positions.length === 0 && closed.length === 0 && goldPanelSort !== "portfolio") {
        list.innerHTML = '<div class="gp-empty">Aucune position active</div>';
        return;
    }

    // Sort buttons
    const sortOptions = [
        { key: "name", label: "A-Z" },
        { key: "rsi", label: "RSI" },
        { key: "score", label: "Score" },
        { key: "portfolio", label: "Portef." },
    ];

    const _getScore = (ticker) => {
        const info = levelsData && levelsData.stocks && levelsData.stocks[ticker];
        return info ? info.score : 0;
    };

    const portfolio = loadPortfolio();
    const isPortfolioView = goldPanelSort === "portfolio";

    const sorted = [...positions].sort((a, b) => {
        if (goldPanelSort === "name" || goldPanelSort === "portfolio") {
            return a.ticker.localeCompare(b.ticker);
        } else if (goldPanelSort === "score") {
            return _getScore(b.ticker) - _getScore(a.ticker); // best first
        } else {
            const rsiA = a.rsi != null ? a.rsi : 999;
            const rsiB = b.rsi != null ? b.rsi : 999;
            return rsiA - rsiB;
        }
    }).filter(p => !goldPanelFilter || p.ticker.includes(goldPanelFilter));

    const isEur = goldPanelCurrency === "EUR" && eurUsdRate != null;
    const rate = isEur ? eurUsdRate : 1;
    const sym = isEur ? "\u20AC" : "$";

    let html = '<div class="gp-sort-bar">';
    for (const opt of sortOptions) {
        const cls = opt.key === goldPanelSort ? "gp-sort-btn active" : "gp-sort-btn";
        html += `<button class="${cls}" onclick="goldPanelSort='${opt.key}';buildGoldPanel()">${opt.label}</button>`;
    }
    html += '<span class="gp-sort-spacer"></span>';
    html += `<span class="gp-amount-chip" onclick="this.style.display='none';this.nextElementSibling.style.display='';this.nextElementSibling.focus()" title="Montant par d\u00e9faut">${getDefaultAmount()}\u20AC</span>`;
    html += `<input type="number" class="gp-amount-input" style="display:none" value="${getDefaultAmount()}" min="1" step="1" onblur="setDefaultAmount(this.value);buildGoldPanel()" onkeydown="if(event.key==='Enter'){this.blur()}">`;
    const eurCls = goldPanelCurrency === "EUR" ? "gp-cur-btn active" : "gp-cur-btn";
    const usdCls = goldPanelCurrency === "USD" ? "gp-cur-btn active" : "gp-cur-btn";
    html += `<button class="${eurCls}" onclick="goldPanelCurrency='EUR';buildGoldPanel()">\u20AC</button>`;
    html += `<button class="${usdCls}" onclick="goldPanelCurrency='USD';buildGoldPanel()">$</button>`;
    html += '</div>';

    // Search filter
    html += `<input type="text" class="gp-search" id="gp-search" placeholder="Filtrer par ticker..." value="${goldPanelFilter}" oninput="goldPanelFilter=this.value.toUpperCase();buildGoldPanel()">`;

    if (isPortfolioView) {
        // Portfolio view: show only stocks in the portfolio
        const pfTickers = Object.keys(portfolio).filter(t => !goldPanelFilter || t.includes(goldPanelFilter));
        if (pfTickers.length === 0) {
            html += '<div class="gp-empty">Aucun achat enregistr\u00e9<br><span style="font-size:0.65rem;color:#475569">Cliquez sur un stock \u2192 "J\'ai achet\u00e9"</span></div>';
        } else {
            for (const ticker of pfTickers.sort()) {
                const pf = portfolio[ticker];
                const sellPrice = calcSellPrice(pf.buyPrice, pf.amount, pf.tpPct);
                const profitNet = pf.amount * pf.tpPct / 100;
                const pfSym = pf.currency === "USD" ? "$" : "\u20AC";

                // Current price from levels data (in display currency)
                const lvl = levelsData && levelsData.stocks && levelsData.stocks[ticker];
                let pnlHtml = "";
                if (lvl && lvl.price) {
                    // Convert market price ($) to portfolio currency
                    const mktInPfCur = pf.currency === "USD" ? lvl.price : (eurUsdRate ? lvl.price * eurUsdRate : null);
                    if (mktInPfCur != null) {
                        const netPnl = (pf.amount * (mktInPfCur / pf.buyPrice - 1) - 2) / pf.amount * 100;
                        const pnlColor = netPnl >= 0 ? "#22c55e" : "#ef4444";
                        const pnlSign = netPnl >= 0 ? "+" : "";
                        pnlHtml = `<span class="gp-pnl" style="color:${pnlColor}">${pnlSign}${netPnl.toFixed(1)}%</span>`;
                    }
                }
                if (!pnlHtml) pnlHtml = `<span class="gp-pnl" style="color:#22c55e">TP ${pf.tpPct}%</span>`;

                html += `<div class="gp-card portfolio-card" onclick="showStockModal('${ticker}')">`;
                html += `<div class="gp-card-head">`;
                html += `<span><span class="gp-ticker">${ticker}</span></span>`;
                html += pnlHtml;
                html += `</div>`;
                html += `<div class="gp-row"><span>Achat</span><span>${pfSym}${pf.buyPrice.toFixed(2)} le ${pf.date}</span></div>`;
                html += `<div class="gp-row"><span>Montant</span><span>${pfSym}${pf.amount}</span></div>`;
                html += `<div class="gp-row gp-sell-target"><span>Vends \u00e0</span><span>${pfSym}${sellPrice.toFixed(2)} (+${pfSym}${profitNet.toFixed(0)} net)</span></div>`;
                html += `</div>`;
            }

            // Export / Import buttons
            html += '<div class="portfolio-actions">';
            html += '<button class="gp-sort-btn" onclick="exportPortfolio()">Exporter</button>';
            html += '<button class="gp-sort-btn" onclick="importPortfolio()">Importer</button>';
            html += '</div>';
        }
    } else {
        for (const p of sorted) {
            const pnlPct = (p.pnl * 100).toFixed(1);
            const pnlSign = p.pnl >= 0 ? "+" : "";
            const pnlColor = p.pnl >= 0 ? "#22c55e" : "#ef4444";
            const cardClass = p.isNew ? "gp-card new" : "gp-card";

            let rsiHtml = "";
            if (p.rsi != null) {
                const rsiCls = p.rsi < 30 ? "oversold" : p.rsi > 70 ? "overbought" : "neutral";
                rsiHtml = `<span class="gp-rsi ${rsiCls}">RSI ${p.rsi.toFixed(0)}</span>`;
            }

            const badgeHtml = p.isNew ? '<span class="gp-badge new">NEW</span>' : "";

            const stockScore = _getScore(p.ticker);
            const scoreColor = stockScore >= 80 ? "#22c55e" : stockScore >= 65 ? "#86efac" :
                stockScore >= 50 ? "#fbbf24" : stockScore >= 35 ? "#f97316" : "#ef4444";
            const scoreHtml = stockScore > 0 ? `<span class="gp-score" style="color:${scoreColor}">${stockScore}</span>` : "";

            const highlighted = chartView && chartView.hovered === p.ticker;
            const hlClass = highlighted ? " highlighted" : "";
            html += `<div class="${cardClass}${hlClass}" onclick="if(chartView){chartView.highlightTicker('${p.ticker}');buildGoldPanel()}showStockModal('${p.ticker}')">`;
            html += `<div class="gp-card-head">`;
            html += `<span><span class="gp-ticker" style="color:${p.color}">${p.ticker}</span>${badgeHtml}${rsiHtml}${scoreHtml}</span>`;
            html += `<span class="gp-pnl" style="color:${pnlColor}">${pnlSign}${pnlPct}%</span>`;
            html += `</div>`;
            html += `<div class="gp-row"><span>Jours</span><span>${p.daysHeld}j</span></div>`;
            html += `<div class="gp-row"><span>Entr\u00e9e</span><span>${sym}${(p.entryPrice * rate).toFixed(2)}</span></div>`;
            html += `<div class="gp-row"><span>Actuel</span><span>${sym}${(p.currentPrice * rate).toFixed(2)}</span></div>`;
            html += `<div class="gp-sector">${p.sectorName} \u00B7 ${p.etf}</div>`;
            html += `</div>`;
        }

        // Closed trades (ghost cards)
        const filteredClosed = closed.filter(t => !goldPanelFilter || t.ticker.includes(goldPanelFilter));
        for (const t of filteredClosed) {
            const pnlPct = t.pnl != null ? (t.pnl * 100).toFixed(1) : "5.0";
            html += `<div class="gp-card sold">`;
            html += `<div class="gp-card-head">`;
            html += `<span><span class="gp-ticker" style="color:${t.color}">${t.ticker}</span><span class="gp-badge sold">SOLD +5%</span></span>`;
            html += `<span class="gp-pnl" style="color:#22c55e">+${pnlPct}%</span>`;
            html += `</div>`;
            html += `<div class="gp-row"><span>Dur\u00e9e</span><span>${t.days}j</span></div>`;
            html += `<div class="gp-row"><span>Entr\u00e9e</span><span>${sym}${(t.entryPrice * rate).toFixed(2)}</span></div>`;
            html += `<div class="gp-row"><span>Sortie</span><span>${sym}${(t.exitPrice * rate).toFixed(2)}</span></div>`;
            html += `<div class="gp-sector">${t.sectorName} \u00B7 ${t.etf}</div>`;
            html += `</div>`;
        }
    }

    list.innerHTML = html;

    // Restore focus on search input after rebuild
    if (goldPanelFilter) {
        const input = document.getElementById("gp-search");
        if (input) { input.focus(); input.selectionStart = input.selectionEnd = input.value.length; }
    }
}

function closePanel(panelId, btnId, label) {
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (panel) panel.classList.remove("open");
    if (btn) { btn.innerHTML = "&#9656; " + label; btn.classList.remove("active"); }
}

function toggleGoldPanel() {
    const panel = document.getElementById("gold-panel");
    const btn = document.getElementById("panel-toggle");
    if (!panel) return;

    const isOpen = panel.classList.toggle("open");
    if (btn) {
        btn.innerHTML = isOpen ? "&#9666; Positions" : "&#9656; Positions";
        btn.classList.toggle("active", isOpen);
    }
    if (isOpen) {
        closePanel("sector-panel", "sector-toggle", "Secteurs");
        buildGoldPanel();
    }
}

/* ---------- Sector Panel ---------- */
function buildSectorPanel() {
    const grid = document.getElementById("sector-panel-grid");
    if (!grid || !chartView) return;

    const sectors = chartView.getSectorOverview();
    if (sectors.length === 0) { grid.innerHTML = ""; return; }

    let html = "";
    for (const s of sectors) {
        const stageLabel = s.stage === "actif" ? "GOLD" : s.stage === "construction" ? "Construction" : s.stage === "surveillance" ? "Surveillance" : "Neutre";
        const cardClass = s.stage === "actif" ? "gold" : s.stage || "";
        const badgeClass = s.stage === "actif" ? "gold" : s.stage || "neutral";

        html += `<div class="sc-card ${cardClass}">`;
        html += `<div class="sc-card-top">`;
        html += `<div><span class="sc-name" style="color:${s.color}">${s.name}</span> <span class="sc-etf">${s.etf}</span></div>`;
        html += `<span class="sc-stage-badge ${badgeClass}">${stageLabel}</span>`;
        html += `</div>`;

        html += `<div class="sc-metrics">`;
        if (s.streak > 0) {
            html += `<span class="sc-metric">Streak <b>${s.streak}j</b></span>`;
        }
        if (s.cmf !== 0) {
            const cmfColor = s.cmf <= -0.15 ? "#ef4444" : s.cmf < 0 ? "#f97316" : "#64748b";
            html += `<span class="sc-metric">CMF <b style="color:${cmfColor}">${s.cmf.toFixed(2)}</b></span>`;
        }
        if (s.posCount > 0) {
            html += `<span class="sc-pos-count">${s.posCount} pos.</span>`;
        }
        html += `</div>`;
        html += `</div>`;
    }

    grid.innerHTML = html;
}

function toggleSectorPanel() {
    const panel = document.getElementById("sector-panel");
    const btn = document.getElementById("sector-toggle");
    if (!panel) return;

    const isOpen = panel.classList.toggle("open");
    if (btn) {
        btn.innerHTML = isOpen ? "&#9666; Secteurs" : "&#9656; Secteurs";
        btn.classList.toggle("active", isOpen);
    }
    if (isOpen) {
        closePanel("gold-panel", "panel-toggle", "Positions");
        buildSectorPanel();
    }
}

/* ---------- Stock Detail Modal ---------- */
function fetchLevels() {
    fetch(`data/levels.json?t=${Date.now()}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { levelsData = d; })
        .catch(() => { levelsData = null; });
}

function showStockModal(ticker) {
    // Remove existing modal
    const old = document.getElementById("stock-modal");
    if (old) old.remove();

    const info = levelsData && levelsData.stocks && levelsData.stocks[ticker];
    if (!info) {
        // No levels data — show basic info
        return;
    }

    const isEur = goldPanelCurrency === "EUR" && eurUsdRate != null;
    const rate = isEur ? eurUsdRate : 1;
    const sym = isEur ? "\u20AC" : "$";

    const scoreColor = info.score >= 75 ? "#22c55e" : info.score >= 60 ? "#86efac" :
        info.score >= 45 ? "#fbbf24" : info.score >= 30 ? "#f97316" : "#ef4444";

    const filled = Math.round(info.score / 5);
    const scoreBar = "\u25A0".repeat(filled) + "\u00B7".repeat(20 - filled);

    let html = `<div class="sm-overlay" onclick="closeStockModal()">`;
    html += `<div class="sm-window" onclick="event.stopPropagation()">`;
    html += `<button class="sm-close" onclick="closeStockModal()">&times;</button>`;

    // Header
    html += `<div class="sm-header">`;
    html += `<span><span class="sm-ticker">${ticker}</span><button class="sm-copy" onclick="navigator.clipboard.writeText('${ticker}');this.textContent='OK';setTimeout(()=>this.textContent='Copier',1000)">Copier</button></span>`;
    html += `<span class="sm-price">${sym}${(info.price * rate).toFixed(2)}</span>`;
    html += `</div>`;

    // Verdict
    html += `<div class="sm-verdict" style="color:${scoreColor}">`;
    html += `<div class="sm-verdict-label">${info.verdict}</div>`;
    html += `<div class="sm-score-bar"><span style="color:${scoreColor}">${scoreBar}</span> ${info.score}/100</div>`;
    html += `<div class="sm-verdict-text">${info.verdict_text}</div>`;
    html += `</div>`;

    // Quick stats
    html += `<div class="sm-stats">`;
    html += `<div class="sm-stat"><span>Tendance</span><span>${info.trend} (${info.swing_low.toFixed(0)} \u2192 ${info.swing_high.toFixed(0)})</span></div>`;
    html += `<div class="sm-stat"><span>RSI</span><span>${info.rsi.toFixed(0)} (${info.rsi_label})</span></div>`;
    html += `<div class="sm-stat"><span>vs MA50</span><span>${info.dist_ma50 > 0 ? "+" : ""}${info.dist_ma50.toFixed(1)}% (${info.ma50_label})</span></div>`;
    html += `</div>`;

    // Supports
    html += `<div class="sm-section-title">Planchers (supports)</div>`;
    if (info.supports && info.supports.length > 0) {
        html += `<div class="sm-levels">`;
        for (let i = 0; i < Math.min(info.supports.length, 4); i++) {
            const s = info.supports[i];
            const stars = "\u2605".repeat(Math.min(s.strength, 5));
            html += `<div class="sm-level support">`;
            html += `<span>#${i + 1}</span>`;
            html += `<span>${sym}${(s.price * rate).toFixed(2)}</span>`;
            html += `<span class="sm-dist">${s.dist_pct > 0 ? "+" : ""}${s.dist_pct.toFixed(1)}%</span>`;
            html += `<span class="sm-stars">${stars}</span>`;
            html += `</div>`;
        }
        html += `</div>`;
    } else {
        html += `<div class="sm-empty">Aucun plancher identifi\u00e9</div>`;
    }

    // Resistances
    html += `<div class="sm-section-title">Plafonds (r\u00e9sistances)</div>`;
    if (info.resistances && info.resistances.length > 0) {
        html += `<div class="sm-levels">`;
        for (let i = 0; i < Math.min(info.resistances.length, 4); i++) {
            const r = info.resistances[i];
            const stars = "\u2605".repeat(Math.min(r.strength, 5));
            html += `<div class="sm-level resistance">`;
            html += `<span>#${i + 1}</span>`;
            html += `<span>${sym}${(r.price * rate).toFixed(2)}</span>`;
            html += `<span class="sm-dist">+${r.dist_pct.toFixed(1)}%</span>`;
            html += `<span class="sm-stars">${stars}</span>`;
            html += `</div>`;
        }
        html += `</div>`;
    } else {
        html += `<div class="sm-empty">Aucun plafond identifi\u00e9</div>`;
    }

    // Risk / Reward
    if (info.supports && info.supports.length > 0 && info.resistances && info.resistances.length > 0) {
        const s1 = info.supports[0];
        const r1 = info.resistances[0];
        const risk = Math.abs(s1.dist_pct);
        const reward = Math.abs(r1.dist_pct);
        const rr = risk > 0 ? (reward / risk).toFixed(1) : "0.0";
        const rrColor = reward / risk >= 2 ? "#22c55e" : reward / risk >= 1 ? "#fbbf24" : "#ef4444";
        const rrLabel = reward / risk >= 2 ? "bon" : reward / risk >= 1 ? "correct" : "d\u00e9favorable";

        html += `<div class="sm-section-title">Risque / Gain</div>`;
        html += `<div class="sm-rr">`;
        html += `<div><span class="sm-rr-down">\u25BC</span> Plancher #1 \u00e0 ${sym}${(s1.price * rate).toFixed(2)} <span class="sm-dist">(${s1.dist_pct.toFixed(1)}%)</span></div>`;
        html += `<div><span class="sm-rr-up">\u25B2</span> Plafond #1 \u00e0 ${sym}${(r1.price * rate).toFixed(2)} <span class="sm-dist">(+${r1.dist_pct.toFixed(1)}%)</span></div>`;
        html += `<div class="sm-rr-ratio">Ratio: <span style="color:${rrColor}">${rr}x (${rrLabel})</span></div>`;
        html += `</div>`;
    }

    // Portfolio section: buy form or summary
    const portfolio = loadPortfolio();
    const pfEntry = portfolio[ticker];

    html += `<div class="sm-section-title">Mon Portefeuille</div>`;

    if (pfEntry) {
        // Already bought — show summary + sell target in levels context
        const sellPrice = calcSellPrice(pfEntry.buyPrice, pfEntry.amount, pfEntry.tpPct);
        const profitNet = pfEntry.amount * pfEntry.tpPct / 100;
        const pfSym = pfEntry.currency === "USD" ? "$" : "\u20AC";

        // P&L: convert market price to portfolio currency
        let pnlLine = "";
        if (info.price) {
            const mktInPfCur = pfEntry.currency === "USD" ? info.price : (eurUsdRate ? info.price * eurUsdRate : null);
            if (mktInPfCur != null) {
                const netPnl = (pfEntry.amount * (mktInPfCur / pfEntry.buyPrice - 1) - 2) / pfEntry.amount * 100;
                const pnlColor = netPnl >= 0 ? "#22c55e" : "#ef4444";
                const pnlSign = netPnl >= 0 ? "+" : "";
                pnlLine = `<div class="gp-row"><span>P&L net</span><span style="color:${pnlColor};font-weight:700">${pnlSign}${netPnl.toFixed(1)}%</span></div>`;
            }
        }

        html += `<div class="sm-buy-form">`;
        html += `<div class="gp-row"><span>Achat</span><span>${pfSym}${pfEntry.buyPrice.toFixed(2)} le ${pfEntry.date}</span></div>`;
        html += `<div class="gp-row"><span>Montant</span><span>${pfSym}${pfEntry.amount}</span></div>`;
        html += pnlLine;
        html += `<div class="gp-row gp-sell-target"><span>Vends \u00e0</span><span style="color:#22c55e;font-weight:700">${pfSym}${sellPrice.toFixed(2)} pour +${pfSym}${profitNet.toFixed(0)} net</span></div>`;
        html += `<button class="sm-buy-btn sold-btn" onclick="removeFromPortfolio('${ticker}');closeStockModal();showStockModal('${ticker}');buildGoldPanel()">Vendu / Retirer</button>`;
        html += `</div>`;
    } else {
        // Buy form
        const defaultPrice = info.price ? info.price.toFixed(2) : "";
        html += `<div class="sm-buy-form">`;
        html += `<div class="sm-buy-row"><label>Prix d'achat (${sym})</label><input type="number" id="pf-buy-price" value="" placeholder="ex: ${isEur ? '46.00' : '50.00'}" step="0.01" min="0"></div>`;
        html += `<div class="sm-buy-row"><label>Montant (${sym})</label><input type="number" id="pf-amount" value="${getDefaultAmount()}" step="10" min="1"></div>`;
        html += `<div class="sm-buy-row"><label>TP cible (%)</label><input type="number" id="pf-tp" value="5" step="0.5" min="0.5"></div>`;
        html += `<button class="sm-buy-btn" onclick="addToPortfolio('${ticker}',document.getElementById('pf-buy-price').value,document.getElementById('pf-amount').value,document.getElementById('pf-tp').value,'${goldPanelCurrency}');closeStockModal();showStockModal('${ticker}');buildGoldPanel()">J'ai achet\u00e9</button>`;
        html += `</div>`;
    }

    html += `</div></div>`;

    const modal = document.createElement("div");
    modal.id = "stock-modal";
    modal.innerHTML = html;
    document.body.appendChild(modal);

    // Insert TP into resistances (always) and PRU into supports (if bought)
    // If in portfolio: use real values. Otherwise: theoretical TP based on current price.
    if (info.price) {
        const displayPrice = info.price * rate; // current price in display currency
        let tpDisplay, tpLabel;

        if (pfEntry) {
            const sellPrice = calcSellPrice(pfEntry.buyPrice, pfEntry.amount, pfEntry.tpPct);
            const pfIsEur = pfEntry.currency !== "USD";
            let toDisplay = 1;
            if (pfIsEur && !isEur && eurUsdRate) toDisplay = 1 / eurUsdRate;
            if (!pfIsEur && isEur && eurUsdRate) toDisplay = eurUsdRate;
            tpDisplay = sellPrice * toDisplay;
            tpLabel = `TP${pfEntry.tpPct}%`;
        } else {
            // Theoretical: if buying now at display price, 200 amount, 5% TP
            const theoSell = calcSellPrice(displayPrice, getDefaultAmount(), 5);
            tpDisplay = theoSell;
            tpLabel = "TP5%";
        }

        const tpDist = ((tpDisplay - displayPrice) / displayPrice * 100).toFixed(1);
        const levelsContainers = modal.querySelectorAll(".sm-levels");

        // Insert TP into resistances (2nd .sm-levels)
        if (levelsContainers.length >= 2) {
            const rList = levelsContainers[1];
            const tpEl = document.createElement("div");
            tpEl.className = "sm-level resistance sm-level-tp";
            tpEl.innerHTML = `<span>${tpLabel}</span><span>${sym}${tpDisplay.toFixed(2)}</span><span class="sm-dist">+${tpDist}%</span><span class="sm-stars" style="color:#22c55e">\u2605</span>`;
            let inserted = false;
            for (const child of rList.children) {
                const priceText = child.querySelectorAll("span")[1];
                if (priceText) {
                    const p = parseFloat(priceText.textContent.replace(/[$\u20AC]/g, ""));
                    if (tpDisplay < p) { rList.insertBefore(tpEl, child); inserted = true; break; }
                }
            }
            if (!inserted) rList.appendChild(tpEl);
        }

        // Insert PRU into supports (only if bought)
        if (pfEntry && levelsContainers.length >= 1) {
            const pfIsEur = pfEntry.currency !== "USD";
            let toDisplay = 1;
            if (pfIsEur && !isEur && eurUsdRate) toDisplay = 1 / eurUsdRate;
            if (!pfIsEur && isEur && eurUsdRate) toDisplay = eurUsdRate;
            const pruDisplay = pfEntry.buyPrice * toDisplay;
            const pruDist = ((pruDisplay - displayPrice) / displayPrice * 100).toFixed(1);

            const sList = levelsContainers[0];
            const pruEl = document.createElement("div");
            pruEl.className = "sm-level support sm-level-tp";
            pruEl.style.background = "rgba(99, 102, 241, 0.08)";
            pruEl.style.border = "1px dashed rgba(99, 102, 241, 0.3)";
            pruEl.innerHTML = `<span>PRU</span><span>${sym}${pruDisplay.toFixed(2)}</span><span class="sm-dist">${pruDist}%</span><span class="sm-stars" style="color:#818cf8">\u2605</span>`;
            let inserted = false;
            for (const child of sList.children) {
                const priceText = child.querySelectorAll("span")[1];
                if (priceText) {
                    const p = parseFloat(priceText.textContent.replace(/[$\u20AC]/g, ""));
                    if (pruDisplay > p) { sList.insertBefore(pruEl, child); inserted = true; break; }
                }
            }
            if (!inserted) sList.appendChild(pruEl);
        }
    }
}

function closeStockModal() {
    const m = document.getElementById("stock-modal");
    if (m) m.remove();
}

/* ---------- Init ---------- */
async function init() {
    fetchEurUsdRate();
    fetchLevels();
    appData = await Promise.resolve(loadData());
    if (!appData || !appData.nodes) return;

    // Last update
    const updateEl = document.getElementById("last-update");
    if (updateEl && appData.metadata && appData.metadata.date) {
        const ts = appData.metadata.generated_at || appData.metadata.date;
        const d = new Date(ts.includes("T") ? ts : ts + "T22:00:00Z");
        updateEl.textContent = d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    }

    await setupTimeline();
}

document.addEventListener("DOMContentLoaded", init);
