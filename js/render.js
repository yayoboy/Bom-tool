/* Canvas renderer: draws components from CPL positions, supports pan/zoom,
 * layer filtering, selection highlight and hover hit-testing.
 *
 * Coordinate model: CPL gives board coords in mm (Y up). We flip Y for the
 * screen. When viewing the BOTTOM, we mirror X so the silkscreen matches the
 * board seen from the back.
 */
(function (global) {
  const COL = {
    top: '#d9534f', bottom: '#5bc0de',
    topFill: 'rgba(217,83,79,0.30)', bottomFill: 'rgba(91,192,222,0.30)',
    sel: '#ffd33d', selFill: 'rgba(255,211,61,0.55)',
    done: 'rgba(120,130,140,0.18)', doneStroke: 'rgba(120,130,140,0.5)',
    outline: '#37424f', grid: 'rgba(255,255,255,0.03)',
  };

  function Renderer(canvas, tooltip) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.ctx = canvas.getContext('2d');
    this.comps = [];
    this.layer = 'top';
    this.selectedGroup = null;
    this.visible = null;        // Set of refs allowed by search, or null = all
    this.showRefs = false;
    this.scale = 1; this.offX = 0; this.offY = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.onHover = null;
    this._bindEvents();
  }

  Renderer.prototype.setComponents = function (comps) { this.comps = comps; };
  Renderer.prototype.setLayer = function (l) { this.layer = l; this.fit(); };
  Renderer.prototype.setSelected = function (g) { this.selectedGroup = g; this.draw(); };
  Renderer.prototype.setVisible = function (set) { this.visible = set; this.draw(); };
  Renderer.prototype.setShowRefs = function (b) { this.showRefs = b; this.draw(); };

  Renderer.prototype._mirror = function () { return this.layer === 'bottom' ? -1 : 1; };

  Renderer.prototype._layerVisible = function (c) {
    if (this.layer === 'both') return true;
    return c.layer === this.layer;
  };

  Renderer.prototype.w2s = function (x, y) {
    return { x: this.offX + x * this.scale * this._mirror(), y: this.offY - y * this.scale };
  };

  Renderer.prototype.resize = function () {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.cssW = rect.width; this.cssH = rect.height;
    this.draw();
  };

  Renderer.prototype._bounds = function () {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const c of this.comps) {
      if (!this._layerVisible(c)) continue;
      any = true;
      const r = Math.max(c.w, c.h) / 2;
      minX = Math.min(minX, c.x - r); maxX = Math.max(maxX, c.x + r);
      minY = Math.min(minY, c.y - r); maxY = Math.max(maxY, c.y + r);
    }
    if (!any) return null;
    return { minX, minY, maxX, maxY };
  };

  Renderer.prototype.fit = function () {
    const b = this._bounds();
    if (!b) { this.draw(); return; }
    const pad = 30;
    const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
    const sx = (this.cssW - pad * 2) / bw, sy = (this.cssH - pad * 2) / bh;
    this.scale = Math.max(0.1, Math.min(sx, sy));
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    this.offX = this.cssW / 2 - cx * this.scale * this._mirror();
    this.offY = this.cssH / 2 + cy * this.scale;
    this.draw();
  };

  Renderer.prototype.zoomBy = function (factor, sx, sy) {
    sx = sx == null ? this.cssW / 2 : sx;
    sy = sy == null ? this.cssH / 2 : sy;
    const wx = (sx - this.offX) / (this.scale * this._mirror());
    const wy = (this.offY - sy) / this.scale;
    this.scale = Math.max(0.05, Math.min(400, this.scale * factor));
    this.offX = sx - wx * this.scale * this._mirror();
    this.offY = sy + wy * this.scale;
    this.draw();
  };

  Renderer.prototype._isVisibleByFilter = function (c) {
    return !this.visible || this.visible.has(c.ref);
  };

  Renderer.prototype.draw = function () {
    const ctx = this.ctx;
    if (!this.cssW) this.resize();
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // board background rectangle from bounds (pseudo-outline)
    const b = this._bounds();
    if (b) {
      const p1 = this.w2s(b.minX, b.maxY), p2 = this.w2s(b.maxX, b.minY);
      const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
      ctx.fillStyle = '#10161d';
      ctx.strokeStyle = COL.outline;
      ctx.lineWidth = 1.5;
      roundRect(ctx, x - 8, y - 8, Math.abs(p2.x - p1.x) + 16, Math.abs(p2.y - p1.y) + 16, 6);
      ctx.fill(); ctx.stroke();
    }

    // components
    for (const c of this.comps) {
      if (!this._layerVisible(c)) continue;
      const filtered = !this._isVisibleByFilter(c);
      const selected = this.selectedGroup != null && c.groupId === this.selectedGroup;
      this._drawComp(ctx, c, selected, filtered);
    }
    ctx.restore();
  };

  Renderer.prototype._drawComp = function (ctx, c, selected, filtered) {
    const p = this.w2s(c.x, c.y);
    const w = Math.max(c.w * this.scale, 3);
    const h = Math.max(c.h * this.scale, 3);
    const rot = (c.rot || 0) * Math.PI / 180 * (this._mirror());

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-rot); // screen Y is flipped, so negate
    ctx.globalAlpha = filtered ? 0.12 : 1;

    let stroke, fill;
    if (c.done) { stroke = COL.doneStroke; fill = COL.done; }
    else if (selected) { stroke = COL.sel; fill = COL.selFill; }
    else if (c.layer === 'top') { stroke = COL.top; fill = COL.topFill; }
    else { stroke = COL.bottom; fill = COL.bottomFill; }

    ctx.lineWidth = selected ? 2.5 : 1.2;
    ctx.strokeStyle = stroke; ctx.fillStyle = fill;
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(2, w / 4, h / 4));
    ctx.fill(); ctx.stroke();

    // pin-1 / orientation tick
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(-w / 2 + Math.min(w, h) * 0.35, -h / 2);
    ctx.strokeStyle = selected ? '#fff' : stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    if ((this.showRefs || selected) && !filtered) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = selected ? COL.sel : 'rgba(230,237,243,0.85)';
      ctx.font = (selected ? 'bold ' : '') + Math.max(9, Math.min(13, h * 0.7)) + 'px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.ref, p.x, p.y);
      ctx.restore();
    }
  };

  Renderer.prototype.hitTest = function (sx, sy) {
    // iterate in reverse for topmost; respect layer + filter
    for (let i = this.comps.length - 1; i >= 0; i--) {
      const c = this.comps[i];
      if (!this._layerVisible(c) || !this._isVisibleByFilter(c)) continue;
      const p = this.w2s(c.x, c.y);
      const rot = (c.rot || 0) * Math.PI / 180 * this._mirror();
      const dx = sx - p.x, dy = sy - p.y;
      const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
      const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
      const w = Math.max(c.w * this.scale, 6), h = Math.max(c.h * this.scale, 6);
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return c;
    }
    return null;
  };

  Renderer.prototype._bindEvents = function () {
    const cv = this.canvas;
    let dragging = false, lx = 0, ly = 0, moved = false;

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    cv.addEventListener('mousedown', (e) => { dragging = true; moved = false; lx = e.clientX; ly = e.clientY; cv.classList.add('panning'); });
    window.addEventListener('mouseup', () => { dragging = false; cv.classList.remove('panning'); });
    window.addEventListener('mousemove', (e) => {
      const r = cv.getBoundingClientRect();
      if (dragging) {
        const dx = e.clientX - lx, dy = e.clientY - ly;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        this.offX += dx; this.offY += dy; lx = e.clientX; ly = e.clientY;
        this.draw();
        return;
      }
      // hover
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (sx < 0 || sy < 0 || sx > r.width || sy > r.height) { this._hideTip(); return; }
      const hit = this.hitTest(sx, sy);
      if (hit) this._showTip(hit, e.clientX - r.left, e.clientY - r.top);
      else this._hideTip();
      if (this.onHover) this.onHover(hit);
    });

    cv.addEventListener('click', (e) => {
      if (moved) return;
      const r = cv.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit && this.onClick) this.onClick(hit);
    });
    cv.addEventListener('mouseleave', () => this._hideTip());
  };

  Renderer.prototype._showTip = function (c, x, y) {
    const t = this.tooltip;
    t.innerHTML = `<strong>${c.ref}</strong> — ${escapeHtml(c.comment || '')}<br>` +
      `<span class="muted">${escapeHtml(c.footprint || '')} · ${c.layer}</span>`;
    t.classList.remove('hidden');
    t.style.left = (x + 14) + 'px';
    t.style.top = (y + 14) + 'px';
  };
  Renderer.prototype._hideTip = function () { this.tooltip.classList.add('hidden'); };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  global.Renderer = Renderer;
  global.escapeHtml = escapeHtml;
})(window);
