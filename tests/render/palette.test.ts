import { describe, expect, it } from 'vitest';
import { TIERS } from '../../src/core/types';
import { BELT_COLOR, OUTLINE, PAL, PLATE, RAMPS, SURFACE_PAL, TIER_COLOR, TIER_TYPED } from '../../src/render/palette';
import {
  ciede2000,
  contrastRatio,
  deltaE2000,
  hex,
  relativeLuminance,
  simulateCvd,
  toLab,
  type Lab,
} from '../../src/render/color';

describe('hex', () => {
  it('parses #RRGGBB in either case', () => {
    expect(hex('#56B4E9')).toEqual([86, 180, 233]);
    expect(hex('#d55e00')).toEqual([213, 94, 0]);
  });

  it('rejects anything that is not a 6-digit hex colour', () => {
    for (const bad of ['56B4E9', '#56B4E', '#56B4E9F', '#GGGGGG', 'red', '']) {
      expect(() => hex(bad)).toThrow();
    }
  });
});

describe('relativeLuminance and contrastRatio (WCAG 2.x)', () => {
  it('gives 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
  });

  it('linearises sRGB before weighting the channels', () => {
    // 0x80 = 128 → ((128/255 + 0.055)/1.055)^2.4 = 0.2158605
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2158605, 6);
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 10);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 10);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 10);
  });

  it('is 21:1 for black on white, 1:1 for a colour on itself, and symmetric', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#56B4E9', '#56B4E9')).toBe(1);
    expect(contrastRatio('#D55E00', '#141626')).toBe(contrastRatio('#141626', '#D55E00'));
  });

  it('matches a known reference pair (#767676 on white ≈ 4.54:1)', () => {
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
  });
});

describe('toLab (sRGB → CIELAB, D65)', () => {
  it('maps white to L 100 and black to L 0 with no chroma', () => {
    const [lw, aw, bw] = toLab('#FFFFFF');
    expect(lw).toBeCloseTo(100, 3);
    expect(aw).toBeCloseTo(0, 3);
    expect(bw).toBeCloseTo(0, 3);
    expect(toLab('#000000')).toEqual([0, 0, 0]);
  });

  it('maps pure red to the textbook Lab value', () => {
    const [l, a, b] = toLab('#FF0000');
    expect(l).toBeCloseTo(53.24, 1);
    expect(a).toBeCloseTo(80.09, 1);
    expect(b).toBeCloseTo(67.2, 1);
  });
});

describe('CIEDE2000', () => {
  // Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula: implementation notes,
  // supplementary test data, and mathematical observations", Table 1 (all 34 pairs).
  const SHARMA: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1.0],
    [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, -1, 2], [50, 0, 0], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.001], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, 2.49, -0.001], [50, -2.49, 0.0012], 7.2195],
    [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
    [[50, -0.001, 2.49], [50, 0.001, -2.49], 4.8045],
    [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
    [[50, 2.5, 0], [50, 3.2972, 0], 1.0],
    [[50, 2.5, 0], [50, 1.8634, 0.5757], 1.0],
    [[50, 2.5, 0], [50, 3.2592, 0.335], 1.0],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
    [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];

  it.each(SHARMA.map((row, i) => [i + 1, ...row] as const))(
    'reproduces Sharma et al. pair %i',
    (_n, x, y, expected) => {
      expect(deltaE2000(x, y)).toBeCloseTo(expected, 4);
      expect(deltaE2000(y, x)).toBeCloseTo(expected, 4);
    },
  );

  it('is 0 for identical colours and 100 for black vs white', () => {
    expect(ciede2000('#56B4E9', '#56B4E9')).toBe(0);
    expect(ciede2000('#000000', '#FFFFFF')).toBeCloseTo(100, 3);
  });

  it('works on hex strings through toLab', () => {
    expect(ciede2000('#56B4E9', '#D55E00')).toBeCloseTo(deltaE2000(toLab('#56B4E9'), toLab('#D55E00')), 12);
  });
});

describe('simulateCvd (Machado et al. 2009, severity 1.0)', () => {
  const KINDS = ['protan', 'deutan', 'tritan'] as const;

  it('leaves black, white and greys unchanged', () => {
    for (const kind of KINDS) {
      for (const c of ['#000000', '#FFFFFF', '#808080', '#3C3C3C']) {
        expect(simulateCvd(c, kind)).toBe(c);
      }
    }
  });

  it('applies the matrices in linear RGB and re-encodes to sRGB hex', () => {
    // Protan row 1/2 on linear (1, 0, 0): 0.152286, 0.114503 → sRGB 109, 95; blue clamps to 0.
    expect(simulateCvd('#FF0000', 'protan')).toBe('#6D5F00');
    // Deutan on linear (1, 0, 0): 0.367322, 0.280085, −0.011820 → 163, 144, 0.
    expect(simulateCvd('#FF0000', 'deutan')).toBe('#A39000');
    // Tritan on linear (0, 0, 1): −0.178779, 0.147602, 0.303900 → 0, 107, 150.
    expect(simulateCvd('#0000FF', 'tritan')).toBe('#006B96');
  });

  /** |Δa*| (red–green axis) and |Δb*| (blue–yellow axis) between two colours as seen by `kind`. */
  function axisGaps(p: string, q: string, kind?: (typeof KINDS)[number]): { da: number; db: number } {
    const [, ap, bp] = toLab(kind ? simulateCvd(p, kind) : p);
    const [, aq, bq] = toLab(kind ? simulateCvd(q, kind) : q);
    return { da: Math.abs(ap - aq), db: Math.abs(bp - bq) };
  }

  it('collapses the red–green axis for protans and deutans but not for tritans', () => {
    const normal = axisGaps('#D03030', '#30A030').da;
    expect(axisGaps('#D03030', '#30A030', 'protan').da).toBeLessThan(normal / 10);
    expect(axisGaps('#D03030', '#30A030', 'deutan').da).toBeLessThan(normal / 10);
    expect(axisGaps('#D03030', '#30A030', 'tritan').da).toBeGreaterThan(normal / 2);
  });

  it('collapses the blue–yellow axis for tritans but not for protans or deutans', () => {
    const normal = axisGaps('#3060D0', '#D0C030').db;
    expect(axisGaps('#3060D0', '#D0C030', 'tritan').db).toBeLessThan(normal / 3);
    expect(axisGaps('#3060D0', '#D0C030', 'protan').db).toBeGreaterThan(normal / 2);
    expect(axisGaps('#3060D0', '#D0C030', 'deutan').db).toBeGreaterThan(normal / 2);
  });
});

const HEX6 = /^#[0-9A-F]{6}$/;
const CVD_KINDS = ['protan', 'deutan', 'tritan'] as const;
const palValues = new Set(Object.values(PAL));
const ramps = Object.entries(RAMPS).flatMap(([kind, list]) => list.map((ramp, i) => ({ name: `${kind}[${i}]`, ramp })));

describe('PAL (scene/UI master palette)', () => {
  it('has at most 48 unique colours, all written as upper-case #RRGGBB', () => {
    expect(palValues.size).toBeLessThanOrEqual(48);
    for (const c of palValues) expect(c).toMatch(HEX6);
  });

  it('contains every tier, plate, outline and surface colour', () => {
    const used = [
      ...Object.values(TIER_COLOR),
      ...Object.values(PLATE),
      OUTLINE,
      ...Object.values(SURFACE_PAL).flatMap((s) => [...s.court, ...s.surround, s.lines, ...s.accent]),
    ];
    for (const c of used) expect(palValues, c).toContain(c);
  });
});

describe('TIER_COLOR', () => {
  it('uses the Okabe–Ito sky blue, yellow and vermillion', () => {
    expect(TIER_COLOR).toEqual({ easy: '#56B4E9', medium: '#F0E442', hard: '#D55E00' });
  });

  it('keeps every pair ≥ 20 CIEDE2000 apart for normal vision and each simulated CVD', () => {
    for (const view of [null, ...CVD_KINDS]) {
      const seen = TIERS.map((t) => (view ? simulateCvd(TIER_COLOR[t], view) : TIER_COLOR[t]));
      for (let i = 0; i < seen.length; i++) {
        for (let j = i + 1; j < seen.length; j++) {
          expect(ciede2000(seen[i]!, seen[j]!), `${view ?? 'normal'} ${TIERS[i]}/${TIERS[j]}`).toBeGreaterThanOrEqual(20);
        }
      }
    }
  });
});

describe('TIER_TYPED (typed-letter shades, spec §4.2)', () => {
  it('snaps every typed shade to the master palette', () => {
    for (const t of TIERS) expect(palValues, t).toContain(TIER_TYPED[t]);
  });

  it('keeps every typed shade at ≥ 4.5:1 against the plate fill', () => {
    for (const t of TIERS) expect(contrastRatio(TIER_TYPED[t], PLATE.fill), t).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the remaining letters ≥ 1.8× as luminous as each typed shade', () => {
    for (const t of TIERS) {
      const ratio = relativeLuminance(PLATE.text) / relativeLuminance(TIER_TYPED[t]);
      expect(ratio, t).toBeGreaterThanOrEqual(1.8);
    }
  });

  it('is a shade of its own tier colour: nearer (CIEDE2000) to it than to either other tier colour', () => {
    for (const t of TIERS) {
      const own = ciede2000(TIER_TYPED[t], TIER_COLOR[t]);
      for (const other of TIERS.filter((o) => o !== t)) {
        expect(own, `${t} vs ${other}`).toBeLessThan(ciede2000(TIER_TYPED[t], TIER_COLOR[other]));
      }
    }
  });
});

describe('PLATE', () => {
  it('has remaining-letter text at ≥ 12:1 against the fill', () => {
    expect(contrastRatio(PLATE.text, PLATE.fill)).toBeGreaterThanOrEqual(12);
  });

  it('has every tier colour at ≥ 4.5:1 against the fill (typed letters and inverse first-letter blocks)', () => {
    for (const t of TIERS) expect(contrastRatio(TIER_COLOR[t], PLATE.fill), t).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the dim grey (remote outline, hidden-letter dots) at ≥ 3:1 against the fill', () => {
    expect(contrastRatio(PLATE.dim, PLATE.fill)).toBeGreaterThanOrEqual(3);
  });

  it('uses a light-grey wrong-key flash and dark outline and halo colours', () => {
    expect(relativeLuminance(PLATE.flash)).toBeGreaterThan(0.4);
    expect(relativeLuminance(PLATE.flash)).toBeLessThan(relativeLuminance(PLATE.text));
    expect(relativeLuminance(PLATE.outline)).toBeLessThanOrEqual(relativeLuminance(PLATE.fill));
    expect(relativeLuminance(PLATE.halo)).toBeLessThan(0.05);
  });
});

describe('RAMPS (character ramp table)', () => {
  it('has 6 skin, 8 hair, 12 cloth and 6 racket ramps, each [hi, mid, lo]', () => {
    expect(RAMPS.skin).toHaveLength(6);
    expect(RAMPS.hair).toHaveLength(8);
    expect(RAMPS.cloth).toHaveLength(12);
    expect(RAMPS.racket).toHaveLength(6);
    for (const { name, ramp } of ramps) {
      expect(ramp, name).toHaveLength(3);
      for (const c of ramp) expect(c, name).toMatch(HEX6);
    }
  });

  it('gets strictly darker from hi to mid to lo in every ramp', () => {
    for (const { name, ramp } of ramps) {
      const [hi, mid, lo] = ramp.map(relativeLuminance);
      expect(hi, name).toBeGreaterThan(mid!);
      expect(mid, name).toBeGreaterThan(lo!);
    }
  });

  it('keeps the shared OUTLINE darker than every ramp shade', () => {
    for (const { name, ramp } of ramps) {
      expect(relativeLuminance(OUTLINE), name).toBeLessThan(relativeLuminance(ramp[2]));
    }
  });
});

describe('BELT_COLOR', () => {
  const BELTS = ['white', 'yellow', 'green', 'brown', 'black'] as const;

  it('points each belt at a distinct cloth ramp', () => {
    const idx = BELTS.map((b) => BELT_COLOR[b]);
    expect(new Set(idx).size).toBe(BELTS.length);
    for (const i of idx) expect(RAMPS.cloth[i]).toBeDefined();
  });

  it('runs from the lightest cloth (white) to the darkest (black)', () => {
    const lum = BELTS.map((b) => relativeLuminance(RAMPS.cloth[BELT_COLOR[b]]![1]));
    for (let i = 1; i < lum.length; i++) expect(lum[i], BELTS[i]).toBeLessThan(lum[i - 1]!);
  });
});

describe('SURFACE_PAL', () => {
  it('defines hard, clay, grass and dojo with light→dark court and surround shades', () => {
    expect(Object.keys(SURFACE_PAL).sort()).toEqual(['clay', 'dojo', 'grass', 'hard']);
    for (const [name, s] of Object.entries(SURFACE_PAL)) {
      for (const shades of [s.court, s.surround]) {
        expect(shades.length, name).toBeGreaterThanOrEqual(2);
        const lum = shades.map(relativeLuminance);
        for (let i = 1; i < lum.length; i++) expect(lum[i], name).toBeLessThan(lum[i - 1]!);
      }
    }
  });

  it('draws court lines that stand out from every court shade (≥ 1.8:1)', () => {
    for (const [name, s] of Object.entries(SURFACE_PAL)) {
      for (const c of s.court) expect(contrastRatio(s.lines, c), name).toBeGreaterThanOrEqual(1.8);
    }
  });
});
