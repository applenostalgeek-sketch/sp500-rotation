/* ---------- Main application ---------- */

let chartView = null;
let appData = null;
let timelinePlaying = false;
let timelineInterval = null;
let timelineReady = false;

/* Screener state */
let currentView = "graph";
let allStocks = [];
let screenerLoaded = false;
let currentSort = { col: "rs_ratio", dir: "desc" };

function loadData() {
    if (window.ROTATION_DATA) return window.ROTATION_DATA;
    return fetch("data/latest.json").then(r => r.ok ? r.json() : null).catch(() => null);
}

/* ---------- View Switch ---------- */
function setupViewSwitch() {
    const btns = document.querySelectorAll(".view-btn");
    btns.forEach(btn => {
        btn.addEventListener("click", () => {
            const view = btn.dataset.view;
            if (view === currentView) return;
            currentView = view;

            btns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");

            if (view === "graph") {
                document.getElementById("screener-view").classList.add("hidden");
                document.getElementById("chart-view").style.display = "";
                document.getElementById("top-bar").style.display = "";
                document.getElementById("timeline-bar").classList.add("visible");
                if (chartView) { chartView._resize(); chartView.draw(); }
            } else {
                document.getElementById("chart-view").style.display = "none";
                document.getElementById("top-bar").style.display = "none";
                document.getElementById("timeline-bar").classList.remove("visible");
                document.getElementById("screener-view").classList.remove("hidden");
                stopPlay();
                if (!screenerLoaded) loadAllStocks();
            }
        });
    });
}

/* ---------- Meteo (compact top bar) ---------- */
function renderMeteo(nodes) {
    const positive = nodes.filter(n => n.cmf > 0.005);
    const negative = nodes.filter(n => n.cmf < -0.005);
    const totalW = nodes.reduce((s, n) => s + n.weight, 0);
    const wAvg = nodes.reduce((s, n) => s + n.cmf * n.weight, 0) / totalW;

    let icon, label;
    if (wAvg < -0.05) { icon = "\u26C8\uFE0F"; label = "Orage"; }
    else if (positive.length >= 9 && wAvg > 0.02) { icon = "\u2600\uFE0F"; label = "Grand soleil"; }
    else if (positive.length >= 8) { icon = "\uD83C\uDF24\uFE0F"; label = "Beau temps"; }
    else if (positive.length >= 6) { icon = "\u26C5"; label = "Eclaircies"; }
    else if (positive.length >= 4) { icon = "\uD83C\uDF25\uFE0F"; label = "Mitige"; }
    else if (negative.length >= 7) { icon = "\uD83C\uDF27\uFE0F"; label = "Pluie"; }
    else { icon = "\uD83C\uDF25\uFE0F"; label = "Couvert"; }

    const el = (id) => document.getElementById(id);
    el("meteo-icon-sm").textContent = icon;
    el("meteo-label-sm").textContent = label;
    el("meteo-count").textContent = `${positive.length}/11 \u2191`;
}

/* ---------- Sector zoom ---------- */
async function loadSectorData(etf) {
    try {
        const resp = await fetch(`data/sectors/${etf}.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error("Not found");
        return await resp.json();
    } catch (err) {
        console.error("Sector fetch error:", err);
        return null;
    }
}

function enterSectorMode(data) {
    chartView.enterSector(data);

    document.getElementById("bar-global").style.display = "none";
    document.getElementById("bar-sector").style.display = "";
    document.getElementById("sector-title").textContent = `${data.sector_name} \u00B7 ${data.stocks.length} actions`;
    document.getElementById("sector-title").style.color = data.sector_color;

    document.getElementById("timeline-bar").classList.remove("visible");
    document.getElementById("view-switch").style.display = "none";
    document.getElementById("sector-filters").style.display = "none";
    stopPlay();
}

function exitSectorMode() {
    chartView.exitSector();

    document.getElementById("bar-global").style.display = "";
    document.getElementById("bar-sector").style.display = "none";

    document.getElementById("timeline-bar").classList.add("visible");
    document.getElementById("view-switch").style.display = "";
    document.getElementById("sector-filters").style.display = "";
    applySignalFilter();
}

function buildSectorFilters() {
    const container = document.getElementById("sector-filters");
    if (!container || !chartView || !chartView.data) return;

    container.innerHTML = "";

    // Signal filter chip
    const sigChip = document.createElement("button");
    sigChip.className = "sector-chip sector-chip-signal";
    sigChip.id = "signal-filter-chip";
    sigChip.innerHTML = `<span class="chip-dot" style="background:#fbbf24"></span>Signaux`;
    sigChip.addEventListener("click", () => {
        signalFilterActive = !signalFilterActive;
        sigChip.classList.toggle("active", signalFilterActive);
        if (signalFilterActive) {
            applySignalFilter();
        } else {
            chartView.showAllSectors();
            container.querySelectorAll(".sector-chip[data-etf]").forEach(c => c.classList.add("active"));
            updateResetChipVisibility();
        }
    });
    container.appendChild(sigChip);

    // Separator
    const sep = document.createElement("span");
    sep.className = "chip-sep";
    container.appendChild(sep);

    // Sector chips
    for (const etf in chartView.data.sectors) {
        const s = chartView.data.sectors[etf];
        const chip = document.createElement("button");
        chip.className = "sector-chip active";
        chip.style.setProperty("--chip-color", s.color);
        chip.innerHTML = `<span class="chip-dot" style="background:${s.color}"></span>${etf}`;
        chip.dataset.etf = etf;

        chip.addEventListener("click", () => {
            // Deactivate signal filter mode when manually toggling
            if (signalFilterActive) {
                signalFilterActive = false;
                document.getElementById("signal-filter-chip").classList.remove("active");
            }
            chartView.toggleSector(etf);
            chip.classList.toggle("active");
            updateResetChipVisibility();
        });

        container.appendChild(chip);
    }

    // Reset button
    const reset = document.createElement("button");
    reset.className = "sector-chip-reset";
    reset.textContent = "Tous";
    reset.id = "sector-filter-reset";
    reset.style.display = "none";
    reset.addEventListener("click", () => {
        signalFilterActive = false;
        const sigEl = document.getElementById("signal-filter-chip");
        if (sigEl) sigEl.classList.remove("active");
        chartView.showAllSectors();
        container.querySelectorAll(".sector-chip[data-etf]").forEach(c => c.classList.add("active"));
        reset.style.display = "none";
    });
    container.appendChild(reset);
}

function updateResetChipVisibility() {
    const reset = document.getElementById("sector-filter-reset");
    if (!reset || !chartView) return;
    reset.style.display = chartView.hiddenSectors.size > 0 ? "" : "none";
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

    // Pass latest node data for CMF sizing
    if (appData && appData.nodes) {
        chartView.setNodeData(appData.nodes);
    }

    chartView.activate();
    buildSectorFilters();

    // Sector click handler
    chartView.onSectorClick(async (etf) => {
        const data = await loadSectorData(etf);
        if (data && data.stocks && data.stocks.length > 0) {
            enterSectorMode(data);
        }
    });

    // Back button
    document.getElementById("sector-back").addEventListener("click", exitSectorMode);

    // Slider
    slider.addEventListener("input", () => {
        const idx = parseInt(slider.value);
        chartView.setIndex(idx);
        if (dateLabel) dateLabel.textContent = chartView.getDateLabel(idx);
        applySignalFilter();
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
        applySignalFilter();
    }, 150);
}

function stopPlay() {
    timelinePlaying = false;
    const playBtn = document.getElementById("timeline-play");
    if (playBtn) playBtn.innerHTML = "&#9654;";
    if (timelineInterval) { clearInterval(timelineInterval); timelineInterval = null; }
}

/* ---------- Signal Filter ---------- */

let signalFilterActive = false;

function applySignalFilter() {
    if (!signalFilterActive || !chartView || !chartView.data) return;
    const idx = chartView.currentIdx;
    const signalEtfs = new Set();
    for (const etf in chartView.data.sectors) {
        if (chartView._isSignalActif(etf, idx)) signalEtfs.add(etf);
    }

    const container = document.getElementById("sector-filters");
    if (!container) return;

    for (const etf in chartView.data.sectors) {
        if (signalEtfs.has(etf)) {
            chartView.hiddenSectors.delete(etf);
        } else {
            chartView.hiddenSectors.add(etf);
        }
    }

    // Update chip visual states
    container.querySelectorAll(".sector-chip[data-etf]").forEach(chip => {
        const etf = chip.dataset.etf;
        chip.classList.toggle("active", !chartView.hiddenSectors.has(etf));
    });

    chartView._initEmitters();
    chartView._particles = [];
    chartView.draw();
    updateResetChipVisibility();
}

/* ---------- Screener ---------- */

const PHASE_LABELS = {
    leading: "Leader",
    improving: "En hausse",
    weakening: "En baisse",
    lagging: "A la traine",
};

const SECTOR_ETFS = ["XLK", "XLF", "XLV", "XLC", "XLI", "XLY", "XLP", "XLE", "XLU", "XLRE", "XLB"];

async function loadAllStocks() {
    screenerLoaded = true;
    const statsEl = document.getElementById("screener-stats");
    if (statsEl) statsEl.innerHTML = `<span>Chargement...</span>`;

    const results = await Promise.all(
        SECTOR_ETFS.map(etf =>
            fetch(`data/sectors/${etf}.json?t=${Date.now()}`)
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
        )
    );

    allStocks = [];
    const sectorNames = new Map();

    // Compute contrarian streaks from history data
    const sectorStreaks = {};
    if (chartView && chartView.data) {
        const latestIdx = chartView.data.dates.length - 1;
        for (const etf in chartView.data.sectors) {
            sectorStreaks[etf] = chartView._computeStreak(etf, latestIdx);
        }
    }

    // Compute MA50 status + trade state per sector for signal actif condition
    const sectorBelowMA50 = {};
    const sectorInTrade = {};
    if (chartView.data && chartView.data.sectors) {
        const latIdx = chartView.data.dates.length - 1;
        for (const etf in chartView.data.sectors) {
            const s = chartView.data.sectors[etf];
            const ma50 = s.ma50 && s.ma50[latIdx] != null ? s.ma50[latIdx] : null;
            sectorBelowMA50[etf] = ma50 !== null && ma50 < 0;
            const ts = chartView._tradeStates && chartView._tradeStates[etf] && chartView._tradeStates[etf][latIdx];
            sectorInTrade[etf] = ts && ts.inTrade ? ts : null;
        }
    }

    for (const data of results) {
        if (!data || !data.stocks) continue;
        sectorNames.set(data.etf, data.sector_name);
        const streak = sectorStreaks[data.etf] || 0;
        const ts = sectorInTrade[data.etf];
        for (const stock of data.stocks) {
            allStocks.push({
                ...stock,
                sector_etf: data.etf,
                sector_name: data.sector_name,
                sector_color: data.sector_color,
                signal_streak: ts ? ts.maxStreak : streak,
                below_ma50: sectorBelowMA50[data.etf] || false,
                in_trade: !!ts,
            });
        }
    }

    populateSectorFilter(sectorNames);
    renderScreener();
    setupScreenerEvents();
}

function populateSectorFilter(sectorNames) {
    const sel = document.getElementById("screener-sector-filter");
    if (!sel) return;
    // Keep first option "Tous secteurs"
    while (sel.options.length > 1) sel.remove(1);
    for (const [etf, name] of sectorNames) {
        const opt = document.createElement("option");
        opt.value = etf;
        opt.textContent = name;
        sel.appendChild(opt);
    }
}

function getFilteredSortedStocks() {
    const search = (document.getElementById("screener-search").value || "").toUpperCase().trim();
    const phase = document.getElementById("screener-phase-filter").value;
    const sector = document.getElementById("screener-sector-filter").value;

    let filtered = allStocks;

    if (search) {
        filtered = filtered.filter(s =>
            s.id.toUpperCase().includes(search) ||
            s.sector_name.toUpperCase().includes(search)
        );
    }
    if (phase) {
        filtered = filtered.filter(s => s.momentum_phase === phase);
    }
    if (sector) {
        filtered = filtered.filter(s => s.sector_etf === sector);
    }

    // Sort
    const { col, dir } = currentSort;
    filtered.sort((a, b) => {
        let va = a[col], vb = b[col];
        if (typeof va === "string") {
            va = va.toLowerCase(); vb = (vb || "").toLowerCase();
            return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        va = va ?? 0; vb = vb ?? 0;
        return dir === "asc" ? va - vb : vb - va;
    });

    return filtered;
}

function renderScreener() {
    const stocks = getFilteredSortedStocks();
    const tbody = document.getElementById("screener-body");
    const statsEl = document.getElementById("screener-stats");
    if (!tbody) return;

    // Stats
    const leaders = stocks.filter(s => s.momentum_phase === "leading").length;
    const improving = stocks.filter(s => s.momentum_phase === "improving").length;
    const weakening = stocks.filter(s => s.momentum_phase === "weakening").length;
    const lagging = stocks.filter(s => s.momentum_phase === "lagging").length;

    if (statsEl) {
        statsEl.innerHTML = `
            <span><span class="stat-val">${stocks.length}</span> actions</span>
            <span style="color:var(--green)"><span class="stat-val">${leaders}</span> leaders</span>
            <span style="color:var(--yellow)"><span class="stat-val">${improving}</span> en hausse</span>
            <span style="color:var(--orange)"><span class="stat-val">${weakening}</span> en baisse</span>
            <span style="color:var(--red)"><span class="stat-val">${lagging}</span> a la traine</span>
        `;
    }

    // Sort indicators on headers
    document.querySelectorAll("#screener-table th[data-sort]").forEach(th => {
        th.classList.remove("sort-asc", "sort-desc");
        if (th.dataset.sort === currentSort.col) {
            th.classList.add(currentSort.dir === "asc" ? "sort-asc" : "sort-desc");
        }
    });

    // Rows
    const rows = stocks.map(s => {
        const phaseClass = `phase-${s.momentum_phase || "lagging"}`;
        const phaseLabel = PHASE_LABELS[s.momentum_phase] || s.momentum_phase || "—";

        const r5 = s.return_5d || 0;
        const r20 = s.return_20d || 0;
        const r5Class = r5 >= 0 ? "val-positive" : "val-negative";
        const r20Class = r20 >= 0 ? "val-positive" : "val-negative";
        const r5Str = (r5 >= 0 ? "+" : "") + (r5 * 100).toFixed(1) + "%";
        const r20Str = (r20 >= 0 ? "+" : "") + (r20 * 100).toFixed(1) + "%";

        const rsi = s.rsi || 0;
        let rsiClass = "val-neutral";
        if (rsi > 70) rsiClass = "rsi-overbought";
        else if (rsi < 30) rsiClass = "rsi-oversold";

        // Signal badge
        let signalHtml = '<span style="color:#475569">—</span>';
        const streak = s.signal_streak || 0;
        const belowMA50 = s.below_ma50 || false;
        const inTrade = s.in_trade || false;
        if ((streak >= 15 && belowMA50) || inTrade) {
            signalHtml = `<span class="signal-badge signal-badge-active">&#9889; ${streak}j</span>`;
        } else if (streak >= 10) {
            signalHtml = `<span class="signal-badge signal-badge-building">${streak}j</span>`;
        } else if (streak >= 5) {
            signalHtml = `<span class="signal-badge signal-badge-watch">${streak}j</span>`;
        }

        return `<tr>
            <td class="stock-ticker">${s.id}</td>
            <td><span class="sector-badge" style="color:${s.sector_color};border-color:${s.sector_color}44">${s.sector_name}</span></td>
            <td><span class="phase-badge ${phaseClass}">${phaseLabel}</span></td>
            <td>${signalHtml}</td>
            <td class="${rsiClass}">${rsi.toFixed(0)}</td>
            <td class="${r5Class}">${r5Str}</td>
            <td class="${r20Class}">${r20Str}</td>
            <td>${(s.rs_ratio || 0).toFixed(1)}</td>
            <td>${(s.rs_momentum || 0).toFixed(1)}</td>
        </tr>`;
    });

    tbody.innerHTML = rows.join("");
}

let _screenerEventsReady = false;
function setupScreenerEvents() {
    if (_screenerEventsReady) return;
    _screenerEventsReady = true;

    // Search
    const searchInput = document.getElementById("screener-search");
    let searchTimeout;
    searchInput.addEventListener("input", () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(renderScreener, 150);
    });

    // Filters
    document.getElementById("screener-phase-filter").addEventListener("change", renderScreener);
    document.getElementById("screener-sector-filter").addEventListener("change", renderScreener);

    // Column sort
    document.querySelectorAll("#screener-table th[data-sort]").forEach(th => {
        th.addEventListener("click", () => {
            const col = th.dataset.sort;
            if (currentSort.col === col) {
                currentSort.dir = currentSort.dir === "asc" ? "desc" : "asc";
            } else {
                currentSort.col = col;
                currentSort.dir = (col === "id" || col === "sector_name" || col === "momentum_phase") ? "asc" : "desc";
            }
            renderScreener();
        });
    });
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

    // Meteo
    renderMeteo(appData.nodes);

    // View switch
    setupViewSwitch();

    // Chart + timeline
    await setupTimeline();
}

document.addEventListener("DOMContentLoaded", init);
