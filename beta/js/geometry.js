// Exact geometry on wall regions. A region is { outer: [[x,y],...], holes: [[[x,y],...], ...] }
// in millimetres, y pointing up from the floor. Everything is computed from vertical
// cross-sections: between "critical" x positions (vertices, edge crossings) every
// cross-section endpoint moves linearly, so midpoint sampling and linear extrapolation are exact.

const TINY = 1e-9;

export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function rectPoly(x0, y0, x1, y1) {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

export function bboxOf(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function transposeRegion(r) {
  const t = p => p.map(([x, y]) => [y, x]);
  return { outer: t(r.outer), holes: r.holes.map(t) };
}

// Intervals of y where the vertical line at x is inside the polygon.
export function polySection(poly, x) {
  const ys = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    if ((x1 <= x && x < x2) || (x2 <= x && x < x1)) {
      ys.push(y1 + (x - x1) * (y2 - y1) / (x2 - x1));
    }
  }
  ys.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < ys.length; i += 2) out.push([ys[i], ys[i + 1]]);
  return out;
}

export function unionIntervals(list, gap = 0) {
  const s = list.filter(([a, b]) => b - a > TINY).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function subtractIntervals(a, holes) {
  if (!holes.length) return a;
  const out = [];
  for (let [s, e] of a) {
    for (const [hs, he] of holes) {
      if (he <= s || hs >= e) continue;
      if (hs > s) out.push([s, hs]);
      s = Math.max(s, he);
      if (s >= e) break;
    }
    if (e - s > TINY) out.push([s, e]);
  }
  return out;
}

export function regionSection(region, x) {
  let iv = polySection(region.outer, x);
  if (region.holes.length) {
    const h = unionIntervals(region.holes.flatMap(p => polySection(p, x)));
    iv = subtractIntervals(iv, h);
  }
  return iv.filter(([a, b]) => b - a > TINY);
}

function edgesOf(region) {
  const edges = [];
  for (const p of [region.outer, ...region.holes]) {
    for (let i = 0; i < p.length; i++) edges.push([p[i], p[(i + 1) % p.length]]);
  }
  return edges;
}

// Sorted x positions where the cross-section structure can change: vertices, edge/edge
// crossings and crossings with the given horizontal lines.
export function criticalXs(region, hLines = []) {
  const xs = [];
  const edges = edgesOf(region);
  for (const [[x]] of edges) xs.push(x);
  for (let i = 0; i < edges.length; i++) {
    const [[ax, ay], [bx, by]] = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const [[cx, cy], [dx, dy]] = edges[j];
      const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (Math.abs(den) < TINY) continue;
      const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
      const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
      if (t > 0 && t < 1 && u > 0 && u < 1) xs.push(ax + t * (bx - ax));
    }
    for (const y of hLines) {
      if ((ay < y && y < by) || (by < y && y < ay)) xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
    }
  }
  xs.sort((a, b) => a - b);
  const out = [];
  for (const x of xs) if (!out.length || x - out[out.length - 1] > 1e-6) out.push(x);
  return out;
}

function slices(crit, x0, x1) {
  const xs = [x0];
  for (const x of crit) if (x > x0 + 1e-6 && x < x1 - 1e-6) xs.push(x);
  xs.push(x1);
  return xs;
}

// Cross-section intervals at both ends of a slice, extrapolated from two interior samples.
function sliceEnds(region, xa, xb) {
  const w = xb - xa;
  const m = regionSection(region, xa + w / 2);
  const q = regionSection(region, xa + w / 4);
  if (m.length !== q.length) {
    const ends = [xa + w * 1e-6, xb - w * 1e-6].map(x => regionSection(region, x));
    return [...ends, m].flat().map(([a, b]) => [a, b, a, b]);
  }
  return m.map(([a, b], i) => {
    const da = 2 * (a - q[i][0]);
    const db = 2 * (b - q[i][1]);
    return [a - da, b - db, a + da, b + db]; // [a@xa, b@xa, a@xb, b@xb]
  });
}

// Area and bounding box of (region ∩ rect). crit must include crossings with y0 and y1.
export function analyzeRect(region, crit, x0, x1, y0, y1) {
  const xs = slices(crit, x0, x1);
  let area = 0;
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let k = 0; k + 1 < xs.length; k++) {
    const xa = xs[k], xb = xs[k + 1], w = xb - xa;
    if (w < 1e-6) continue;
    const mid = regionSection(region, xa + w / 2);
    let len = 0;
    for (const [a, b] of mid) len += Math.max(0, Math.min(b, y1) - Math.max(a, y0));
    if (len <= TINY) continue;
    area += len * w;
    bb.x0 = Math.min(bb.x0, xa);
    bb.x1 = Math.max(bb.x1, xb);
    for (const [aa, ba, ab, bb2] of sliceEnds(region, xa, xb)) {
      const lo = Math.max(y0, Math.min(aa, ab));
      const hi = Math.min(y1, Math.max(ba, bb2));
      if (hi - lo > TINY) {
        bb.y0 = Math.min(bb.y0, lo);
        bb.y1 = Math.max(bb.y1, hi);
      }
    }
  }
  return { area, bbox: area > TINY ? bb : null };
}

// y-ranges a full-width vertical strip [x0, x1] has to cover. Material runs through any
// height where some part of the strip's width is wall, so only openings that span the
// whole strip width split it.
export function stripSegments(region, crit, x0, x1, mergeGap = 0.5) {
  const xs = slices(crit, x0, x1);
  const segs = [];
  for (let k = 0; k + 1 < xs.length; k++) {
    const xa = xs[k], xb = xs[k + 1];
    if (xb - xa < 1e-6) continue;
    for (const [aa, ba, ab, bb] of sliceEnds(region, xa, xb)) {
      segs.push([Math.min(aa, ab), Math.max(ba, bb)]);
    }
  }
  return unionIntervals(segs, mergeGap);
}

export function regionArea(region) {
  const bb = bboxOf([region.outer]);
  return analyzeRect(region, criticalXs(region), bb.x0, bb.x1, -Infinity, Infinity).area;
}
