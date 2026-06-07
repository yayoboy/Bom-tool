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
  (localStorage) — riprendi da dove avevi lasciato.

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

## Note tecniche

- Le posizioni vengono lette dal CPL (coordinate in mm). La dimensione disegnata di
  ogni componente è **stimata dal nome del footprint** (es. `0402`, `SOT-23`,
  `LQFP-48`, `3.0x3.0`); per ora non viene letto il Gerber, quindi il contorno
  scheda è il bounding box dei componenti.
- Un componente presente nel BOM ma assente nel CPL viene contato come "senza
  posizione" e non disegnato (segnalato nella barra info).

## Roadmap

- [ ] Fase 2: parsing dei **Gerber** per contorno scheda e piazzole reali.
- [ ] Esportazione in singolo file HTML autonomo.
- [ ] Supporto diretto file nativi (`.kicad_pcb`).

## Struttura

```
index.html          # UI
css/style.css       # stile
js/csv.js           # parser CSV/TSV
js/footprints.js    # stima dimensioni footprint
js/parsers.js       # parsing BOM + CPL (JLCPCB/KiCad)
js/render.js        # canvas: disegno, pan/zoom, hit-test
js/bom.js           # modello dati + tabella
js/app.js           # controller principale
sample/             # file BOM + CPL di esempio
```
