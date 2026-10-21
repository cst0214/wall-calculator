// AR measuring with the phone camera (WebXR "immersive-ar": Chrome on Android with Google Play
// Services for AR). The phone finds the floor; the wall is taken as the upright plane through the
// two bottom corners, so the top corners are where the aim line meets that plane. That way a plain
// white wall works too: only the floor needs to be recognised.
//
// Two modes:
//   'size'  – bottom-left, bottom-right, top edge  -> { w, h }
//   'photo' – bottom-left, bottom-right, both top corners, then a camera photo
//             -> { w, hl, hr, photo: { canvas, corners: { tl, tr, br, bl } } }  (photo is null
//                when this phone does not give camera access; the sizes are still returned)
// All results are in mm. Resolves null when cancelled.

const UP = [0, 1, 0];

// ---------- vector / matrix helpers (exported for tests) ----------

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

// Where a ray meets a plane; null if it runs parallel or the plane is behind.
export function rayPlane(origin, dir, point, normal) {
  const den = v3.dot(dir, normal);
  if (Math.abs(den) < 1e-6) return null;
  const t = v3.dot(v3.sub(point, origin), normal) / den;
  return t > 0 ? v3.add(origin, v3.scale(dir, t)) : null;
}

// The wall: upright plane through the two bottom corners.
export function wallFrame(bl, br) {
  const along = v3.norm([br[0] - bl[0], 0, br[2] - bl[2]]);
  return { along, normal: v3.norm(v3.cross(along, UP)), floorY: (bl[1] + br[1]) / 2, origin: bl };
}

export const horizontalDist = (a, b) => Math.hypot(b[0] - a[0], b[2] - a[2]);

// 4x4 column-major matrices, as WebXR gives them.
export function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// World point -> normalised device coordinates [-1..1] (y up); null if behind the camera.
export function toNdc(m, p) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return w > 1e-6 ? [x / w, y / w] : null;
}

// NDC -> pixel position in an image or screen of w x h (y down).
export const ndcToPx = ([x, y], w, h) => [(x + 1) / 2 * w, (1 - y) / 2 * h];

// The 4 corners of the wall in 3D (metres). Top height is the larger of the two when sloped.
export function wallCorners3d(frame, width, height) {
  const bl = [frame.origin[0], frame.floorY, frame.origin[2]];
  const br = v3.add(bl, v3.scale(frame.along, width));
  return { bl, br, tr: v3.add(br, v3.scale(UP, height)), tl: v3.add(bl, v3.scale(UP, height)) };
}

// ---------- support check ----------

export async function arSupport() {
  const res = { ar: false, photo: false };
  if (!window.isSecureContext || !navigator.xr?.isSessionSupported) return res;
  try { res.ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch { /* not supported */ }
  res.photo = res.ar && typeof window.XRWebGLBinding === 'function' && 'getCameraImage' in window.XRWebGLBinding.prototype;
  return res;
}

// ---------- the AR session ----------

const STEPS = {
  size: [
    { key: 'bl', kind: 'floor', text: 'Aim the + at the <b>bottom-left corner</b> of the wall, where the wall meets the floor. Then tap <b>Add point</b>.' },
    { key: 'br', kind: 'floor', text: 'Now aim at the <b>bottom-right corner</b>, where the wall meets the floor.' },
    { key: 'top', kind: 'wall', text: 'Now aim at the <b>top edge</b> of the wall, where it meets the ceiling.' },
  ],
  photo: [
    { key: 'bl', kind: 'floor', text: 'Aim the + at the <b>bottom-left corner</b> of the wall, where the wall meets the floor. Then tap <b>Add point</b>.' },
    { key: 'br', kind: 'floor', text: 'Now aim at the <b>bottom-right corner</b>, where the wall meets the floor.' },
    { key: 'tr', kind: 'wall', text: 'Now aim at the <b>top-right corner</b> of the wall.' },
    { key: 'tl', kind: 'wall', text: 'Now aim at the <b>top-left corner</b> of the wall.' },
  ],
};

const mm = m => `${Math.round(m * 1000).toLocaleString('en')} mm`;

// Must be called straight from a tap (the browser only opens AR on a user action).
export function runAr(mode) {
  const steps = STEPS[mode];
  const ui = buildOverlay();
  document.body.append(ui.root);

  return new Promise(resolve => {
    let session = null, result = null, finished = false;

    const finish = res => {
      if (finished) return;
      finished = true;
      result = res;
      if (session) session.end().catch(() => done());
      else done();
    };
    const done = () => {
      ui.root.remove();
      resolve(result);
    };

    navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'dom-overlay'],
      optionalFeatures: mode === 'photo' ? ['camera-access'] : [],
      domOverlay: { root: ui.root },
    }).then(s => {
      session = s;
      session.addEventListener('end', done);
      if (finished) { session.end().catch(() => {}); return; }
      start(session, mode, steps, ui, finish).catch(err => finish({ error: err?.message || 'AR stopped unexpectedly.' }));
    }).catch(err => {
      result = { error: err?.message || 'AR could not start on this phone.' };
      finished = true;
      done();
    });
  });
}

async function start(session, mode, steps, ui, finish) {
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false });
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  const local = await session.requestReferenceSpace('local');
  const viewer = await session.requestReferenceSpace('viewer');
  let hitSource;
  try {
    hitSource = await session.requestHitTestSource({ space: viewer, entityTypes: ['plane', 'point'] });
  } catch {
    hitSource = await session.requestHitTestSource({ space: viewer });
  }
  const cameraOk = mode === 'photo' && (session.enabledFeatures ? session.enabledFeatures.includes('camera-access') : true)
    && typeof XRWebGLBinding === 'function';
  const binding = cameraOk ? new XRWebGLBinding(session, gl) : null;

  let pts = {}; // placed points (metres, local space)
  const undoStack = []; // pts before each tap, so Undo point takes back exactly the last tap
  let stepIdx = 0, aim = null, wantPhoto = false, capturing = false, waitFrames = 0;
  let lastFloorHit = null;

  const frameOf = () => (pts.bl && pts.br ? wallFrame(pts.bl, pts.br) : null);

  // Sizes from the points so far (metres).
  function sizes(extra = {}) {
    const p = { ...pts, ...extra };
    const out = {};
    if (p.bl && p.br) out.w = horizontalDist(p.bl, p.br);
    const f = p.bl && p.br ? wallFrame(p.bl, p.br) : null;
    if (f) for (const k of ['top', 'tl', 'tr']) if (p[k]) out[k] = p[k][1] - f.floorY;
    return out;
  }

  function refreshUi() {
    const step = steps[stepIdx];
    ui.undo.disabled = stepIdx === 0 || wantPhoto;
    if (step) {
      ui.stepNo.textContent = `Step ${stepIdx + 1} of ${steps.length + (mode === 'photo' ? 1 : 0)}`;
      ui.text.innerHTML = step.text;
      ui.add.textContent = 'Add point';
      return;
    }
    const s = sizes();
    if (mode === 'size') {
      ui.stepNo.textContent = 'Done';
      ui.text.innerHTML = `Width <b>${mm(s.w)}</b> · Height <b>${mm(s.top)}</b><br><small>Tap Undo point to redo the last point.</small>`;
      ui.add.textContent = 'Use these sizes';
    } else if (cameraOk) {
      ui.stepNo.textContent = `Step ${steps.length + 1} of ${steps.length + 1}`;
      ui.text.innerHTML = 'Step back until the <b>whole wall</b> fits on the screen, hold the phone still, then tap <b>Take photo</b>.';
      ui.add.textContent = 'Take photo';
    } else {
      ui.stepNo.textContent = 'Done';
      ui.text.innerHTML = `Width <b>${mm(s.w)}</b> · Height <b>${mm((s.tl + s.tr) / 2)}</b><br><small>This phone cannot take the photo inside AR. Tap Continue, then take a normal photo.</small>`;
      ui.add.textContent = 'Continue';
    }
  }

  function result() {
    const s = sizes();
    if (mode === 'size') return { w: s.w * 1000, h: s.top * 1000 };
    return { w: s.w * 1000, hl: s.tl * 1000, hr: s.tr * 1000, photo: null };
  }

  ui.add.addEventListener('click', () => {
    const step = steps[stepIdx];
    if (step) {
      if (!aim) return;
      if (step.key === 'br' && horizontalDist(pts.bl, aim) < 0.1) {
        ui.holdUntil = 0; setStatus(ui, 'That is the same corner. Aim at the other bottom corner.'); ui.holdUntil = Date.now() + 3000;
        return;
      }
      undoStack.push({ ...pts });
      pts[step.key] = aim;
      // Left and right are decided by where the points are, not the order they were tapped in.
      if (step.key === 'br' && v3.dot(v3.sub(pts.br, pts.bl), ui.camRight || [1, 0, 0]) < 0) [pts.bl, pts.br] = [pts.br, pts.bl];
      stepIdx++;
      if (!steps[stepIdx] && mode === 'photo') {
        const f = frameOf();
        const along = p => v3.dot(v3.sub(p, f.origin), f.along);
        if (along(pts.tl) > along(pts.tr)) [pts.tl, pts.tr] = [pts.tr, pts.tl];
      }
      refreshUi();
      return;
    }
    if (mode === 'photo' && cameraOk) { wantPhoto = true; waitFrames = 0; ui.add.disabled = true; ui.text.innerHTML = 'Hold still…'; return; }
    finish(result());
  });
  ui.undo.addEventListener('click', () => {
    if (stepIdx === 0 || wantPhoto) return;
    stepIdx--;
    pts = undoStack.pop();
    refreshUi();
  });
  ui.cancel.addEventListener('click', () => finish(null));
  refreshUi();

  const onFrame = (t, frame) => {
    if (capturing) return;
    session.requestAnimationFrame(onFrame);
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const pose = frame.getViewerPose(local);
    if (!pose) { setStatus(ui, 'Move the phone slowly…'); return; }
    const m = pose.transform.matrix;
    const origin = [m[12], m[13], m[14]];
    const fwd = v3.norm([-m[8], -m[9], -m[10]]);
    ui.camRight = v3.norm([m[0], 0, m[2]]);

    // What the + is pointing at for the current step.
    const step = steps[stepIdx];
    aim = null;
    const hits = frame.getHitTestResults(hitSource);
    const hitPose = hits.length ? hits[0].getPose(local) : null;
    const hitP = hitPose ? [hitPose.transform.position.x, hitPose.transform.position.y, hitPose.transform.position.z] : null;
    if (hitP) lastFloorHit = hitP;
    if (step?.kind === 'floor') {
      // First corner: needs the phone to have found the floor. Second: same floor height.
      if (step.key === 'bl') aim = hitP;
      else aim = rayPlane(origin, fwd, [0, pts.bl[1], 0], UP) || hitP;
    } else if (step?.kind === 'wall') {
      const f = frameOf();
      aim = rayPlane(origin, fwd, f.origin, f.normal);
    }
    ui.add.disabled = wantPhoto || (!!step && !aim);
    if (step && !aim) setStatus(ui, step.key === 'bl' && !lastFloorHit
      ? 'Looking for the floor… move the phone slowly and point at the floor.'
      : 'Point the + at the wall.');
    else setStatus(ui, '');

    const view = pose.views[0];
    const vp = mul4(view.projectionMatrix, view.transform.inverse.matrix);

    if (wantPhoto && binding) {
      const camView = pose.views.find(v => v.camera);
      if (camView) {
        capturing = true;
        try {
          const shot = grabCamera(gl, binding, camView);
          const s = sizes();
          const h = Math.max(s.tl, s.tr);
          const c3 = wallCorners3d(frameOf(), s.w, h);
          const cvp = mul4(camView.projectionMatrix, camView.transform.inverse.matrix);
          const corners = {};
          for (const k of ['tl', 'tr', 'br', 'bl']) {
            const n = toNdc(cvp, c3[k]);
            if (!n) throw new Error('The wall is behind the camera. Step back and try again.');
            corners[k] = ndcToPx(n, shot.width, shot.height);
          }
          finish({ ...result(), photo: { canvas: shot, corners } });
        } catch (err) {
          capturing = false;
          wantPhoto = false;
          ui.add.disabled = false;
          refreshUi();
          ui.holdUntil = 0; setStatus(ui, err.message || 'Could not take the photo. Try again.'); ui.holdUntil = Date.now() + 4000;
        }
        return;
      }
      // No camera picture after ~2 seconds: keep the sizes, the photo is taken normally instead.
      if (++waitFrames > 120) { finish(result()); return; }
    }

    drawOverlay(ui, vp, pts, aim, step, frameOf(), sizes(aim && step ? { [step.key]: aim } : {}), mode, !step && mode === 'photo' ? sizes() : null);
  };
  session.requestAnimationFrame(onFrame);
}

// Copies the camera picture of this frame into a normal canvas.
function grabCamera(gl, binding, view) {
  const cam = view.camera;
  const w = cam.width, h = cam.height;
  const tex = binding.getCameraImage(cam);
  if (!tex) throw new Error('The camera picture is not ready. Try again.');

  const vs = 'attribute vec2 p; varying vec2 uv; void main(){ gl_Position = vec4(p, 0.0, 1.0); uv = (p + 1.0) * 0.5; }';
  const fs = 'precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, uv); }';
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);

  const target = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, target);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.useProgram(prog);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, 't'), 0);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // WebGL rows start at the bottom; canvas rows start at the top.
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  ctx.putImageData(img, 0, 0);
  return out;
}

// ---------- on-screen drawing ----------

function drawOverlay(ui, vp, pts, aim, step, frame, live, mode, finalSizes) {
  const c = ui.canvas;
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth, H = window.innerHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const scr = p => { const n = toNdc(vp, p); return n ? ndcToPx(n, W, H) : null; };

  const line = (a, b, colour, label) => {
    const sa = scr(a), sb = scr(b);
    if (!sa || !sb) return;
    ctx.strokeStyle = colour; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(...sa); ctx.lineTo(...sb); ctx.stroke();
    if (label) pill(ctx, (sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2, label);
  };
  const dot = (p, colour) => {
    const s = scr(p);
    if (!s) return;
    ctx.fillStyle = colour; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(s[0], s[1], 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  };

  const all = { ...pts };
  if (aim && step) all[step.key] = aim;
  const floorPt = p => (frame ? [p[0], frame.floorY, p[2]] : p);

  if (all.bl && all.br) line(all.bl, all.br, '#22d3ee', live.w ? mm(live.w) : '');
  if (frame) {
    if (all.top) line(floorPt(all.top), all.top, '#fbbf24', live.top ? mm(live.top) : '');
    if (all.tr) line(all.br, all.tr, '#fbbf24', live.tr ? mm(live.tr) : '');
    if (all.tl) line(all.bl, all.tl, '#fbbf24', live.tl ? mm(live.tl) : '');
    if (all.tl && all.tr) line(all.tl, all.tr, '#22d3ee', '');
  }
  for (const k of Object.keys(pts)) dot(pts[k], '#0f766e');

  // Final step of photo mode: show the wall frame so the whole wall can be fitted on screen.
  if (finalSizes && frame) {
    const c3 = wallCorners3d(frame, finalSizes.w, Math.max(finalSizes.tl, finalSizes.tr));
    const s = ['bl', 'br', 'tr', 'tl'].map(k => scr(c3[k]));
    const inside = s.every(p => p && p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H);
    if (s.every(Boolean)) {
      ctx.strokeStyle = inside ? '#22c55e' : '#ef4444'; ctx.lineWidth = 3; ctx.setLineDash([10, 6]);
      ctx.beginPath(); s.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
    }
    setStatus(ui, inside ? '' : 'Part of the wall is off the screen. Step back a little.');
  }

  // The + shows exactly where the phone is aiming.
  const target = aim ? scr(aim) : [W / 2, H / 2];
  if (target && step) {
    const [x, y] = target;
    ctx.strokeStyle = aim ? '#ffffff' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x - 18, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 18, y);
    ctx.moveTo(x, y - 18); ctx.lineTo(x, y - 5); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 18);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2); ctx.stroke();
  }
}

// An error message stays up for a few seconds before normal hints replace it.
function setStatus(ui, text) {
  if (Date.now() < (ui.holdUntil || 0)) return;
  if (ui.status.textContent !== text) ui.status.textContent = text;
}

function pill(ctx, x, y, text) {
  ctx.font = '700 15px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 16;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - 14, w, 28, 8); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
}

function buildOverlay() {
  const root = document.createElement('div');
  root.className = 'ar-ui';
  root.innerHTML = `
    <canvas class="ar-draw"></canvas>
    <div class="ar-top">
      <div class="ar-step"></div>
      <div class="ar-text"></div>
      <div class="ar-status" role="status"></div>
    </div>
    <div class="ar-bottom">
      <button type="button" class="ar-btn" data-ar="cancel">Cancel</button>
      <button type="button" class="ar-btn" data-ar="undo">Undo point</button>
      <button type="button" class="ar-btn main" data-ar="add" disabled>Add point</button>
    </div>`;
  // Taps on the buttons must not also count as taps in the AR scene.
  root.addEventListener('beforexrselect', e => e.preventDefault());
  return {
    root,
    canvas: root.querySelector('.ar-draw'),
    stepNo: root.querySelector('.ar-step'),
    text: root.querySelector('.ar-text'),
    status: root.querySelector('.ar-status'),
    add: root.querySelector('[data-ar="add"]'),
    undo: root.querySelector('[data-ar="undo"]'),
    cancel: root.querySelector('[data-ar="cancel"]'),
  };
}
