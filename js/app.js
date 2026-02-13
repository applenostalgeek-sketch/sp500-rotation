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
    positif:       { label: "Positif",       color: "#22c55e", icon: "\u25B2" },
    essoufflement: { label: "Essoufflement", color: "#f59e0b", icon: "\u25BC" },
    negatif:       { label: "Negatif",       color: "#ef4444", icon: "\u25BC" },
};

function phaseInfo(node) {
    return PHASE_INFO[node.momentum_phase] || PHASE_INFO.negatif;
}

/* Visual phase value — ensures green > orange > red visually */
function displayPV(node) {
    const pv = (node.phase_value || 0) / 100; // 0..1
    const phase = node.momentum_phase;
    if (phase === "positif")       return 55 + pv * 35;  // 55-90%
    if (phase === "essoufflement") return 25 + pv * 25;  // 25-50%
    return 5 + pv * 17;                                   // 5-22%
}

/* ---------- Header ---------- */
function renderHeader(data) {
    const el = document.getElementById("narrative");
    const meta = data.metadata;
    el.innerHTML = `<span class="narrative-text">${meta.narrative}</span>
        <span class="narrative-date">${meta.date} \u00B7 Cloture US</span>`;
}

/* ---------- Sidebar (sector list) ---------- */
function renderSidebar(data) {
    const container = document.getElementById("sector-list");

    const PHASE_ORDER = { positif: 0, essoufflement: 1, negatif: 2 };
    const sorted = [...data.nodes].sort((a, b) => {
        const pa = PHASE_ORDER[a.momentum_phase] ?? 2;
        const pb = PHASE_ORDER[b.momentum_phase] ?? 2;
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
        const delta = node.phase_delta || 0;
        const deltaArrow = Math.abs(delta) > 2 ? (delta > 0 ? "\u25B2" : "\u25BC") : "";
        const deltaClass = delta > 2 ? "positive" : delta < -2 ? "negative" : "";

        html += `
            <div class="sector-card sector-card-clickable" data-etf="${node.id}">
                <div class="sector-card-top">
                    <div class="sector-id">
                        <div class="sector-dot" style="background:${node.color}"></div>
                        <span class="sector-name">${node.name}</span>
                    </div>
                    <span class="phase-badge" style="color:${phase.color}">${phase.icon} ${phase.label}${deltaArrow ? ` <span class="${deltaClass}">${deltaArrow}</span>` : ''}</span>
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
        const delta = stock.phase_delta || 0;
        const deltaArrow = Math.abs(delta) > 2 ? (delta > 0 ? "\u25B2" : "\u25BC") : "";
        const deltaClass = delta > 2 ? "positive" : delta < -2 ? "negative" : "";

        html += `
            <div class="sector-card">
                <div class="sector-card-top">
                    <div class="sector-id">
                        <div class="sector-dot" style="background:${phase.color}"></div>
                        <span class="sector-name">${stock.id}</span>
                    </div>
                    <span class="phase-badge" style="color:${phase.color}">${phase.icon} ${phase.label}${deltaArrow ? ` <span class="${deltaClass}">${deltaArrow}</span>` : ''}</span>
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

    // Animated zoom into sector
    const sectorNode = appData.nodes.find(n => n.id === etf);
    if (graphView && sectorNode) {
        graphView.zoomToSector(sectorNode, sectorData);
    }

    // Update sidebar with stocks
    renderStockSidebar(sectorData);

    // Update header
    const el = document.getElementById("narrative");
    const positifs = sectorData.stocks.filter(s => s.momentum_phase === "positif").length;
    const total = sectorData.stocks.length;
    el.innerHTML = `<span class="narrative-text">${sectorName} : ${positifs}/${total} actions en momentum positif</span>
        <span class="narrative-date">Par rapport a l'ETF ${etf}</span>`;
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

    const el = document.getElementById("narrative");
    const positifs = sectorData.stocks.filter(s => s.momentum_phase === "positif").length;
    const total = sectorData.stocks.length;
    el.innerHTML = `<span class="narrative-text">${sectorName} : ${positifs}/${total} actions en momentum positif</span>
        <span class="narrative-date">Par rapport a l'ETF ${etf}</span>`;
}

/* ---------- Navigation: back to global (called when zoom-out completes) ---------- */
function onBackToGlobal() {
    currentMode = "global";
    const sidebarTitle = document.querySelector(".sidebar-title");
    if (sidebarTitle) sidebarTitle.textContent = "Secteurs S&P 500";

    renderHeader(appData);
    renderSidebar(appData);
}

/* ---------- Mobile bottom sheet (draggable, 3 snap points) ---------- */
function setupBottomSheet() {
    if (window.innerWidth > 900) return;
    const sidebar = document.getElementById("sidebar");
    const handle = document.getElementById("sheet-handle");
    if (!handle || !sidebar) return;

    const PEEK = 52;
    const vh = window.innerHeight;
    const snaps = [vh - PEEK, vh * 0.6, vh * 0.3];
    let currentSnap = 0;
    let dragging = false;
    let startY = 0;
    let startTop = 0;

    function setPosition(top, animate) {
        sidebar.style.transition = animate ? "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)" : "none";
        sidebar.style.transform = `translateY(${top}px)`;
        sidebar.style.overflow = top <= snaps[1] ? "auto" : "hidden";
    }

    sidebar.style.transform = `translateY(${snaps[0]}px)`;
    sidebar.style.position = "fixed";
    sidebar.style.top = "0";
    sidebar.style.bottom = "auto";
    sidebar.style.height = "100vh";

    handle.addEventListener("click", () => {
        if (dragging) return;
        currentSnap = (currentSnap + 1) % snaps.length;
        setPosition(snaps[currentSnap], true);
    });

    handle.addEventListener("touchstart", (e) => {
        dragging = false;
        startY = e.touches[0].clientY;
        startTop = snaps[currentSnap];
        sidebar.style.transition = "none";
    }, { passive: true });

    handle.addEventListener("touchmove", (e) => {
        dragging = true;
        const dy = e.touches[0].clientY - startY;
        const newTop = Math.max(snaps[2], Math.min(snaps[0], startTop + dy));
        sidebar.style.transform = `translateY(${newTop}px)`;
    }, { passive: true });

    handle.addEventListener("touchend", (e) => {
        if (!dragging) return;
        const endTop = startTop + (e.changedTouches[0].clientY - startY);
        let closest = 0;
        let minDist = Infinity;
        for (let i = 0; i < snaps.length; i++) {
            const d = Math.abs(endTop - snaps[i]);
            if (d < minDist) { minDist = d; closest = i; }
        }
        currentSnap = closest;
        setPosition(snaps[currentSnap], true);
    }, { passive: true });

    window.addEventListener("resize", () => {
        const vh = window.innerHeight;
        snaps[0] = vh - PEEK;
        snaps[1] = vh * 0.6;
        snaps[2] = vh * 0.3;
        setPosition(snaps[currentSnap], false);
    });
}

/* ---------- Init ---------- */
async function init() {
    appData = await Promise.resolve(loadData());
    if (!appData) {
        document.getElementById("narrative").textContent =
            "Aucune donnee disponible.";
        return;
    }

    renderHeader(appData);
    renderSidebar(appData);

    graphView = new RotationGraph(document.getElementById("graph-canvas"), appData);

    // Wire up callbacks
    graphView.onSectorRequest = (etf) => enterSector(etf);
    graphView.onSectorSwitch = (etf) => switchSector(etf);
    graphView.onSectorExit = () => onBackToGlobal();

    setupBottomSheet();
}

document.addEventListener("DOMContentLoaded", init);
