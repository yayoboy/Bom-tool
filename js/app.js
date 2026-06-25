/* Main controller: file loading, model building, UI wiring, persistence. */
(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    bomText: null, cplText: null,
    bomName: '', cplName: '',
    gerberFiles: null, gerberName: '', outline: null, pads: null, silk: null, drill: null,
    kicad: null, kicadName: '',
    model: null,
    selectedId: null,
    filterIds: null,
    layer: 'top',
    hideDNP: false,
    view: '2d',
    sig: null,
  };

  let renderer = null;
  let iso = null;

  /* ---------- File loading ---------- */
  function readFile(file, cb) {
    const r = new FileReader();
    r.onload = () => cb(r.result);
    r.onerror = () => showLoaderError('Errore di lettura del file: ' + file.name);
    r.readAsText(file);
  }

  function setBomFile(file) {
    readFile(file, (txt) => {
      state.bomText = txt; state.bomName = file.name;
      $('bomStatus').textContent = file.name;
      $('slotBom').classList.add('loaded');
      updateGenerateBtn();
    });
  }
  function setCplFile(file) {
    readFile(file, (txt) => {
      state.cplText = txt; state.cplName = file.name;
      $('cplStatus').textContent = file.name;
      $('slotCpl').classList.add('loaded');
      updateGenerateBtn();
    });
  }

  async function setGerberFile(file) {
    showLoaderError('');
    state.gerberName = file.name;
    $('gerberStatus').textContent = 'Lettura…';
    try {
      let files;
      if (/\.zip$/i.test(file.name)) {
        const buf = await file.arrayBuffer();
        files = await Gerber.unzip(buf);
      } else {
        files = [{ name: file.name, text: await file.text() }];
      }
      state.gerberFiles = files;
      const layers = Gerber.layersFromFiles(files);
      state.outline = layers.outline;
      state.pads = layers.pads;
      state.silk = layers.silk;
      state.drill = layers.drill;
      const padCount = (layers.pads.top ? layers.pads.top.pads.length : 0) + (layers.pads.bottom ? layers.pads.bottom.pads.length : 0);
      if (layers.outline || padCount) {
        const bits = [];
        if (layers.outline) bits.push('contorno');
        if (padCount) bits.push(padCount + ' piazzole');
        if (layers.silk && (layers.silk.top || layers.silk.bottom)) bits.push('serigrafia');
        if (layers.drill) bits.push(layers.drill.holes.length + ' fori');
        $('gerberStatus').textContent = '✓ ' + bits.join(' · ');
        $('slotGerber').classList.add('loaded');
      } else {
        $('gerberStatus').textContent = '⚠ nessun layer riconosciuto';
      }
    } catch (e) {
      console.error(e);
      $('gerberStatus').textContent = '⚠ errore lettura';
      showLoaderError('Gerber: ' + (e.message || e));
    }
  }

  async function setKicadFile(file) {
    showLoaderError('');
    state.kicadName = file.name;
    $('kicadStatus').textContent = 'Lettura…';
    try {
      const r = KiCad.parse(await file.text());
      state.kicad = { bomRows: r.bomRows, cplMap: r.cplMap };
      state.outline = r.outline;
      state.pads = r.pads;
      state.silk = r.silk;
      state.drill = r.drill;
      const padN = (r.pads.top ? r.pads.top.pads.length : 0) + (r.pads.bottom ? r.pads.bottom.pads.length : 0);
      const extra = (r.stats.dnp ? ` · ${r.stats.dnp} DNP` : '') + (r.drill ? ` · ${r.drill.holes.length} fori` : '');
      $('kicadStatus').textContent = `✓ ${r.stats.footprints} footprint · ${r.bomRows.length} gruppi · ${padN} piazzole${extra}`;
      $('slotKicad').classList.add('loaded');
      updateGenerateBtn();
    } catch (e) {
      console.error(e);
      $('kicadStatus').textContent = '⚠ ' + (e.message || 'errore');
      showLoaderError('KiCad: ' + (e.message || e));
    }
  }

  // Heuristic: which slot does a dropped file belong to?
  function classifyAndAssign(file) {
    const name = file.name.toLowerCase();
    if (/\.kicad_pcb$/.test(name)) return setKicadFile(file);
    if (/\.zip$|\.gko$|\.gm\d|\.gml$|gerber|edge|outline/.test(name)) return setGerberFile(file);
    if (/cpl|pick|place|pos|placement|position/.test(name)) return setCplFile(file);
    if (/bom/.test(name)) return setBomFile(file);
    // fallback: fill empty slot, bom first
    if (!state.bomText) return setBomFile(file);
    if (!state.cplText) return setCplFile(file);
    return setGerberFile(file);
  }

  function updateGenerateBtn() {
    $('generateBtn').disabled = !((state.bomText && state.cplText) || state.kicad);
  }
  function showLoaderError(msg) { $('loaderError').textContent = msg || ''; }

  /* ---------- Build & show ---------- */
  function generate() {
    showLoaderError('');
    try {
      let bomRows, cplMap;
      if (state.kicad) {
        bomRows = state.kicad.bomRows; cplMap = state.kicad.cplMap;
        if (!state.bomName) state.bomName = state.kicadName;
      } else {
        bomRows = Parsers.parseBOM(state.bomText);
        cplMap = Parsers.parseCPL(state.cplText);
      }
      const model = BOM.buildModel(bomRows, cplMap);
      state.model = model;
      state.sig = signature(model);
      loadProgress();

      $('loader').classList.add('hidden');
      $('app').classList.remove('hidden');
      $('projectName').textContent = state.bomName ? state.bomName.replace(/\.[^.]+$/, '') : '';

      if (!renderer) {
        renderer = new Renderer($('board'), $('tooltip'));
        renderer.onClick = (c) => selectGroup(c.groupId, true);
        renderer.onHover = (c) => { /* reserved */ };
        window.addEventListener('resize', () => { renderer.resize(); if (state.view === 'iso') iso.render(); });
      }
      if (!iso) {
        iso = new IsoView($('isoView'));
        iso.onClick = (gid) => selectGroup(gid, true);
      }
      associatePads(state.pads, model.drawable);

      renderer.setComponents(model.drawable);
      renderer.setOutline(state.outline);
      renderer.setPads(state.pads);
      renderer.setSilk(state.silk);
      renderer.setDrill(state.drill);
      iso.setComponents(model.drawable);
      iso.setOutline(state.outline);
      iso.setPads(state.pads);
      iso.setSilk(state.silk);
      iso.setDrill(state.drill);
      iso.setLayer(state.layer);
      iso.setExplode(parseFloat($('explodeRange').value));

      renderer.resize();
      renderer.setLayer(state.layer);

      applyFilter();
      refreshTable();
      updateProgress();
      updateCanvasInfo();
    } catch (e) {
      showLoaderError(e.message || String(e));
      console.error(e);
    }
  }

  // Link Gerber pads (which carry no designator) to the nearest component.
  // KiCad pads already have .ref, so we only fill in the missing ones.
  function associatePads(pads, comps) {
    if (!pads) return;
    for (const layer of ['top', 'bottom']) {
      const L = pads[layer];
      if (!L || !L.pads.length) continue;
      if (L.pads[0] && L.pads[0].ref) continue; // already linked (KiCad)
      const cs = comps.filter(c => c.layer === layer);
      if (!cs.length || cs.length * L.pads.length > 4e6) continue;
      for (const pad of L.pads) {
        let best = null, bestD = Infinity;
        for (const c of cs) {
          const dx = pad.x - c.x, dy = pad.y - c.y;
          const a = -(c.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
          const lx = Math.abs(dx * ca - dy * sa), ly = Math.abs(dx * sa + dy * ca);
          const inside = lx <= c.w / 2 + 0.4 && ly <= c.h / 2 + 0.4;
          const d = dx * dx + dy * dy;
          if (inside && d < bestD) { bestD = d; best = c; }
        }
        if (best) pad.ref = best.ref;
      }
    }
  }

  function updateCanvasInfo() {
    const m = state.model;
    let txt = `${m.components.length} componenti · ${m.groups.length} gruppi`;
    const dnpN = m.groups.filter(g => g.dnp).length;
    if (dnpN) txt += ` · ${dnpN} DNP`;
    if (state.outline) txt += ' · contorno';
    if (state.drill) txt += ` · ${state.drill.holes.length} fori`;
    if (m.missing) txt += ` · ⚠ ${m.missing} senza posizione (assenti nel CPL)`;
    $('canvasInfo').textContent = txt;
  }

  /* ---------- Selection ---------- */
  function selectGroup(id, scrollIntoView) {
    state.selectedId = (state.selectedId === id) ? null : id;
    let refs = null;
    if (state.selectedId != null) {
      const g = state.model.groups.find(x => x.id === state.selectedId);
      if (g) refs = new Set(g.designators);
    }
    renderer.setSelectedRefs(refs);
    iso.setSelectedRefs(refs);
    renderer.setSelected(state.selectedId);
    iso.setSelected(state.selectedId);
    refreshTable();
    if (scrollIntoView && state.selectedId != null) {
      const row = document.querySelector(`tr[data-gid="${state.selectedId}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------- Filtering / search ---------- */
  function applyFilter() {
    const q = $('searchInput').value.trim().toLowerCase();
    const constrained = q || state.hideDNP;
    if (!constrained) { state.filterIds = null; renderer.setVisible(null); if (iso) iso.setVisible(null); return; }
    const ids = new Set();
    const refs = new Set();
    for (const g of state.model.groups) {
      if (state.hideDNP && g.dnp) continue;
      const hay = (g.comment + ' ' + g.footprint + ' ' + g.lcsc + ' ' + g.designators.join(' ')).toLowerCase();
      if (!q || hay.includes(q)) { ids.add(g.id); g.designators.forEach(r => refs.add(r)); }
    }
    state.filterIds = ids;
    renderer.setVisible(refs);
    if (iso) iso.setVisible(refs);
  }

  function refreshTable() {
    const n = BOM.renderTable($('bomBody'), state.model.groups, state.selectedId, state.filterIds);
  }

  /* ---------- Progress / persistence ---------- */
  function signature(model) {
    let s = model.groups.length + ':';
    for (const g of model.groups) s += g.comment + g.footprint + g.designators.join('') + ';';
    return 'ibom:' + hash(s);
  }
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function saveProgress() {
    const done = state.model.groups.filter(g => g.done).map(g => g.id);
    try { localStorage.setItem(state.sig, JSON.stringify(done)); } catch (e) {}
  }
  function loadProgress() {
    let done = [];
    try { done = JSON.parse(localStorage.getItem(state.sig) || '[]'); } catch (e) {}
    const set = new Set(done);
    for (const g of state.model.groups) {
      g.done = set.has(g.id);
      g.comps.forEach(c => c.done = g.done);
    }
  }
  function redrawViews() { renderer.draw(); if (iso) iso.render(); }

  function setDone(id, val) {
    const g = state.model.groups.find(x => x.id === id);
    if (!g) return;
    g.done = val; g.comps.forEach(c => c.done = val);
    saveProgress(); updateProgress(); refreshTable(); redrawViews();
  }
  function updateProgress() {
    const groups = state.model.groups.filter(g => !g.dnp); // DNP non si montano
    const total = groups.length;
    const done = groups.filter(g => g.done).length;
    $('progressFill').style.width = total ? (done / total * 100) + '%' : '0';
    $('progressText').textContent = `${done} / ${total}`;
    $('checkAll').checked = total > 0 && done === total;
  }

  /* ---------- Events ---------- */
  function wireLoader() {
    $('bomInput').addEventListener('change', e => e.target.files[0] && setBomFile(e.target.files[0]));
    $('cplInput').addEventListener('change', e => e.target.files[0] && setCplFile(e.target.files[0]));
    $('gerberInput').addEventListener('change', e => e.target.files[0] && setGerberFile(e.target.files[0]));
    $('kicadInput').addEventListener('change', e => e.target.files[0] && setKicadFile(e.target.files[0]));
    $('generateBtn').addEventListener('click', generate);
    $('sampleBtn').addEventListener('click', loadSample);
    $('loadBtn').addEventListener('click', () => {
      $('app').classList.add('hidden'); $('loader').classList.remove('hidden');
    });

    const dz = $('dropZone');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', e => {
      const files = [...(e.dataTransfer?.files || [])];
      files.forEach(classifyAndAssign);
    });
  }

  function wireApp() {
    $('searchInput').addEventListener('input', () => { applyFilter(); refreshTable(); });

    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.layer = btn.dataset.layer;
        renderer.setLayer(state.layer);
      });
    });

    $('bomBody').addEventListener('click', (e) => {
      const cb = e.target.closest('input[data-check]');
      if (cb) { setDone(parseInt(cb.dataset.check, 10), cb.checked); e.stopPropagation(); return; }
      const tr = e.target.closest('tr[data-gid]');
      if (tr) selectGroup(parseInt(tr.dataset.gid, 10), false);
    });

    $('checkAll').addEventListener('change', (e) => {
      const val = e.target.checked;
      for (const g of state.model.groups) { if (g.dnp) continue; g.done = val; g.comps.forEach(c => c.done = val); }
      saveProgress(); updateProgress(); refreshTable(); redrawViews();
    });

    $('resetProgressBtn').addEventListener('click', () => {
      if (!state.model) return;
      if (!confirm('Azzerare tutto l’avanzamento del montaggio?')) return;
      for (const g of state.model.groups) { g.done = false; g.comps.forEach(c => c.done = false); }
      saveProgress(); updateProgress(); refreshTable(); redrawViews();
    });

    // view toggle 2D / isometric
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setView(btn.dataset.view);
      });
    });

    $('explodeRange').addEventListener('input', e => { if (iso) iso.setExplode(parseFloat(e.target.value)); });
    $('exportSvgBtn').addEventListener('click', exportSvg);
    $('exportHtmlBtn').addEventListener('click', exportStandalone);
    $('stencilBtn').addEventListener('click', openStencil);
    $('stencilClose').addEventListener('click', closeStencil);
    $('stencilCancel').addEventListener('click', closeStencil);
    $('stencilModal').addEventListener('click', e => { if (e.target === $('stencilModal')) closeStencil(); });
    $('stStencilSide').addEventListener('change', e => {
      const both = e.target.value === 'both';
      $('stMirror').disabled = both;                       // in "both" il bottom è specchiato automaticamente
      $('stMirror').checked = both ? false : e.target.value === 'bottom';
      refreshStencilInfo();
    });
    $('stReduction').addEventListener('input', refreshStencilInfo);
    $('stMirror').addEventListener('change', refreshStencilInfo);
    $('stencilExport').addEventListener('click', exportStencil);
    $('showPads').addEventListener('change', e => { renderer.setShowPads(e.target.checked); if (iso) iso.setShowPads(e.target.checked); });
    $('showSilk').addEventListener('change', e => { renderer.setShowSilk(e.target.checked); if (iso) iso.setShowSilk(e.target.checked); });
    $('showDrill').addEventListener('change', e => { renderer.setShowDrill(e.target.checked); if (iso) iso.setShowDrill(e.target.checked); });
    $('showDNP').addEventListener('change', e => { state.hideDNP = !e.target.checked; applyFilter(); refreshTable(); redrawViews(); });

    $('zoomInBtn').addEventListener('click', () => (state.view === 'iso' ? iso.zoomBy(1.25) : renderer.zoomBy(1.25)));
    $('zoomOutBtn').addEventListener('click', () => (state.view === 'iso' ? iso.zoomBy(1 / 1.25) : renderer.zoomBy(1 / 1.25)));
    $('fitBtn').addEventListener('click', () => (state.view === 'iso' ? iso.fit() : renderer.fit()));
    $('showRefs').addEventListener('change', e => { renderer.setShowRefs(e.target.checked); if (iso) iso.setShowRefs(e.target.checked); });
  }

  function setView(v) {
    state.view = v;
    const isIso = v === 'iso';
    $('board').classList.toggle('hidden', isIso);
    $('isoView').classList.toggle('hidden', !isIso);
    document.querySelectorAll('.iso-only').forEach(el => el.classList.toggle('hidden', !isIso));
    if (isIso) iso.render(true);
    else renderer.resize();
  }

  function download(content, name, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportSvg() {
    if (!iso) return;
    const base = state.bomName ? state.bomName.replace(/\.[^.]+$/, '') : 'board';
    download(iso.exportSVG(), base + '-iso.svg', 'image/svg+xml');
  }

  /* ---------- Stencil ---------- */
  function pasteAvailable(side) {
    const L = state.pads && state.pads[side];
    return !!(L && ((L.pads && L.pads.length) || (L.regions && L.regions.length)));
  }

  function openStencil() {
    $('stencilErr').textContent = '';
    // pick a side that actually has data
    const sideSel = $('stStencilSide');
    if (!pasteAvailable('top') && pasteAvailable('bottom')) sideSel.value = 'bottom';
    const both = sideSel.value === 'both';
    $('stMirror').disabled = both;
    $('stMirror').checked = both ? false : sideSel.value === 'bottom';
    $('stencilModal').classList.remove('hidden');
    refreshStencilInfo();
  }
  function closeStencil() { $('stencilModal').classList.add('hidden'); }

  function sideInfo(side) {
    const L = state.pads[side];
    const n = (L.pads ? L.pads.length : 0) + (L.regions ? L.regions.length : 0);
    const src = L.isPaste === false
      ? ' <span style="color:var(--warn)">(da rame, non paste: aperture sovradimensionate)</span>'
      : '';
    return `${n} aperture · ${side}${src}`;
  }
  function refreshStencilInfo() {
    const side = $('stStencilSide').value;
    const info = $('stencilInfo');
    const sides = side === 'both' ? ['top', 'bottom'] : [side];
    const have = sides.filter(pasteAvailable);
    if (!have.length) {
      info.innerHTML = '<span style="color:var(--warn)">Nessuna piazzola paste. Carica i Gerber (layer .gtp/.gbp) o un file .kicad_pcb.</span>';
      return;
    }
    const skipped = sides.filter(s => !pasteAvailable(s));
    info.innerHTML = have.map(sideInfo).join('<br>') +
      (skipped.length ? `<br><span style="color:var(--muted)">${skipped.join(', ')}: nessuna paste, lato saltato</span>` : '');
  }

  function exportStencilSide(side, fmt, baseOpts, delay) {
    // bottom is mirrored by default; in "both" mode the per-side flag wins.
    const opts = Object.assign({}, baseOpts, { mirror: baseOpts.mirror || side === 'bottom' && baseOpts.bothMode });
    const r = Stencil.build(state.pads, side, opts);
    const base = (state.bomName || 'board').replace(/\.[^.]+$/, '') + '-stencil-' + side;
    const fire = () => {
      if (fmt === 'svg') download(Stencil.toSVG(r.contours, r.frame), base + '.svg', 'image/svg+xml');
      else if (fmt === 'dxf') download(Stencil.toDXF(r.contours, r.frame), base + '.dxf', 'application/dxf');
      else if (fmt === 'gerber') download(Stencil.toGerber(r.contours), base + (side === 'top' ? '.gtp' : '.gbp'), 'text/plain');
      else if (fmt === 'stl') download(Stencil.toSTL(r.contours, r.frame, opts.thickness), base + '.stl', 'model/stl');
    };
    if (delay) setTimeout(fire, delay); else fire();
  }

  function exportStencil() {
    const errEl = $('stencilErr'); errEl.textContent = '';
    try {
      const side = $('stStencilSide').value;
      const fmt = $('stFormat').value;
      const bothMode = side === 'both';
      const baseOpts = {
        reduction: parseFloat($('stReduction').value) || 0,
        margin: parseFloat($('stMargin').value),
        mirror: $('stMirror').checked,
        thickness: parseFloat($('stThickness').value) || 0.12,
        boardBounds: state.outline ? state.outline.bounds : null,
        bothMode,
      };
      const sides = (bothMode ? ['top', 'bottom'] : [side]).filter(pasteAvailable);
      if (!sides.length) throw new Error('Nessuna piazzola di solder paste da esportare.');
      // stagger downloads so the browser doesn't drop the second file
      sides.forEach((s, i) => exportStencilSide(s, fmt, baseOpts, i * 350));
      closeStencil();
    } catch (e) {
      console.error(e);
      errEl.textContent = e.message || String(e);
    }
  }

  const JS_FILES = ['csv.js', 'footprints.js', 'parsers.js', 'gerber.js', 'stencil.js', 'kicad.js', 'render.js', 'iso.js', 'bom.js', 'app.js'];

  async function exportStandalone() {
    try {
      const htmlSrc = await (await fetch(location.href)).text();
      const css = await (await fetch('css/style.css')).text();
      const js = {};
      for (const f of JS_FILES) js[f] = await (await fetch('js/' + f).then(r => { if (!r.ok) throw new Error('js/' + f); return r; })).text();

      let html = htmlSrc.replace(/<link[^>]*href="css\/style\.css"[^>]*>/, () => `<style>\n${css}\n</style>`);

      const data = {
        bomText: state.bomText, cplText: state.cplText,
        kicad: state.kicad,
        outline: state.outline, pads: state.pads, silk: state.silk, drill: state.drill,
        name: state.bomName || 'board',
      };
      const json = JSON.stringify(data).replace(/</g, '\\u003c');
      const embedTag = `<script>window.IBOM_EMBED=${json};<\/script>\n`;

      for (const f of JS_FILES) {
        const tag = `<script src="js/${f}"><\/script>`;
        const safe = js[f].replace(/<\/script/gi, '<\\/script'); // avoid premature block close
        const inline = `<script>\n${safe}\n<\/script>`;
        html = html.replace(tag, () => (f === JS_FILES[0] ? embedTag + inline : inline));
      }

      const base = (state.bomName || 'board').replace(/\.[^.]+$/, '');
      download(html, base + '-ibom.html', 'text/html;charset=utf-8');
    } catch (e) {
      console.error(e);
      alert('Export HTML non riuscito (' + (e.message || e) + ').\n\n' +
        'Questa funzione richiede di aprire il tool da un server (es. GitHub Pages o un server locale), ' +
        'non con doppio click su file://.');
    }
  }

  /* ---------- Sample ---------- */
  function loadSample() {
    state.bomText = SAMPLE.bom; state.cplText = SAMPLE.cpl;
    state.bomName = 'esempio.csv'; state.cplName = 'esempio_cpl.csv';
    // simple rectangular outline so the example shows a real board contour
    const r = { minX: 0, minY: 4, maxX: 42, maxY: 26 };
    state.outline = {
      paths: [{ closed: true, pts: [
        { x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY },
        { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY },
      ] }],
      bounds: r, source: 'esempio',
    };
    state.pads = null;
    generate();
  }

  const SAMPLE = {
    bom:
`Comment,Designator,Footprint,LCSC Part #
10k,"R1,R2,R3,R4",R0402,C25744
100nF,"C1,C2,C3,C4,C5",C0402,C1525
10uF,"C6,C7",C0805,C15850
Blue LED,"D1,D2",LED0603,C72041
1k,"R5,R6",R0603,C21190
STM32F103C8T6,U1,LQFP-48,C8734
USB-C,J1,USB-Type-C-16P,C165948
8MHz,Y1,SMD-3225,C115962
Tactile SW,SW1,SW-SMD_4P-L6.0,C318884`,
    cpl:
`Designator,Mid X,Mid Y,Layer,Rotation
R1,12.0,20.0,top,0
R2,12.0,18.0,top,0
R3,12.0,16.0,top,0
R4,12.0,14.0,top,90
C1,16.0,20.0,top,0
C2,16.0,18.0,top,0
C3,16.0,16.0,top,0
C4,16.0,14.0,top,0
C5,16.0,12.0,top,0
C6,20.0,20.0,top,0
C7,20.0,17.0,top,0
D1,8.0,22.0,top,0
D2,8.0,20.0,top,0
R5,24.0,8.0,bottom,0
R6,26.0,8.0,bottom,0
U1,30.0,18.0,top,45
J1,4.0,10.0,top,90
Y1,30.0,8.0,top,0
SW1,38.0,10.0,top,0`,
  };

  /* ---------- Init ---------- */
  wireLoader();
  wireApp();

  // Standalone export: data embedded directly in the page -> auto-open.
  if (window.IBOM_EMBED) {
    const d = window.IBOM_EMBED;
    state.bomText = d.bomText; state.cplText = d.cplText;
    state.kicad = d.kicad || null;
    state.outline = d.outline || null; state.pads = d.pads || null;
    state.silk = d.silk || null; state.drill = d.drill || null;
    state.bomName = d.name || 'board';
    generate();
  }
})();
