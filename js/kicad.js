/* Native KiCad board (.kicad_pcb) reader.
 *
 * Parses the s-expression file and derives everything the tool needs from a
 * single source: BOM rows (grouped by value+footprint), component positions
 * (CPL), the Edge.Cuts outline, and SMD/THT pads (top/bottom).
 *
 * Coordinate handling: KiCad files store Y growing downward while angles use
 * the GUI convention (CCW positive, Y up). We negate every Y on read so the
 * whole model lives in a Y-up frame matching the GUI, and rotate CCW. This
 * reproduces the board as seen from the top; bottom-side exactness may need a
 * tweak on real boards.
 */
(function (global) {

  /* ---- s-expression parser -> nested arrays of {v} atoms / arrays ---- */
  function tokenize(text) {
    const toks = [];
    let i = 0, n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '(' || c === ')') { toks.push(c); i++; }
      else if (c === '"') {
        let s = ''; i++;
        while (i < n && text[i] !== '"') { if (text[i] === '\\') { s += text[i + 1]; i += 2; } else { s += text[i++]; } }
        i++; toks.push({ s });
      }
      else if (/\s/.test(c)) i++;
      else { let s = ''; while (i < n && !/[\s()"]/.test(text[i])) s += text[i++]; toks.push({ a: s }); }
    }
    return toks;
  }

  function parseSexpr(text) {
    const toks = tokenize(text);
    let i = 0;
    function node() {
      // assumes toks[i] === '('
      i++; const arr = [];
      while (i < toks.length && toks[i] !== ')') {
        if (toks[i] === '(') arr.push(node());
        else arr.push(toks[i++]);
      }
      i++; // skip ')'
      return arr;
    }
    while (i < toks.length && toks[i] !== '(') i++;
    return i < toks.length ? node() : [];
  }

  // helpers over a node (array). node[0] is the head atom.
  const head = (nd) => (Array.isArray(nd) && nd[0] && nd[0].a) ? nd[0].a : null;
  const isArr = (x) => Array.isArray(x);
  const num = (x) => x && (x.a != null) ? parseFloat(x.a) : (x && x.s != null ? parseFloat(x.s) : NaN);
  const str = (x) => x ? (x.s != null ? x.s : x.a) : null;
  function child(nd, name) { for (const c of nd) if (isArr(c) && head(c) === name) return c; return null; }
  function children(nd, name) { return nd.filter(c => isArr(c) && head(c) === name); }

  /* ---- geometry helpers (work in Y-up after negation) ---- */
  function rotCCW(x, y, deg) { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return { x: x * c - y * s, y: x * s + y * c }; }

  function arc3(p0, pm, p1, out) {
    // circle through 3 points
    const ax = p0.x, ay = p0.y, bx = pm.x, by = pm.y, cx = p1.x, cy = p1.y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) { out.push(p1); return; }
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy);
    let a0 = Math.atan2(ay - uy, ax - ux), a1 = Math.atan2(cy - uy, cx - ux), am = Math.atan2(by - uy, bx - ux);
    const norm = (a) => { while (a < a0) a += 2 * Math.PI; return a; };
    am = norm(am); a1 = norm(a1);
    const ccw = am < a1;
    if (!ccw) a1 -= 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 60)));
    for (let k = 1; k <= steps; k++) { const a = a0 + (a1 - a0) * k / steps; out.push({ x: ux + r * Math.cos(a), y: uy + r * Math.sin(a) }); }
  }

  // stitch independent segments/polylines into loops
  function stitch(segs) {
    const eps = 0.01;
    const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
    const used = new Array(segs.length).fill(false);
    const paths = [];
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue; used[i] = true;
      const pts = segs[i].slice();
      let extended = true;
      while (extended) {
        extended = false;
        const end = pts[pts.length - 1];
        for (let j = 0; j < segs.length; j++) {
          if (used[j]) continue;
          const s = segs[j];
          if (close(end, s[0])) { for (let k = 1; k < s.length; k++) pts.push(s[k]); used[j] = true; extended = true; break; }
          if (close(end, s[s.length - 1])) { for (let k = s.length - 2; k >= 0; k--) pts.push(s[k]); used[j] = true; extended = true; break; }
        }
      }
      const closed = pts.length > 2 && close(pts[0], pts[pts.length - 1]);
      if (closed) pts.pop();
      paths.push({ pts, closed });
    }
    return paths;
  }

  const onSilk = (nd) => { const l = child(nd, 'layer'); return l && /Silk/i.test(str(l[1]) || ''); };
  function circleLocal(c, r, tp) {
    const cx = num(c[1]), cy = num(c[2]), out = [], n = 32;
    for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; out.push(tp(cx + r * Math.cos(a), cy + r * Math.sin(a))); }
    return out;
  }

  /* ---- main parse ---- */
  function parse(text) {
    const root = parseSexpr(text);
    if (!root.length) throw new Error('File KiCad illeggibile.');

    const fps = root.filter(c => isArr(c) && (head(c) === 'footprint' || head(c) === 'module'));
    if (!fps.length) throw new Error('Nessun footprint trovato nel file .kicad_pcb.');

    const bomMap = new Map();   // key -> {comment, footprint, designators[], dnp}
    const cplMap = {};
    const padsTop = { pads: [], regions: [], isPaste: false };
    const padsBot = { pads: [], regions: [], isPaste: false };
    const silkTop = { paths: [] }, silkBot = { paths: [] };
    const holes = [];           // {x,y,d}
    const dnpRefs = {};

    for (const fp of fps) {
      const fpName = str(fp[1]) || '';
      const footprint = fpName.includes(':') ? fpName.split(':')[1] : fpName;

      const at = child(fp, 'at');
      const fx = at ? num(at[1]) : 0, fyRaw = at ? num(at[2]) : 0;
      const frot = at && at[3] != null ? num(at[3]) : 0;
      const fy = -fyRaw; // to Y-up
      // transform a footprint-local point (file coords) into absolute Y-up
      const tp = (lx, ly) => { const r = rotCCW(lx, -ly, frot); return { x: fx + r.x, y: fy + r.y }; };

      const layerNode = child(fp, 'layer');
      const onBottom = layerNode && /B\.Cu|B\.Adhes|Bottom/i.test(str(layerNode[1]) || '');

      // DNP / do-not-populate detection (KiCad v7/v8 variants)
      let dnp = false;
      const attr = child(fp, 'attr');
      if (attr && attr.some(x => x && x.a === 'dnp')) dnp = true;
      const dnpNode = child(fp, 'dnp');
      if (dnpNode && /yes|true/i.test(str(dnpNode[1]) || 'yes')) dnp = true;

      // reference & value (KiCad v6+: property; older: fp_text)
      let ref = null, val = null;
      for (const p of children(fp, 'property')) {
        const k = str(p[1]);
        if (k === 'Reference') ref = str(p[2]);
        else if (k === 'Value') val = str(p[2]);
        else if (/dnp|do.?not.?(populate|place)|populate/i.test(k || '') && /no|dnp|false|do.?not/i.test(str(p[2]) || '')) dnp = true;
      }
      for (const t of children(fp, 'fp_text')) {
        const k = t[1] && t[1].a; if (k === 'reference' && !ref) ref = str(t[2]); else if (k === 'value' && !val) val = str(t[2]);
      }
      if (!ref) continue;
      if (dnp) dnpRefs[ref] = true;

      cplMap[ref] = { x: fx, y: fy, rot: frot, layer: onBottom ? 'bottom' : 'top' };

      const key = (val || '') + '|' + footprint + (dnp ? '|DNP' : '');
      if (!bomMap.has(key)) bomMap.set(key, { comment: val || '', footprint, lcsc: '', designators: [], dnp });
      bomMap.get(key).designators.push(ref);

      // pads
      const bucket = onBottom ? padsBot : padsTop;
      for (const pad of children(fp, 'pad')) {
        const shape = pad[3] && pad[3].a;            // rect | roundrect | circle | oval | trapezoid | custom
        const pat = child(pad, 'at');
        const size = child(pad, 'size');
        if (!pat || !size) continue;
        const plx = num(pat[1]), plyRaw = num(pat[2]);
        const prot = pat[3] != null ? num(pat[3]) : 0;
        const w = num(size[1]), h = num(size[2]);
        // pad local in Y-up frame, then rotate by footprint angle and translate
        const local = { x: plx, y: -plyRaw };
        const r = rotCCW(local.x, local.y, frot);
        const px = fx + r.x, py = fy + r.y;
        const total = frot + prot;                   // CCW, Y-up
        if (shape === 'circle' || (shape === 'oval' && Math.abs(w - h) < 1e-6)) {
          bucket.pads.push({ x: px, y: py, kind: 'circle', d: Math.max(w, h), ref });
        } else {
          // rect / roundrect / oval / trapezoid / custom -> rotated rectangle contour
          const hw = w / 2, hh = h / 2;
          const corners = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }]
            .map(c => rotCCW(c.x, c.y, total));
          bucket.pads.push({ x: px, y: py, kind: 'macro', contours: [corners], ref });
        }
        // drill hole (through-hole pads / NPTH)
        const drill = child(pad, 'drill');
        if (drill) {
          const dd = num(drill[1]);
          if (!isNaN(dd) && dd > 0) holes.push({ x: px, y: py, d: dd });
        }
      }

      // silkscreen graphics belonging to this footprint
      const silkBucket = onBottom ? silkBot : silkTop;
      for (const ln of children(fp, 'fp_line')) {
        if (!onSilk(ln)) continue;
        const s = child(ln, 'start'), e = child(ln, 'end');
        if (s && e) silkBucket.paths.push({ pts: [tp(num(s[1]), num(s[2])), tp(num(e[1]), num(e[2]))], closed: false });
      }
      for (const rc of children(fp, 'fp_rect')) {
        if (!onSilk(rc)) continue;
        const s = child(rc, 'start'), e = child(rc, 'end');
        if (s && e) { const a = tp(num(s[1]), num(s[2])), b = tp(num(e[1]), num(s[2])), c2 = tp(num(e[1]), num(e[2])), d2 = tp(num(s[1]), num(e[2])); silkBucket.paths.push({ pts: [a, b, c2, d2], closed: true }); }
      }
      for (const ci of children(fp, 'fp_circle')) {
        if (!onSilk(ci)) continue;
        const c = child(ci, 'center'), e = child(ci, 'end');
        if (c && e) { const r2 = Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2])); silkBucket.paths.push({ pts: circleLocal(c, r2, tp), closed: true }); }
      }
      for (const ar of children(fp, 'fp_arc')) {
        if (!onSilk(ar)) continue;
        const s = child(ar, 'start'), m = child(ar, 'mid'), e = child(ar, 'end');
        if (s && m && e) { const out = [tp(num(s[1]), num(s[2]))]; arc3(tp(num(s[1]), num(s[2])), tp(num(m[1]), num(m[2])), tp(num(e[1]), num(e[2])), out); silkBucket.paths.push({ pts: out, closed: false }); }
      }
      for (const pl of children(fp, 'fp_poly')) {
        if (!onSilk(pl)) continue;
        const ptsNode = child(pl, 'pts'); if (!ptsNode) continue;
        const pts = children(ptsNode, 'xy').map(p => tp(num(p[1]), num(p[2])));
        if (pts.length > 2) silkBucket.paths.push({ pts, closed: true });
      }
    }

    // ---- outline from Edge.Cuts ----
    const segs = [];
    const onEdge = (nd) => { const l = child(nd, 'layer'); return l && /Edge\.Cuts/i.test(str(l[1]) || ''); };
    const Y = (v) => -v;
    for (const ln of children(root, 'gr_line')) {
      if (!onEdge(ln)) continue;
      const s = child(ln, 'start'), e = child(ln, 'end');
      if (s && e) segs.push([{ x: num(s[1]), y: Y(num(s[2])) }, { x: num(e[1]), y: Y(num(e[2])) }]);
    }
    for (const rc of children(root, 'gr_rect')) {
      if (!onEdge(rc)) continue;
      const s = child(rc, 'start'), e = child(rc, 'end');
      if (s && e) { const x0 = num(s[1]), y0 = Y(num(s[2])), x1 = num(e[1]), y1 = Y(num(e[2])); segs.push([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }]); }
    }
    for (const ar of children(root, 'gr_arc')) {
      if (!onEdge(ar)) continue;
      const s = child(ar, 'start'), m = child(ar, 'mid'), e = child(ar, 'end'), ang = child(ar, 'angle');
      const out = [];
      if (s && m && e) { out.push({ x: num(s[1]), y: Y(num(s[2])) }); arc3({ x: num(s[1]), y: Y(num(s[2])) }, { x: num(m[1]), y: Y(num(m[2])) }, { x: num(e[1]), y: Y(num(e[2])) }, out); }
      else if (s && e) { out.push({ x: num(s[1]), y: Y(num(s[2])) }, { x: num(e[1]), y: Y(num(e[2])) }); }
      if (out.length > 1) segs.push(out);
    }
    for (const pl of children(root, 'gr_poly')) {
      if (!onEdge(pl)) continue;
      const ptsNode = child(pl, 'pts'); if (!ptsNode) continue;
      const pts = children(ptsNode, 'xy').map(p => ({ x: num(p[1]), y: Y(num(p[2])) }));
      if (pts.length > 2) { pts.push(pts[0]); segs.push(pts); }
    }

    let outline = null;
    if (segs.length) {
      const paths = stitch(segs);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of paths) for (const pt of p.pts) { minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x); minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y); }
      outline = { paths, bounds: { minX, minY, maxX, maxY }, source: 'kicad' };
    }

    // vias -> through holes
    for (const via of children(root, 'via')) {
      const at = child(via, 'at'), dr = child(via, 'drill');
      if (at && dr) { const dd = num(dr[1]); if (dd > 0) holes.push({ x: num(at[1]), y: -num(at[2]), d: dd }); }
    }
    // board-level silk graphics
    const idn = (x, y) => ({ x, y: -y });
    for (const ln of children(root, 'gr_line')) {
      if (!onSilk(ln)) continue;
      const s = child(ln, 'start'), e = child(ln, 'end');
      const bucket = /B\./i.test(str(child(ln, 'layer')[1]) || '') ? silkBot : silkTop;
      if (s && e) bucket.paths.push({ pts: [idn(num(s[1]), num(s[2])), idn(num(e[1]), num(e[2]))], closed: false });
    }

    let drill = null;
    if (holes.length) {
      let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
      for (const h of holes) { mnX = Math.min(mnX, h.x); mxX = Math.max(mxX, h.x); mnY = Math.min(mnY, h.y); mxY = Math.max(mxY, h.y); }
      drill = { holes, bounds: { minX: mnX, minY: mnY, maxX: mxX, maxY: mxY } };
    }

    const bomRows = [...bomMap.values()];
    bomRows.sort((a, b) => (a.dnp ? 1 : 0) - (b.dnp ? 1 : 0) || a.designators.length - b.designators.length);
    return {
      bomRows, cplMap, outline,
      pads: { top: padsTop.pads.length || padsTop.regions.length ? padsTop : null, bottom: padsBot.pads.length ? padsBot : null },
      silk: { top: silkTop.paths.length ? silkTop : null, bottom: silkBot.paths.length ? silkBot : null },
      drill,
      stats: { footprints: fps.length, dnp: Object.keys(dnpRefs).length },
    };
  }

  global.KiCad = { parse, parseSexpr };
})(window);
