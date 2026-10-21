import { calculate } from './calc.js';
import { DEFAULT_SETTINGS } from './catalog.js';
import { rectPoly, regionArea } from './geometry.js';
import { applyH, estimateAspect, homography, measureWithPaper, orderQuad } from './photo.js';
import {
  horizontalDist, mul4, ndcToPx, rayPlane, toNdc, v3, wallCorners3d, wallFrame,
} from './ar.js';

const out = document.getElementById('out');
const results = [];

function check(name, actual, expected, tol = 1e-6) {
  const ok = typeof expected === 'number' ? Math.abs(actual - expected) <= tol : actual === expected;
  results.push(ok);
  const div = document.createElement('div');
  div.className = ok ? 'pass' : 'fail';
  div.innerHTML = `<pre>${ok ? '✓' : '✗'} ${name}: got ${actual}${ok ? '' : `, expected ${expected}`}</pre>`;
  out.append(div);
}

const S = structuredClone(DEFAULT_SETTINGS);
const wpc = (extra = {}) => ({ type: 'wpc', profile: '24', colour: 'FWPC 001', orientation: 'vertical', ...extra });
const tile = (extra = {}) => ({ type: 'tile', design: 'FFT 1004 TT', orientation: 'vertical', gap: 0, align: 'left', ...extra });
let n = 0;
const wall = (outline, material, openings = [], qty = 1) => ({ id: `w${++n}`, name: `W${n}`, kind: 'wall', qty, material, outline, openings });
const run = (...surfaces) => calculate({ surfaces }, S).groups;

// WPC 24 mm panels are 168 mm wide; 1680 = 10 panels, 3360 = 20 panels.

// 1. Plain rectangle, width an exact multiple of the panel width.
{
  const [g] = run(wall(rectPoly(0, 0, 3360, 2800), wpc()));
  check('3360x2800 WPC24: panels', g.total, 20);
  check('3360x2800 WPC24: net m²', g.netArea / 1e6, 3360 * 2800 / 1e6, 1e-9);
  check('3360x2800 WPC24: waste %', g.wastePct, (1 - (3360 * 2800) / (20 * 2900 * 168)) * 100, 1e-9);
  check('3360x2800 WPC24: leftover m²', g.leftoverArea / 1e6, 20 * 100 * 168 / 1e6, 1e-9);
}

// 2. Width not a multiple: 3000 / 168 -> 18 panels, last one ripped to 144 mm.
{
  const [g] = run(wall(rectPoly(0, 0, 3000, 2800), wpc()));
  check('3000 wide WPC24: panels', g.total, 18);
  check('3000 wide WPC24: trim m² (rip 24 mm × 2800)', g.trimArea / 1e6, 24 * 2800 / 1e6, 1e-6);
}

// 3. Window spanning whole strips: 6 strips split into 900 + 700.
{
  const [g] = run(wall(rectPoly(0, 0, 1680, 2800), wpc(), [{ id: 'o', type: 'window', x: 336, y: 900, w: 1008, h: 1200 }]));
  check('window: panels', g.total, 8);
  check('window: pieces from leftovers', g.reusedCount, 8);
  check('window: net m²', g.netArea / 1e6, (1680 * 2800 - 1008 * 1200) / 1e6, 1e-9);
}

// 4. Window not aligned with strips: partly covered strips stay one piece.
{
  const [g] = run(wall(rectPoly(0, 0, 1680, 2800), wpc(), [{ id: 'o', type: 'window', x: 420, y: 900, w: 840, h: 1200 }]));
  // Strips 336-504 and 1176-1344 are only partly window -> full 2800 (6 panels in total).
  // Strips 504-1176 split into 900 + 700: 4x900 + 4x700 -> 3 panels.
  check('offset window: panels', g.total, 9);
}

// 5. Taller than one panel: joined piece.
{
  const [g] = run(wall(rectPoly(0, 0, 168, 3400), wpc()));
  check('3400 tall: panels', g.total, 2);
  check('3400 tall: full panels', g.fullCount, 1);
}

// 6. Sloped top: strip heights 2080..2800, no reuse possible.
{
  const [g] = run(wall([[0, 0], [1680, 0], [1680, 2800], [0, 2000]], wpc()));
  check('slope top: panels', g.total, 10);
  check('slope top: net m²', g.netArea / 1e6, 1680 * 2400 / 1e6, 1e-9);
  check('slope top: reused', g.reusedCount, 0);
}

// 7. Leftovers reused across walls only when long enough.
{
  const [g] = run(
    wall(rectPoly(0, 0, 168, 1900), wpc()), // leftover 1000
    wall(rectPoly(0, 0, 168, 900), wpc()),  // fits in 1000
  );
  check('cross-wall reuse 900 in 1000: panels', g.total, 1);
  const [g2] = run(
    wall(rectPoly(0, 0, 168, 1900), wpc()),
    wall(rectPoly(0, 0, 168, 1100), wpc()), // does not fit in 1000
  );
  check('cross-wall 1100 does not fit 1000: panels', g2.total, 2);
}

// 8. Door from the floor: strips above the door only.
{
  const [g] = run(wall(rectPoly(0, 0, 1680, 2800), wpc(), [{ id: 'd', type: 'door', x: 504, y: 0, w: 1008, h: 2100 }]));
  // 4 strips x 2800 -> 4 panels; 6 strips x 700 -> 4 from one panel + 2 from another
  check('door: panels', g.total, 6);
}

// 9. Horizontal WPC.
{
  const [g] = run(wall(rectPoly(0, 0, 2800, 1680), wpc({ orientation: 'horizontal' })));
  check('horizontal 2800x1680: panels', g.total, 10);
}

// 9b. 10 mm profile is 155 mm wide.
{
  const [g] = run(wall(rectPoly(0, 0, 1550, 2800), wpc({ profile: '10' })));
  check('10 mm profile 1550 wide: panels', g.total, 10);
}

// 10. Tiles, top row cut to 300 mm: 4 cuts per tile.
{
  const [g] = run(wall(rectPoly(0, 0, 3000, 2700), tile()));
  check('tile 3000x2700: total', g.total, 12);
  check('tile 3000x2700: full', g.fullCount, 10);
  check('tile 3000x2700: waste %', g.wastePct, (1 - 8.1 / 8.64) * 100, 1e-9);
}

// 11. Tiles horizontal.
{
  const [g] = run(wall(rectPoly(0, 0, 3000, 2700), tile({ orientation: 'horizontal' })));
  // cols: 0,1200,2400 (last 600 wide); rows: 0,600,...,2400 (last 300 tall)
  // full: 2 cols x 4 rows = 8; right col 600x600 x4 + top row 1200x300 x2 + corner 600x300
  // tile-local L along 1200: pieces (L=600,S=600)x4, (L=1200,S=300)x2, (L=600,S=300)x1
  check('tile horizontal: total', g.total, 8 + 2 + 1 + 1);
}

// 12. Tiles with joint gap.
{
  const [g] = run(wall(rectPoly(0, 0, 1210, 1200), tile({ gap: 10 })));
  check('tile gap 10: total', g.total, 2);
  check('tile gap 10: waste', g.wasteArea, 0, 1e-6);
}

// 13. Tiles are not rotated: 1200x300 strip cannot come from 600 wide leftover rotated.
{
  const [g] = run(
    wall(rectPoly(0, 0, 600, 300), tile()),                          // piece 600 wide x 300 tall
    wall(rectPoly(0, 0, 300, 1200), tile()),                         // piece 300 wide x 1200 tall
  );
  // Tile 1: cut 600x300 (L=300,S=600) leaves L=900,S=600. Piece 2 is L=1200,S=300: does not fit -> new tile.
  check('no rotation: total', g.total, 2);
}

// 14. Socket does not reduce material but reduces covered area.
{
  const [g] = run(wall(rectPoly(0, 0, 3360, 2800), wpc(), [{ id: 's', type: 'cutout', x: 500, y: 300, w: 86, h: 86 }]));
  check('socket: panels unchanged', g.total, 20);
  check('socket: net area', g.netArea, 3360 * 2800 - 86 * 86, 1e-3);
}

// 15. Missing corner: top-right 1008 x 800 cut away (strips 15-20 are 2000 tall).
{
  const [g] = run(wall([[0, 0], [3360, 0], [3360, 2000], [2352, 2000], [2352, 2800], [0, 2800]], wpc()));
  check('missing corner: panels', g.total, 20);
  check('missing corner: area', g.netArea / 1e6, (3360 * 2800 - 1008 * 800) / 1e6, 1e-9);
}

// 16. Round column unrolled.
{
  const s = { id: 'c', name: 'C', kind: 'round-column', qty: 2, material: tile(), diameter: 400, height: 1200 };
  const [g] = calculate({ surfaces: [s] }, S).groups;
  // circumference 1256.6 -> 2 full + 1 piece 57 wide per column; 2 columns: 4 full + 2 pieces (fit in 1 tile)
  check('round column ×2: total', g.total, 5);
}

// 17. Region area with overlapping openings.
{
  const a = regionArea({ outer: rectPoly(0, 0, 1000, 1000), holes: [rectPoly(100, 100, 500, 500), rectPoly(300, 300, 700, 700)] });
  check('overlapping holes area', a, 1e6 - (160000 + 160000 - 40000), 1e-6);
}

// 18. Perspective: homography round trip and aspect estimate.
{
  const H = homography([[0, 0], [1, 0], [1, 1], [0, 1]], [[10, 20], [200, 30], [180, 220], [5, 190]]);
  const [x, y] = applyH(H, 1, 1);
  check('homography corner x', x, 180, 1e-6);
  check('homography corner y', y, 220, 1e-6);

  // Synthetic camera looking at a 4000 x 2500 wall from an angle.
  const f = 1400, W = 1600, Hh = 1200;
  const yaw = 0.5, pitch = 0.15;
  const project = ([X, Y]) => {
    // Wall plane z = 0, centred; camera rotated (yaw about Y, pitch about X), 6 m away.
    let px = X - 2000, py = Y - 1250, pz = 0;
    const cx = Math.cos(yaw) * px + Math.sin(yaw) * pz, cz = -Math.sin(yaw) * px + Math.cos(yaw) * pz;
    px = cx; pz = cz;
    const cy = Math.cos(pitch) * py - Math.sin(pitch) * pz, cz2 = Math.sin(pitch) * py + Math.cos(pitch) * pz;
    py = cy; pz = cz2 + 6000;
    return [W / 2 + f * px / pz, Hh / 2 - f * py / pz];
  };
  const corners = { tl: project([0, 2500]), tr: project([4000, 2500]), bl: project([0, 0]), br: project([4000, 0]) };
  const { ratio, solved } = estimateAspect(corners, W, Hh);
  check('aspect solved', solved, true);
  check('aspect ratio 1.6', ratio, 1.6, 1e-6);

  // 19. A4 sheet on the same wall gives the wall size, whatever order the sheet dots are in.
  const sheet = (x, y, w, h) => [project([x + w, y]), project([x, y + h]), project([x, y]), project([x + w, y + h])];
  const flat = measureWithPaper(corners, sheet(1850, 1100, 297, 210), W, Hh);
  check('A4 sideways: wall width', flat.w, 4000, 1e-6);
  check('A4 sideways: wall height', flat.h, 2500, 1e-6);
  check('A4 sideways: seen as sideways', flat.upright, false);
  const up = measureWithPaper(corners, sheet(600, 900, 210, 297), W, Hh);
  check('A4 upright: wall width', up.w, 4000, 1e-6);
  check('A4 upright: wall height', up.h, 2500, 1e-6);
  check('A4 upright: seen as upright', up.upright, true);
  const q = orderQuad([[5, 9], [1, 1], [9, 0], [0, 8]]);
  check('dot order: top-left', q.tl.join(), '1,1');
  check('dot order: bottom-right', q.br.join(), '5,9');
}

// 20. AR geometry: aim line meets the wall; 3D -> screen projection.
{
  const hit = rayPlane([0, 1.5, 0], [0, 0, -1], [0, 0, -3], [0, 0, 1]);
  check('aim meets wall: z', hit[2], -3, 1e-9);
  check('aim meets wall: height kept', hit[1], 1.5, 1e-9);
  check('aim pointing away: no hit', rayPlane([0, 1.5, 0], [0, 0, 1], [0, 0, -3], [0, 0, 1]), null);

  // Wall 3.2 m wide; floor found 1 cm higher on the right; top aimed at 2.7 m.
  const bl = [-1, 0, -3], br = [2.2, 0.01, -3];
  const f = wallFrame(bl, br);
  check('AR width (flat distance)', horizontalDist(bl, br) * 1000, 3200, 1e-6);
  const top = rayPlane([0.5, 1.6, 0], v3.norm([0, 1.1, -3]), f.origin, f.normal);
  check('AR top on wall plane', top[2], -3, 1e-9);
  check('AR height from floor', (top[1] - f.floorY) * 1000, 2700 - 5, 1e-6);

  // Camera looking down -z, 60° field of view, square image 1000 px.
  const t = 1 / Math.tan(Math.PI / 6), n = 0.1, fa = 100;
  const proj = [t, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0];
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const m = mul4(proj, ident);
  const c = ndcToPx(toNdc(m, [0, 0, -2]), 1000, 1000);
  check('projection: straight ahead is the centre x', c[0], 500, 1e-9);
  check('projection: straight ahead is the centre y', c[1], 500, 1e-9);
  const edge = ndcToPx(toNdc(m, [2 * Math.tan(Math.PI / 6), 0, -2]), 1000, 1000);
  check('projection: 30° right is the right edge', edge[0], 1000, 1e-6);
  const above = ndcToPx(toNdc(m, [0, 0.5, -2]), 1000, 1000);
  check('projection: higher point is nearer the top', above[1] < 500, true);
  check('projection: behind the camera is ignored', toNdc(m, [0, 0, 2]), null);

  // The photo is straightened from the 4 projected corners. Any other point of the wall must land
  // where the camera really sees it, or doors drawn on the photo would be in the wrong place.
  const cam = mul4(proj, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.6, -1.1, -2, 1]); // camera 2 m back, 0.6 m to the side
  const ww = Math.hypot(3, 0.6), wh = 2.6;
  const fr = wallFrame([-1, 0, -1], [2, 0, -1.6]);
  const w3 = wallCorners3d(fr, ww, wh);
  const px = p => ndcToPx(toNdc(cam, p), 1000, 1000);
  const Hw = homography([[0, 0], [ww, 0], [ww, wh], [0, wh]], [px(w3.bl), px(w3.br), px(w3.tr), px(w3.tl)]);
  const door = v3.add(v3.add(w3.bl, v3.scale(fr.along, 0.8)), [0, 2.1, 0]); // door top, 0.8 m from the left
  const viaPhoto = applyH(Hw, 0.8, 2.1), seen = px(door);
  check('AR photo: door top lands right (x)', viaPhoto[0], seen[0], 1e-6);
  check('AR photo: door top lands right (y)', viaPhoto[1], seen[1], 1e-6);
}

const passed = results.filter(Boolean).length;
document.getElementById('summary').textContent = `${passed} / ${results.length} passed`;
document.title = `${passed}/${results.length} passed`;
window.__testSummary = { passed, total: results.length };
