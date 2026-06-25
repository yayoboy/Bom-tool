/* Solder-paste stencil generator.
 *
 * Takes the paste layer already parsed by gerber.js / kicad.js
 * (state.pads.{top,bottom} -> {pads:[...], regions:[...], isPaste}) and turns
 * the paste apertures into a stencil you can fabricate:
 *
 *   - SVG    : 1:1 mm vector, black openings on the board outline (laser / view)
 *   - DXF    : LWPOLYLINE per opening (laser cutters, LightBurn, Inkscape…)
 *   - Gerber : RS-274X paste layer regenerated as filled regions (stencil house)
 *   - STL    : 3D-printable plate (frame) with the openings as through-holes,
 *              user-set thickness ("spessore variabile").
 *
 * Common stencil tweaks are supported: per-aperture area reduction (shrink to
 * release less paste) and a holding frame margin. Apertures are emitted as
 * closed polygons in millimetres in a Y-up frame (Gerber convention).
 */
(function (global) {
  'use strict';

  /* ---------------- shape -> polygon contour(s) ---------------- */
  function circleC(cx, cy, r, n) {
    n = n || 32; const out = [];
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    return out;
  }
  function obroundC(cx, cy, w, h) {
    const r = Math.min(w, h) / 2, out = [], arc = 8;
    if (w >= h) {
      const dx = w / 2 - r;
      for (let i = 0; i <= arc; i++) { const a = -Math.PI / 2 + i / arc * Math.PI; out.push({ x: cx + dx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
      for (let i = 0; i <= arc; i++) { const a = Math.PI / 2 + i / arc * Math.PI; out.push({ x: cx - dx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    } else {
      const dy = h / 2 - r;
      for (let i = 0; i <= arc; i++) { const a = 0 + i / arc * Math.PI; out.push({ x: cx + r * Math.cos(a), y: cy + dy + r * Math.sin(a) }); }
      for (let i = 0; i <= arc; i++) { const a = Math.PI + i / arc * Math.PI; out.push({ x: cx + r * Math.cos(a), y: cy - dy + r * Math.sin(a) }); }
    }
    return out;
  }
  function polyC(cx, cy, r, n, rotDeg) {
    const out = [], rot = (rotDeg || 0) * Math.PI / 180;
    n = Math.max(3, n || 3);
    for (let i = 0; i < n; i++) { const a = rot + i / n * Math.PI * 2; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    return out;
  }

  // Return an array of contours (each a closed polygon, absolute mm) for a pad.
  function padContours(pad) {
    switch (pad.kind) {
      case 'circle': return [circleC(pad.x, pad.y, (pad.d || 0) / 2, 32)];
      case 'rect': return [[
        { x: pad.x - pad.w / 2, y: pad.y - pad.h / 2 }, { x: pad.x + pad.w / 2, y: pad.y - pad.h / 2 },
        { x: pad.x + pad.w / 2, y: pad.y + pad.h / 2 }, { x: pad.x - pad.w / 2, y: pad.y + pad.h / 2 },
      ]];
      case 'obround': return [obroundC(pad.x, pad.y, pad.w, pad.h)];
      case 'poly': return [polyC(pad.x, pad.y, (pad.d || 0) / 2, pad.n, pad.rot)];
      case 'macro': return (pad.contours || []).filter(c => c && c.length >= 3).map(c => c.map(p => ({ x: pad.x + p.x, y: pad.y + p.y })));
      default: return [];
    }
  }

  /* ---------------- geometry helpers ---------------- */
  function centroid(pts) {
    let x = 0, y = 0; for (const p of pts) { x += p.x; y += p.y; } return { x: x / pts.length, y: y / pts.length };
  }
  // Linear shrink about the centroid (area-reduction style). factor in (0,1].
  function scaleAbout(pts, factor) {
    if (factor === 1) return pts;
    const c = centroid(pts);
    return pts.map(p => ({ x: c.x + (p.x - c.x) * factor, y: c.y + (p.y - c.y) * factor }));
  }
  function signedArea(pts) {
    let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p.x * q.y - q.x * p.y; } return a / 2;
  }
  function orient(pts, ccw) {
    const a = signedArea(pts);
    if ((a < 0 && ccw) || (a > 0 && !ccw)) return pts.slice().reverse();
    return pts;
  }

  /* ---------------- collect apertures from a paste layer ---------------- */
  // opts: { reduction:%, mirror:bool, bounds:{minX..} (for mirror axis) }
  function collect(layer, opts) {
    opts = opts || {};
    const factor = Math.max(0.05, 1 - (opts.reduction || 0) / 100);
    const out = [];
    const push = (c) => {
      if (!c || c.length < 3) return;
      let pts = factor !== 1 ? scaleAbout(c, factor) : c.map(p => ({ x: p.x, y: p.y }));
      if (opts.mirror && opts.bounds) { const ax = opts.bounds.minX + opts.bounds.maxX; pts = pts.map(p => ({ x: ax - p.x, y: p.y })); }
      out.push(pts);
    };
    for (const pad of (layer.pads || [])) for (const c of padContours(pad)) push(c);
    for (const rg of (layer.regions || [])) push(rg.pts);
    return out;
  }

  // Bounding box of a set of contours.
  function bbox(contours) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of contours) for (const p of c) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    return { minX, minY, maxX, maxY };
  }

  /* ---------------- SVG ---------------- */
  function toSVG(contours, frame) {
    const W = frame.maxX - frame.minX, H = frame.maxY - frame.minY;
    const fy = (y) => (frame.maxY - y); // flip to SVG Y-down, keep mm
    const fx = (x) => (x - frame.minX);
    const path = contours.map(c => 'M' + c.map((p, i) => (i ? 'L' : '') + fx(p.x).toFixed(4) + ' ' + fy(p.y).toFixed(4)).join(' ') + 'Z').join(' ');
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(3)}mm" height="${H.toFixed(3)}mm" viewBox="0 0 ${W.toFixed(4)} ${H.toFixed(4)}">
  <desc>Solder paste stencil - openings in black, 1:1 mm</desc>
  <rect x="0" y="0" width="${W.toFixed(4)}" height="${H.toFixed(4)}" fill="#ffffff"/>
  <path d="${path}" fill="#000000" fill-rule="nonzero"/>
  <rect x="0" y="0" width="${W.toFixed(4)}" height="${H.toFixed(4)}" fill="none" stroke="#888" stroke-width="0.1"/>
</svg>`;
  }

  /* ---------------- DXF (R2000, LWPOLYLINE) ---------------- */
  function toDXF(contours, frame) {
    const L = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES'];
    const poly = (pts, closed) => {
      L.push('0', 'LWPOLYLINE', '8', '0', '90', String(pts.length), '70', closed ? '1' : '0');
      for (const p of pts) { L.push('10', p.x.toFixed(4), '20', p.y.toFixed(4)); }
    };
    for (const c of contours) poly(c, true);
    // holding-frame border
    poly([{ x: frame.minX, y: frame.minY }, { x: frame.maxX, y: frame.minY },
    { x: frame.maxX, y: frame.maxY }, { x: frame.minX, y: frame.maxY }], true);
    L.push('0', 'ENDSEC', '0', 'EOF');
    return L.join('\n') + '\n';
  }

  /* ---------------- Gerber (RS-274X, filled regions) ---------------- */
  function toGerber(contours) {
    const S = 1e6; // 4.6 format
    const c = (v) => Math.round(v * S);
    const out = [
      '%FSLAX46Y46*%', '%MOMM*%', 'G04 Solder paste stencil generated by Interactive BOM*',
      '%ADD10C,0.010*%', 'D10*', 'G01*',
    ];
    for (const ct of contours) {
      if (ct.length < 3) continue;
      out.push('G36*');
      out.push('X' + c(ct[0].x) + 'Y' + c(ct[0].y) + 'D02*');
      for (let i = 1; i < ct.length; i++) out.push('X' + c(ct[i].x) + 'Y' + c(ct[i].y) + 'D01*');
      out.push('X' + c(ct[0].x) + 'Y' + c(ct[0].y) + 'D01*');
      out.push('G37*');
    }
    out.push('M02*');
    return out.join('\n') + '\n';
  }

  /* ---------------- STL (binary) : plate with through-holes ---------------- */
  // Triangulate a rectangular plate (frame) with polygonal holes (apertures)
  // and extrude to `thickness`. Returns an ArrayBuffer (binary STL).
  function toSTL(contours, frame, thickness) {
    const T = thickness > 0 ? thickness : 0.12;
    const outer = orient([
      { x: frame.minX, y: frame.minY }, { x: frame.maxX, y: frame.minY },
      { x: frame.maxX, y: frame.maxY }, { x: frame.minX, y: frame.maxY },
    ], true); // CCW

    // flat coords + hole indices for earcut; holes oriented CW
    const flat = [], holeIdx = [];
    for (const p of outer) flat.push(p.x, p.y);
    const rings = [outer];
    for (const c of contours) {
      if (c.length < 3) continue;
      const h = orient(c, false); // CW for holes
      holeIdx.push(flat.length / 2);
      for (const p of h) flat.push(p.x, p.y);
      rings.push(h);
    }
    const tris = earcut(flat, holeIdx, 2); // indices into `flat`/2

    const tri = []; // each: [ax,ay,az, bx,by,bz, cx,cy,cz]
    const V = (i) => ({ x: flat[i * 2], y: flat[i * 2 + 1] });
    // top (z=T, CCW -> +Z) and bottom (z=0, reversed -> -Z)
    for (let i = 0; i < tris.length; i += 3) {
      const a = V(tris[i]), b = V(tris[i + 1]), c = V(tris[i + 2]);
      tri.push([a.x, a.y, T, b.x, b.y, T, c.x, c.y, T]);
      tri.push([a.x, a.y, 0, c.x, c.y, 0, b.x, b.y, 0]);
    }
    // walls: outer ring (CCW) + holes (CW) -> outward / into-cavity normals
    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        tri.push([p.x, p.y, 0, q.x, q.y, 0, q.x, q.y, T]);
        tri.push([p.x, p.y, 0, q.x, q.y, T, p.x, p.y, T]);
      }
    }

    const buf = new ArrayBuffer(84 + tri.length * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, tri.length, true);
    let o = 84;
    for (const t of tri) {
      const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
      const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
      dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
      for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, t[k], true);
      dv.setUint16(o + 48, 0, true);
      o += 50;
    }
    return buf;
  }

  /* ================= earcut (Mapbox, ISC licensed, trimmed) ================= */
  function earcut(data, holeIndices, dim) {
    dim = dim || 2;
    const hasHoles = holeIndices && holeIndices.length;
    const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
    let outerNode = linkedList(data, 0, outerLen, dim, true);
    const triangles = [];
    if (!outerNode || outerNode.next === outerNode.prev) return triangles;
    if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);
    let minX, minY, invSize;
    if (data.length > 80 * dim) {
      minX = Infinity; minY = Infinity; let maxX = -Infinity, maxY = -Infinity;
      for (let i = dim; i < outerLen; i += dim) {
        const x = data[i], y = data[i + 1];
        if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
      invSize = Math.max(maxX - minX, maxY - minY); invSize = invSize !== 0 ? 32767 / invSize : 0;
    }
    earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);
    return triangles;
  }
  function linkedList(data, start, end, dim, clockwise) {
    let last;
    if (clockwise === (signedAreaFlat(data, start, end, dim) > 0)) {
      for (let i = start; i < end; i += dim) last = insertNode(i, data[i], data[i + 1], last);
    } else {
      for (let i = end - dim; i >= start; i -= dim) last = insertNode(i, data[i], data[i + 1], last);
    }
    if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
    return last;
  }
  function filterPoints(start, end) {
    if (!start) return start;
    if (!end) end = start;
    let p = start, again;
    do {
      again = false;
      if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
        removeNode(p); p = end = p.prev;
        if (p === p.next) break;
        again = true;
      } else p = p.next;
    } while (again || p !== end);
    return end;
  }
  function earcutLinked(ear, triangles, dim, minX, minY, invSize, pass) {
    if (!ear) return;
    if (!pass && invSize) indexCurve(ear, minX, minY, invSize);
    let stop = ear, prev, next;
    while (ear.prev !== ear.next) {
      prev = ear.prev; next = ear.next;
      if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
        triangles.push(prev.i / dim | 0, ear.i / dim | 0, next.i / dim | 0);
        removeNode(ear); ear = next.next; stop = next.next; continue;
      }
      ear = next;
      if (ear === stop) {
        if (!pass) earcutLinked(filterPoints(ear), triangles, dim, minX, minY, invSize, 1);
        else if (pass === 1) { ear = cureLocalIntersections(filterPoints(ear), triangles, dim); earcutLinked(ear, triangles, dim, minX, minY, invSize, 2); }
        else if (pass === 2) splitEarcut(ear, triangles, dim, minX, minY, invSize);
        break;
      }
    }
  }
  function isEar(ear) {
    const a = ear.prev, b = ear, c = ear.next;
    if (area(a, b, c) >= 0) return false;
    const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
    const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy), x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);
    let p = c.next;
    while (p !== a) {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
      p = p.next;
    }
    return true;
  }
  function isEarHashed(ear, minX, minY, invSize) {
    const a = ear.prev, b = ear, c = ear.next;
    if (area(a, b, c) >= 0) return false;
    const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
    const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy), x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);
    const minZ = zOrder(x0, y0, minX, minY, invSize), maxZ = zOrder(x1, y1, minX, minY, invSize);
    let p = ear.prevZ, n = ear.nextZ;
    while (p && p.z >= minZ && n && n.z <= maxZ) {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
      p = p.prevZ;
      if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
      n = n.nextZ;
    }
    while (p && p.z >= minZ) {
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
      p = p.prevZ;
    }
    while (n && n.z <= maxZ) {
      if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
      n = n.nextZ;
    }
    return true;
  }
  function cureLocalIntersections(start, triangles, dim) {
    let p = start;
    do {
      const a = p.prev, b = p.next.next;
      if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
        triangles.push(a.i / dim | 0, p.i / dim | 0, b.i / dim | 0);
        removeNode(p); removeNode(p.next); p = start = b;
      }
      p = p.next;
    } while (p !== start);
    return filterPoints(p);
  }
  function splitEarcut(start, triangles, dim, minX, minY, invSize) {
    let a = start;
    do {
      let b = a.next.next;
      while (b !== a.prev) {
        if (a.i !== b.i && isValidDiagonal(a, b)) {
          let c = splitPolygon(a, b);
          a = filterPoints(a, a.next); c = filterPoints(c, c.next);
          earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
          earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
          return;
        }
        b = b.next;
      }
      a = a.next;
    } while (a !== start);
  }
  function eliminateHoles(data, holeIndices, outerNode, dim) {
    const queue = [];
    for (let i = 0, len = holeIndices.length; i < len; i++) {
      const start = holeIndices[i] * dim, end = i < len - 1 ? holeIndices[i + 1] * dim : data.length;
      const list = linkedList(data, start, end, dim, false);
      if (list === list.next) list.steiner = true;
      queue.push(getLeftmost(list));
    }
    queue.sort((a, b) => a.x - b.x);
    for (let i = 0; i < queue.length; i++) outerNode = eliminateHole(queue[i], outerNode);
    return outerNode;
  }
  function eliminateHole(hole, outerNode) {
    const bridge = findHoleBridge(hole, outerNode);
    if (!bridge) return outerNode;
    const bridgeReverse = splitPolygon(bridge, hole);
    filterPoints(bridgeReverse, bridgeReverse.next);
    return filterPoints(bridge, bridge.next);
  }
  function findHoleBridge(hole, outerNode) {
    let p = outerNode, qx = -Infinity, m;
    const hx = hole.x, hy = hole.y;
    do {
      if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
        const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
        if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
      }
      p = p.next;
    } while (p !== outerNode);
    if (!m) return null;
    const stop = m, mx = m.x, my = m.y; let tanMin = Infinity;
    p = m;
    do {
      if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
        const tan = Math.abs(hy - p.y) / (hx - p.x);
        if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || (p.x === m.x && sectorContainsSector(m, p)))))) {
          m = p; tanMin = tan;
        }
      }
      p = p.next;
    } while (p !== stop);
    return m;
  }
  function sectorContainsSector(m, p) { return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0; }
  function indexCurve(start, minX, minY, invSize) {
    let p = start;
    do {
      if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize);
      p.prevZ = p.prev; p.nextZ = p.next; p = p.next;
    } while (p !== start);
    p.prevZ.nextZ = null; p.prevZ = null; sortLinked(p);
  }
  function sortLinked(list) {
    let numMerges, inSize = 1;
    do {
      let p = list, e; list = null; let tail = null; numMerges = 0;
      while (p) {
        numMerges++; let q = p, pSize = 0;
        for (let i = 0; i < inSize; i++) { pSize++; q = q.nextZ; if (!q) break; }
        let qSize = inSize;
        while (pSize > 0 || (qSize > 0 && q)) {
          if (pSize !== 0 && (qSize === 0 || !q || p.z <= q.z)) { e = p; p = p.nextZ; pSize--; }
          else { e = q; q = q.nextZ; qSize--; }
          if (tail) tail.nextZ = e; else list = e;
          e.prevZ = tail; tail = e;
        }
        p = q;
      }
      tail.nextZ = null; inSize *= 2;
    } while (numMerges > 1);
    return list;
  }
  function zOrder(x, y, minX, minY, invSize) {
    x = (x - minX) * invSize | 0; y = (y - minY) * invSize | 0;
    x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555;
    y = (y | (y << 8)) & 0x00FF00FF; y = (y | (y << 4)) & 0x0F0F0F0F; y = (y | (y << 2)) & 0x33333333; y = (y | (y << 1)) & 0x55555555;
    return x | (y << 1);
  }
  function getLeftmost(start) { let p = start, leftmost = start; do { if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p; p = p.next; } while (p !== start); return leftmost; }
  function pointInTriangle(ax, ay, bx, by, cx, cy, px, py) {
    return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
      (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
      (bx - px) * (cy - py) >= (cx - px) * (by - py);
  }
  function isValidDiagonal(a, b) {
    return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
      (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
        (area(a.prev, a, b.prev) || area(a, b.prev, b)) || equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0);
  }
  function area(p, q, r) { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
  function equals(p1, p2) { return p1.x === p2.x && p1.y === p2.y; }
  function intersects(p1, q1, p2, q2) {
    const o1 = sign(area(p1, q1, p2)), o2 = sign(area(p1, q1, q2)), o3 = sign(area(p2, q2, p1)), o4 = sign(area(p2, q2, q1));
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSegment(p1, p2, q1)) return true;
    if (o2 === 0 && onSegment(p1, q2, q1)) return true;
    if (o3 === 0 && onSegment(p2, p1, q2)) return true;
    if (o4 === 0 && onSegment(p2, q1, q2)) return true;
    return false;
  }
  function onSegment(p, q, r) { return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y); }
  function sign(num) { return num > 0 ? 1 : num < 0 ? -1 : 0; }
  function intersectsPolygon(a, b) {
    let p = a;
    do {
      if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
      p = p.next;
    } while (p !== a);
    return false;
  }
  function locallyInside(a, b) { return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0; }
  function middleInside(a, b) {
    let p = a, inside = false; const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
    do {
      if (((p.y > py) !== (p.next.y > py)) && p.next.y !== p.y && (px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x)) inside = !inside;
      p = p.next;
    } while (p !== a);
    return inside;
  }
  function splitPolygon(a, b) {
    const a2 = new Node(a.i, a.x, a.y), b2 = new Node(b.i, b.x, b.y), an = a.next, bp = b.prev;
    a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp;
    return b2;
  }
  function insertNode(i, x, y, last) {
    const p = new Node(i, x, y);
    if (!last) { p.prev = p; p.next = p; } else { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
    return p;
  }
  function removeNode(p) { p.next.prev = p.prev; p.prev.next = p.next; if (p.prevZ) p.prevZ.nextZ = p.nextZ; if (p.nextZ) p.nextZ.prevZ = p.prevZ; }
  function Node(i, x, y) { this.i = i; this.x = x; this.y = y; this.prev = null; this.next = null; this.z = 0; this.prevZ = null; this.nextZ = null; this.steiner = false; }
  function signedAreaFlat(data, start, end, dim) {
    let sum = 0; for (let i = start, j = end - dim; i < end; i += dim) { sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]); j = i; } return sum;
  }
  /* =============== end earcut =============== */

  /* ---------------- high-level build ---------------- */
  // pads: state.pads ({top,bottom}); side: 'top'|'bottom'; opts: {reduction,margin,mirror,thickness,boardBounds}
  function build(pads, side, opts) {
    opts = opts || {};
    const layer = pads && pads[side];
    if (!layer || !((layer.pads && layer.pads.length) || (layer.regions && layer.regions.length))) {
      throw new Error('Nessuna piazzola di solder paste per il lato ' + side + '.');
    }
    const contours = collect(layer, {
      reduction: opts.reduction || 0,
      mirror: !!opts.mirror,
      bounds: layer.bounds,
    });
    if (!contours.length) throw new Error('Nessuna apertura generata.');
    // frame = board outline bbox (mirrored to match, since `contours` is already
    // mirrored) or, lacking an outline, the already-mirrored apertures' bbox.
    let b;
    if (opts.boardBounds && isFinite(opts.boardBounds.minX)) {
      b = Object.assign({}, opts.boardBounds);
      if (opts.mirror) { const ax = layer.bounds.minX + layer.bounds.maxX; const nx0 = ax - b.maxX, nx1 = ax - b.minX; b.minX = Math.min(nx0, nx1); b.maxX = Math.max(nx0, nx1); }
    } else {
      b = bbox(contours);
    }
    const m = opts.margin != null ? opts.margin : 5;
    const frame = { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
    return { contours, frame, count: contours.length, isPaste: layer.isPaste !== false };
  }

  global.Stencil = {
    build, collect, padContours, bbox,
    toSVG, toDXF, toGerber, toSTL,
  };
})(window);
