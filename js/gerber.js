/* Minimal RS-274X (Gerber) reader focused on extracting board-outline
 * geometry, plus a dependency-free ZIP extractor (uses the native
 * DecompressionStream API) so the user can drop a JLCPCB gerber .zip directly.
 *
 * The parser is intentionally scoped to what we need to draw the board shape:
 * format/units, aperture selection, linear & circular interpolation, regions
 * (G36/G37). It returns polylines/polygons in millimetres.
 */
(function (global) {

  /* ---------------- ZIP (read-only) ---------------- */
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function unzip(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const u8 = new Uint8Array(arrayBuffer);
    const len = dv.byteLength;
    // locate End Of Central Directory (sig 0x06054b50), scanning from the end
    let eocd = -1;
    for (let i = len - 22; i >= 0 && i >= len - 22 - 65536; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP non valido (EOCD non trovato).');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);

    const entries = [];
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = utf8(u8.subarray(off + 46, off + 46 + nameLen));
      entries.push({ name, method, compSize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }

    const files = [];
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      const lh = e.localOff;
      if (dv.getUint32(lh, true) !== 0x04034b50) continue;
      const nameLen = dv.getUint16(lh + 26, true);
      const extraLen = dv.getUint16(lh + 28, true);
      const dataStart = lh + 30 + nameLen + extraLen;
      const raw = u8.subarray(dataStart, dataStart + e.compSize);
      let data;
      if (e.method === 0) data = raw;
      else if (e.method === 8) data = await inflateRaw(raw);
      else continue; // unsupported compression
      files.push({ name: e.name, text: utf8(data) });
    }
    return files;
  }

  function utf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) { return String.fromCharCode.apply(null, bytes); }
  }

  /* Pick the most likely board-outline gerber among a set of files. */
  function pickOutline(files) {
    const score = (name) => {
      const n = name.toLowerCase();
      let s = 0;
      if (/edge[_\-.]?cuts?/.test(n)) s += 100;
      if (/board.?outline|outline|profile/.test(n)) s += 80;
      if (/\.gko$/.test(n)) s += 90;
      if (/\.gm1$|\.gml$|\.gm\d+$/.test(n)) s += 85;
      if (/\boutline\b/.test(n)) s += 40;
      if (/\.(gbr|gbl|gtl|gts|gbs|gto|gbo|drl|txt)$/.test(n)) s += 1;
      return s;
    };
    let best = null, bestScore = 0;
    for (const f of files) {
      const sc = score(f.name);
      if (sc > bestScore) { bestScore = sc; best = f; }
    }
    return bestScore > 0 ? best : null;
  }

  /* ---------------- Gerber parser ---------------- */
  function parse(text) {
    let fmtInt = 3, fmtDec = 6, zeroOmit = 'L'; // leading omitted (default)
    let unitScale = 1; // to mm
    let cur = { x: 0, y: 0 };
    let mode = 'G01';   // interpolation
    let multiQuad = true;
    let pen = false;
    let inRegion = false;
    const paths = [];   // {pts:[{x,y}], closed:bool}
    let path = null;
    let region = null;

    const parseCoord = (s) => {
      let sign = 1;
      if (s[0] === '+') s = s.slice(1);
      else if (s[0] === '-') { sign = -1; s = s.slice(1); }
      const total = fmtInt + fmtDec;
      if (zeroOmit === 'T') s = (s + '0'.repeat(total)).slice(0, total); // trailing omitted -> pad right
      const val = parseInt(s, 10) || 0;
      return sign * val / Math.pow(10, fmtDec) * unitScale;
    };

    const startPath = () => { path = { pts: [{ x: cur.x, y: cur.y }], closed: false }; };
    const flushPath = () => { if (path && path.pts.length > 1) paths.push(path); path = null; };

    // Tessellate an arc from cur to (nx,ny) with center offset (i,j)
    const addArc = (nx, ny, i, j, cw, target) => {
      const cx = cur.x + i, cy = cur.y + j;
      const r = Math.hypot(cur.x - cx, cur.y - cy);
      let a0 = Math.atan2(cur.y - cy, cur.x - cx);
      let a1 = Math.atan2(ny - cy, nx - cx);
      if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI; }
      else { if (a1 <= a0) a1 += 2 * Math.PI; }
      const span = Math.abs(a1 - a0);
      const steps = Math.max(2, Math.ceil(span / (Math.PI / 90))); // ~2°
      for (let k = 1; k <= steps; k++) {
        const a = a0 + (a1 - a0) * (k / steps);
        target.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
    };

    // Split the stream into blocks. Extended commands are wrapped in %...%.
    const blocks = text.replace(/\r/g, '').split('*');
    for (let raw of blocks) {
      let b = raw.trim();
      if (!b) continue;

      // Extended (parameter) commands
      if (b[0] === '%') b = b.replace(/%/g, '').trim();
      if (b.startsWith('FS')) {
        zeroOmit = b.includes('FST') ? 'T' : 'L';
        const m = b.match(/X(\d)(\d)/);
        if (m) { fmtInt = +m[1]; fmtDec = +m[2]; }
        continue;
      }
      if (b.startsWith('MO')) { unitScale = b.includes('IN') ? 25.4 : 1; continue; }
      if (b.startsWith('AD') || b.startsWith('AM') || b.startsWith('LP') ||
          b.startsWith('LN') || b.startsWith('TF') || b.startsWith('TA') ||
          b.startsWith('TO') || b.startsWith('TD') || b.startsWith('SR') ||
          b.startsWith('IP') || b.startsWith('AS') || b.startsWith('IR') ||
          b.startsWith('MI') || b.startsWith('OF') || b.startsWith('SF')) continue;
      if (b.startsWith('G04')) continue; // comment

      // function/coordinate codes (may be combined, e.g. G01X..Y..D01)
      if (/G36/.test(b)) { inRegion = true; region = null; }
      if (/G37/.test(b)) { if (region && region.pts.length > 2) { region.closed = true; paths.push(region); } region = null; inRegion = false; continue; }
      if (/G74/.test(b)) multiQuad = false;
      if (/G75/.test(b)) multiQuad = true;
      if (/G01/.test(b)) mode = 'G01';
      if (/G02/.test(b)) mode = 'G02';
      if (/G03/.test(b)) mode = 'G03';

      const mx = b.match(/X([+-]?\d+)/);
      const my = b.match(/Y([+-]?\d+)/);
      const mi = b.match(/I([+-]?\d+)/);
      const mj = b.match(/J([+-]?\d+)/);
      const md = b.match(/D(\d+)/);
      if (!mx && !my && !md) continue;

      const nx = mx ? parseCoord(mx[1]) : cur.x;
      const ny = my ? parseCoord(my[1]) : cur.y;
      const dcode = md ? +md[1] : null;

      if (dcode === 2 || (!inRegion && dcode === null && (mx || my))) {
        // move (pen up) -> break stroke
        flushPath();
      }

      if (inRegion) {
        if (dcode === 2 || region === null) {
          if (region && region.pts.length > 2) { region.closed = true; paths.push(region); }
          region = { pts: [{ x: nx, y: ny }], closed: false };
        } else if (dcode === 1) {
          if (mode === 'G01') region.pts.push({ x: nx, y: ny });
          else addArc(nx, ny, mi ? parseCoord(mi[1]) : 0, mj ? parseCoord(mj[1]) : 0, mode === 'G02', region.pts);
        }
      } else if (dcode === 1) {
        if (!path) startPath();
        if (mode === 'G01') path.pts.push({ x: nx, y: ny });
        else addArc(nx, ny, mi ? parseCoord(mi[1]) : 0, mj ? parseCoord(mj[1]) : 0, mode === 'G02', path.pts);
      }

      cur = { x: nx, y: ny };
      if (/M02|M00/.test(b)) break;
    }
    flushPath();

    if (!paths.length) return null;

    // mark stroked paths whose ends coincide as closed (fillable)
    for (const p of paths) {
      if (p.closed || p.pts.length < 3) continue;
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 0.02) { p.closed = true; p.pts.pop(); }
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of paths) for (const pt of p.pts) {
      minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
    }
    return { paths, bounds: { minX, minY, maxX, maxY } };
  }

  /* High-level: from a single file's text, or list of files (from zip),
   * return outline geometry or null. */
  function outlineFromFiles(files) {
    const f = pickOutline(files);
    if (!f) return null;
    const geo = parse(f.text);
    if (geo) geo.source = f.name;
    return geo;
  }

  /* ---------------- Aperture macros (AM) ---------------- */
  // Capture %AM<name>* <primitive>* ... %  definitions from the raw text.
  function parseMacros(text) {
    const macros = {};
    const re = /%AM([^*\s]+)\*([\s\S]*?)%/g;
    let m;
    while ((m = re.exec(text))) {
      const body = m[2].split('*').map(s => s.trim()).filter(Boolean);
      macros[m[1].trim()] = body;
    }
    return macros;
  }

  function evalExpr(s, params) {
    if (s == null) return 0;
    s = String(s).replace(/\$(\d+)/g, (_, n) => '(' + (params[+n - 1] != null ? params[+n - 1] : 0) + ')');
    s = s.replace(/[xX]/g, '*');
    if (/^[-+]?\d*\.?\d+$/.test(s.trim())) return parseFloat(s);
    if (!/^[-+*/().\se0-9]*$/i.test(s)) return parseFloat(s) || 0;
    try { return Function('"use strict";return (' + s + ');')() || 0; } catch (e) { return 0; }
  }

  function rotPts(pts, deg) {
    if (!deg) return pts;
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return pts.map(p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
  }
  function circlePts(cx, cy, r, n) {
    const out = []; n = n || 24;
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    return out;
  }

  // Evaluate a macro body with call params -> array of contours (exposed only).
  function evalMacro(body, callParams) {
    const params = callParams.slice();
    const contours = [];
    for (const line of body) {
      if (line[0] === '0') continue; // comment
      const eqm = line.match(/^\$(\d+)\s*=\s*(.+)$/);
      if (eqm) { params[+eqm[1] - 1] = evalExpr(eqm[2], params); continue; }
      const t = line.split(',');
      const code = parseInt(t[0], 10);
      const v = (i) => evalExpr(t[i], params);
      if (code === 1) { // circle: exp, dia, cx, cy[, rot]
        if (v(1) === 0) continue;
        let pts = circlePts(v(2), v(3), v(1) / 2, 24);
        contours.push(rotPts(pts, t[5] != null ? v(5) : 0));
      } else if (code === 4) { // outline: exp, n, x0,y0,...,xn,yn, rot
        if (v(1) === 0) continue;
        const n = Math.round(v(2)); const pts = [];
        for (let i = 0; i <= n; i++) pts.push({ x: v(3 + i * 2), y: v(4 + i * 2) });
        contours.push(rotPts(pts, v(3 + (n + 1) * 2)));
      } else if (code === 5) { // regular polygon: exp, nverts, cx, cy, dia, rot
        if (v(1) === 0) continue;
        const nv = Math.round(v(2)), r = v(5) / 2, rot = v(6) || 0, pts = [];
        for (let i = 0; i < nv; i++) { const a = rot * Math.PI / 180 + i / nv * Math.PI * 2; pts.push({ x: v(3) + r * Math.cos(a), y: v(4) + r * Math.sin(a) }); }
        contours.push(pts);
      } else if (code === 20 || code === 2) { // vector line: exp, width, x1,y1,x2,y2, rot
        if (v(1) === 0) continue;
        const w = v(2) / 2, x1 = v(3), y1 = v(4), x2 = v(5), y2 = v(6), rot = v(7) || 0;
        const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len * w, ny = dx / len * w;
        contours.push(rotPts([{ x: x1 + nx, y: y1 + ny }, { x: x2 + nx, y: y2 + ny }, { x: x2 - nx, y: y2 - ny }, { x: x1 - nx, y: y1 - ny }], rot));
      } else if (code === 21) { // center line (rect): exp, w, h, cx, cy, rot
        if (v(1) === 0) continue;
        const w = v(2) / 2, h = v(3) / 2, cx = v(4), cy = v(5), rot = v(6) || 0;
        contours.push(rotPts([{ x: cx - w, y: cy - h }, { x: cx + w, y: cy - h }, { x: cx + w, y: cy + h }, { x: cx - w, y: cy + h }], rot));
      }
      // codes 6 (moiré) / 7 (thermal) intentionally skipped
    }
    return contours;
  }

  /* ---------------- Pad layer parser (copper / paste) ---------------- */
  function resolveAperture(template, paramStr, macros) {
    const p = paramStr ? paramStr.split('X').map(s => parseFloat(s)) : [];
    switch ((template || '').toUpperCase()) {
      case 'C': return { kind: 'circle', d: p[0] || 0.5 };
      case 'R': return { kind: 'rect', w: p[0] || 0.5, h: p[1] || p[0] || 0.5 };
      case 'O': return { kind: 'obround', w: p[0] || 0.5, h: p[1] || p[0] || 0.5 };
      case 'P': return { kind: 'poly', d: p[0] || 0.5, n: Math.round(p[1] || 3), rot: p[2] || 0 };
      default:
        if (macros && macros[template]) {
          const contours = evalMacro(macros[template], p);
          if (contours.length) return { kind: 'macro', contours };
        }
        return { kind: 'circle', d: p[0] || 1 }; // unknown -> approx
    }
  }

  function parseLayer(text) {
    let fmtInt = 3, fmtDec = 6, zeroOmit = 'L', unitScale = 1;
    let cur = { x: 0, y: 0 }, mode = 'G01', inRegion = false, curAp = null;
    const macros = parseMacros(text);
    const apertures = {};
    const pads = [];      // {x,y,kind,...}
    const regions = [];   // {pts}
    let region = null;

    const parseCoord = (s) => {
      let sign = 1;
      if (s[0] === '+') s = s.slice(1); else if (s[0] === '-') { sign = -1; s = s.slice(1); }
      const total = fmtInt + fmtDec;
      if (zeroOmit === 'T') s = (s + '0'.repeat(total)).slice(0, total);
      return sign * (parseInt(s, 10) || 0) / Math.pow(10, fmtDec) * unitScale;
    };
    const addArc = (nx, ny, i, j, cw, target) => {
      const cx = cur.x + i, cy = cur.y + j;
      const r = Math.hypot(cur.x - cx, cur.y - cy);
      let a0 = Math.atan2(cur.y - cy, cur.x - cx), a1 = Math.atan2(ny - cy, nx - cx);
      if (cw) { if (a1 >= a0) a1 -= 2 * Math.PI; } else { if (a1 <= a0) a1 += 2 * Math.PI; }
      const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 90)));
      for (let k = 1; k <= steps; k++) { const a = a0 + (a1 - a0) * (k / steps); target.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    };

    for (let raw of text.replace(/\r/g, '').split('*')) {
      let b = raw.trim(); if (!b) continue;
      if (b[0] === '%') b = b.replace(/%/g, '').trim();
      if (b.startsWith('FS')) { zeroOmit = b.includes('FST') ? 'T' : 'L'; const m = b.match(/X(\d)(\d)/); if (m) { fmtInt = +m[1]; fmtDec = +m[2]; } continue; }
      if (b.startsWith('MO')) { unitScale = b.includes('IN') ? 25.4 : 1; continue; }
      if (b.startsWith('ADD')) {
        const m = b.match(/^ADD(\d+)([A-Za-z_$][\w$.\-]*)?(?:,(.*))?$/);
        if (m) apertures[+m[1]] = resolveAperture(m[2], m[3], macros);
        continue;
      }
      if (/^(AM|AB|LP|LN|LM|LR|LS|TF|TA|TO|TD|SR|IP|AS|IR|MI|OF|SF|MO)/.test(b)) continue;
      if (b.startsWith('G04')) continue;

      if (/G36/.test(b)) { inRegion = true; region = null; }
      if (/G37/.test(b)) { if (region && region.pts.length > 2) regions.push(region); region = null; inRegion = false; continue; }
      if (/G01/.test(b)) mode = 'G01';
      if (/G02/.test(b)) mode = 'G02';
      if (/G03/.test(b)) mode = 'G03';

      const md = b.match(/D(\d+)/);
      if (md) { const d = +md[1]; if (d >= 10) { curAp = d; if (!/[XY]/.test(b)) continue; } }

      const mx = b.match(/X([+-]?\d+)/), my = b.match(/Y([+-]?\d+)/);
      const mi = b.match(/I([+-]?\d+)/), mj = b.match(/J([+-]?\d+)/);
      if (!mx && !my && !md) continue;
      const nx = mx ? parseCoord(mx[1]) : cur.x, ny = my ? parseCoord(my[1]) : cur.y;
      const op = md ? +md[1] : null;

      if (inRegion) {
        if (op === 2 || region === null) { if (region && region.pts.length > 2) regions.push(region); region = { pts: [{ x: nx, y: ny }] }; }
        else if (op === 1) { if (mode === 'G01') region.pts.push({ x: nx, y: ny }); else addArc(nx, ny, mi ? parseCoord(mi[1]) : 0, mj ? parseCoord(mj[1]) : 0, mode === 'G02', region.pts); }
      } else if (op === 3) {
        const ap = apertures[curAp];
        if (ap) pads.push(Object.assign({ x: nx, y: ny }, ap));
      }
      cur = { x: nx, y: ny };
      if (/M02|M00/.test(b)) break;
    }
    if (region && region.pts.length > 2) regions.push(region);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const ext = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
    for (const p of pads) {
      if (p.kind === 'macro') { for (const ct of p.contours) for (const pt of ct) ext(p.x + pt.x, p.y + pt.y); }
      else { const r = (p.d || Math.max(p.w || 0, p.h || 0)) / 2; ext(p.x - r, p.y - r); ext(p.x + r, p.y + r); }
    }
    for (const rg of regions) for (const pt of rg.pts) ext(pt.x, pt.y);
    return { pads, regions, bounds: { minX, minY, maxX, maxY } };
  }

  /* ---------------- Excellon drill parser ---------------- */
  function parseExcellon(text) {
    let units = 'mm', dec = 3, integerMode = false;
    const tools = {}; let curTool = null;
    const holes = [];
    let cx = 0, cy = 0;
    const lines = text.replace(/\r/g, '').split('\n');
    // format hints
    if (/INCH/i.test(text)) { units = 'in'; dec = 4; }
    if (/METRIC/i.test(text)) { units = 'mm'; dec = 3; }

    const coord = (s) => {
      if (s == null) return null;
      if (s.includes('.')) return parseFloat(s) * (units === 'in' ? 25.4 : 1);
      const sign = s[0] === '-' ? -1 : 1; s = s.replace(/^[+-]/, '');
      return sign * (parseInt(s, 10) || 0) / Math.pow(10, dec) * (units === 'in' ? 25.4 : 1);
    };

    for (let ln of lines) {
      ln = ln.trim(); if (!ln || ln[0] === ';') continue;
      let m = ln.match(/^T(\d+)C([\d.]+)/i);
      if (m) { tools[m[1]] = parseFloat(m[2]) * (units === 'in' ? 25.4 : 1); continue; }
      m = ln.match(/^T(\d+)\s*$/i);
      if (m) { curTool = m[1]; continue; }
      const mx = ln.match(/X([+-]?[\d.]+)/i), my = ln.match(/Y([+-]?[\d.]+)/i);
      if (mx || my) {
        if (mx) cx = coord(mx[1]); if (my) cy = coord(my[1]);
        const d = curTool && tools[curTool] ? tools[curTool] : 0.3;
        holes.push({ x: cx, y: cy, d });
      }
    }
    if (!holes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const h of holes) { const r = h.d / 2; minX = Math.min(minX, h.x - r); maxX = Math.max(maxX, h.x + r); minY = Math.min(minY, h.y - r); maxY = Math.max(maxY, h.y + r); }
    return { holes, bounds: { minX, minY, maxX, maxY } };
  }

  function pickLayers(files) {
    const find = (re) => files.find(f => re.test(f.name.toLowerCase()));
    return {
      outlineF: pickOutline(files),
      pasteTop: find(/(^|[^a-z])f[_.\- ]?paste|top.?paste|paste.?top|\.gtp$/),
      pasteBot: find(/(^|[^a-z])b[_.\- ]?paste|bot.?paste|paste.?bot|\.gbp$/),
      copperTop: find(/(^|[^a-z])f[_.\- ]?cu|top.?copper|copper.?top|\.gtl$/),
      copperBot: find(/(^|[^a-z])b[_.\- ]?cu|bot.?copper|copper.?bot|\.gbl$/),
      silkTop: find(/(^|[^a-z])f[_.\- ]?silk|top.?silk|silk.?top|\.gto$/),
      silkBot: find(/(^|[^a-z])b[_.\- ]?silk|bot.?silk|silk.?bot|\.gbo$/),
      drill: find(/\.drl$|\.xln$|\.nc$|drill|\.tap$/),
    };
  }

  /* High-level: outline + pads + silk + drill from a set of gerber files. */
  function layersFromFiles(files) {
    const L = pickLayers(files);
    const outline = L.outlineF ? Object.assign(parse(L.outlineF.text) || {}, { source: L.outlineF.name }) : null;
    const padSide = (pasteF, copperF) => {
      const f = pasteF || copperF;
      if (!f) return null;
      const g = parseLayer(f.text);
      g.source = f.name; g.isPaste = !!pasteF;
      return g;
    };
    const silkSide = (f) => { if (!f) return null; const g = parse(f.text); if (g) g.source = f.name; return g; };
    return {
      outline: (outline && outline.paths) ? outline : null,
      pads: { top: padSide(L.pasteTop, L.copperTop), bottom: padSide(L.pasteBot, L.copperBot) },
      silk: { top: silkSide(L.silkTop), bottom: silkSide(L.silkBot) },
      drill: L.drill ? parseExcellon(L.drill.text) : null,
    };
  }

  global.Gerber = { unzip, parse, parseLayer, parseExcellon, pickOutline, pickLayers, outlineFromFiles, layersFromFiles };
})(window);
