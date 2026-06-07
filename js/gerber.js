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
      if (b[0] === '%') b = b.replace(/%/g, '');
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

  global.Gerber = { unzip, parse, pickOutline, outlineFromFiles };
})(window);
