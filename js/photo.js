// Photo handling: load, perspective correction from 4 marked corners, and the
// rectangle aspect-ratio estimate (Zhang & He, "Whiteboard scanning", 2003) that lets the
// user measure only one side of the wall.

const MAX_SIDE = 2000;

export async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not open this image.'));
      i.src = url;
    });
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Corners are degenerate.');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// 3x3 homography (row-major, h33 = 1) mapping src[i] -> dst[i].
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return [...solve(A, b), 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Width/height ratio of the real rectangle whose corners appear at tl, tr, bl, br (pixels).
// Assumes the principal point is the image centre and square pixels (true for uncropped
// phone photos). Falls back to a typical phone focal length when it cannot be solved.
export function estimateAspect(corners, imgW, imgH) {
  const { tl, tr, bl, br } = corners;
  const m1 = [...tl, 1], m2 = [...tr, 1], m3 = [...bl, 1], m4 = [...br, 1];
  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const u0 = imgW / 2, v0 = imgH / 2;
  const a2 = [n2[0] - u0 * n2[2], n2[1] - v0 * n2[2]];
  const a3 = [n3[0] - u0 * n3[2], n3[1] - v0 * n3[2]];
  const side = Math.max(imgW, imgH);
  let f2 = -(a2[0] * a3[0] + a2[1] * a3[1]) / (n2[2] * n3[2]);
  let solved = true;
  if (!isFinite(f2) || f2 < (0.4 * side) ** 2 || f2 > (4 * side) ** 2) {
    f2 = (0.75 * side) ** 2;
    solved = false;
  }
  const len2 = (a, n) => a[0] * a[0] + a[1] * a[1] + f2 * n * n;
  return { ratio: Math.sqrt(len2(a2, n2[2]) / len2(a3, n3[2])), solved };
}

// Warp the photo so that the marked rectangle becomes width x height mm, viewed straight on.
// Returns a JPEG data URL plus the wall-coordinate rectangle it covers (y up from the floor).
export function rectify(photo, corners, width, height, margin = 0.15) {
  const H = homography(
    [[0, height], [width, height], [width, 0], [0, 0]],
    [corners.tl, corners.tr, corners.br, corners.bl],
  );
  const mx = width * margin, my = height * margin;
  const rect = { x0: -mx, y0: -my, x1: width + mx, y1: height + my };
  const rw = rect.x1 - rect.x0, rh = rect.y1 - rect.y0;
  const scale = 1400 / Math.max(rw, rh); // px per mm
  const ow = Math.round(rw * scale), oh = Math.round(rh * scale);
  const src = photo.getContext('2d').getImageData(0, 0, photo.width, photo.height);
  const out = new ImageData(ow, oh);
  const sw = photo.width, sh = photo.height, s = src.data, d = out.data;
  for (let py = 0; py < oh; py++) {
    const wy = rect.y1 - (py + 0.5) / scale;
    for (let px = 0; px < ow; px++) {
      const wx = rect.x0 + (px + 0.5) / scale;
      const den = H[6] * wx + H[7] * wy + H[8];
      const o = (py * ow + px) * 4;
      if (den <= 0) { d[o + 3] = 0; continue; }
      const ix = (H[0] * wx + H[1] * wy + H[2]) / den - 0.5;
      const iy = (H[3] * wx + H[4] * wy + H[5]) / den - 0.5;
      if (ix < 0 || iy < 0 || ix >= sw - 1 || iy >= sh - 1) { d[o + 3] = 0; continue; }
      const x0 = ix | 0, y0 = iy | 0, fx = ix - x0, fy = iy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        d[o + c] = (s[i00 + c] * (1 - fx) + s[i10 + c] * fx) * (1 - fy)
          + (s[i01 + c] * (1 - fx) + s[i11 + c] * fx) * fy;
      }
      d[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = ow; c.height = oh;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ow, oh);
  const tmp = document.createElement('canvas');
  tmp.width = ow; tmp.height = oh;
  tmp.getContext('2d').putImageData(out, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  return { dataUrl: c.toDataURL('image/jpeg', 0.72), ...rect };
}

// Interactive corner marking on the original photo.
export class CornerPicker {
  constructor(canvas, photo, onChange) {
    this.canvas = canvas;
    this.photo = photo;
    this.onChange = onChange;
    const w = photo.width, h = photo.height;
    this.corners = {
      tl: [w * 0.2, h * 0.2], tr: [w * 0.8, h * 0.2],
      br: [w * 0.8, h * 0.8], bl: [w * 0.2, h * 0.8],
    };
    this.drag = null;
    this.resize();
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  destroy() { this.ro.disconnect(); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = Math.round(Math.min(window.innerHeight * 0.62, cw * this.photo.height / this.photo.width));
    if (this.canvas.style.height !== `${ch}px`) this.canvas.style.height = `${ch}px`;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.k = Math.min(this.canvas.width / this.photo.width, this.canvas.height / this.photo.height);
    this.ox = (this.canvas.width - this.photo.width * this.k) / 2;
    this.oy = (this.canvas.height - this.photo.height * this.k) / 2;
    this.draw();
  }

  toScreen([x, y]) { return [this.ox + x * this.k, this.oy + y * this.k]; }

  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
  }

  down(e) {
    const [sx, sy] = this.eventPoint(e);
    const hit = 34 * (this.canvas.width / this.canvas.getBoundingClientRect().width);
    let best = null, bestD = hit;
    for (const [name, p] of Object.entries(this.corners)) {
      const [px, py] = this.toScreen(p);
      const d = Math.hypot(px - sx, py - sy);
      if (d < bestD) { best = name; bestD = d; }
    }
    if (!best) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const [px, py] = this.toScreen(this.corners[best]);
    this.drag = { name: best, dx: px - sx, dy: py - sy, at: [sx, sy] };
    this.draw();
  }

  move(e) {
    if (!this.drag) return;
    e.preventDefault();
    const [sx, sy] = this.eventPoint(e);
    const x = (sx + this.drag.dx - this.ox) / this.k;
    const y = (sy + this.drag.dy - this.oy) / this.k;
    this.corners[this.drag.name] = [
      Math.min(this.photo.width, Math.max(0, x)),
      Math.min(this.photo.height, Math.max(0, y)),
    ];
    this.drag.at = [sx, sy];
    this.draw();
  }

  up() {
    if (!this.drag) return;
    this.drag = null;
    this.draw();
    this.onChange?.();
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    const { width: W, height: H } = this.canvas;
    const dpr = W / (this.canvas.getBoundingClientRect().width || W);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.photo, this.ox, this.oy, this.photo.width * this.k, this.photo.height * this.k);
    const order = ['tl', 'tr', 'br', 'bl'];
    const pts = order.map(n => this.toScreen(this.corners[n]));
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(14, 116, 144, 0.18)';
    ctx.fill();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = '#06b6d4';
    ctx.stroke();
    const labels = { tl: 'TL', tr: 'TR', br: 'BR', bl: 'BL' };
    order.forEach((n, i) => {
      const [x, y] = pts[i];
      ctx.beginPath();
      ctx.arc(x, y, 13 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = this.drag?.name === n ? 'rgba(6,182,212,0.55)' : 'rgba(255,255,255,0.35)';
      ctx.fill();
      ctx.lineWidth = 2.5 * dpr;
      ctx.strokeStyle = '#06b6d4';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(labels[n], x, y - 18 * dpr);
    });
    if (this.drag) this.drawLoupe(ctx, dpr);
  }

  // Magnified view so the finger does not hide the corner being placed.
  drawLoupe(ctx, dpr) {
    const p = this.corners[this.drag.name];
    const [sx] = this.toScreen(p);
    const r = 62 * dpr, zoom = 3;
    const cx = sx < this.canvas.width / 2 ? this.canvas.width - r - 10 * dpr : r + 10 * dpr;
    const cy = r + 10 * dpr;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    const k = this.k * zoom;
    ctx.drawImage(this.photo, cx - p[0] * k, cy - p[1] * k, this.photo.width * k, this.photo.height * k);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
}
