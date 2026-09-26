/** A CIELAB colour (D65 white): [L*, a*, b*]. */
export type Lab = [number, number, number];

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Parses a `#RRGGBB` string into 0–255 channels; throws on any other format. */
export function hex(rgb: string): [number, number, number] {
  if (!HEX_RE.test(rgb)) throw new Error(`not a #RRGGBB colour: ${JSON.stringify(rgb)}`);
  const n = parseInt(rgb.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toLinear(c255: number): number {
  const c = c255 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

function linearRgb(rgb: string): Vec3 {
  const [r, g, b] = hex(rgb);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

function toHex(c: Vec3): string {
  return `#${c.map((v) => fromLinear(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function mul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** WCAG 2.x relative luminance (0 = black, 1 = white) of a `#RRGGBB` colour. */
export function relativeLuminance(rgb: string): number {
  const [r, g, b] = linearRgb(rgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Linear sRGB → CIE XYZ (IEC 61966-2-1, D65). */
const SRGB_TO_XYZ: Mat3 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const D65: Vec3 = [0.95047, 1, 1.08883];
const LAB_EPS = (6 / 29) ** 3;

function labF(t: number): number {
  return t > LAB_EPS ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29;
}

/** Converts a `#RRGGBB` sRGB colour to CIELAB (D65 white point, 2° observer). */
export function toLab(rgb: string): Lab {
  const xyz = mul(SRGB_TO_XYZ, linearRgb(rgb));
  const fx = labF(xyz[0] / D65[0]);
  const fy = labF(xyz[1] / D65[1]);
  const fz = labF(xyz[2] / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = Math.PI / 180;
const POW25_7 = 25 ** 7;

function hueDeg(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / DEG;
  return h < 0 ? h + 360 : h;
}

/** CIEDE2000 colour difference between two Lab colours (kL = kC = kH = 1; Sharma et al. 2005). */
export function deltaE2000(x: Lab, y: Lab): number {
  const [l1, a1, b1] = x;
  const [l2, a2, b2] = y;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + POW25_7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(b1, a1p);
  const h2p = hueDeg(b2, a2p);

  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * DEG);

  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2;
    else hBarP = (h1p + h2p - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * DEG) +
    0.24 * Math.cos(2 * hBarP * DEG) +
    0.32 * Math.cos((3 * hBarP + 6) * DEG) -
    0.2 * Math.cos((4 * hBarP - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + POW25_7));
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * DEG) * rc;

  const lTerm = dLp / sl;
  const cTerm = dCp / sc;
  const hTerm = dHp / sh;
  return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + rt * cTerm * hTerm);
}

/** CIEDE2000 colour difference between two `#RRGGBB` colours. */
export function ciede2000(a: string, b: string): number {
  return deltaE2000(toLab(a), toLab(b));
}

/** Machado, Oliveira & Fernandes (2009) simulation matrices at severity 1.0, for linear RGB. */
const CVD: Record<'protan' | 'deutan' | 'tritan', Mat3> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** How `rgb` looks with full (severity 1.0) protanopia, deuteranopia or tritanopia (Machado 2009). */
export function simulateCvd(rgb: string, kind: 'protan' | 'deutan' | 'tritan'): string {
  return toHex(mul(CVD[kind], linearRgb(rgb)));
}
