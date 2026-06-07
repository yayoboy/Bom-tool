/* Isometric "exploded / disassembly" view rendered as interactive SVG.
 *
 * The board lies on the isometric plane; components are lifted above (top
 * layer) or below (bottom layer) their footprint position, connected by a
 * thin call-out line. An explode amount (0..1) controls the lift. The SVG is
 * clickable (selection) and can be exported to a standalone .svg file.
 *
 * Projection (2:1 isometric), units in mm:
 *   px = (X - Y) * cos30
 *   py = (X + Y) * sin30  - Z      (screen Y grows downward)
 */
(function (global) {
  const COS30 = Math.cos(Math.PI / 6); // 0.866
  const SIN30 = 0.5;
  const SVGNS = 'http://www.w3.org/2000/svg';

  const COL = {
    boardTop: '#10301f', boardSide: '#0a2014', boardEdge: '#1f6f47',
    top: '#d9534f', topSide: '#9c3b38',
    bottom: '#5bc0de', bottomSide: '#3f8499',
    sel: '#ffd33d', selSide: '#b89622',
    done: '#4a545e', doneSide: '#363d44',
    line: 'rgba(180,190,200,0.45)', ref: '#e6edf3',
  };

  function IsoView(svg) {
    this.svg = svg;
    this.comps = [];
    this.outline = null;
    this.pads = null;
    this.showPads = true;
    this.layer = 'top';
    this.selectedGroup = null;
    this.visible = null;
    this.explode = 0.6;
    this.showRefs = false;
    this.cx = 0; this.cy = 0;       // board centre (mm)
    this.size = 50;                  // board characteristic size (mm)
    this.thickness = 1.6;
    this.bodyH = 1.0;
    this.viewBox = null;
    this._bind();
  }

  IsoView.prototype.setComponents = function (c) { this.comps = c; this._computeCentre(); };
  IsoView.prototype.setOutline = function (geo) { this.outline = geo; this._computeCentre(); };
  IsoView.prototype.setPads = function (p) { this.pads = p; };
  IsoView.prototype.setShowPads = function (b) { this.showPads = b; this.render(); };
  IsoView.prototype.setLayer = function (l) { this.layer = l; this.render(true); };
  IsoView.prototype.setSelected = function (g) { this.selectedGroup = g; this.render(); };
  IsoView.prototype.setVisible = function (s) { this.visible = s; this.render(); };
  IsoView.prototype.setExplode = function (v) { this.explode = v; this.render(); };
  IsoView.prototype.setShowRefs = function (b) { this.showRefs = b; this.render(); };

  IsoView.prototype._computeCentre = function () {
    let b;
    if (this.outline) b = this.outline.bounds;
    else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of this.comps) {
        minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
        minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
      }
      b = { minX, minY, maxX, maxY };
    }
    if (!isFinite(b.minX)) { b = { minX: 0, minY: 0, maxX: 50, maxY: 50 }; }
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    this.size = Math.max(b.maxX - b.minX, b.maxY - b.minY, 10);
    this.bounds = b;
  };

  // project board (x,y) mm + z (mm height) -> screen point
  IsoView.prototype._p = function (x, y, z) {
    const bx = x - this.cx, by = y - this.cy;
    return { x: (bx - by) * COS30, y: (bx + by) * SIN30 - (z || 0) };
  };

  IsoView.prototype._layerVisible = function (c) {
    if (this.layer === 'both') return true;
    return c.layer === this.layer;
  };
  IsoView.prototype._filtered = function (c) { return this.visible && !this.visible.has(c.ref); };

  IsoView.prototype.render = function (refit) {
    const lift = this.size * 0.5 * this.explode;
    const parts = [];

    // ----- board slab (extruded outline or bounding rect) -----
    const polys = this.outline
      ? this.outline.paths.filter(p => p.closed || p.pts.length > 2).map(p => p.pts)
      : [[
          { x: this.bounds.minX, y: this.bounds.minY }, { x: this.bounds.maxX, y: this.bounds.minY },
          { x: this.bounds.maxX, y: this.bounds.maxY }, { x: this.bounds.minX, y: this.bounds.maxY },
        ]];

    for (const poly of polys) parts.push(this._slab(poly, 0, this.thickness, COL.boardSide, COL.boardTop, COL.boardEdge));

    // ----- pads on board surfaces -----
    if (this.pads && this.showPads) {
      if ((this.layer === 'top' || this.layer === 'both') && this.pads.top)
        parts.push(this._padsSvg(this.pads.top, 0));
      if ((this.layer === 'bottom' || this.layer === 'both') && this.pads.bottom)
        parts.unshift(this._padsSvg(this.pads.bottom, -this.thickness));
    }

    // ----- components, painter-sorted back -> front -----
    const list = this.comps.filter(c => this._layerVisible(c));
    const bottoms = list.filter(c => c.layer === 'bottom').sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tops = list.filter(c => c.layer !== 'bottom').sort((a, b) => (a.x + a.y) - (b.x + b.y));

    for (const c of bottoms) parts.unshift(this._comp(c, -(this.thickness + lift))); // below board, drawn first
    for (const c of tops) parts.push(this._comp(c, lift));

    const w = this.svg.clientWidth || 800, h = this.svg.clientHeight || 600;
    this.svg.innerHTML = parts.join('');
    if (refit || !this.viewBox) this._fit(w, h);
    this._applyViewBox();
  };

  IsoView.prototype._slab = function (pts, zTop, thick, sideCol, topCol, edge) {
    const top = pts.map(p => this._p(p.x, p.y, zTop));
    const bot = pts.map(p => this._p(p.x, p.y, zTop - thick));
    let s = `<g class="iso-board">`;
    // bottom face
    s += `<polygon points="${ptsStr(bot)}" fill="${sideCol}" />`;
    // side walls (front-facing edges only, by screen normal pointing down)
    for (let i = 0; i < top.length; i++) {
      const j = (i + 1) % top.length;
      const t1 = top[i], t2 = top[j], b1 = bot[i], b2 = bot[j];
      // edge faces viewer if it goes left->right along increasing screen x with downward normal
      const front = (t2.x - t1.x) >= 0;
      if (!front) continue;
      s += `<polygon points="${t1.x},${t1.y} ${t2.x},${t2.y} ${b2.x},${b2.y} ${b1.x},${b1.y}" fill="${sideCol}" stroke="${sideCol}" stroke-width="0.4" vector-effect="non-scaling-stroke"/>`;
    }
    // top face
    s += `<polygon points="${ptsStr(top)}" fill="${topCol}" stroke="${edge}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`;
    s += `</g>`;
    return s;
  };

  IsoView.prototype._padsSvg = function (L, z) {
    const fill = L.isPaste ? '#aab4be' : '#c4a048';
    let s = `<g class="iso-pads" fill="${fill}">`;
    const poly = (pts) => `<polygon points="${ptsStr(pts.map(p => this._p(p.x, p.y, z)))}"/>`;
    if (L.regions) for (const rg of L.regions) if (rg.pts.length >= 3) s += poly(rg.pts);
    for (const pad of L.pads) {
      let pts;
      if (pad.kind === 'rect' || pad.kind === 'obround') {
        const hw = pad.w / 2, hh = pad.h / 2;
        pts = [{ x: pad.x - hw, y: pad.y - hh }, { x: pad.x + hw, y: pad.y - hh }, { x: pad.x + hw, y: pad.y + hh }, { x: pad.x - hw, y: pad.y + hh }];
      } else {
        const r = (pad.d || 0.5) / 2, n = pad.kind === 'poly' ? Math.max(3, pad.n) : 8, rot = (pad.rot || 0) * Math.PI / 180;
        pts = [];
        for (let i = 0; i < n; i++) { const a = rot + i / n * Math.PI * 2; pts.push({ x: pad.x + r * Math.cos(a), y: pad.y + r * Math.sin(a) }); }
      }
      s += poly(pts);
    }
    return s + `</g>`;
  };

  IsoView.prototype._comp = function (c, z) {
    const sel = this.selectedGroup != null && c.groupId === this.selectedGroup;
    const filtered = this._filtered(c);
    const opacity = filtered ? 0.12 : 1;
    let topCol, sideCol;
    if (c.done) { topCol = COL.done; sideCol = COL.doneSide; }
    else if (sel) { topCol = COL.sel; sideCol = COL.selSide; }
    else if (c.layer === 'bottom') { topCol = COL.bottom; sideCol = COL.bottomSide; }
    else { topCol = COL.top; sideCol = COL.topSide; }

    // footprint rectangle corners in board space (rotated)
    const a = (c.rot || 0) * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const hw = Math.max(c.w, 0.6) / 2, hh = Math.max(c.h, 0.6) / 2;
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({
      x: c.x + dx * ca - dy * sa, y: c.y + dx * sa + dy * ca,
    }));
    const bodyH = this.bodyH;
    const topF = corners.map(p => this._p(p.x, p.y, z + bodyH));
    const botF = corners.map(p => this._p(p.x, p.y, z));

    // call-out line from board surface to component
    const a0 = this._p(c.x, c.y, c.layer === 'bottom' ? -this.thickness : 0);
    const a1 = this._p(c.x, c.y, z);

    let s = `<g class="iso-comp" data-gid="${c.groupId}" data-ref="${escAttr(c.ref)}" style="opacity:${opacity};cursor:pointer">`;
    s += `<line x1="${a0.x}" y1="${a0.y}" x2="${a1.x}" y2="${a1.y}" stroke="${COL.line}" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>`;
    // side walls
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      if ((topF[j].x - topF[i].x) < 0) continue;
      s += `<polygon points="${topF[i].x},${topF[i].y} ${topF[j].x},${topF[j].y} ${botF[j].x},${botF[j].y} ${botF[i].x},${botF[i].y}" fill="${sideCol}"/>`;
    }
    s += `<polygon points="${ptsStr(topF)}" fill="${topCol}" stroke="${sel ? '#fff' : sideCol}" stroke-width="${sel ? 1.6 : 0.8}" vector-effect="non-scaling-stroke"/>`;
    if ((this.showRefs || sel) && !filtered) {
      const ctr = this._p(c.x, c.y, z + bodyH);
      const fs = Math.max(this.size * 0.018, 1.2);
      s += `<text x="${ctr.x}" y="${ctr.y}" font-size="${fs}" fill="${sel ? COL.sel : COL.ref}" text-anchor="middle" dominant-baseline="central" style="font-family:monospace;pointer-events:none">${escAttr(c.ref)}</text>`;
    }
    s += `</g>`;
    return s;
  };

  IsoView.prototype._fit = function (w, h) {
    // measure content from current DOM bbox
    let bb;
    try { bb = this.svg.getBBox(); } catch (e) { bb = null; }
    if (!bb || !bb.width) {
      const r = this.size * 2;
      bb = { x: -r, y: -r, width: r * 2, height: r * 2 };
    }
    const pad = Math.max(bb.width, bb.height) * 0.06 + 2;
    let vbW = bb.width + pad * 2, vbH = bb.height + pad * 2;
    // match aspect ratio of the element
    const ar = w / h;
    if (vbW / vbH < ar) { const nw = vbH * ar; vbW = nw; }
    else { const nh = vbW / ar; vbH = nh; }
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    this.viewBox = { x: cx - vbW / 2, y: cy - vbH / 2, w: vbW, h: vbH };
  };

  IsoView.prototype._applyViewBox = function () {
    const v = this.viewBox;
    if (v) this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  };

  IsoView.prototype.fit = function () {
    this._fit(this.svg.clientWidth || 800, this.svg.clientHeight || 600);
    this._applyViewBox();
  };

  IsoView.prototype.zoomBy = function (f) {
    const v = this.viewBox; if (!v) return;
    const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    v.w /= f; v.h /= f; v.x = cx - v.w / 2; v.y = cy - v.h / 2;
    this._applyViewBox();
  };

  IsoView.prototype._bind = function () {
    const svg = this.svg;
    svg.addEventListener('click', (e) => {
      const g = e.target.closest('.iso-comp');
      if (g && this.onClick) this.onClick(+g.dataset.gid);
    });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.viewBox) return;
      const r = svg.getBoundingClientRect();
      const mx = this.viewBox.x + (e.clientX - r.left) / r.width * this.viewBox.w;
      const my = this.viewBox.y + (e.clientY - r.top) / r.height * this.viewBox.h;
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.viewBox.w /= f; this.viewBox.h /= f;
      this.viewBox.x = mx - (mx - this.viewBox.x) / f;
      this.viewBox.y = my - (my - this.viewBox.y) / f;
      this._applyViewBox();
    }, { passive: false });
    let drag = false, lx = 0, ly = 0;
    svg.addEventListener('mousedown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; svg.style.cursor = 'grabbing'; });
    window.addEventListener('mouseup', () => { drag = false; svg.style.cursor = ''; });
    window.addEventListener('mousemove', (e) => {
      if (!drag || !this.viewBox) return;
      const r = svg.getBoundingClientRect();
      this.viewBox.x -= (e.clientX - lx) / r.width * this.viewBox.w;
      this.viewBox.y -= (e.clientY - ly) / r.height * this.viewBox.h;
      lx = e.clientX; ly = e.clientY;
      this._applyViewBox();
    });
  };

  IsoView.prototype.exportSVG = function () {
    const v = this.viewBox || { x: 0, y: 0, w: 100, h: 100 };
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="${SVGNS}" viewBox="${v.x} ${v.y} ${v.w} ${v.h}" width="1600">` +
      `<rect x="${v.x}" y="${v.y}" width="${v.w}" height="${v.h}" fill="#0a0d11"/>` +
      this.svg.innerHTML + `</svg>`;
  };

  function ptsStr(pts) { return pts.map(p => `${round(p.x)},${round(p.y)}`).join(' '); }
  function round(n) { return Math.round(n * 1000) / 1000; }
  function escAttr(s) { return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

  global.IsoView = IsoView;
})(window);
