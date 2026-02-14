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
    improving:  { label: "Rebond",           color: "#eab308" },
    weakening:  { label: "Essoufflement",   color: "#f97316" },
    lagging:    { label: "Sous pression",   color: "#ef4444" },
};

/* ---------- Market narrative ---------- */
function renderNarrative(data) {
    const el = document.getElementById("narrative-text");
    const bar = document.getElementById("bottom-bar");
    if (!el) return;
    const narrative = data.metadata?.narrative;
    if (!narrative) {
        el.textContent = "";
        if (bar) bar.classList.add("hidden-bar");
        return;
    }
    el.textContent = narrative;
    if (bar) bar.classList.remove("hidden-bar");
}

/* ---------- Navigation: enter sector ---------- */
async function enterSector(etf) {
    let sectorData;
    try {
        const resp = await fetch(`data/sectors/${etf}.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error("Not found");
        sectorData = await resp.json();
    } catch (err) {
        console.error("Sector fetch error:", err);
        return;
    }

    currentMode = "sector";
    const bar = document.getElementById("bottom-bar");
    if (bar) bar.classList.add("hidden-bar");

    const sectorNode = appData.nodes.find(n => n.id === etf);
    if (graphView && sectorNode) {
        graphView.zoomToSector(sectorNode, sectorData);
    }
}

/* ---------- Navigation: switch sector via pills ---------- */
async function switchSector(etf) {
    let sectorData;
    try {
        const resp = await fetch(`data/sectors/${etf}.json?t=${Date.now()}`);
        if (!resp.ok) throw new Error("Not found");
        sectorData = await resp.json();
    } catch (err) {
        console.error("Sector fetch error:", err);
        return;
    }

    const sectorNode = appData.nodes.find(n => n.id === etf);
    if (graphView && sectorNode) {
        graphView.switchSector(sectorNode, sectorData);
    }
}

/* ---------- Navigation: back to global ---------- */
function onBackToGlobal() {
    currentMode = "global";
    const bar = document.getElementById("bottom-bar");
    if (bar) bar.classList.remove("hidden-bar");
}

/* ---------- Onboarding ---------- */
function setupOnboarding() {
    const overlay = document.getElementById("onboarding");
    if (!overlay) return;

    if (localStorage.getItem("sp500-onboarded")) {
        overlay.remove();
        return;
    }

    const btn = document.getElementById("onboarding-dismiss");
    if (btn) {
        btn.addEventListener("click", () => {
            localStorage.setItem("sp500-onboarded", "1");
            overlay.style.animation = "fadeIn 0.2s ease reverse forwards";
            setTimeout(() => overlay.remove(), 200);
        });
    }
}

/* ---------- Init ---------- */
async function init() {
    setupOnboarding();

    appData = await Promise.resolve(loadData());
    if (!appData) return;

    // Display last update date
    const updateEl = document.getElementById("last-update");
    if (updateEl && appData.metadata?.date) {
        const ts = appData.metadata.generated_at || appData.metadata.date;
        const d = new Date(ts.includes("T") ? ts : ts + "T22:00:00Z");
        const dateStr = d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
        const timeStr = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
        updateEl.textContent = `Mise à jour : ${dateStr} à ${timeStr} UTC`;
    }

    renderNarrative(appData);

    graphView = new RotationGraph(document.getElementById("graph-canvas"), appData);

    // Wire up callbacks
    graphView.onSectorRequest = (etf) => enterSector(etf);
    graphView.onSectorSwitch = (etf) => switchSector(etf);
    graphView.onSectorExit = () => onBackToGlobal();
}

document.addEventListener("DOMContentLoaded", init);
