/** Pixel icons as bitmaps ('#' = ink); each becomes a crisp inline SVG drawn in the current text colour. */
const BITMAPS = {
  left: ['...#', '..##', '.###', '####', '.###', '..##', '...#'],
  right: ['#...', '##..', '###.', '####', '###.', '##..', '#...'],
  tick: ['......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  diamond: ['..#..', '.###.', '#####', '.###.', '..#..'],
  none: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  fullscreen: ['###.###', '#.....#', '#.....#', '.......', '#.....#', '#.....#', '###.###'],
} as const satisfies Record<string, readonly string[]>;

/** Name of a pixel icon. */
export type IconName = keyof typeof BITMAPS;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * An inline SVG of a pixel icon, one unit per pixel (horizontal runs merged), filled with
 * `currentColor`; its CSS size is set in game pixels (`--iw`/`--ih`) so it scales with `--u`.
 */
export function icon(name: IconName): SVGSVGElement {
  const rows = BITMAPS[name];
  const w = rows[0]?.length ?? 0;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${rows.length}`);
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.style.setProperty('--iw', String(w));
  svg.style.setProperty('--ih', String(rows.length));
  let d = '';
  rows.forEach((row, y) => {
    for (const run of row.matchAll(/#+/g)) d += `M${run.index} ${y}h${run[0].length}v1h-${run[0].length}z`;
  });
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}
