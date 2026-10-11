// Canvas editor for one wall: outline polygon + rectangular openings, in mm (y up).
// One finger drags handles or pans, two fingers pinch-zoom, mouse wheel zooms.

const SNAP = 10; // mm
const OPENING_STYLE = {
  door: { fill: 'rgba(255,255,255,0.88)', stroke: '#b45309', label: 'Door' },
  window: { fill: 'rgba(224,242,254,0.88)', stroke: '#0369a1', label: 'Window' },
  cutout: { fill: 'rgba(254,226,226,0.9)', stroke: '#b91c1c', label: 'Socket' },
};

export class WallEditor {
  constructor(canvas, surface, { onChange, onSelect, getPhoto }) {
    this.canvas = canvas;
    this.s = surface;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.getPhoto = getPhoto;
    this.sel = null; // {type:'vertex', i} | {type:'edge', i} | {type:'opening', id}
    this.pointers = new Map();
    this.gesture = null;
    this.showPhoto = true;
    this.view = { k: 0.1, ox: 0, oy: 0 };
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      canvas.addEventListener(ev, e => this[ev](e));
    }
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.fit();
  }

  destroy() { this.ro.disconnect(); }

  get dpr() { return window.devicePixelRatio || 1; }

  resize() {
    const cw = this.canvas.clientWidth;
    const ch = Math.round(Math.max(260, Math.min(window.innerHeight * 0.55, cw * 0.85)));
    if (this.canvas.style.height !== `${ch}px`) this.canvas.style.height = `${ch}px`;
    const w = Math.round(cw * this.dpr), h = Math.round(ch * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      const first = !this.canvas.width;
      this.canvas.width = w; this.canvas.height = h;
      if (first) this.fit();
    }
    this.draw();
  }

  bounds() {
    const xs = this.s.outline.map(p => p[0]), ys = this.s.outline.map(p => p[1]);
    for (const o of this.s.openings) { xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h); }
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  fit() {
    const b = this.bounds();
    const W = this.canvas.width, H = this.canvas.height;
    const pad = 46 * this.dpr;
    const k = Math.min((W - 2 * pad) / Math.max(1, b.x1 - b.x0), (H - 2 * pad) / Math.max(1, b.y1 - b.y0));
    this.view.k = k;
    this.view.ox = (W - (b.x1 - b.x0) * k) / 2 - b.x0 * k;
    this.view.oy = (H + (b.y1 - b.y0) * k) / 2 + b.y0 * k;
    this.draw();
  }

  toScreen(x, y) { return [this.view.ox + x * this.view.k, this.view.oy - y * this.view.k]; }
  toWorld(sx, sy) { return [(sx - this.view.ox) / this.view.k, (this.view.oy - sy) / this.view.k]; }

  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr];
  }

  snapValue(v, axis, skip) {
    // Align with other vertices / opening edges within 8 px, else round to SNAP mm.
    const tol = 8 * this.dpr / this.view.k;
    let best = null, bestD = tol;
    const cands = [];
    this.s.outline.forEach((p, i) => { if (!(skip?.type === 'vertex' && skip.i === i)) cands.push(p[axis]); });
    for (const o of this.s.openings) {
      if (skip?.type === 'opening' && skip.id === o.id) continue;
      cands.push(axis ? o.y : o.x, axis ? o.y + o.h : o.x + o.w);
    }
    for (const c of cands) { const d = Math.abs(c - v); if (d < bestD) { best = c; bestD = d; } }
    return best ?? Math.round(v / SNAP) * SNAP;
  }

  hit(sx, sy) {
    const r = 18 * this.dpr;
    const selO = this.sel?.type === 'opening' && this.s.openings.find(o => o.id === this.sel.id);
    if (selO) {
      for (const [cx, cy, corner] of openingCorners(selO)) {
        const [px, py] = this.toScreen(cx, cy);
        if (Math.hypot(px - sx, py - sy) < r) return { type: 'opening-corner', id: selO.id, corner };
      }
    }
    for (let i = 0; i < this.s.outline.length; i++) {
      const [px, py] = this.toScreen(...this.s.outline[i]);
      if (Math.hypot(px - sx, py - sy) < r) return { type: 'vertex', i };
    }
    const [wx, wy] = this.toWorld(sx, sy);
    for (let j = this.s.openings.length - 1; j >= 0; j--) {
      const o = this.s.openings[j];
      if (wx >= o.x && wx <= o.x + o.w && wy >= o.y && wy <= o.y + o.h) return { type: 'opening', id: o.id };
    }
    const n = this.s.outline.length;
    for (let i = 0; i < n; i++) {
      const a = this.toScreen(...this.s.outline[i]);
      const b = this.toScreen(...this.s.outline[(i + 1) % n]);
      if (segDist(sx, sy, a, b) < 12 * this.dpr) return { type: 'edge', i };
    }
    return null;
  }

  pointerdown(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const p = this.eventPoint(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = { type: 'pinch', d: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: mid(a, b), view: { ...this.view } };
      return;
    }
    const h = this.hit(...p);
    const start = { p, moved: false, hit: h };
    if (h?.type === 'vertex') {
      this.gesture = { type: 'vertex', i: h.i, ...start };
    } else if (h?.type === 'opening-corner') {
      const o = this.s.openings.find(x => x.id === h.id);
      this.gesture = { type: 'corner', o, corner: h.corner, ...start };
    } else if (h?.type === 'opening') {
      const o = this.s.openings.find(x => x.id === h.id);
      const [wx, wy] = this.toWorld(...p);
      this.gesture = { type: 'opening', o, dx: wx - o.x, dy: wy - o.y, ...start };
    } else {
      this.gesture = { type: 'pan', view: { ...this.view }, ...start };
    }
  }

  pointermove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.eventPoint(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;
    e.preventDefault();
    if (g.type === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const m = mid(a, b);
      const f = d / g.d;
      this.view.k = g.view.k * f;
      this.view.ox = m[0] - (g.mid[0] - g.view.ox) * f;
      this.view.oy = m[1] - (g.mid[1] - g.view.oy) * f;
      this.draw();
      return;
    }
    if (!g.moved && Math.hypot(p[0] - g.p[0], p[1] - g.p[1]) < 6 * this.dpr) return;
    g.moved = true;
    const [wx, wy] = this.toWorld(...p);
    if (g.type === 'pan') {
      this.view.ox = g.view.ox + p[0] - g.p[0];
      this.view.oy = g.view.oy + p[1] - g.p[1];
    } else if (g.type === 'vertex') {
      const skip = { type: 'vertex', i: g.i };
      this.s.outline[g.i] = [this.snapValue(wx, 0, skip), this.snapValue(wy, 1, skip)];
      this.select({ type: 'vertex', i: g.i });
    } else if (g.type === 'opening') {
      const skip = { type: 'opening', id: g.o.id };
      let x = wx - g.dx, y = wy - g.dy;
      const sx = this.snapValue(x, 0, skip), sxr = this.snapValue(x + g.o.w, 0, skip) - g.o.w;
      const sy = this.snapValue(y, 1, skip), syt = this.snapValue(y + g.o.h, 1, skip) - g.o.h;
      g.o.x = Math.abs(sxr - x) < Math.abs(sx - x) ? sxr : sx;
      g.o.y = Math.abs(syt - y) < Math.abs(sy - y) ? syt : sy;
      this.select({ type: 'opening', id: g.o.id });
    } else if (g.type === 'corner') {
      const o = g.o, skip = { type: 'opening', id: o.id };
      const x = this.snapValue(wx, 0, skip), y = this.snapValue(wy, 1, skip);
      const right = o.x + o.w, top = o.y + o.h;
      if (g.corner.includes('l')) { o.x = Math.min(x, right - SNAP); o.w = right - o.x; }
      else o.w = Math.max(SNAP, x - o.x);
      if (g.corner.includes('b')) { o.y = Math.min(y, top - SNAP); o.h = top - o.y; }
      else o.h = Math.max(SNAP, y - o.y);
      this.select({ type: 'opening', id: o.id });
    }
    this.draw();
  }

  pointerup(e) {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (g && g.type !== 'pinch' && !g.moved) {
      const h = g.hit;
      if (h?.type === 'opening-corner') this.select({ type: 'opening', id: h.id });
      else this.select(h && h.type !== 'opening-corner' ? h : null);
    } else if (g && g.moved && g.type !== 'pan') {
      this.onChange?.();
    }
    if (this.pointers.size === 0) this.gesture = null;
    else if (g?.type === 'pinch') this.gesture = null;
    this.draw();
  }

  pointercancel(e) { this.pointerup(e); }

  wheel(e) {
    e.preventDefault();
    const [sx, sy] = this.eventPoint(e);
    const f = Math.exp(-e.deltaY * 0.0015);
    this.view.ox = sx - (sx - this.view.ox) * f;
    this.view.oy = sy - (sy - this.view.oy) * f;
    this.view.k *= f;
    this.draw();
  }

  select(sel) {
    this.sel = sel;
    this.onSelect?.(sel);
    this.draw();
  }

  gridStep() {
    const target = 70 * this.dpr / this.view.k; // ~70 px between lines
    for (const s of [50, 100, 250, 500, 1000, 2000, 5000]) if (s >= target) return s;
    return 10000;
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    const W = this.canvas.width, H = this.canvas.height, dpr = this.dpr;
    const css = getComputedStyle(this.canvas);
    const col = name => css.getPropertyValue(name).trim();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = col('--canvas-bg') || '#f8fafc';
    ctx.fillRect(0, 0, W, H);

    // Grid
    const step = this.gridStep();
    const [wx0, wy1] = this.toWorld(0, 0), [wx1, wy0] = this.toWorld(W, H);
    ctx.lineWidth = 1;
    for (let x = Math.floor(wx0 / step) * step; x <= wx1; x += step) {
      const [sx] = this.toScreen(x, 0);
      ctx.strokeStyle = x === 0 ? col('--grid-strong') : col('--grid');
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    }
    for (let y = Math.floor(wy0 / step) * step; y <= wy1; y += step) {
      const [, sy] = this.toScreen(0, y);
      ctx.strokeStyle = y === 0 ? col('--grid-strong') : col('--grid');
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
    }

    // Photo underlay
    const photo = this.showPhoto && this.getPhoto?.();
    if (photo?.img?.complete && photo.img.naturalWidth) {
      const [px, py] = this.toScreen(photo.x0, photo.y1);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(photo.img, px, py, (photo.x1 - photo.x0) * this.view.k, (photo.y1 - photo.y0) * this.view.k);
      ctx.globalAlpha = 1;
    }

    // Wall outline
    const pts = this.s.outline.map(p => this.toScreen(...p));
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = photo ? 'rgba(13,148,136,0.16)' : col('--wall-fill');
    ctx.fill();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = col('--accent');
    ctx.stroke();

    // Edge lengths
    ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const n = this.s.outline.length;
    const area = signedArea(this.s.outline);
    for (let i = 0; i < n; i++) {
      const a = this.s.outline[i], b = this.s.outline[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len * this.view.k < 40 * dpr) continue;
      const [sa, sb] = [this.toScreen(...a), this.toScreen(...b)];
      // Offset the label to the outside of the polygon.
      let nx = sb[1] - sa[1], ny = -(sb[0] - sa[0]);
      const nl = Math.hypot(nx, ny) || 1;
      const sign = area > 0 ? -1 : 1;
      nx = nx / nl * 14 * dpr * sign; ny = ny / nl * 14 * dpr * sign;
      const tx = (sa[0] + sb[0]) / 2 + nx, ty = (sa[1] + sb[1]) / 2 + ny;
      const text = `${Math.round(len)}`;
      const tw = ctx.measureText(text).width + 8 * dpr;
      const selected = this.sel?.type === 'edge' && this.sel.i === i;
      ctx.fillStyle = selected ? col('--accent') : col('--label-bg');
      roundRect(ctx, tx - tw / 2, ty - 9 * dpr, tw, 18 * dpr, 4 * dpr);
      ctx.fill();
      ctx.fillStyle = selected ? '#fff' : col('--text');
      ctx.fillText(text, tx, ty + 0.5);
    }
    if (this.sel?.type === 'edge') {
      const a = pts[this.sel.i], b = pts[(this.sel.i + 1) % n];
      ctx.lineWidth = 5 * dpr;
      ctx.strokeStyle = col('--accent');
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }

    // Openings
    for (const o of this.s.openings) {
      const st = OPENING_STYLE[o.type];
      const [x0, y1] = this.toScreen(o.x, o.y + o.h);
      const w = o.w * this.view.k, h = o.h * this.view.k;
      ctx.fillStyle = st.fill;
      ctx.fillRect(x0, y1, w, h);
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.lineWidth = (this.sel?.id === o.id ? 2.5 : 1.5) * dpr;
      ctx.strokeStyle = st.stroke;
      ctx.strokeRect(x0, y1, w, h);
      ctx.setLineDash([]);
      if (w > 34 * dpr && h > 22 * dpr) {
        ctx.fillStyle = st.stroke;
        ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
        ctx.fillText(st.label, x0 + w / 2, y1 + h / 2 - (h > 44 * dpr ? 8 * dpr : 0));
        if (h > 44 * dpr) {
          ctx.font = `${10 * dpr}px system-ui, sans-serif`;
          ctx.fillText(`${Math.round(o.w)}×${Math.round(o.h)}`, x0 + w / 2, y1 + h / 2 + 8 * dpr);
        }
      }
      if (this.sel?.id === o.id) {
        for (const [cx, cy] of openingCorners(o)) {
          const [sx, sy] = this.toScreen(cx, cy);
          handle(ctx, sx, sy, 7 * dpr, st.stroke, true);
        }
      }
    }

    // Vertices
    this.s.outline.forEach((p, i) => {
      const [sx, sy] = this.toScreen(...p);
      const selected = this.sel?.type === 'vertex' && this.sel.i === i;
      handle(ctx, sx, sy, (selected ? 10 : 8) * dpr, col('--accent'), selected);
    });
  }
}

function openingCorners(o) {
  return [[o.x, o.y, 'bl'], [o.x + o.w, o.y, 'br'], [o.x + o.w, o.y + o.h, 'tr'], [o.x, o.y + o.h, 'tl']];
}

function handle(ctx, x, y, r, color, filled) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = filled ? color : '#fff';
  ctx.fill();
  ctx.lineWidth = 2.5 * (window.devicePixelRatio || 1);
  ctx.strokeStyle = color;
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}

export function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
