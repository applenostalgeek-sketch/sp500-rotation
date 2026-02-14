/* ---------- Unified force-directed graph with zoom transitions ---------- */

/* --- Particles --- */
class Particle {
    constructor(link) {
        this.link = link;
        this.t = Math.random();
        this.speed = 0.003 + Math.random() * 0.004;
    }
    update() { this.t += this.speed; if (this.t >= 1) this.t = 0; }
    getPos() {
        const s = this.link.source, t = this.link.target;
        return { x: s.x + (t.x - s.x) * this.t, y: s.y + (t.y - s.y) * this.t };
    }
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/* --- Main unified graph --- */
class RotationGraph {
    constructor(canvasEl, data) {
        this.canvas = canvasEl;
        this.ctx = canvasEl.getContext("2d");
        this.data = data;
        this.hoveredNode = null;
        this.hoveredLink = null;
        this.particles = [];
        this.dpr = window.devicePixelRatio || 1;
        this.transform = d3.zoomIdentity;
        this.running = true;

        // Mode: "global" | "zoom-in" | "zoom-out" | "sector"
        this.mode = "global";
        this.sectorData = null;
        this.activeSectorEtf = null;
        this.activeSectorNode = null;
        this.sectorSimulation = null;

        // Transition state
        this.transitionProgress = 0;
        this.transitionStart = 0;
        this.transitionDuration = 800;
        this.savedTransform = null;

        // Callbacks (set by app.js)
        this.onSectorRequest = null;  // (etf) => fetch & call zoomToSector
        this.onSectorSwitch = null;   // (etf) => fetch & call switchSector
        this.onSectorEnter = null;    // () => sidebar update after zoom completes
        this.onSectorExit = null;     // () => sidebar update after zoom-out completes

        this._resize();
        this._buildGlobalSimulation();
        this._createParticles();
        this._setupInteractions();
        this._animate();

        this._resizeHandler = () => {
            this._resize();
            if (this.mode === "global" || this.mode === "zoom-out") {
                this.simulation.force("center", d3.forceCenter(this.width / 2, this.height / 2));
                this.simulation.alpha(0.3).restart();
            }
            if (this.sectorSimulation) {
                this.sectorSimulation.force("center", d3.forceCenter(this.width / 2, this.height / 2));
                this.sectorSimulation.alpha(0.3).restart();
            }
        };
        window.addEventListener("resize", this._resizeHandler);
    }

    /* ========== Shared helpers ========== */

    _resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;
        this.canvas.width = rect.width * this.dpr;
        this.canvas.height = rect.height * this.dpr;
        this.canvas.style.width = rect.width + "px";
        this.canvas.style.height = rect.height + "px";
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    _isMobile() { return this.width < 600; }

    _phaseColor(phase) {
        if (phase === "leading") return "#22c55e";
        if (phase === "improving") return "#eab308";
        if (phase === "weakening") return "#f97316";
        return "#ef4444";
    }

    _displayPV(node) {
        const pv = (node.phase_value || 0) / 100;
        const ph = node.momentum_phase;
        if (ph === "leading") return 0.65 + pv * 0.25;
        if (ph === "improving") return 0.40 + pv * 0.20;
        if (ph === "weakening") return 0.20 + pv * 0.18;
        return 0.05 + pv * 0.13;
    }

    _pointToSegmentDist(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    /* ========== Global simulation ========== */

    _nodeRadius(d) {
        const mobile = this._isMobile();
        const w = d.weight || 5;
        const minR = mobile ? 18 : 24;
        const maxR = mobile ? 42 : 55;
        return minR + Math.sqrt(w / 31) * (maxR - minR);
    }

    _linkWidth(d) {
        const maxScore = this.data.rotations[0]?.score || 1;
        return 1.5 + (d.score / maxScore) * 6;
    }

    _buildGlobalSimulation() {
        const links = this.data.rotations.map(r => ({
            source: r.source, target: r.target,
            source_name: r.source_name, target_name: r.target_name,
            score: r.score, return_divergence: r.return_divergence,
            mfi_divergence: r.mfi_divergence, correlation: r.correlation,
        }));
        this.links = links;
        const mobile = this._isMobile();
        this.simulation = d3.forceSimulation(this.data.nodes)
            .force("link", d3.forceLink(links).id(d => d.id).distance(mobile ? 120 : 200).strength(0.2))
            .force("charge", d3.forceManyBody().strength(mobile ? -500 : -900))
            .force("center", d3.forceCenter(this.width / 2, this.height / 2))
            .force("collision", d3.forceCollide().radius(d => this._nodeRadius(d) + (mobile ? 8 : 15)))
            .force("x", d3.forceX(this.width / 2).strength(mobile ? 0.1 : 0.06))
            .force("y", d3.forceY(this.height / 2).strength(mobile ? 0.1 : 0.06))
            .alphaDecay(0.02).velocityDecay(0.4);
    }

    _createParticles() {
        this.particles = [];
        const maxScore = this.data.rotations[0]?.score || 1;
        for (const link of this.links) {
            const count = Math.max(2, Math.ceil((link.score / maxScore) * 8));
            for (let i = 0; i < count; i++) this.particles.push(new Particle(link));
        }
    }

    /* ========== Sector simulation ========== */

    _stockRadius(d) {
        const mobile = this._isMobile();
        const w = d.weight || 50;
        const minR = mobile ? 14 : 20;
        const maxR = mobile ? 36 : 48;
        return minR + Math.sqrt(w / 100) * (maxR - minR);
    }

    _buildSectorSimulation(sectorData) {
        if (this.sectorSimulation) this.sectorSimulation.stop();
        const mobile = this._isMobile();
        const count = sectorData.stocks.length;
        const charge = count > 15 ? (mobile ? -300 : -500) : (mobile ? -400 : -700);
        const cx = this.width / 2, cy = this.height / 2;
        const self = this;

        // Containment force: keep stocks inside the bubble
        function forceContain() {
            let nodes;
            function force() {
                const maxR = self.bubbleEnd ? self.bubbleEnd.r - 25 : Math.min(self.width, self.height) * 0.4;
                for (const node of nodes) {
                    const dx = node.x - cx, dy = node.y - cy;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const nodeR = self._stockRadius(node);
                    if (dist + nodeR > maxR) {
                        const target = maxR - nodeR;
                        const scale = target / dist;
                        node.x = cx + dx * scale;
                        node.y = cy + dy * scale;
                    }
                }
            }
            force.initialize = (n) => { nodes = n; };
            return force;
        }

        // Correlation-based attraction: correlated stocks cluster together
        const corrLinks = [];
        if (sectorData.correlations) {
            const stockIds = new Set(sectorData.stocks.map(s => s.id));
            for (const c of sectorData.correlations) {
                if (stockIds.has(c.source) && stockIds.has(c.target)) {
                    corrLinks.push({
                        source: c.source, target: c.target,
                        strength: Math.abs(c.correlation),
                    });
                }
            }
        }

        this.sectorSimulation = d3.forceSimulation(sectorData.stocks)
            .force("charge", d3.forceManyBody().strength(charge * 0.6))
            .force("center", d3.forceCenter(cx, cy))
            .force("collision", d3.forceCollide().radius(d => this._stockRadius(d) + (mobile ? 4 : 8)))
            .force("x", d3.forceX(cx).strength(0.06))
            .force("y", d3.forceY(cy).strength(0.06))
            .force("contain", forceContain())
            .alphaDecay(0.02).velocityDecay(0.4);

        if (corrLinks.length > 0) {
            this.sectorSimulation.force("corrLink",
                d3.forceLink(corrLinks)
                    .id(d => d.id)
                    .distance(d => mobile ? 40 + (1 - d.strength) * 80 : 50 + (1 - d.strength) * 120)
                    .strength(d => d.strength * 0.3)
            );
        }
    }

    /* ========== Zoom transitions ========== */

    zoomToSector(sectorNode, sectorData) {
        this.activeSectorNode = sectorNode;
        this.activeSectorEtf = sectorNode.id;
        this.sectorData = sectorData;
        this.savedTransform = this.transform;
        this.hoveredNode = null;
        this.hoveredLink = null;
        this._hideTooltip();

        // Target camera: zoom so sector node fills the viewport
        const r = this._nodeRadius(sectorNode);
        const targetR = Math.min(this.width, this.height) * 0.44;
        this._targetK = targetR / r;
        this._targetX = this.width / 2 - sectorNode.x * this._targetK;
        this._targetY = this.height / 2 - sectorNode.y * this._targetK;
        this.bubbleEnd = { x: this.width / 2, y: this.height / 2, r: targetR };

        // Position stocks near center
        const cx = this.width / 2, cy = this.height / 2;
        for (const s of sectorData.stocks) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * targetR * 0.3;
            s.x = cx + Math.cos(angle) * dist;
            s.y = cy + Math.sin(angle) * dist;
        }
        this._buildSectorSimulation(sectorData);

        this.mode = "zoom-in";
        this.transitionStart = performance.now();
        this.transitionDuration = 1000;
    }

    zoomToGlobal() {
        if (this.mode === "zoom-out") return;
        this.hoveredNode = null;
        this.hoveredLink = null;
        this._hideTooltip();
        this.mode = "zoom-out";
        this.transitionStart = performance.now();
        this.transitionDuration = 1000;
    }

    switchSector(sectorNode, sectorData) {
        if (this.sectorSimulation) this.sectorSimulation.stop();
        this.activeSectorNode = sectorNode;
        this.activeSectorEtf = sectorNode.id;
        this.sectorData = sectorData;
        this.hoveredNode = null;
        this._hideTooltip();

        this.bubbleEnd = { x: this.width / 2, y: this.height / 2, r: Math.min(this.width, this.height) * 0.44 };
        // Keep bubbleStart from original entry for zoom-out

        const cx = this.width / 2, cy = this.height / 2;
        for (const s of sectorData.stocks) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * this.bubbleEnd.r * 0.3;
            s.x = cx + Math.cos(angle) * dist;
            s.y = cy + Math.sin(angle) * dist;
        }
        this._buildSectorSimulation(sectorData);
        this.transform = d3.zoomIdentity;
        d3.select(this.canvas).call(this._zoom.transform, d3.zoomIdentity);
        this.mode = "sector";
        this._updatePillsActive();
    }

    /* ========== Sector navigation pills ========== */

    _showSectorPills() {
        let container = document.getElementById("sector-pills");
        if (!container) {
            container = document.createElement("div");
            container.id = "sector-pills";
            container.className = "sector-pills";
            this.canvas.parentElement.appendChild(container);
        }
        const self = this;
        let html = '<button class="sector-pill sector-pill-back" data-etf="">\u2190 Vue globale</button>';
        for (const node of this.data.nodes) {
            const active = node.id === this.activeSectorEtf ? " active" : "";
            html += `<button class="sector-pill${active}" data-etf="${node.id}" style="border-color:${node.color}66">${node.name}</button>`;
        }
        container.innerHTML = html;
        container.style.display = "flex";

        container.querySelectorAll(".sector-pill").forEach(btn => {
            btn.addEventListener("click", () => {
                const etf = btn.dataset.etf;
                if (!etf) {
                    self.zoomToGlobal();
                } else if (etf !== self.activeSectorEtf) {
                    if (self.onSectorSwitch) self.onSectorSwitch(etf);
                }
            });
        });
    }

    _updatePillsActive() {
        const container = document.getElementById("sector-pills");
        if (!container) return;
        container.querySelectorAll(".sector-pill").forEach(btn => {
            if (btn.dataset.etf) btn.classList.toggle("active", btn.dataset.etf === this.activeSectorEtf);
        });
    }

    _hideSectorPills() {
        const container = document.getElementById("sector-pills");
        if (container) container.style.display = "none";
    }

    /* ========== Interactions ========== */

    _setupInteractions() {
        const canvas = this.canvas;
        const self = this;

        this._zoom = d3.zoom()
            .scaleExtent([0.3, 5])
            .on("zoom", (event) => {
                if (self.mode === "global" || self.mode === "sector") {
                    self.transform = event.transform;
                }
            });
        d3.select(canvas).call(this._zoom);

        // Hover
        canvas.addEventListener("mousemove", (e) => {
            if (self.mode !== "global" && self.mode !== "sector") return;
            const rect = canvas.getBoundingClientRect();
            const mx = (e.clientX - rect.left - self.transform.x) / self.transform.k;
            const my = (e.clientY - rect.top - self.transform.y) / self.transform.k;

            if (self.mode === "global") self._hitTestGlobal(mx, my);
            else self._hitTestSector(mx, my);

            self._updateTooltip(e.clientX, e.clientY);
            canvas.style.cursor = (self.hoveredNode || self.hoveredLink) ? "pointer" : "grab";
        });

        canvas.addEventListener("mouseleave", () => {
            self.hoveredNode = null;
            self.hoveredLink = null;
            self._hideTooltip();
        });

        // Click detection via pointer events in CAPTURE phase (fires before d3)
        let ptrDown = null;
        canvas.addEventListener("pointerdown", (e) => {
            ptrDown = { x: e.clientX, y: e.clientY };
        }, true);

        canvas.addEventListener("pointerup", (e) => {
            if (!ptrDown) return;
            const dx = e.clientX - ptrDown.x, dy = e.clientY - ptrDown.y;
            ptrDown = null;
            if (dx * dx + dy * dy > 36) return; // moved too much = drag, not click

            if (self.mode !== "global" && self.mode !== "sector") return;

            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const mx = (screenX - self.transform.x) / self.transform.k;
            const my = (screenY - self.transform.y) / self.transform.k;

            if (self.mode === "global") {
                // Click on sector node → enter
                for (const node of self.data.nodes) {
                    const r = self._nodeRadius(node) + 4;
                    if ((node.x - mx) ** 2 + (node.y - my) ** 2 < r * r) {
                        setTimeout(() => {
                            if (self.onSectorRequest) self.onSectorRequest(node.id);
                        }, 10);
                        return;
                    }
                }
            } else if (self.mode === "sector" && self.bubbleEnd) {
                // Click outside bubble → exit
                const bDx = screenX - self.bubbleEnd.x;
                const bDy = screenY - self.bubbleEnd.y;
                if (bDx * bDx + bDy * bDy > self.bubbleEnd.r * self.bubbleEnd.r) {
                    setTimeout(() => self.zoomToGlobal(), 10);
                }
            }
        }, true);

        // Touch: hover + tooltip
        canvas.addEventListener("touchstart", (e) => {
            if (e.touches.length !== 1) return;
            if (self.mode !== "global" && self.mode !== "sector") return;
            const touch = e.touches[0];
            const rect = canvas.getBoundingClientRect();
            const mx = (touch.clientX - rect.left - self.transform.x) / self.transform.k;
            const my = (touch.clientY - rect.top - self.transform.y) / self.transform.k;

            if (self.mode === "global") {
                let found = null;
                for (const node of self.data.nodes) {
                    const r = self._nodeRadius(node) + 8;
                    if ((node.x - mx) ** 2 + (node.y - my) ** 2 < r * r) { found = node; break; }
                }
                self.hoveredNode = found;
                self.hoveredLink = null;
            } else if (self.sectorData) {
                let found = null;
                for (const node of self.sectorData.stocks) {
                    const r = self._stockRadius(node) + 8;
                    if ((node.x - mx) ** 2 + (node.y - my) ** 2 < r * r) { found = node; break; }
                }
                self.hoveredNode = found;
                self.hoveredLink = null;
            }
            if (self.hoveredNode) self._updateTooltip(touch.clientX, touch.clientY);
            else self._hideTooltip();
        }, { passive: true });

        // Drag (nodes only, separate from click detection)
        d3.select(canvas).call(
            d3.drag()
                .subject((event) => {
                    if (self.mode !== "global" && self.mode !== "sector") return null;
                    const mx = (event.x - self.transform.x) / self.transform.k;
                    const my = (event.y - self.transform.y) / self.transform.k;
                    const nodes = self.mode === "global" ? self.data.nodes : (self.sectorData?.stocks || []);
                    const radiusFn = self.mode === "global" ? (n) => self._nodeRadius(n) : (n) => self._stockRadius(n);
                    for (const node of nodes) {
                        const r = radiusFn(node) + 4;
                        if ((node.x - mx) ** 2 + (node.y - my) ** 2 < r * r) return node;
                    }
                    return null;
                })
                .on("start", (event) => {
                    if (!event.subject) return;
                    const sim = self.mode === "sector" ? self.sectorSimulation : self.simulation;
                    if (sim && !event.active) sim.alphaTarget(0.3).restart();
                    event.subject.fx = event.subject.x;
                    event.subject.fy = event.subject.y;
                })
                .on("drag", (event) => {
                    if (!event.subject) return;
                    event.subject.fx = (event.x - self.transform.x) / self.transform.k;
                    event.subject.fy = (event.y - self.transform.y) / self.transform.k;
                })
                .on("end", (event) => {
                    if (!event.subject) return;
                    const sim = self.mode === "sector" ? self.sectorSimulation : self.simulation;
                    if (sim && !event.active) sim.alphaTarget(0);
                    event.subject.fx = null;
                    event.subject.fy = null;
                })
        );
    }

    _hitTestGlobal(mx, my) {
        let found = null;
        for (const node of this.data.nodes) {
            const r = this._nodeRadius(node) + 4;
            if ((node.x - mx) ** 2 + (node.y - my) ** 2 < r * r) { found = node; break; }
        }
        this.hoveredNode = found;
        if (!found) {
            let closest = null, minD = 10;
            for (const link of this.links) {
                const d = this._pointToSegmentDist(mx, my, link.source.x, link.source.y, link.target.x, link.target.y);
                if (d < minD) { minD = d; closest = link; }
            }
            this.hoveredLink = closest;
        } else {
            this.hoveredLink = null;
        }
    }

    _hitTestSector(mx, my) {
        if (!this.sectorData) return;
        let found = null;
        for (const node of this.sectorData.stocks) {
            const r = this._stockRadius(node) + 4;
            if ((node.x - mx) ** 2 + (node.y - my) ** 2 < r * r) { found = node; break; }
        }
        this.hoveredNode = found;
        this.hoveredLink = null;
    }

    /* ========== Tooltip ========== */

    _updateTooltip(cx, cy) {
        const tip = document.getElementById("tooltip");
        if (this.mode === "global" && this.hoveredNode) {
            const n = this.hoveredNode;
            const r5 = (n.return_5d * 100).toFixed(1);
            const r20 = (n.return_20d * 100).toFixed(1);
            const phases = { leading: "Surperformance", improving: "Rebond", weakening: "Essoufflement", lagging: "Sous pression" };
            const pc = this._phaseColor(n.momentum_phase);
            tip.innerHTML = `
                <div class="ticker">${n.name}</div>
                <div class="sector">${n.id}</div>
                <div style="color:${pc};font-weight:700">${phases[n.momentum_phase] || "?"} (${(n.phase_value || 0).toFixed(0)}%)</div>
                <div>1 sem: <span class="${r5 >= 0 ? 'positive' : 'negative'}">${r5}%</span> · 1 mois: <span class="${r20 >= 0 ? 'positive' : 'negative'}">${r20}%</span></div>
                <div style="color:var(--text-muted);font-size:0.68rem;margin-top:4px">Vol: ${n.volume_ratio.toFixed(1)}x · MFI: ${n.mfi.toFixed(0)} · CMF: ${n.cmf.toFixed(2)}</div>
                <div style="color:var(--text-muted);font-size:0.6rem;margin-top:2px">Cliquer pour explorer</div>`;
            tip.classList.add("visible");
        } else if (this.mode === "sector" && this.hoveredNode) {
            const n = this.hoveredNode;
            const r5 = (n.return_5d * 100).toFixed(1);
            const r20 = (n.return_20d * 100).toFixed(1);
            const phases = { leading: "Surperformance", improving: "Rebond", weakening: "Essoufflement", lagging: "Sous pression" };
            const pc = this._phaseColor(n.momentum_phase);
            // Find top correlations for this stock
            let corrHtml = "";
            if (this.sectorData?.correlations) {
                const related = this.sectorData.correlations
                    .filter(c => c.source === n.id || c.target === n.id)
                    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
                    .slice(0, 3);
                if (related.length > 0) {
                    const items = related.map(c => {
                        const other = c.source === n.id ? c.target : c.source;
                        const val = c.correlation;
                        const color = val > 0 ? "var(--green)" : "var(--red)";
                        return `<span style="color:${color}">${other} ${val > 0 ? '+' : ''}${val.toFixed(2)}</span>`;
                    }).join(" · ");
                    corrHtml = `<div style="color:var(--text-muted);font-size:0.65rem;margin-top:3px">Correle : ${items}</div>`;
                }
            }
            const rsi = n.rsi != null ? Math.round(n.rsi) : null;
            const rsiColor = rsi != null ? (rsi < 50 ? "var(--green)" : rsi < 70 ? "var(--text-muted)" : "var(--orange)") : "var(--text-muted)";
            const rsiHtml = rsi != null ? `<span style="color:${rsiColor};font-weight:600">RSI ${rsi}</span> · ` : "";
            tip.innerHTML = `
                <div class="ticker">${n.id}</div>
                <div style="color:${pc};font-weight:700">${phases[n.momentum_phase] || "?"}</div>
                <div>1 sem: <span class="${n.return_5d >= 0 ? 'positive' : 'negative'}">${n.return_5d >= 0 ? '+' : ''}${r5}%</span> · 1 mois: <span class="${n.return_20d >= 0 ? 'positive' : 'negative'}">${n.return_20d >= 0 ? '+' : ''}${r20}%</span></div>
                <div style="color:var(--text-muted);font-size:0.68rem">${rsiHtml}Vol: ${n.volume_ratio.toFixed(1)}x</div>${corrHtml}`;
            tip.classList.add("visible");
        } else if (this.hoveredLink) {
            // Global rotation link
            const l = this.hoveredLink;
            const sn = l.source_name || l.source.name || l.source.id;
            const tn = l.target_name || l.target.name || l.target.id;
            tip.innerHTML = `
                <div><span class="ticker">${sn}</span><span style="color:var(--orange)"> &rarr; </span><span class="ticker">${tn}</span></div>
                <div>Score: <span style="color:var(--accent)">${l.score.toFixed(2)}</span></div>
                <div>Divergence: ${l.return_divergence?.toFixed(2) ?? "?"}%</div>
                <div>Correlation: ${l.correlation?.toFixed(2) ?? "?"}</div>`;
            tip.classList.add("visible");
        } else {
            this._hideTooltip();
            return;
        }
        tip.style.left = (cx + 14) + "px";
        tip.style.top = (cy - 10) + "px";
    }

    _hideTooltip() {
        document.getElementById("tooltip").classList.remove("visible");
    }

    /* ========== Main animation loop ========== */

    _animate() {
        if (!this.running) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.clearRect(0, 0, this.width, this.height);

        switch (this.mode) {
            case "global":   this._drawGlobal(ctx); break;
            case "zoom-in":  this._animateZoomIn(ctx); break;
            case "zoom-out": this._animateZoomOut(ctx); break;
            case "sector":   this._drawSector(ctx); break;
        }

        ctx.restore();
        requestAnimationFrame(() => this._animate());
    }

    /* ========== Zoom-in animation (real camera zoom) ========== */

    _animateZoomIn(ctx) {
        const elapsed = performance.now() - this.transitionStart;
        const t = easeInOutCubic(Math.min(1, elapsed / this.transitionDuration));
        const sk = this.savedTransform.k, sx = this.savedTransform.x, sy = this.savedTransform.y;

        // Interpolate camera transform — everything zooms together
        const ck = sk + (this._targetK - sk) * t;
        const cx = sx + (this._targetX - sx) * t;
        const cy = sy + (this._targetY - sy) * t;

        // 1. Draw global view with zooming camera (nodes naturally slide off edges)
        const globalAlpha = t < 0.55 ? 1 : Math.max(0, 1 - (t - 0.55) / 0.45);
        if (globalAlpha > 0.001) {
            ctx.save();
            ctx.globalAlpha = globalAlpha;
            ctx.translate(cx, cy);
            ctx.scale(ck, ck);
            this._drawGlobalNodes(ctx, null);
            ctx.restore();
        }

        // 2. Sector bubble background fading in
        const be = this.bubbleEnd;
        const sectorColor = this.activeSectorNode.color || "#64748b";
        const bubbleAlpha = Math.max(0, (t - 0.4) / 0.6);
        if (bubbleAlpha > 0.001) {
            ctx.save();
            ctx.globalAlpha = bubbleAlpha * 0.12;
            ctx.beginPath();
            ctx.arc(be.x, be.y, be.r, 0, Math.PI * 2);
            ctx.fillStyle = sectorColor;
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.globalAlpha = bubbleAlpha * 0.3;
            ctx.beginPath();
            ctx.arc(be.x, be.y, be.r, 0, Math.PI * 2);
            ctx.strokeStyle = sectorColor;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
        }

        // 3. Stocks appearing inside (after t > 0.55)
        const stockAlpha = Math.max(0, (t - 0.55) / 0.45);
        if (stockAlpha > 0.001 && this.sectorData) {
            ctx.save();
            ctx.globalAlpha = stockAlpha;
            this._drawSectorNodes(ctx);
            ctx.restore();
        }

        // 4. Sector name
        if (t > 0.6) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, (t - 0.6) / 0.3);
            ctx.font = "700 16px -apple-system, sans-serif";
            ctx.textAlign = "center";
            ctx.fillStyle = sectorColor + "cc";
            ctx.fillText(this.sectorData?.sector_name || "", be.x, be.y - be.r + 30);
            ctx.restore();
        }

        if (t >= 1) {
            this.mode = "sector";
            this.transform = d3.zoomIdentity;
            d3.select(this.canvas).call(this._zoom.transform, d3.zoomIdentity);
            if (this.onSectorEnter) this.onSectorEnter(this.activeSectorEtf);
        }
    }

    /* ========== Zoom-out animation (reverse camera zoom) ========== */

    _animateZoomOut(ctx) {
        const elapsed = performance.now() - this.transitionStart;
        const t = easeInOutCubic(Math.min(1, elapsed / this.transitionDuration));
        const sk = this.savedTransform.k, sx = this.savedTransform.x, sy = this.savedTransform.y;

        // 1. Stocks + bubble fading out
        const stockAlpha = Math.max(0, 1 - t * 2.2);
        if (stockAlpha > 0.001 && this.sectorData) {
            const be = this.bubbleEnd;
            const sectorColor = this.activeSectorNode.color || "#64748b";
            ctx.save();
            ctx.globalAlpha = stockAlpha * 0.12;
            ctx.beginPath();
            ctx.arc(be.x, be.y, be.r, 0, Math.PI * 2);
            ctx.fillStyle = sectorColor;
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.globalAlpha = stockAlpha;
            this._drawSectorNodes(ctx);
            ctx.restore();
        }

        // 2. Camera zooming back out — global nodes slide back in
        const globalAlpha = Math.max(0, (t - 0.25) / 0.75);
        if (globalAlpha > 0.001) {
            const rt = 1 - t;
            const ck = sk + (this._targetK - sk) * rt;
            const cx = sx + (this._targetX - sx) * rt;
            const cy = sy + (this._targetY - sy) * rt;

            ctx.save();
            ctx.globalAlpha = globalAlpha;
            ctx.translate(cx, cy);
            ctx.scale(ck, ck);
            this._drawGlobalNodes(ctx, null);
            ctx.restore();
        }

        if (t >= 1) {
            this.mode = "global";
            this.transform = this.savedTransform || d3.zoomIdentity;
            d3.select(this.canvas).call(this._zoom.transform, this.transform);
            if (this.sectorSimulation) { this.sectorSimulation.stop(); this.sectorSimulation = null; }
            this.sectorData = null;
            this.activeSectorNode = null;
            this.activeSectorEtf = null;
            if (this.onSectorExit) this.onSectorExit();
        }
    }

    /* ========== Draw global view ========== */

    _drawGlobal(ctx) {
        ctx.translate(this.transform.x, this.transform.y);
        ctx.scale(this.transform.k, this.transform.k);
        this._drawGlobalNodes(ctx, null);
    }

    _drawGlobalNodes(ctx, highlightNode) {
        // Links
        for (const link of this.links) {
            const isH = link === this.hoveredLink;
            const conn = this.hoveredNode && (link.source === this.hoveredNode || link.target === this.hoveredNode);
            const dim = (this.hoveredNode && !conn) || (highlightNode && link.source !== highlightNode && link.target !== highlightNode);

            ctx.beginPath();
            ctx.moveTo(link.source.x, link.source.y);
            ctx.lineTo(link.target.x, link.target.y);
            ctx.strokeStyle = isH || conn ? "rgba(245,158,11,0.7)" : dim ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.12)";
            ctx.lineWidth = isH ? this._linkWidth(link) + 1 : this._linkWidth(link);
            ctx.stroke();

            if (!dim) {
                const angle = Math.atan2(link.target.y - link.source.y, link.target.x - link.source.x);
                const tr = this._nodeRadius(link.target) + 6;
                const ax = link.target.x - Math.cos(angle) * tr;
                const ay = link.target.y - Math.sin(angle) * tr;
                const hl = 8 + this._linkWidth(link);
                ctx.beginPath();
                ctx.moveTo(ax, ay);
                ctx.lineTo(ax - hl * Math.cos(angle - 0.4), ay - hl * Math.sin(angle - 0.4));
                ctx.lineTo(ax - hl * Math.cos(angle + 0.4), ay - hl * Math.sin(angle + 0.4));
                ctx.closePath();
                ctx.fillStyle = conn || isH ? "rgba(245,158,11,0.8)" : "rgba(255,255,255,0.25)";
                ctx.fill();
            }
        }

        // Particles
        for (const p of this.particles) {
            p.update();
            const pos = p.getPos();
            const conn = this.hoveredNode && (p.link.source === this.hoveredNode || p.link.target === this.hoveredNode);
            const dim = (this.hoveredNode && !conn) || (highlightNode && p.link.source !== highlightNode && p.link.target !== highlightNode);
            if (dim) continue;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = conn ? "rgba(245,158,11,0.95)" : "rgba(245,158,11,0.6)";
            ctx.fill();
        }

        // Nodes
        for (const node of this.data.nodes) {
            if (node.x == null) continue;
            const r = this._nodeRadius(node);
            const color = node.color || "#64748b";
            const isHov = node === this.hoveredNode;
            const isConn = this.hoveredNode && this.links.some(l =>
                (l.source === this.hoveredNode && l.target === node) || (l.target === this.hoveredNode && l.source === node));
            const dim = (this.hoveredNode && !isHov && !isConn) || (highlightNode && node !== highlightNode);

            // Glow
            if (isHov) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 12, 0, Math.PI * 2);
                ctx.fillStyle = color + "22";
                ctx.fill();
            }

            // Momentum arc
            if (!dim) {
                const pv = this._displayPV(node);
                const pc = this._phaseColor(node.momentum_phase);
                const arcR = r + 5, arcW = isHov ? 5 : 4;

                // Track
                ctx.beginPath(); ctx.arc(node.x, node.y, arcR, 0, Math.PI * 2);
                ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = arcW; ctx.stroke();

                // Filled arc
                if (pv > 0.01) {
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, arcR, -Math.PI / 2, -Math.PI / 2 + pv * Math.PI * 2);
                    ctx.strokeStyle = pc;
                    ctx.lineWidth = arcW; ctx.lineCap = "round"; ctx.stroke(); ctx.lineCap = "butt";
                }
            }

            // Circle
            ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
            ctx.fillStyle = dim ? color + "22" : color + (isHov ? "ee" : "88");
            ctx.fill();
            ctx.strokeStyle = dim ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.15)";
            ctx.lineWidth = 1; ctx.stroke();

            // Label
            if (!dim) {
                const mobile = this._isMobile();
                const fs = mobile ? Math.max(7, Math.min(10, r * 0.35)) : Math.max(9, Math.min(13, r * 0.35));
                ctx.font = `${isHov ? "bold " : "600 "}${fs}px -apple-system, sans-serif`;
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillStyle = "rgba(255,255,255,0.95)";
                ctx.fillText(node.name, node.x, node.y - (mobile ? 3 : 5));
                const retPct = (node.return_5d * 100).toFixed(1);
                const retSize = Math.max(mobile ? 6 : 8, fs - 1);
                ctx.font = `700 ${retSize}px -apple-system, monospace`;
                ctx.fillStyle = node.return_5d >= 0 ? "#22c55e" : "#ef4444";
                ctx.fillText((node.return_5d >= 0 ? "+" : "") + retPct + "%", node.x, node.y + (mobile ? 7 : 10));
            }
        }
    }

    /* ========== Draw sector view ========== */

    _drawSector(ctx) {
        const be = this.bubbleEnd;
        const sectorColor = this.activeSectorNode?.color || "#64748b";
        const name = this.sectorData?.sector_name || "";

        // Background bubble
        ctx.beginPath();
        ctx.arc(be.x, be.y, be.r, 0, Math.PI * 2);
        ctx.fillStyle = sectorColor + "1a"; // ~10% alpha
        ctx.fill();
        ctx.strokeStyle = sectorColor + "44";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Sector label at top of bubble
        ctx.font = "700 16px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = sectorColor + "cc";
        ctx.fillText(name, be.x, be.y - be.r + 30);

        ctx.translate(this.transform.x, this.transform.y);
        ctx.scale(this.transform.k, this.transform.k);
        this._drawSectorNodes(ctx);
    }

    _drawSectorNodes(ctx) {
        if (!this.sectorData) return;
        for (const node of this.sectorData.stocks) {
            if (node.x == null) continue;
            const r = this._stockRadius(node);
            const pc = this._phaseColor(node.momentum_phase);
            const isHov = node === this.hoveredNode;

            if (isHov) {
                ctx.beginPath(); ctx.arc(node.x, node.y, r + 10, 0, Math.PI * 2);
                ctx.fillStyle = pc + "22"; ctx.fill();
            }

            // Momentum arc
            const pv = this._displayPV(node);
            const arcR = r + 4, arcW = isHov ? 4 : 3;

            ctx.beginPath(); ctx.arc(node.x, node.y, arcR, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = arcW; ctx.stroke();
            if (pv > 0.01) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, arcR, -Math.PI / 2, -Math.PI / 2 + pv * Math.PI * 2);
                ctx.strokeStyle = pc; ctx.lineWidth = arcW; ctx.lineCap = "round"; ctx.stroke(); ctx.lineCap = "butt";
            }

            // Fresh signal pulse glow
            const dip = node.days_in_phase;
            if (dip != null && dip <= 3 && (node.momentum_phase === "improving" || node.momentum_phase === "leading")) {
                const pulse = 0.3 + Math.sin(performance.now() * 0.003) * 0.15;
                ctx.save();
                ctx.beginPath(); ctx.arc(node.x, node.y, r + 8, 0, Math.PI * 2);
                ctx.fillStyle = pc + Math.round(pulse * 255).toString(16).padStart(2, "0");
                ctx.fill();
                ctx.restore();
            }

            // Circle
            ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
            ctx.fillStyle = pc + (isHov ? "55" : "33"); ctx.fill();
            ctx.strokeStyle = pc + (isHov ? "aa" : "66"); ctx.lineWidth = 1; ctx.stroke();

            // Label
            const mobile = this._isMobile();
            const fs = mobile ? Math.max(7, r * 0.38) : Math.max(9, r * 0.4);
            ctx.font = `${isHov ? "bold " : "600 "}${fs}px -apple-system, sans-serif`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillStyle = "rgba(255,255,255,0.95)";
            ctx.fillText(node.id, node.x, node.y - (mobile ? 2 : 4));
            const retPct = (node.return_5d * 100).toFixed(1);
            const retSize = Math.max(mobile ? 5.5 : 7, fs - 2);
            ctx.font = `700 ${retSize}px -apple-system, monospace`;
            ctx.fillStyle = pc;
            ctx.fillText((node.return_5d >= 0 ? "+" : "") + retPct + "%", node.x, node.y + (mobile ? 5 : 8));
        }
    }

    /* ========== Cleanup ========== */

    destroy() {
        this.running = false;
        this.simulation.stop();
        if (this.sectorSimulation) this.sectorSimulation.stop();
        window.removeEventListener("resize", this._resizeHandler);
        this._hideSectorPills();
    }
}
