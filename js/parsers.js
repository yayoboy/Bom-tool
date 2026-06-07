/* Parses JLCPCB / KiCad BOM and Pick&Place (CPL) CSV files into a
 * normalized form, tolerating the various column names each tool emits.
 */
(function (global) {
  // Find the first record key that matches one of the candidate regexes.
  function findKey(headers, candidates) {
    for (const re of candidates) {
      const hit = headers.find(h => re.test(h.trim()));
      if (hit) return hit;
    }
    return null;
  }

  function splitDesignators(str) {
    if (!str) return [];
    return str.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }

  function parseNumber(v) {
    if (v == null) return NaN;
    const m = String(v).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }

  function normLayer(v) {
    const s = String(v || '').toLowerCase();
    if (/bot|^b$|back/.test(s)) return 'bottom';
    return 'top';
  }

  function parseBOM(text) {
    const { headers, records } = CSV.parseObjects(text);
    if (!headers.length) throw new Error('BOM vuoto o illeggibile.');

    const kComment = findKey(headers, [/^comment$/i, /^value$/i, /^val$/i, /description/i, /^name$/i]);
    const kDesig = findKey(headers, [/designator/i, /^ref(?:erence)?s?$/i, /^part$/i]);
    const kFoot = findKey(headers, [/footprint/i, /package/i, /^pattern$/i]);
    const kLcsc = findKey(headers, [/lcsc/i, /jlcpcb\s*part/i, /supplier\s*part/i, /^mpn$/i, /manufacturer\s*part/i]);
    const kQty = findKey(headers, [/quantity/i, /^qty$/i]);
    const kPop = findKey(headers, [/^dnp$/i, /populate/i, /^mount$/i, /fitted/i, /assembly/i, /^place$/i]);

    if (!kDesig) throw new Error('Colonna "Designator" non trovata nel BOM. Intestazioni: ' + headers.join(', '));

    const rows = [];
    for (const rec of records) {
      const designators = splitDesignators(rec[kDesig]);
      if (!designators.length) continue;
      let dnp = false;
      if (kPop) {
        const v = (rec[kPop] || '').toLowerCase();
        // column may mean "populate" (no=DNP) or "DNP" (yes=DNP)
        if (/dnp/i.test(kPop) || /assembly/i.test(kPop)) dnp = /^(y|yes|true|1|dnp)$/.test(v);
        else dnp = /^(n|no|false|0|dnp|do.?not)/.test(v);
      }
      rows.push({
        comment: kComment ? rec[kComment] : '',
        footprint: kFoot ? rec[kFoot] : '',
        lcsc: kLcsc ? rec[kLcsc] : '',
        qty: kQty ? (parseInt(rec[kQty], 10) || designators.length) : designators.length,
        designators, dnp,
      });
    }
    if (!rows.length) throw new Error('Nessuna riga valida nel BOM.');
    return rows;
  }

  function parseCPL(text) {
    const { headers, records } = CSV.parseObjects(text);
    if (!headers.length) throw new Error('File CPL vuoto o illeggibile.');

    const kRef = findKey(headers, [/designator/i, /^ref(?:erence)?$/i, /^part$/i]);
    const kX = findKey(headers, [/mid\s*x/i, /^pos\s*x/i, /^x$/i, /center-?x/i, /ref-?x/i]);
    const kY = findKey(headers, [/mid\s*y/i, /^pos\s*y/i, /^y$/i, /center-?y/i, /ref-?y/i]);
    const kRot = findKey(headers, [/rotation/i, /^rot$/i, /angle/i]);
    const kLayer = findKey(headers, [/layer/i, /^side$/i]);

    if (!kRef) throw new Error('Colonna "Designator" non trovata nel CPL. Intestazioni: ' + headers.join(', '));
    if (!kX || !kY) throw new Error('Colonne X/Y non trovate nel CPL. Intestazioni: ' + headers.join(', '));

    const map = {};
    for (const rec of records) {
      const ref = (rec[kRef] || '').trim();
      if (!ref) continue;
      const x = parseNumber(rec[kX]);
      const y = parseNumber(rec[kY]);
      if (isNaN(x) || isNaN(y)) continue;
      map[ref] = {
        x, y,
        rot: kRot ? (parseNumber(rec[kRot]) || 0) : 0,
        layer: kLayer ? normLayer(rec[kLayer]) : 'top',
      };
    }
    if (!Object.keys(map).length) throw new Error('Nessuna posizione valida nel CPL.');
    return map;
  }

  global.Parsers = { parseBOM, parseCPL };
})(window);
