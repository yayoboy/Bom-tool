/* Main controller: file loading, model building, UI wiring, persistence. */
(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    bomText: null, cplText: null,
    bomName: '', cplName: '',
    gerberFiles: null, gerberName: '', outline: null,
    model: null,
    selectedId: null,
    filterIds: null,
    layer: 'top',
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
      const outline = Gerber.outlineFromFiles(files);
      state.outline = outline;
      if (outline) {
        $('gerberStatus').textContent = '✓ contorno: ' + outline.source.split('/').pop();
        $('slotGerber').classList.add('loaded');
      } else {
        $('gerberStatus').textContent = '⚠ nessun contorno riconosciuto';
      }
    } catch (e) {
      console.error(e);
      $('gerberStatus').textContent = '⚠ errore lettura';
      showLoaderError('Gerber: ' + (e.message || e));
    }
  }

  // Heuristic: which slot does a dropped file belong to?
  function classifyAndAssign(file) {
    const name = file.name.toLowerCase();
    if (/\.zip$|\.gko$|\.gm\d|\.gml$|gerber|edge|outline/.test(name)) return setGerberFile(file);
    if (/cpl|pick|place|pos|placement|position/.test(name)) return setCplFile(file);
    if (/bom/.test(name)) return setBomFile(file);
    // fallback: fill empty slot, bom first
    if (!state.bomText) return setBomFile(file);
    if (!state.cplText) return setCplFile(file);
    return setGerberFile(file);
  }

  function updateGenerateBtn() {
    $('generateBtn').disabled = !(state.bomText && state.cplText);
  }
  function showLoaderError(msg) { $('loaderError').textContent = msg || ''; }

  /* ---------- Build & show ---------- */
  function generate() {
    showLoaderError('');
    try {
      const bomRows = Parsers.parseBOM(state.bomText);
      const cplMap = Parsers.parseCPL(state.cplText);
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
      renderer.setComponents(model.drawable);
      renderer.setOutline(state.outline);
      iso.setComponents(model.drawable);
      iso.setOutline(state.outline);
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

  function updateCanvasInfo() {
    const m = state.model;
    let txt = `${m.components.length} componenti · ${m.groups.length} gruppi`;
    if (state.outline) txt += ' · contorno Gerber';
    if (m.missing) txt += ` · ⚠ ${m.missing} senza posizione (assenti nel CPL)`;
    $('canvasInfo').textContent = txt;
  }

  /* ---------- Selection ---------- */
  function selectGroup(id, scrollIntoView) {
    state.selectedId = (state.selectedId === id) ? null : id;
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
    if (!q) { state.filterIds = null; renderer.setVisible(null); if (iso) iso.setVisible(null); return; }
    const ids = new Set();
    const refs = new Set();
    for (const g of state.model.groups) {
      const hay = (g.comment + ' ' + g.footprint + ' ' + g.lcsc + ' ' + g.designators.join(' ')).toLowerCase();
      if (hay.includes(q)) { ids.add(g.id); g.designators.forEach(r => refs.add(r)); }
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
    const groups = state.model.groups;
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
      for (const g of state.model.groups) { g.done = val; g.comps.forEach(c => c.done = val); }
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

  function exportSvg() {
    if (!iso) return;
    const blob = new Blob([iso.exportSVG()], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.bomName ? state.bomName.replace(/\.[^.]+$/, '') : 'board') + '-iso.svg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- Sample ---------- */
  function loadSample() {
    state.bomText = SAMPLE.bom; state.cplText = SAMPLE.cpl;
    state.bomName = 'esempio.csv'; state.cplName = 'esempio_cpl.csv';
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
})();
