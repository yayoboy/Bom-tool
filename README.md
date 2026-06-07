# Interactive BOM Tool

Generatore di **BOM interattivo** per l'assemblaggio manuale di PCB — un'alternativa
autonoma al tool di JLCPCB quando questo non funziona.

Carichi il **BOM** e il **Pick & Place (CPL)** esportati dal tuo EDA e ottieni:

- la distinta componenti raggruppata per valore/footprint;
- una vista della scheda con i componenti posizionati (da CPL);
- **click su una riga → componenti evidenziati** sulla board (e viceversa);
- toggle **Top / Bottom / Entrambi**, con mirroring corretto del lato bottom;
- **zoom / pan**, ricerca, tooltip al passaggio del mouse;
- **checklist di montaggio** con barra di avanzamento, salvata nel browser
  (localStorage) — riprendi da dove avevi lasciato;
- **contorno reale della scheda** dai file **Gerber** (puoi trascinare
  direttamente lo **.zip** di JLCPCB: viene scompattato nel browser);
- **vista isometrica "esplosa"** in SVG, con slider di esplosione ed
  esportazione in file `.svg`.

Tutto gira **nel browser, senza installazione e senza backend**: nessun dato lascia
il tuo computer.

## Uso

1. Apri `index.html` (doppio click) oppure pubblica la cartella su GitHub Pages.
2. Trascina i due file nella pagina, oppure usa i pulsanti:
   - **BOM CSV**
   - **Pick & Place (CPL) CSV**
3. Premi **Genera BOM interattivo**.

Per provare subito senza file: clicca **Carica progetto di esempio**.

## Come esportare i file

### EasyEDA / JLCEDA
- **BOM**: `Fabbricazione → Bill of Materials (BOM)` → esporta CSV.
- **Pick & Place**: `Fabbricazione → Pick and Place file` → esporta CSV.

### KiCad
- **BOM**: dallo schematico, *Tools → Generate BOM* (CSV).
- **Posizioni**: dal PCB, *File → Fabrication Outputs → Component Placement (.pos)*,
  formato CSV.

Il parser riconosce automaticamente le intestazioni più comuni di entrambi gli
strumenti (es. `Comment`/`Value`, `Designator`/`Ref`, `Mid X`/`PosX`,
`Layer`/`Side`, `LCSC Part #`/`MPN`…) e il separatore (`,` `;` o tab).

## Vista isometrica (disassembly)

Dal pulsante **Isometrico** nella barra della board ottieni una proiezione 2:1
in cui i componenti sono "sollevati" sopra (top) o sotto (bottom) la loro
posizione, con linea di richiamo — l'effetto vista esplosa per capire dove va
ogni parte. Lo slider **Esplodi** regola l'altezza, e **⬇ SVG** esporta la vista
come immagine vettoriale.

## Note tecniche

- Le posizioni vengono lette dal CPL (coordinate in mm). La dimensione disegnata di
  ogni componente è **stimata dal nome del footprint** (es. `0402`, `SOT-23`,
  `LQFP-48`, `3.0x3.0`).
- Il **contorno scheda** viene estratto dal layer di profilo dei Gerber
  (`Edge_Cuts`, `.GKO`, `.GM1`, *Outline*…). Lo ZIP viene scompattato in locale
  con l'API nativa `DecompressionStream` (nessuna libreria esterna). Se non
  carichi i Gerber, il contorno è il bounding box dei componenti.
- Il parser Gerber copre quanto serve al profilo: formato/unità, selezione
  apertura, interpolazione lineare e circolare (archi), regioni (G36/G37). Non
  rende ancora le piazzole rame.
- Un componente presente nel BOM ma assente nel CPL viene contato come "senza
  posizione" e non disegnato (segnalato nella barra info).

## Roadmap

- [x] Fase 2: parsing dei **Gerber** per il contorno scheda + vista isometrica.
- [ ] Rendering delle **piazzole** (layer rame/pasta) sotto i componenti.
- [ ] Esportazione in singolo file HTML autonomo.
- [ ] Supporto diretto file nativi (`.kicad_pcb`).

## Struttura

```
index.html          # UI
css/style.css       # stile
js/csv.js           # parser CSV/TSV
js/footprints.js    # stima dimensioni footprint
js/parsers.js       # parsing BOM + CPL (JLCPCB/KiCad)
js/gerber.js        # parser Gerber (contorno) + unzip nativo
js/render.js        # canvas 2D: disegno, pan/zoom, hit-test
js/iso.js           # vista isometrica esplosa in SVG
js/bom.js           # modello dati + tabella
js/app.js           # controller principale
sample/             # BOM + CPL + Gerber di esempio
```
