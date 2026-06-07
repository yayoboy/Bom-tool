/* Estimates a component's drawn size (mm) from its footprint string.
 * The CPL file gives us the centre position but not the body size, so we
 * approximate the rectangle to draw. Sizes are body dimensions in mm.
 */
(function (global) {
  // Imperial chip packages (resistors, caps, LEDs...) -> [W, H] mm
  const CHIP = {
    '0201': [0.6, 0.3], '0402': [1.0, 0.5], '0603': [1.6, 0.8],
    '0805': [2.0, 1.25], '1206': [3.2, 1.6], '1210': [3.2, 2.5],
    '1812': [4.5, 3.2], '2010': [5.0, 2.5], '2512': [6.3, 3.2],
    '1808': [4.5, 2.0], '0508': [1.25, 2.0],
  };

  // Named packages -> [W, H] mm (approx body, square-ish unless noted)
  const NAMED = [
    [/SOT-?23-?5|SOT-?23-?6|SOT-?363|SC-?70/, [2.0, 2.1]],
    [/SOT-?23/, [2.9, 1.3]],
    [/SOT-?89/, [4.5, 2.5]],
    [/SOT-?223/, [6.5, 3.5]],
    [/SOT-?143/, [2.9, 1.3]],
    [/SOD-?123/, [3.7, 1.7]],
    [/SOD-?323|SOD-?523/, [1.7, 1.25]],
    [/SOD-?80|MELF|MiniMELF/, [3.6, 1.5]],
    [/SMA|DO-?214AC/, [4.3, 2.6]],
    [/SMB|DO-?214AA/, [4.6, 3.6]],
    [/SMC|DO-?214AB/, [7.0, 6.2]],
    [/QFN-?(\d+).*?(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/i, null], // handled by dim regex below
    [/TQFP-?44|LQFP-?44/, [10, 10]],
    [/TQFP-?48|LQFP-?48/, [7, 7]],
    [/TQFP-?64|LQFP-?64/, [10, 10]],
    [/TQFP-?100|LQFP-?100/, [14, 14]],
    [/TSSOP-?(\d+)/, [4.4, 5.0]],
    [/MSOP-?(\d+)/, [3.0, 3.0]],
    [/SOIC-?8|SO-?8/, [4.9, 3.9]],
    [/SOIC-?14|SO-?14/, [8.7, 3.9]],
    [/SOIC-?16|SO-?16/, [9.9, 3.9]],
    [/SOIC-?(\d+)/, [6.0, 4.0]],
    [/DFN-?(\d+)/, [2.0, 2.0]],
    [/QFN-?(\d+)/, [4.0, 4.0]],
    [/0603-?LED|LED-?0603/, [1.6, 0.8]],
    [/USB|Type-?C/i, [9.0, 7.0]],
    [/HDR|HEADER|PINHEADER|Pin_?Header|CONN/i, [5.0, 2.5]],
    [/ELEC|CAP-?RADIAL|Radial|Electrolytic/i, [6.6, 6.6]],
    [/TO-?252|DPAK/, [6.5, 6.1]],
    [/TO-?263|D2PAK/, [10.0, 9.0]],
    [/SMD,?L?5.?7|CRYSTAL|XTAL|Resonator/i, [5.0, 3.2]],
    [/R0402|C0402|L0402/, [1.0, 0.5]],
    [/R0603|C0603|L0603/, [1.6, 0.8]],
    [/R0805|C0805|L0805/, [2.0, 1.25]],
    [/R1206|C1206|L1206/, [3.2, 1.6]],
  ];

  const DEFAULT_SIZE = [2.0, 2.0];

  function lookup(footprint) {
    if (!footprint) return DEFAULT_SIZE.slice();
    const fp = String(footprint);

    // 1) explicit dimensions like "3.0x3.0" or "L5.0-W5.0"
    const dim = fp.match(/(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)/);
    if (dim) {
      const w = parseFloat(dim[1]), h = parseFloat(dim[2]);
      if (w > 0 && h > 0 && w < 200 && h < 200) return [w, h];
    }

    // 2) imperial chip code as a standalone token
    const chip = fp.match(/(?:^|[^0-9])(0201|0402|0603|0805|1206|1210|1812|2010|2512|1808|0508)(?:[^0-9]|$)/);
    if (chip && CHIP[chip[1]]) return CHIP[chip[1]].slice();

    // 3) named packages
    for (const [re, size] of NAMED) {
      if (size && re.test(fp)) return size.slice();
    }

    return DEFAULT_SIZE.slice();
  }

  global.Footprints = { lookup };
})(window);
