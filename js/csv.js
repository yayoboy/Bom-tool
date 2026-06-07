/* Minimal but robust CSV/TSV parser.
 * Handles quoted fields, embedded commas/newlines, escaped quotes ("").
 * Auto-detects delimiter (comma / semicolon / tab) from the header line.
 */
(function (global) {
  function detectDelimiter(text) {
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let inQuotes = false;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && counts.hasOwnProperty(ch)) counts[ch]++;
    }
    let best = ',', bestN = -1;
    for (const d in counts) if (counts[d] > bestN) { bestN = counts[d]; best = d; }
    return best;
  }

  function parse(text, delimiter) {
    // Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const delim = delimiter || detectDelimiter(text);
    const rows = [];
    let field = '', row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === delim) { row.push(field); field = ''; }
        else if (c === '\r') { /* ignore */ }
        else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
        else field += c;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
  }

  /* Parse into array of objects keyed by header. Headers are trimmed. */
  function parseObjects(text) {
    const rows = parse(text);
    if (!rows.length) return { headers: [], records: [] };
    const headers = rows[0].map(h => h.trim());
    const records = [];
    for (let r = 1; r < rows.length; r++) {
      const obj = {};
      for (let c = 0; c < headers.length; c++) obj[headers[c]] = (rows[r][c] ?? '').trim();
      records.push(obj);
    }
    return { headers, records };
  }

  global.CSV = { parse, parseObjects, detectDelimiter };
})(window);
