// SVG drawings of surfaces and their piece layouts (y up in data, y down in SVG).

import { bboxOf } from './geometry.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let clipSeq = 0;

function frame(polys, pad) {
  const b = bboxOf(polys);
  const W = b.x1 - b.x0, H = b.y1 - b.y0;
  const p = pad * Math.max(W, H);
  return {
    b, p, W: W + 2 * p, H: H + 2 * p,
    X: x => (x - b.x0 + p).toFixed(1),
    Y: y => (b.y1 - y + p).toFixed(1),
  };
}

function pathOf(poly, f) {
  return poly.map(([x, y], i) => `${i ? 'L' : 'M'}${f.X(x)} ${f.Y(y)}`).join('') + 'Z';
}

// Small outline preview used on surface cards.
export function previewSvg(region) {
  const f = frame([region.outer], 0.04);
  const sw = Math.max(f.W, f.H) / 90;
  return `<svg viewBox="0 0 ${f.W} ${f.H}" class="preview" aria-hidden="true">
    <path d="${pathOf(region.outer, f)}" class="pv-wall" stroke-width="${sw}"/>
    ${region.holes.map(h => `<path d="${pathOf(h, f)}" class="pv-hole" stroke-width="${sw}"/>`).join('')}
  </svg>`;
}

// Full layout: wall, openings, every piece coloured by where it comes from.
export function layoutSvg(r, type) {
  const f = frame([r.region.outer], 0.03);
  const size = Math.max(f.W, f.H);
  const sw = size / 400;
  const font = size / 38;
  const dimFont = size / 26;
  const id = `clip${++clipSeq}`;
  const regionPath = [r.region.outer, ...r.region.holes].map(p => pathOf(p, f)).join('');
  const pieces = r.pieces.map(p => {
    const cls = p.full ? 'pc-full' : p.reused ? 'pc-reuse' : 'pc-cut';
    const x = f.X(p.x0), y = f.Y(p.y1);
    const w = (p.x1 - p.x0).toFixed(1), h = (p.y1 - p.y0).toFixed(1);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="${cls}" stroke-width="${sw}"/>`;
  }).join('');
  const labels = r.pieces.filter(p => p.label).map(p => {
    const c = p.cut || p;
    const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
    const w = c.x1 - c.x0, h = c.y1 - c.y0;
    const vertical = type === 'wpc' && !p.horizontal && h > w * 1.6;
    const fs = Math.min(font, (vertical ? w : h) * 0.7, (vertical ? h : w) / Math.max(2.4, p.label.length * 0.62));
    if (fs < font * 0.35) return '';
    const rot = vertical ? ` transform="rotate(-90 ${f.X(cx)} ${f.Y(cy)})"` : '';
    return `<text x="${f.X(cx)}" y="${f.Y(cy)}" font-size="${fs.toFixed(1)}"${rot} class="pc-label">${esc(p.label)}</text>`;
  }).join('');
  const holes = r.region.holes.map(hp => `<path d="${pathOf(hp, f)}" class="hole" stroke-width="${sw * 1.5}" stroke-dasharray="${sw * 6} ${sw * 4}"/>`).join('');
  const cutouts = r.cutouts.map(cp => `<path d="${pathOf(cp, f)}" class="cutout" stroke-width="${sw * 1.5}"/>`).join('');
  const bb = f.b;
  const gutter = dimFont * 1.5;
  const hx = (-gutter / 2).toFixed(1), hy = f.Y((bb.y0 + bb.y1) / 2);
  const dims = `
    <text x="${f.X((bb.x0 + bb.x1) / 2)}" y="${(f.H + gutter / 2).toFixed(1)}" font-size="${dimFont.toFixed(1)}" class="dim">${Math.round(bb.x1 - bb.x0)} mm</text>
    <text x="${hx}" y="${hy}" font-size="${dimFont.toFixed(1)}" class="dim" transform="rotate(-90 ${hx} ${hy})">${Math.round(bb.y1 - bb.y0)} mm</text>`;
  return `<svg viewBox="${(-gutter).toFixed(1)} 0 ${(f.W + gutter).toFixed(1)} ${(f.H + gutter).toFixed(1)}" class="layout" role="img" aria-label="Layout drawing">
    <defs><clipPath id="${id}"><path d="${regionPath}" clip-rule="evenodd"/></clipPath></defs>
    <path d="${regionPath}" fill-rule="evenodd" class="wall-bg"/>
    <g clip-path="url(#${id})">${pieces}</g>
    <path d="${pathOf(r.region.outer, f)}" class="wall-line" stroke-width="${sw * 2}"/>
    ${holes}${cutouts}
    ${labels}
    ${dims}
  </svg>`;
}
