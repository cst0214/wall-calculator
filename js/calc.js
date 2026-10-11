// Turns surfaces into material pieces, then works out how many panels/tiles to buy.
//
// Reuse rule (from Balentino installers): a leftover can only be used for a piece it covers
// completely. WPC: leftover length >= piece length. Flexible tile: leftover rectangle must
// contain the whole piece, same grain direction (tiles are never rotated).

import {
  analyzeRect, bboxOf, criticalXs, rectPoly, regionArea, stripSegments, transposeRegion,
} from './geometry.js';
import { materialLabel } from './catalog.js';

const TOL = 0.5; // mm

const mm = v => Math.max(1, Math.ceil(v - TOL));

export function groupKey(m) {
  return m.type === 'tile' ? `tile|${m.design}` : `wpc|${m.profile}|${m.colour}`;
}

export function surfaceRegions(s) {
  if (s.kind === 'round-column') {
    const c = Math.PI * s.diameter;
    return [{ name: 'Unrolled', region: { outer: rectPoly(0, 0, c, s.height), holes: [] }, cutouts: [] }];
  }
  if (s.kind === 'rect-column') {
    return [s.width, s.depth, s.width, s.depth].map((w, i) => ({
      name: `Face ${i + 1}`,
      region: { outer: rectPoly(0, 0, w, s.height), holes: [] },
      cutouts: [],
    }));
  }
  const rect = o => rectPoly(o.x, o.y, o.x + o.w, o.y + o.h);
  return [{
    name: '',
    region: { outer: s.outline, holes: s.openings.filter(o => o.type !== 'cutout').map(rect) },
    cutouts: s.openings.filter(o => o.type === 'cutout').map(rect),
  }];
}

function layoutWpc(region, mat, settings) {
  const spec = settings.wpc[mat.profile];
  const horizontal = mat.orientation === 'horizontal';
  const r = horizontal ? transposeRegion(region) : region;
  const bb = bboxOf([r.outer]);
  const crit = criticalXs(r);
  const count = Math.max(1, Math.ceil((bb.x1 - bb.x0 - TOL) / spec.width));
  const pieces = [];
  for (let i = 0; i < count; i++) {
    const x0 = bb.x0 + i * spec.width;
    const x1 = Math.min(x0 + spec.width, bb.x1);
    for (const [a, b] of stripSegments(r, crit, x0, x1)) {
      let len = mm(b - a);
      let y = a;
      while (len > 0) {
        const piece = Math.min(len, spec.length);
        if (piece <= TOL) break;
        // Store rectangles in wall coordinates for drawing; `cut` is the part actually on the wall.
        const toWall = b => (horizontal ? { x0: b.y0, x1: b.y1, y0: b.x0, y1: b.x1 } : b);
        const rect = toWall({ x0, x1, y0: y, y1: y + piece });
        const vis = analyzeRect(r, criticalXs(r, [y, y + piece]), x0, x1, y, y + piece).bbox;
        pieces.push({
          ...rect,
          cut: vis ? toWall(vis) : rect,
          len: piece,
          strip: i + 1,
          from: Math.round(y - bb.y0),
          to: Math.round(y - bb.y0 + piece),
          horizontal,
          joinedAbove: len > spec.length,
        });
        y += piece;
        len -= piece;
      }
    }
  }
  return { pieces, coveredArea: null };
}

function centredStart(lo, hi, tw, g) {
  const pitch = tw + g;
  const c = (lo + hi) / 2;
  let best = lo, bestEdge = -1;
  for (const start of [c - tw / 2, c + g / 2]) {
    const ox = start - Math.ceil((start - lo) / pitch) * pitch;
    let edge = tw - ((lo - ox) % pitch);
    if (edge <= 0) edge = tw;
    if (edge > bestEdge + TOL) { best = ox; bestEdge = edge; }
  }
  return best;
}

function layoutTile(region, mat, settings) {
  const T = settings.tile;
  const vertical = mat.orientation !== 'horizontal';
  const tw = vertical ? T.width : T.length;
  const th = vertical ? T.length : T.width;
  const g = Math.max(0, Number(mat.gap) || 0);
  const bb = bboxOf([region.outer]);
  const ox = mat.align === 'center' ? centredStart(bb.x0, bb.x1, tw, g) : bb.x0;
  const oy = bb.y0;
  const rows = [], cols = [];
  for (let y = oy; y < bb.y1 - TOL; y += th + g) rows.push(y);
  for (let x = ox; x < bb.x1 - TOL; x += tw + g) cols.push(x);
  const crit = criticalXs(region, rows.flatMap(y => [y, y + th]));
  const pieces = [];
  let coveredArea = 0;
  rows.forEach((y, j) => cols.forEach((x, i) => {
    const { area, bbox } = analyzeRect(region, crit, x, x + tw, y, y + th);
    if (area < 1 || !bbox) return;
    coveredArea += area;
    const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
    const full = w >= tw - TOL && h >= th - TOL;
    const pw = full ? tw : Math.min(tw, mm(w));
    const ph = full ? th : Math.min(th, mm(h));
    pieces.push({
      x0: x, y0: y, x1: x + tw, y1: y + th,
      cut: { x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 },
      full,
      shaped: area < w * h - 1,
      w: pw, h: ph,
      // Tile-local size: L along the tile's long side, S along the short side.
      L: vertical ? ph : pw,
      S: vertical ? pw : ph,
      row: j + 1,
      col: i + 1,
    });
  }));
  return { pieces, coveredArea, tileW: tw, tileH: th };
}

function packWpc(pieces, stock) {
  const panels = [];
  let full = 0;
  const sorted = [...pieces].sort((a, b) => b.len - a.len);
  for (const p of sorted) {
    if (p.len >= stock - TOL) { p.full = true; p.label = ''; full++; continue; }
    let best = null;
    for (const panel of panels) {
      if (panel.left + TOL >= p.len && (!best || panel.left < best.left)) best = panel;
    }
    p.reused = !!best;
    if (!best) {
      best = { no: panels.length + 1, left: stock, cuts: [] };
      panels.push(best);
    }
    best.left = Math.max(0, best.left - p.len);
    best.cuts.push(p);
    p.label = `P${best.no}`;
    p.unit = best.no;
  }
  return { full, units: panels };
}

function packTiles(pieces, L0, S0) {
  const tiles = [];
  let full = 0;
  const sorted = [...pieces].sort((a, b) => b.L - a.L || b.S - a.S);
  for (const p of sorted) {
    if (p.full) { p.label = ''; full++; continue; }
    let best = null, bestTile = null, bestScore = Infinity;
    for (const t of tiles) {
      for (const f of t.free) {
        if (f.L + TOL >= p.L && f.S + TOL >= p.S) {
          const score = f.L * f.S - p.L * p.S;
          if (score < bestScore) { best = f; bestTile = t; bestScore = score; }
        }
      }
    }
    p.reused = !!best;
    if (!best) {
      bestTile = { no: tiles.length + 1, free: [], cuts: [] };
      best = { L: L0, S: S0 };
      bestTile.free.push(best);
      tiles.push(bestTile);
    }
    bestTile.free.splice(bestTile.free.indexOf(best), 1);
    const dL = best.L - p.L, dS = best.S - p.S;
    const a = [{ L: dL, S: best.S }, { L: p.L, S: dS }];
    const b = [{ L: dL, S: p.S }, { L: best.L, S: dS }];
    const biggest = rs => Math.max(...rs.map(r => r.L * r.S));
    for (const r of biggest(a) >= biggest(b) ? a : b) {
      if (r.L >= 1 && r.S >= 1) bestTile.free.push(r);
    }
    bestTile.cuts.push(p);
    p.label = `T${bestTile.no}`;
    p.unit = bestTile.no;
  }
  return { full, units: tiles };
}

function location(p) {
  const where = [p.surfaceName, p.regionName].filter(Boolean).join(' · ');
  const copy = p.copy ? ` (copy ${p.copy + 1})` : '';
  if (p.row) return `${where}${copy} · row ${p.row}, col ${p.col}`;
  const dir = p.horizontal ? `row ${p.strip} from floor` : `strip ${p.strip} from left`;
  const span = p.horizontal ? `${p.from}–${p.to} mm from left` : `${p.from}–${p.to} mm from floor`;
  return `${where}${copy} · ${dir} · ${span}`;
}

export function calculate(project, settings) {
  const groups = new Map();
  const surfaces = [];
  for (const s of project.surfaces) {
    const qty = Math.max(1, Math.round(Number(s.qty) || 1));
    const key = groupKey(s.material);
    if (!groups.has(key)) {
      groups.set(key, {
        key, material: s.material, label: materialLabel(s.material),
        type: s.material.type, pieces: [], netArea: 0, coveredArea: 0, surfaces: [],
      });
    }
    const g = groups.get(key);
    g.surfaces.push(s.name);
    const regions = surfaceRegions(s).map(r => {
      const lay = s.material.type === 'wpc'
        ? layoutWpc(r.region, s.material, settings)
        : layoutTile(r.region, s.material, settings);
      const netArea = regionArea({ outer: r.region.outer, holes: [...r.region.holes, ...r.cutouts] });
      const cutoutArea = r.cutouts.length ? regionArea(r.region) - netArea : 0;
      const covered = lay.coveredArea === null ? netArea : lay.coveredArea - cutoutArea;
      return { ...r, ...lay, netArea, coveredArea: covered };
    });
    for (let copy = 0; copy < qty; copy++) {
      for (const r of regions) {
        for (const p of r.pieces) {
          const piece = copy === 0 ? p : { ...p };
          Object.assign(piece, { copy, surfaceName: s.name, regionName: r.name });
          g.pieces.push(piece);
        }
        g.netArea += r.netArea;
        g.coveredArea += r.coveredArea;
      }
    }
    surfaces.push({
      surface: s, qty, key, regions,
      netArea: regions.reduce((t, r) => t + r.netArea, 0),
    });
  }

  for (const g of groups.values()) {
    let packed, unitArea, leftovers;
    if (g.type === 'wpc') {
      const spec = settings.wpc[g.material.profile];
      packed = packWpc(g.pieces, spec.length);
      unitArea = spec.length * spec.width;
      leftovers = packed.units.filter(u => u.left >= 1).map(u => ({ unit: u.no, len: Math.round(u.left) }));
      g.leftoverArea = leftovers.reduce((t, l) => t + l.len * spec.width, 0);
      g.stock = { length: spec.length, width: spec.width };
    } else {
      const { length: L0, width: S0 } = settings.tile;
      packed = packTiles(g.pieces, L0, S0);
      unitArea = L0 * S0;
      leftovers = packed.units.flatMap(u => u.free.map(f => ({ unit: u.no, L: Math.round(f.L), S: Math.round(f.S) })));
      g.leftoverArea = leftovers.reduce((t, l) => t + l.L * l.S, 0);
      g.stock = { length: L0, width: S0 };
    }
    g.fullCount = packed.full;
    g.cutCount = packed.units.length;
    g.total = packed.full + packed.units.length;
    g.materialArea = g.total * unitArea;
    g.wasteArea = Math.max(0, g.materialArea - g.coveredArea);
    g.trimArea = Math.max(0, g.wasteArea - g.leftoverArea);
    g.wastePct = g.materialArea ? (g.wasteArea / g.materialArea) * 100 : 0;
    g.reusedCount = g.pieces.filter(p => p.reused).length;
    g.leftovers = leftovers.sort((a, b) => (b.len ?? b.L * b.S) - (a.len ?? a.L * a.S));
    g.cutPlan = packed.units.map(u => ({
      no: u.no,
      cuts: u.cuts.map(p => ({
        size: g.type === 'wpc' ? `${p.len} mm` : `${p.w} × ${p.h} mm${p.shaped ? ' (shaped)' : ''}`,
        where: location(p),
        reused: p.reused,
      })),
      left: g.type === 'wpc' ? `${Math.round(u.left)} mm` : u.free.length
        ? u.free.map(f => `${Math.round(f.S)}×${Math.round(f.L)}`).join(', ') : '0',
    }));
    delete g.pieces;
  }

  return { groups: [...groups.values()], surfaces };
}
