/* Builds the combined data model (groups + components) by joining the BOM
 * rows with CPL positions, and renders the BOM table.
 */
(function (global) {
  function buildModel(bomRows, cplMap) {
    const groups = [];
    const components = [];
    let missing = 0;

    bomRows.forEach((row, idx) => {
      const [w, h] = Footprints.lookup(row.footprint);
      const groupComps = [];
      const layers = new Set();
      const dnp = !!row.dnp;

      for (const ref of row.designators) {
        const pos = cplMap[ref];
        const comp = {
          ref, groupId: idx,
          comment: row.comment, footprint: row.footprint, lcsc: row.lcsc,
          w, h, done: false, dnp,
          x: pos ? pos.x : null, y: pos ? pos.y : null,
          rot: pos ? pos.rot : 0,
          layer: pos ? pos.layer : 'top',
          hasPos: !!pos,
        };
        if (!pos) missing++; else layers.add(pos.layer);
        components.push(comp);
        groupComps.push(comp);
      }

      groups.push({
        id: idx,
        comment: row.comment, footprint: row.footprint, lcsc: row.lcsc,
        qty: row.designators.length,
        designators: row.designators,
        layer: layers.size === 0 ? 'top' : layers.size > 1 ? 'mixed' : [...layers][0],
        comps: groupComps,
        done: false, dnp,
      });
    });

    // Only components with positions are drawable
    const drawable = components.filter(c => c.hasPos);
    return { groups, components, drawable, missing };
  }

  function lcscLink(lcsc) {
    if (!lcsc) return '';
    const m = String(lcsc).match(/C\d{3,}/i);
    if (!m) return escapeHtml(lcsc);
    const id = m[0].toUpperCase();
    return `<a href="https://www.lcsc.com/search?q=${id}" target="_blank" rel="noopener">${id}</a>`;
  }

  function layerSwatch(layer) {
    const color = layer === 'bottom' ? '#5bc0de' : layer === 'mixed' ? '#a371f7' : '#d9534f';
    return `<span class="swatch" style="background:${color}" title="${layer}"></span>`;
  }

  /* Render rows into tbody. `filter` is a Set of visible groupIds (or null). */
  function renderTable(tbody, groups, selectedId, filterIds) {
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const g of groups) {
      if (filterIds && !filterIds.has(g.id)) continue;
      n++;
      const tr = document.createElement('tr');
      tr.dataset.gid = g.id;
      if (g.id === selectedId) tr.classList.add('selected');
      if (g.done) tr.classList.add('done');
      if (g.dnp) tr.classList.add('dnp');
      const dnpBadge = g.dnp ? ' <span class="badge-dnp">DNP</span>' : '';
      tr.innerHTML =
        `<td class="col-check"><input type="checkbox" ${g.done ? 'checked' : ''} ${g.dnp ? 'disabled' : ''} data-check="${g.id}"></td>` +
        `<td class="col-num">${n}</td>` +
        `<td class="col-qty">${g.qty}</td>` +
        `<td class="col-value">${layerSwatch(g.layer)}${escapeHtml(g.comment || '(senza valore)')}${dnpBadge}</td>` +
        `<td>${escapeHtml(g.footprint || '')}</td>` +
        `<td class="designators">${g.designators.map(escapeHtml).join(', ')}</td>` +
        `<td class="lcsc">${lcscLink(g.lcsc)}</td>`;
      frag.appendChild(tr);
    }
    tbody.innerHTML = '';
    tbody.appendChild(frag);
    return n;
  }

  global.BOM = { buildModel, renderTable };
})(window);
