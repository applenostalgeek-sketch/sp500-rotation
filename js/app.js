/* ---------- Main application ---------- */

let chartView = null;
let appData = null;
let timelinePlaying = false;
let timelineInterval = null;
let timelineReady = false;

let tradeLog = [];
let tradeLogReady = false;
let allStockHistories = {};

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

            for (let i = 0; i < states.length && i < sd.ma50.length; i++) {
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
                    const isIn = states[i] && states[i].inTrade;
                    const wasIn = i > 0 && states[i - 1] && states[i - 1].inTrade;

                    if (isIn && !wasIn && sd.ma50[i] != null && sd.ma50[i] <= -0.08) {
                        const ei = i + 1;
                        if (ei < sd.close.length && sd.close[ei] != null) {
                            inTrade = true;
                            entryIdx = ei;
                            entryPrice = sd.close[ei];
                        }
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
    });

    if (playBtn) playBtn.addEventListener("click", togglePlay);
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
    }, 150);
}

function stopPlay() {
    timelinePlaying = false;
    const playBtn = document.getElementById("timeline-play");
    if (playBtn) playBtn.innerHTML = "&#9654;";
    if (timelineInterval) { clearInterval(timelineInterval); timelineInterval = null; }
}

/* ---------- Init ---------- */
async function init() {
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
