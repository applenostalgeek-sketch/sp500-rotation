/* ---------- Main application ---------- */

let graphView = null;
let appData = null;
let currentMode = "global"; // "global" or "sector"

function loadData() {
    if (window.ROTATION_DATA) return window.ROTATION_DATA;
    return fetch("data/latest.json")
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
}

/* ---------- Phase display ---------- */
const PHASE_INFO = {
    leading:    { label: "Surperformance",   color: "#22c55e" },
    improving:  { label: "Accélération",    color: "#eab308" },
    weakening:  { label: "Essoufflement",   color: "#f97316" },
    lagging:    { label: "Sous pression",   color: "#ef4444" },
};

function phaseInfo(node) {
    return PHASE_INFO[node.momentum_phase] || PHASE_INFO.lagging;
}

/* Visual phase value — ensures visual ordering leading > improving > weakening > lagging */
function displayPV(node) {
    const pv = (node.phase_value || 0) / 100; // 0..1
    const phase = node.momentum_phase;
    if (phase === "leading")    return 65 + pv * 25;  // 65-90%
    if (phase === "improving")  return 40 + pv * 20;  // 40-60%
    if (phase === "weakening")  return 20 + pv * 18;  // 20-38%
    return 5 + pv * 13;                                // 5-18%
}

/* ---------- Market narrative ---------- */
function renderNarrative(data) {
    const container = document.getElementById("signal-history");
    if (!container) return;
    const narrative = data.metadata?.narrative;
    if (!narrative) { container.innerHTML = ""; return; }

    container.innerHTML = `<div class="narrative">${narrative}</div>`;
}

/* ---------- Sidebar (sector list) ---------- */
function renderSidebar(data) {
    const container = document.getElementById("sector-list");

    const PHASE_ORDER = { leading: 0, improving: 1, weakening: 2, lagging: 3 };
    const sorted = [...data.nodes].sort((a, b) => {
        const pa = PHASE_ORDER[a.momentum_phase] ?? 3;
        const pb = PHASE_ORDER[b.momentum_phase] ?? 3;
        if (pa !== pb) return pa - pb;
        return (b.phase_value || 0) - (a.phase_value || 0);
    });

    let html = '';
    for (const node of sorted) {
        const phase = phaseInfo(node);
        const pv = displayPV(node);
        const r1w = (node.return_5d * 100).toFixed(1);
        const r1m = (node.return_20d * 100).toFixed(1);
        const r1wSign = node.return_5d >= 0 ? "+" : "";
        const r1mSign = node.return_20d >= 0 ? "+" : "";
        const r1wClass = node.return_5d >= 0 ? "positive" : "negative";
        const r1mClass = node.return_20d >= 0 ? "positive" : "negative";
        html += `
            <div class="sector-card sector-card-clickable" data-etf="${node.id}">
                <div class="sector-card-top">
                    <div class="sector-id">
                        <div class="sector-dot" style="background:${node.color}"></div>
                        <span class="sector-name">${node.name}</span>
                    </div>
                </div>
                <div class="phase-bar-track">
                    <div class="phase-bar-fill" style="width:${pv}%;background:${phase.color}"></div>
                </div>
                <div class="sector-card-returns">
                    <span class="ret-col">1 sem <span class="${r1wClass}">${r1wSign}${r1w}%</span></span>
                    <span class="ret-col">1 mois <span class="${r1mClass}">${r1mSign}${r1m}%</span></span>
                </div>
            </div>`;
    }

    container.innerHTML = html;

    // Click on sector card = enter sector detail
    container.querySelectorAll(".sector-card-clickable").forEach(card => {
        card.addEventListener("click", () => enterSector(card.dataset.etf));
    });
}

/* ---------- Sidebar (stock list within a sector) ---------- */
function renderStockSidebar(sectorData) {
    const container = document.getElementById("sector-list");

    let html = '';
    for (const stock of sectorData.stocks) {
        const phase = phaseInfo(stock);
        const pv = displayPV(stock);
        const r1w = (stock.return_5d * 100).toFixed(1);
        const r1m = (stock.return_20d * 100).toFixed(1);
        const r1wSign = stock.return_5d >= 0 ? "+" : "";
        const r1mSign = stock.return_20d >= 0 ? "+" : "";
        const r1wClass = stock.return_5d >= 0 ? "positive" : "negative";
        const r1mClass = stock.return_20d >= 0 ? "positive" : "negative";
        html += `
            <div class="sector-card">
                <div class="sector-card-top">
                    <div class="sector-id">
                        <div class="sector-dot" style="background:${phase.color}"></div>
                        <span class="sector-name">${stock.id}</span>
                    </div>
                </div>
                <div class="phase-bar-track">
                    <div class="phase-bar-fill" style="width:${pv}%;background:${phase.color}"></div>
                </div>
                <div class="sector-card-returns">
                    <span class="ret-col">1 sem <span class="${r1wClass}">${r1wSign}${r1w}%</span></span>
                    <span class="ret-col">1 mois <span class="${r1mClass}">${r1mSign}${r1m}%</span></span>
                </div>
            </div>`;
    }

    container.innerHTML = html;
}

/* ---------- Navigation: enter sector ---------- */
async function enterSector(etf) {
    const sidebarTitle = document.querySelector(".sidebar-title");

    const sectorName = appData.nodes.find(n => n.id === etf)?.name || etf;
    if (sidebarTitle) sidebarTitle.textContent = `${sectorName} \u2014 Chargement...`;

    // Fetch sector data
    let sectorData;
    try {
        const resp = await fetch(`data/sectors/${etf}.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error("Not found");
        sectorData = await resp.json();
    } catch (err) {
        console.error("Sector fetch error:", err);
        if (sidebarTitle) sidebarTitle.textContent = `${sectorName} \u2014 Donnees indisponibles`;
        return;
    }

    currentMode = "sector";
    if (sidebarTitle) sidebarTitle.textContent = sectorName;
    const sigHist = document.getElementById("signal-history");
    if (sigHist) sigHist.style.display = "none";

    // Animated zoom into sector
    const sectorNode = appData.nodes.find(n => n.id === etf);
    if (graphView && sectorNode) {
        graphView.zoomToSector(sectorNode, sectorData);
    }

    // Update sidebar with stocks
    renderStockSidebar(sectorData);
}

/* ---------- Navigation: switch sector via pills ---------- */
async function switchSector(etf) {
    const sidebarTitle = document.querySelector(".sidebar-title");
    const sectorName = appData.nodes.find(n => n.id === etf)?.name || etf;
    if (sidebarTitle) sidebarTitle.textContent = `${sectorName} \u2014 Chargement...`;

    let sectorData;
    try {
        const resp = await fetch(`data/sectors/${etf}.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error("Not found");
        sectorData = await resp.json();
    } catch (err) {
        console.error("Sector fetch error:", err);
        if (sidebarTitle) sidebarTitle.textContent = `${sectorName} \u2014 Donnees indisponibles`;
        return;
    }

    if (sidebarTitle) sidebarTitle.textContent = sectorName;

    const sectorNode = appData.nodes.find(n => n.id === etf);
    if (graphView && sectorNode) {
        graphView.switchSector(sectorNode, sectorData);
    }

    renderStockSidebar(sectorData);
}

/* ---------- Navigation: back to global (called when zoom-out completes) ---------- */
function onBackToGlobal() {
    currentMode = "global";
    const sidebarTitle = document.querySelector(".sidebar-title");
    if (sidebarTitle) sidebarTitle.textContent = "Secteurs S&P 500";

    renderNarrative(appData);
    renderSidebar(appData);
    const sigHist = document.getElementById("signal-history");
    if (sigHist) sigHist.style.display = "";
}

/* ---------- Sidebar toggle ---------- */
function setupSidebarToggle() {
    const sidebar = document.getElementById("sidebar");
    const toggleBtn = document.getElementById("sidebar-toggle");
    const closeBtn = document.getElementById("sidebar-close");
    if (!sidebar || !toggleBtn) return;

    toggleBtn.addEventListener("click", () => {
        sidebar.classList.toggle("open");
    });

    if (closeBtn) {
        closeBtn.addEventListener("click", () => {
            sidebar.classList.remove("open");
        });
    }
}

/* ---------- Init ---------- */
async function init() {
    appData = await Promise.resolve(loadData());
    if (!appData) { return; }

    // Display last update date
    const updateEl = document.getElementById("last-update");
    if (updateEl && appData.metadata?.date) {
        const ts = appData.metadata.generated_at || appData.metadata.date;
        const d = new Date(ts.includes("T") ? ts : ts + "T22:00:00Z");
        const dateStr = d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
        const timeStr = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
        updateEl.textContent = `Dernière mise à jour : ${dateStr} à ${timeStr} UTC`;
    }

    renderNarrative(appData);
    renderSidebar(appData);

    graphView = new RotationGraph(document.getElementById("graph-canvas"), appData);

    // Wire up callbacks
    graphView.onSectorRequest = (etf) => enterSector(etf);
    graphView.onSectorSwitch = (etf) => switchSector(etf);
    graphView.onSectorExit = () => onBackToGlobal();

    setupSidebarToggle();
}

document.addEventListener("DOMContentLoaded", init);
