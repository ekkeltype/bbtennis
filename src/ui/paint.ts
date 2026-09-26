/** Fills one solid `w`×`h` rectangle at (x, y) in colour `c`: the pixel primitive of the menu art (logo, illustrations). */
export function rect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string): void {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
}
