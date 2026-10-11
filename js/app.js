import {
  COMPANY, DEFAULT_SETTINGS, TILE_DESIGNS, WPC_COLOURS, loadSettings, materialLabel, saveSettings,
} from './catalog.js';
import { calculate, surfaceRegions } from './calc.js';
import { bboxOf, rectPoly, regionArea } from './geometry.js';
import { WallEditor } from './editor.js';
import { CornerPicker, estimateAspect, loadPhoto, rectify } from './photo.js';
import { layoutSvg, previewSvg } from './render.js';

const PROJECT_KEY = 'balentino-calc-project-v1';
const app = document.getElementById('app');

const state = {
  project: loadProject(),
  settings: loadSettings(),
  view: 'home',
  editId: null,
  photo: null, // canvas being calibrated
};

const photoCache = new Map();
let cleanup = null;

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => Math.random().toString(36).slice(2, 10);
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const m2 = a => (a / 1e6).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = n => Math.round(n).toLocaleString('en');
const pct = n => n.toLocaleString('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// action: optional { label, run } shown as a button inside the toast (e.g. Undo).
function toast(msg, action) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  t.classList.toggle('has-action', !!action);
  if (action) t.querySelector('button').addEventListener('click', () => { t.classList.remove('show'); action.run(); });
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
}

function newProject() { return { name: 'My project', surfaces: [] }; }

function loadProject() {
  try {
    const p = JSON.parse(localStorage.getItem(PROJECT_KEY) || 'null');
    if (p && Array.isArray(p.surfaces)) return p;
  } catch { /* fall through */ }
  return newProject();
}

// ---------- undo / redo ----------
// Every save() is one undo step: the state from the previous save goes on the undo stack.
// Saves with the same tag in quick succession (typing in one box) merge into one step.
// Photos never change after a wall is created, so snapshots share them instead of copying.

const cloneSurface = s => ({ ...structuredClone({ ...s, photo: null }), photo: s.photo });
const snapshot = p => ({ name: p.name, surfaces: p.surfaces.map(cloneSurface) });
const snapKey = sn => JSON.stringify(sn, (k, v) => (k === 'photo' ? !!v : v));
const undoStack = [], redoStack = [];
let lastSaved = snapshot(state.project), lastTag = null, lastTagTime = 0;

function save(tag) {
  const now = Date.now();
  const cur = snapshot(state.project);
  if (snapKey(cur) !== snapKey(lastSaved)) {
    if (!(tag && tag === lastTag && now - lastTagTime < 1500)) {
      undoStack.push(lastSaved);
      if (undoStack.length > 100) undoStack.shift();
    }
    redoStack.length = 0;
    lastSaved = cur;
  }
  lastTag = tag || null;
  lastTagTime = now;
  updateUndoButtons();
  persist();
}

function restore(sn) {
  state.project = { name: sn.name, surfaces: sn.surfaces.map(cloneSurface) };
  lastSaved = snapshot(state.project);
  lastTag = null;
  persist();
  if (state.view === 'edit' && !state.project.surfaces.some(s => s.id === state.editId)) {
    state.view = 'home';
    history.replaceState({ view: 'home' }, '');
  }
  if (state.view === 'home' || state.view === 'edit') render({ keepScroll: true });
  updateUndoButtons();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(lastSaved);
  restore(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(lastSaved);
  restore(redoStack.pop());
}

function updateUndoButtons() {
  app.querySelectorAll('[data-act="undo"]').forEach(b => { b.disabled = !undoStack.length; });
  app.querySelectorAll('[data-act="redo"]').forEach(b => { b.disabled = !redoStack.length; });
}

const undoButtons = () => `
  <button class="icon-btn" data-act="undo" aria-label="Undo" title="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg></button>
  <button class="icon-btn" data-act="redo" aria-label="Redo" title="Redo"><svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg></button>`;

document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest('input, textarea, select') || !['home', 'edit'].includes(state.view)) return;
  e.preventDefault();
  if (e.shiftKey) redo(); else undo();
});

let saveTimer = 0, warnedPhotos = false;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(PROJECT_KEY, JSON.stringify(state.project));
    } catch {
      try {
        const lite = structuredClone(state.project);
        for (const s of lite.surfaces) if (s.photo) s.photo.dataUrl = null;
        localStorage.setItem(PROJECT_KEY, JSON.stringify(lite));
        if (!warnedPhotos) { warnedPhotos = true; toast('Phone storage is full: photos will not be kept after closing.'); }
      } catch { /* storage unavailable */ }
    }
  }, 250);
}

function photoOf(s) {
  if (!s.photo?.dataUrl) return null;
  let img = photoCache.get(s.id);
  if (!img || img.src !== s.photo.dataUrl) {
    img = new Image();
    img.src = s.photo.dataUrl;
    photoCache.set(s.id, img);
  }
  return { img, ...s.photo };
}

function defaultMaterial() {
  const last = state.project.surfaces[state.project.surfaces.length - 1];
  return last ? structuredClone(last.material) : {
    type: 'wpc', profile: '24', colour: WPC_COLOURS[0].code, orientation: 'vertical',
    design: 'FFT 1004 TT', gap: 0, align: 'left',
  };
}

const TRASH_ICON = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/></svg>';
const X_ICON = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// No confirm dialog: the toast offers Undo instead.
function deleteSurface(s) {
  state.project.surfaces = state.project.surfaces.filter(x => x !== s);
  save();
  toast(`${s.name} deleted`, { label: 'Undo', run: undo });
  if (state.view === 'edit') back();
  else render({ keepScroll: true });
}

function nextName(prefix) {
  const used = new Set(state.project.surfaces.map(s => s.name));
  for (let i = 1; ; i++) if (!used.has(`${prefix} ${i}`)) return `${prefix} ${i}`;
}

function surfaceSize(s) {
  if (s.kind === 'round-column') return `Round column Ø${int(s.diameter)} × ${int(s.height)} mm`;
  if (s.kind === 'rect-column') return `Square column ${int(s.width)} × ${int(s.depth)} × ${int(s.height)} mm`;
  const b = bboxOf([s.outline]);
  const n = s.openings.length;
  return `${int(b.x1 - b.x0)} × ${int(b.y1 - b.y0)} mm${n ? ` · ${n} opening${n > 1 ? 's' : ''}` : ''}`;
}

function surfaceNetArea(s) {
  return surfaceRegions(s).reduce((t, r) => t + regionArea({ outer: r.region.outer, holes: [...r.region.holes, ...r.cutouts] }), 0);
}

// ---------- navigation ----------

function go(view, opts = {}) {
  if (opts.replace) history.replaceState({ view, editId: state.editId }, '');
  else if (view !== 'home') history.pushState({ view, editId: state.editId }, '');
  state.view = view;
  render();
}

window.addEventListener('popstate', e => {
  const v = e.state?.view || 'home';
  if (v === 'calibrate' && !state.photo) { state.view = 'home'; render(); return; }
  state.view = v;
  if (e.state?.editId) state.editId = e.state.editId;
  if ((v === 'edit') && !state.project.surfaces.find(s => s.id === state.editId)) state.view = 'home';
  render();
});

function back() {
  if (history.state?.view && history.state.view !== 'home') history.back();
  else { state.view = 'home'; render(); }
}

function render({ keepScroll = false } = {}) {
  cleanup?.();
  cleanup = null;
  const y = window.scrollY;
  ({ home: renderHome, calibrate: renderCalibrate, edit: renderEdit, results: renderResults, settings: renderSettings })[state.view]();
  window.scrollTo(0, keepScroll ? y : 0);
  updateUndoButtons();
  on(app, 'undo', undo);
  on(app, 'redo', redo);
}

function topbar(title, { backBtn = true, right = '' } = {}) {
  return `<header class="topbar">
    ${backBtn ? '<button class="icon-btn" data-act="back" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>' : '<span class="brand-mark" aria-hidden="true"></span>'}
    <h1>${title}</h1>
    <div class="topbar-right">${right}</div>
  </header>`;
}

function on(root, act, fn) {
  root.querySelectorAll(`[data-act="${act}"]`).forEach(el => el.addEventListener('click', fn));
}

// ---------- home ----------

function renderHome() {
  const p = state.project;
  const cards = p.surfaces.map(s => {
    const regions = surfaceRegions(s);
    return `<div class="surface-row">
      <button class="surface-card" data-edit="${s.id}">
        <div class="thumb">${previewSvg(regions[0].region)}</div>
        <div class="sc-body">
          <div class="sc-title">${esc(s.name)}${s.qty > 1 ? ` <span class="badge">× ${s.qty}</span>` : ''}</div>
          <div class="sc-sub">${esc(surfaceSize(s))}</div>
          <div class="sc-mat"><span class="dot ${s.material.type}"></span>${esc(materialLabel(s.material))}</div>
        </div>
        <div class="sc-area">${m2(surfaceNetArea(s) * (s.qty || 1))}<small>m²</small></div>
      </button>
      <button class="icon-btn trash" data-del="${s.id}" aria-label="Delete ${esc(s.name)}" title="Delete">${TRASH_ICON}</button>
    </div>`;
  }).join('');

  app.innerHTML = `
    ${topbar('Wall Calculator', {
      backBtn: false,
      right: `${undoButtons()}<button class="icon-btn" data-act="settings" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></svg></button>`,
    })}
    <main class="page">
      <div class="project-row">
        <label class="field grow"><span>Project</span><input id="p-name" value="${esc(p.name)}" autocomplete="off"></label>
        <button class="ghost" data-act="new">New</button>
      </div>
      ${p.surfaces.length ? `<div class="surface-list">${cards}</div>` : `
        <section class="empty">
          <h2>Work out how many panels or tiles a job needs</h2>
          <ol>
            <li><b>Add each wall or column.</b> Take a photo and measure one side, or type the sizes in.</li>
            <li><b>Mark doors, windows, sockets, missing corners and slopes</b> on the drawing.</li>
            <li><b>Calculate.</b> You get the pieces to order, a cutting plan, and how much is wasted.</li>
          </ol>
        </section>`}
      <h2 class="section-label">Add a surface</h2>
      <div class="add-grid">
        <label class="add-btn">
          <input type="file" accept="image/*" id="photo-input" hidden>
          <svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
          <span>Wall from photo</span>
        </label>
        <button class="add-btn" data-act="add-wall">
          <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14"/><path d="M4 9h3M4 13h2M17 19v-3M13 19v-2"/></svg>
          <span>Wall by size</span>
        </button>
        <button class="add-btn" data-act="add-round">
          <svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="5" ry="2"/><path d="M7 5.5v13c0 1.1 2.2 2 5 2s5-.9 5-2v-13"/></svg>
          <span>Round column</span>
        </button>
        <button class="add-btn" data-act="add-square">
          <svg viewBox="0 0 24 24"><path d="M7 6l5-2 5 2v13l-5 2-5-2z"/><path d="M12 4v17M7 6l5 2 5-2"/></svg>
          <span>Square column</span>
        </button>
      </div>
    </main>
    <div class="bottombar">
      <button class="primary wide" data-act="calc" ${p.surfaces.length ? '' : 'disabled'}>Calculate materials</button>
    </div>`;

  app.querySelector('#p-name').addEventListener('input', e => { p.name = e.target.value; save('project-name'); });
  app.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    state.editId = b.dataset.edit; go('edit');
  }));
  app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const s = p.surfaces.find(x => x.id === b.dataset.del);
    if (s) deleteSurface(s);
  }));
  on(app, 'settings', () => go('settings'));
  on(app, 'calc', () => go('results'));
  on(app, 'new', () => {
    if (p.surfaces.length && !confirm('Start a new project? The current one will be cleared.')) return;
    state.project = newProject(); save(); render();
    toast('New project started', { label: 'Undo', run: undo });
  });
  on(app, 'add-wall', () => addSurface({
    kind: 'wall', name: nextName('Wall'), outline: rectPoly(0, 0, 3000, 2800), openings: [], photo: null,
  }));
  on(app, 'add-round', () => addSurface({ kind: 'round-column', name: nextName('Column'), diameter: 400, height: 2800 }));
  on(app, 'add-square', () => addSurface({ kind: 'rect-column', name: nextName('Column'), width: 400, depth: 400, height: 2800 }));
  app.querySelector('#photo-input').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      state.photo = await loadPhoto(file);
      go('calibrate');
    } catch (err) { toast(err.message); }
  });
}

function addSurface(s) {
  const surface = { id: uid(), qty: 1, material: defaultMaterial(), ...s };
  state.project.surfaces.push(surface);
  save();
  state.editId = surface.id;
  go('edit');
}

// ---------- photo calibration ----------

function renderCalibrate() {
  if (!state.photo) { state.view = 'home'; render(); return; }
  app.innerHTML = `
    ${topbar('Mark the wall')}
    <main class="page">
      <p class="lead">Drag the 4 dots onto the corners of the wall. If a corner is hidden or missing, put the dot where the corner would be.</p>
      <canvas id="pick" class="pick-canvas"></canvas>
      <section class="card">
        <div class="seg" role="group" aria-label="Measured side">
          <button data-side="width" aria-pressed="true">I measured the width</button>
          <button data-side="height" aria-pressed="false">I measured the height</button>
        </div>
        <label class="field"><span id="m-label">Width (top dot to top dot), mm</span>
          <input id="m-val" type="number" inputmode="decimal" placeholder="e.g. 3200"></label>
        <div class="estimate" id="estimate"></div>
        <label class="check"><input type="checkbox" id="both"> I measured the other side too (more accurate)</label>
        <label class="field" id="other-wrap" hidden><span id="o-label">Height, mm</span>
          <input id="o-val" type="number" inputmode="decimal"></label>
      </section>
    </main>
    <div class="bottombar"><button class="primary wide" data-act="next" disabled>Continue</button></div>`;

  let side = 'width';
  const picker = new CornerPicker(app.querySelector('#pick'), state.photo, () => update());
  cleanup = () => picker.destroy();
  const mVal = app.querySelector('#m-val'), oVal = app.querySelector('#o-val');
  const both = app.querySelector('#both');

  function dims() {
    const m = num(mVal.value);
    if (!m || m <= 0) return null;
    if (both.checked) {
      const o = num(oVal.value);
      if (!o || o <= 0) return null;
      return side === 'width' ? { w: m, h: o } : { w: o, h: m };
    }
    const { ratio } = estimateAspect(picker.corners, state.photo.width, state.photo.height);
    if (!(ratio > 0.02 && ratio < 50)) return null;
    return side === 'width' ? { w: m, h: m / ratio } : { w: m * ratio, h: m };
  }

  function update() {
    const other = side === 'width' ? 'height' : 'width';
    app.querySelector('#m-label').textContent = side === 'width'
      ? 'Width (between the two top dots), mm' : 'Height (between the two left dots), mm';
    app.querySelector('#o-label').textContent = `${other[0].toUpperCase()}${other.slice(1)}, mm`;
    app.querySelector('#other-wrap').hidden = !both.checked;
    const est = app.querySelector('#estimate');
    const d = dims();
    if (d && !both.checked) {
      const { solved } = estimateAspect(picker.corners, state.photo.width, state.photo.height);
      est.innerHTML = `Estimated ${other}: <b>${int(side === 'width' ? d.h : d.w)} mm</b>
        <small>${solved ? 'Worked out from the photo’s perspective.' : 'Photo taken nearly straight on, so this is a rough estimate.'} Measure it as well for best accuracy.</small>`;
    } else if (!d && !both.checked && num(mVal.value) > 0) {
      est.innerHTML = '<small>The 4 dots do not make a usable shape. Move them onto the wall corners.</small>';
    } else est.innerHTML = '';
    app.querySelector('[data-act="next"]').disabled = !d;
  }

  app.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => {
    side = b.dataset.side;
    app.querySelectorAll('[data-side]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    update();
  }));
  for (const el of [mVal, oVal]) el.addEventListener('input', update);
  both.addEventListener('change', update);
  on(app, 'back', back);
  on(app, 'next', () => {
    const d = dims();
    if (!d) return;
    const w = Math.round(d.w), h = Math.round(d.h);
    let photo = null;
    try { photo = rectify(state.photo, picker.corners, w, h); } catch (err) { toast(err.message); return; }
    const surface = {
      id: uid(), qty: 1, kind: 'wall', name: nextName('Wall'), material: defaultMaterial(),
      outline: rectPoly(0, 0, w, h), openings: [], photo,
    };
    state.project.surfaces.push(surface);
    state.photo = null;
    save();
    state.editId = surface.id;
    go('edit', { replace: true });
  });
  update();
}

// ---------- edit surface ----------

function materialForm(m) {
  const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, label]) =>
    `<button data-set="${key}" data-val="${v}" aria-pressed="${String(m[key]) === String(v)}">${label}</button>`).join('')}</div>`;
  const W = state.settings.wpc;
  return `
    ${seg('type', [['wpc', 'WPC Wall Panel'], ['tile', 'Flexible Tile']])}
    ${m.type === 'wpc' ? `
      <label class="field"><span>Profile</span>${seg('profile', [['24', `24 mm <small>${W[24].width} mm wide</small>`], ['10', `10 mm <small>${W[10].width} mm wide</small>`]])}</label>
      <label class="field"><span>Colour</span><select data-field="colour">
        ${WPC_COLOURS.map(c => `<option value="${c.code}" ${c.code === m.colour ? 'selected' : ''}>${c.code} ${c.name}</option>`).join('')}
      </select></label>
      <label class="field"><span>Panel direction</span>${seg('orientation', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']])}</label>
    ` : `
      <label class="field"><span>Design</span><select data-field="design">
        ${['Granite', 'Travertine'].map(series => `<optgroup label="${series}">${TILE_DESIGNS.filter(d => d.series === series)
          .map(d => `<option value="${d.code}" ${d.code === m.design ? 'selected' : ''}>${d.code} ${d.name}</option>`).join('')}</optgroup>`).join('')}
      </select></label>
      <label class="field"><span>Laying direction (pattern stays the same way)</span>${seg('orientation', [['vertical', `Vertical <small>${state.settings.tile.width}×${state.settings.tile.length}</small>`], ['horizontal', `Horizontal <small>${state.settings.tile.length}×${state.settings.tile.width}</small>`]])}</label>
      <div class="field-row">
        <label class="field grow"><span>Joint between tiles, mm</span>
          <input data-field="gap" type="number" min="0" step="0.5" inputmode="decimal" value="${m.gap || 0}"></label>
        <label class="field grow"><span>First tile starts</span>${seg('align', [['left', 'At left'], ['center', 'Centred']])}</label>
      </div>
      <p class="hint">Joint 0 = tiles butt together with no gap.</p>
    `}`;
}

function bindMaterial(root, m, changed) {
  root.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', e => {
    e.preventDefault();
    m[b.dataset.set] = b.dataset.val;
    changed(b.dataset.set === 'type');
  }));
  root.querySelectorAll('[data-field]').forEach(el => el.addEventListener('change', () => {
    m[el.dataset.field] = el.type === 'number' ? Math.max(0, num(el.value) ?? 0) : el.value;
    changed(false);
  }));
}

function quickResult(s) {
  const res = calculate({ surfaces: [s] }, state.settings);
  const g = res.groups[0];
  if (!g) return '';
  const unit = g.type === 'wpc' ? 'panel' : 'tile';
  return `<div class="quick-grid">
      <div><span>Area to cover</span><b>${m2(g.netArea)} m²</b></div>
      <div><span>${unit[0].toUpperCase() + unit.slice(1)}s needed</span><b>${g.total}</b></div>
      <div><span>Waste</span><b>${pct(g.wastePct)}%</b></div>
    </div>
    <p class="hint">For this surface alone${s.qty > 1 ? ` (× ${s.qty})` : ''}. The project total can be lower, because leftovers get reused on other walls.</p>`;
}

const PRESETS = {
  rect: { label: 'Rectangle', fields: [['w', 'Width'], ['h', 'Height']] },
  corner: { label: 'Missing corner / L-shape', fields: [['w', 'Width'], ['h', 'Height'], ['cw', 'Cut-out width'], ['ch', 'Cut-out height']], corner: true },
  slopeTop: { label: 'Sloped top (slanted ceiling)', fields: [['w', 'Width'], ['hl', 'Height at left'], ['hr', 'Height at right']] },
  slopeBottom: { label: 'Sloped bottom (stair wall)', fields: [['w', 'Width'], ['hl', 'Height at left'], ['hr', 'Height at right']] },
  gable: { label: 'Gable (pointed top)', fields: [['w', 'Width'], ['h', 'Wall height at sides'], ['ph', 'Height at peak']] },
};

function presetOutline(type, v) {
  const { w, h } = v;
  switch (type) {
    case 'rect': return rectPoly(0, 0, w, h);
    case 'corner': {
      const cw = Math.min(v.cw, w - 1), ch = Math.min(v.ch, h - 1);
      return {
        tl: [[0, 0], [w, 0], [w, h], [cw, h], [cw, h - ch], [0, h - ch]],
        tr: [[0, 0], [w, 0], [w, h - ch], [w - cw, h - ch], [w - cw, h], [0, h]],
        bl: [[cw, 0], [w, 0], [w, h], [0, h], [0, ch], [cw, ch]],
        br: [[0, 0], [w - cw, 0], [w - cw, ch], [w, ch], [w, h], [0, h]],
      }[v.corner || 'tr'];
    }
    case 'slopeTop': return [[0, 0], [w, 0], [w, v.hr], [0, v.hl]];
    case 'slopeBottom': {
      const top = Math.max(v.hl, v.hr);
      return [[0, top - v.hl], [w, top - v.hr], [w, top], [0, top]];
    }
    case 'gable': return [[0, 0], [w, 0], [w, h], [w / 2, Math.max(h, v.ph)], [0, h]];
  }
  return null;
}

const OPENING_TYPES = { door: 'Door', window: 'Window', cutout: 'Socket' };

// Shows what "From left" and "From floor" measure.
const OPENING_DIAGRAM = `<svg viewBox="0 0 280 118" class="op-diagram" role="img"
    aria-label="From left: wall's left edge to the opening's left edge. From floor: floor to the opening's bottom edge.">
  <rect x="10" y="6" width="260" height="98" class="d-wall"/>
  <line x1="2" y1="104" x2="278" y2="104" class="d-floor"/>
  <text x="274" y="115" class="d-small" text-anchor="end">floor</text>
  <rect x="130" y="28" width="64" height="46" class="d-open"/>
  <text x="162" y="55" class="d-small" text-anchor="middle">opening</text>
  <path d="M12 51H128M18 46l-6 5 6 5M122 46l6 5-6 5" class="d-arrow"/>
  <text x="70" y="44" class="d-text" text-anchor="middle">From left</text>
  <path d="M162 76V102M157 82l5-6 5 6M157 96l5 6 5-6" class="d-arrow"/>
  <text x="170" y="94" class="d-text">From floor</text>
</svg>`;

function renderEdit() {
  const s = state.project.surfaces.find(x => x.id === state.editId);
  if (!s) { state.view = 'home'; render(); return; }
  const isWall = s.kind === 'wall';

  app.innerHTML = `
    ${topbar(isWall ? 'Edit wall' : 'Edit column', { right: undoButtons() })}
    <main class="page">
      <div class="field-row">
        <label class="field grow"><span>Name</span><input id="f-name" value="${esc(s.name)}" autocomplete="off"></label>
        <label class="field qty"><span>How many</span><input id="f-qty" type="number" min="1" step="1" inputmode="numeric" value="${s.qty || 1}"></label>
      </div>
      ${isWall ? `
        <div class="toolbar">
          <button data-act="shape">Size &amp; shape</button>
          <button data-act="add-door">+ Door</button>
          <button data-act="add-window">+ Window</button>
          <button data-act="add-cutout">+ Socket</button>
        </div>
        <div class="canvas-wrap">
          <canvas id="wall-canvas" class="wall-canvas" aria-label="Wall drawing"></canvas>
          <div class="canvas-tools">
            ${s.photo?.dataUrl ? '<button data-act="photo" aria-pressed="true">Photo</button>' : ''}
            <button data-act="fit">Fit</button>
          </div>
        </div>
        <div id="sel-panel" class="sel-panel"></div>
        <section class="card">
          <h2>Doors, windows &amp; sockets</h2>
          ${OPENING_DIAGRAM}
          <div id="op-list" class="op-list"></div>
        </section>
      ` : `
        <section class="card">
          <div class="seg" role="group">
            <button data-kind="round-column" aria-pressed="${s.kind === 'round-column'}">Round</button>
            <button data-kind="rect-column" aria-pressed="${s.kind === 'rect-column'}">Square / rectangular</button>
          </div>
          <div class="field-row">
            ${s.kind === 'round-column'
              ? `<label class="field grow"><span>Diameter, mm</span><input data-dim="diameter" type="number" inputmode="decimal" value="${s.diameter}"></label>`
              : `<label class="field grow"><span>Width, mm</span><input data-dim="width" type="number" inputmode="decimal" value="${s.width}"></label>
                 <label class="field grow"><span>Depth, mm</span><input data-dim="depth" type="number" inputmode="decimal" value="${s.depth}"></label>`}
            <label class="field grow"><span>Height, mm</span><input data-dim="height" type="number" inputmode="decimal" value="${s.height}"></label>
          </div>
          <p class="hint">${s.kind === 'round-column'
            ? 'Worked out on the unrolled surface (circumference × height). Flexible tiles bend around the column. With WPC it is an estimate, because flat panels form a polygon around the column.'
            : 'Each of the 4 faces is laid out on its own.'}</p>
        </section>`}
      <section class="card" id="mat"><h2>Material</h2><div id="mat-body">${materialForm(s.material)}</div></section>
      <section class="card quick" id="quick"></section>
      <div class="row-actions">
        <button class="danger-ghost" data-act="delete">${TRASH_ICON}Delete ${isWall ? 'wall' : 'column'}</button>
        <button class="ghost" data-act="duplicate">Duplicate</button>
      </div>
    </main>
    <div class="bottombar"><button class="primary wide" data-act="done">Done</button></div>
    ${isWall ? `<dialog id="shape-dlg"><form class="dlg">
      <h2>Wall size &amp; shape</h2>
      <label class="field"><span>Type</span><select id="preset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('')}</select></label>
      <div id="preset-fields"></div>
      <p class="hint">This replaces the outline. Doors, windows and sockets are kept. You can still drag the corners afterwards, and Undo brings the old shape back.</p>
      <div class="dlg-actions"><button type="button" class="ghost" id="preset-cancel">Cancel</button><button type="button" class="primary" id="preset-ok">Apply</button></div>
    </form></dialog>
    <dialog id="op-dlg"><form class="dlg">
      <h2 id="op-dlg-title">Add</h2>
      ${OPENING_DIAGRAM}
      <div class="field-row wrap" id="op-dlg-fields"></div>
      <p class="hint">Sizes in mm. You can also drag it on the drawing afterwards.</p>
      <div class="dlg-actions"><button type="button" class="ghost" id="op-cancel">Cancel</button><button type="button" class="primary" id="op-ok">Add</button></div>
    </form></dialog>` : ''}`;

  let quickTimer = 0;
  const refreshQuick = () => {
    clearTimeout(quickTimer);
    quickTimer = setTimeout(() => { app.querySelector('#quick').innerHTML = quickResult(s); }, 120);
  };
  const changed = tag => { save(tag); refreshQuick(); };

  app.querySelector('#f-name').addEventListener('input', e => { s.name = e.target.value; save('surface-name'); });
  app.querySelector('#f-qty').addEventListener('input', e => {
    s.qty = Math.max(1, Math.round(num(e.target.value) || 1));
    changed('qty');
  });

  const matBody = app.querySelector('#mat-body');
  const bindMat = () => bindMaterial(matBody, s.material, () => {
    matBody.innerHTML = materialForm(s.material);
    bindMat();
    changed();
  });
  bindMat();

  on(app, 'back', back);
  on(app, 'done', back);
  on(app, 'delete', () => deleteSurface(s));
  on(app, 'duplicate', () => {
    const copy = { ...cloneSurface(s), id: uid(), name: nextName(s.kind === 'wall' ? 'Wall' : 'Column') };
    state.project.surfaces.push(copy);
    save();
    state.editId = copy.id;
    history.replaceState({ view: 'edit', editId: copy.id }, '');
    render();
    toast(`Duplicated as ${copy.name}`, { label: 'Undo', run: undo });
  });

  if (!isWall) {
    app.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
      s.kind = b.dataset.kind; save(); render({ keepScroll: true });
    }));
    app.querySelectorAll('[data-dim]').forEach(el => el.addEventListener('input', () => {
      const v = num(el.value);
      if (v && v > 0) { s[el.dataset.dim] = v; changed(`dim-${el.dataset.dim}`); }
    }));
    refreshQuick();
    return;
  }

  const panel = app.querySelector('#sel-panel');
  const opList = app.querySelector('#op-list');
  const editor = new WallEditor(app.querySelector('#wall-canvas'), s, {
    onChange: () => { changed(); syncOpenings(); },
    onSelect: sel => { renderSel(sel); highlightOpening(sel); syncOpenings(); },
    getPhoto: () => photoOf(s),
  });
  const img = photoOf(s)?.img;
  if (img && !img.complete) img.onload = () => editor.draw();
  cleanup = () => editor.destroy();

  // ----- openings list: exact sizes + delete button for every door/window/socket -----

  const openingName = o => {
    const same = s.openings.filter(x => x.type === o.type);
    return `${OPENING_TYPES[o.type]} ${same.indexOf(o) + 1}`;
  };
  const opInput = (key, label, value) => `<label class="op-field"><span>${label}</span>
    <input data-ok="${key}" type="number" inputmode="decimal" value="${Math.round(value)}"></label>`;

  function renderOpenings() {
    if (!s.openings.length) {
      opList.innerHTML = '<p class="hint">None yet. Use + Door, + Window or + Socket above. Each one gets its own size boxes here.</p>';
      return;
    }
    opList.innerHTML = s.openings.map(o => `<div class="op-row op-${o.type}" data-oid="${o.id}">
        <div class="op-head">
          <button type="button" class="op-name" data-osel="${o.id}"><span class="op-dot"></span>${esc(openingName(o))}</button>
          <button type="button" class="icon-btn op-del" data-odel="${o.id}" aria-label="Remove ${esc(openingName(o))}" title="Remove">${X_ICON}</button>
        </div>
        <div class="op-fields">
          ${opInput('w', 'Width', o.w)}${opInput('h', 'Height', o.h)}${opInput('x', 'From left', o.x)}${opInput('y', 'From floor', o.y)}
        </div>
        ${o.type === 'door' ? `<div class="op-warn" data-warn hidden>
          <span>This door is not on the floor. Doors normally have “From floor” = 0.</span>
          <button type="button" class="ghost" data-floor="${o.id}">Put on floor</button>
        </div>` : ''}
      </div>`).join('');
    opList.querySelectorAll('[data-floor]').forEach(b => b.addEventListener('click', () => {
      const o = s.openings.find(x => x.id === b.dataset.floor);
      if (!o) return;
      o.y = bboxOf([s.outline]).y0;
      editor.draw();
      changed();
      syncOpenings();
    }));
    opList.querySelectorAll('[data-osel]').forEach(b => b.addEventListener('click', () => {
      editor.select({ type: 'opening', id: b.dataset.osel });
    }));
    opList.querySelectorAll('[data-odel]').forEach(b => b.addEventListener('click', () => {
      const o = s.openings.find(x => x.id === b.dataset.odel);
      if (!o) return;
      const name = openingName(o);
      s.openings = s.openings.filter(x => x !== o);
      if (editor.sel?.id === o.id) editor.select(null);
      editor.draw();
      changed();
      renderOpenings();
      toast(`${name} removed`, { label: 'Undo', run: undo });
    }));
    opList.querySelectorAll('input[data-ok]').forEach(el => el.addEventListener('change', () => {
      const o = s.openings.find(x => x.id === el.closest('[data-oid]').dataset.oid);
      const k = el.dataset.ok;
      const v = num(el.value);
      if (!o || v === null || ((k === 'w' || k === 'h') && v <= 0)) {
        if (o) el.value = Math.round(o[k]);
        toast(k === 'w' || k === 'h' ? 'Width and height must be above 0' : 'Please enter a number');
        return;
      }
      o[k] = v;
      editor.draw();
      changed();
      syncOpenings();
    }));
    syncOpenings();
    highlightOpening(editor.sel);
  }

  // Keep the boxes in step with dragging on the drawing (without disturbing a box being typed in).
  function syncOpenings() {
    const floor = bboxOf([s.outline]).y0;
    for (const row of opList.querySelectorAll('[data-oid]')) {
      const o = s.openings.find(x => x.id === row.dataset.oid);
      if (!o) continue;
      for (const el of row.querySelectorAll('input[data-ok]')) {
        if (el !== document.activeElement) el.value = Math.round(o[el.dataset.ok]);
      }
      const warn = row.querySelector('[data-warn]');
      if (warn) warn.hidden = Math.round(o.y - floor) <= 0;
    }
  }

  function highlightOpening(sel) {
    for (const row of opList.querySelectorAll('[data-oid]')) {
      row.classList.toggle('selected', sel?.type === 'opening' && sel.id === row.dataset.oid);
    }
  }

  // ----- selected corner / edge -----

  function field(label, key, value) {
    return `<label class="field"><span>${label}</span><input data-k="${key}" type="number" inputmode="decimal" value="${Math.round(value)}"></label>`;
  }

  function renderSel(sel) {
    if (sel?.type === 'opening') {
      const o = s.openings.find(x => x.id === sel.id);
      if (o) {
        panel.innerHTML = `<p class="hint"><b>${esc(openingName(o))}</b> selected. Drag it to move, drag a corner dot to resize, or type exact sizes in the list below.</p>`;
        return;
      }
      sel = null;
    }
    if (!sel) {
      panel.innerHTML = `<p class="hint">Tap a corner or an edge of the wall to type its exact position or length. Drag to move. Use two fingers to zoom. All sizes are in mm, measured from the left and from the floor.</p>`;
      return;
    }
    if (sel.type === 'vertex') {
      const [x, y] = s.outline[sel.i];
      panel.innerHTML = `<div class="sel-head">Corner ${sel.i + 1}</div>
        <div class="field-row">${field('From left', 'x', x)}${field('From floor', 'y', y)}</div>
        <div class="sel-actions"><button class="danger-ghost" data-sel="del" ${s.outline.length <= 3 ? 'disabled' : ''}>Remove corner</button></div>`;
    } else {
      const a = s.outline[sel.i], b = s.outline[(sel.i + 1) % s.outline.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      panel.innerHTML = `<div class="sel-head">Edge ${sel.i + 1}</div>
        <div class="field-row">${field('Length', 'len', len)}</div>
        <div class="sel-actions"><button class="ghost" data-sel="split">Add a corner in the middle</button></div>
        <p class="hint">Changing the length moves corner ${(sel.i + 1) % s.outline.length + 1}. To make a missing corner or step, add a corner and drag it.</p>`;
    }
    panel.querySelectorAll('input[data-k]').forEach(el => el.addEventListener('change', () => {
      const v = num(el.value);
      if (v === null) return;
      if (sel.type === 'vertex') {
        s.outline[sel.i][el.dataset.k === 'x' ? 0 : 1] = v;
      } else {
        const n = s.outline.length, a = s.outline[sel.i], b = s.outline[(sel.i + 1) % n];
        const cur = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (v > 0 && cur > 0) s.outline[(sel.i + 1) % n] = [a[0] + (b[0] - a[0]) * v / cur, a[1] + (b[1] - a[1]) * v / cur];
      }
      editor.draw(); changed();
      renderSel(sel);
    }));
    panel.querySelector('[data-sel="del"]')?.addEventListener('click', () => {
      s.outline.splice(sel.i, 1);
      editor.select(null); changed();
      toast('Corner removed', { label: 'Undo', run: undo });
    });
    panel.querySelector('[data-sel="split"]')?.addEventListener('click', () => {
      const n = s.outline.length, a = s.outline[sel.i], b = s.outline[(sel.i + 1) % n];
      s.outline.splice(sel.i + 1, 0, [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2)]);
      editor.select({ type: 'vertex', i: sel.i + 1 }); changed();
    });
  }

  // ----- add opening: ask for exact sizes first -----

  const opDlg = app.querySelector('#op-dlg');
  let opType = 'door';
  function defaultOpening(type) {
    const b = bboxOf([s.outline]);
    const size = { door: [900, 2100, 0], window: [1200, 1200, 900], cutout: [86, 86, 300] }[type];
    const w = Math.round(Math.min(size[0], (b.x1 - b.x0) * 0.6));
    const h = Math.round(Math.min(size[1], (b.y1 - b.y0) * 0.8));
    const y = Math.round(b.y0 + Math.min(size[2], b.y1 - b.y0 - h));
    // Prefer the centre, otherwise the free spot nearest to it, so new openings don't stack.
    const free = x => s.openings.every(o => x + w <= o.x || x >= o.x + o.w || y + h <= o.y || y >= o.y + o.h);
    const centre = Math.round((b.x0 + b.x1 - w) / 2);
    let x = centre;
    for (let d = 0; d <= b.x1 - b.x0; d += 50) {
      const options = [centre - d, centre + d].filter(v => v >= b.x0 && v + w <= b.x1 && free(v));
      if (options.length) { x = options[0]; break; }
    }
    return { w, h, x, y };
  }
  function openAddDialog(type) {
    opType = type;
    const d = defaultOpening(type);
    opDlg.querySelector('#op-dlg-title').textContent = `Add ${OPENING_TYPES[type].toLowerCase()}`;
    opDlg.querySelector('#op-dlg-fields').innerHTML = [['w', 'Width'], ['h', 'Height'], ['x', 'From left'], ['y', 'From floor']]
      .map(([k, l]) => `<label class="field"><span>${l}, mm</span><input data-new="${k}" type="number" inputmode="decimal" value="${d[k]}"></label>`).join('');
    opDlg.showModal();
    opDlg.querySelector('[data-new="w"]').select();
  }
  opDlg.querySelector('form').addEventListener('submit', e => { e.preventDefault(); opDlg.querySelector('#op-ok').click(); });
  opDlg.querySelector('#op-cancel').addEventListener('click', () => opDlg.close());
  opDlg.querySelector('#op-ok').addEventListener('click', () => {
    const v = {};
    for (const el of opDlg.querySelectorAll('[data-new]')) v[el.dataset.new] = num(el.value);
    if (!(v.w > 0) || !(v.h > 0)) { toast('Width and height must be above 0'); return; }
    if (v.x === null || v.y === null) { toast('Please fill in every box'); return; }
    opDlg.close();
    const o = { id: uid(), type: opType, ...v };
    s.openings.push(o);
    renderOpenings();
    editor.select({ type: 'opening', id: o.id });
    changed();
  });
  on(app, 'add-door', () => openAddDialog('door'));
  on(app, 'add-window', () => openAddDialog('window'));
  on(app, 'add-cutout', () => openAddDialog('cutout'));
  on(app, 'fit', () => editor.fit());
  on(app, 'photo', e => {
    editor.showPhoto = !editor.showPhoto;
    e.currentTarget.setAttribute('aria-pressed', String(editor.showPhoto));
    editor.draw();
  });

  // ----- wall size & shape presets -----

  const dlg = app.querySelector('#shape-dlg');
  const presetSel = dlg.querySelector('#preset');
  const fieldsBox = dlg.querySelector('#preset-fields');
  function presetFields() {
    const b = bboxOf([s.outline]);
    const w = Math.round(b.x1 - b.x0), h = Math.round(b.y1 - b.y0);
    const defaults = { w, h, hl: h, hr: Math.round(h * 0.7), cw: Math.round(w / 3), ch: Math.round(h / 3), ph: Math.round(h * 1.3) };
    const p = PRESETS[presetSel.value];
    fieldsBox.innerHTML = `${p.corner ? `<label class="field"><span>Which corner is missing</span><select data-p="corner">
        <option value="tr">Top right</option><option value="tl">Top left</option><option value="br">Bottom right</option><option value="bl">Bottom left</option></select></label>` : ''}
      <div class="field-row wrap">${p.fields.map(([k, l]) => `<label class="field"><span>${l}, mm</span><input data-p="${k}" type="number" inputmode="decimal" value="${defaults[k]}"></label>`).join('')}</div>`;
  }
  presetSel.addEventListener('change', presetFields);
  on(app, 'shape', () => { presetFields(); dlg.showModal(); });
  dlg.querySelector('form').addEventListener('submit', e => { e.preventDefault(); dlg.querySelector('#preset-ok').click(); });
  dlg.querySelector('#preset-cancel').addEventListener('click', () => dlg.close());
  dlg.querySelector('#preset-ok').addEventListener('click', () => {
    const v = {};
    for (const el of fieldsBox.querySelectorAll('[data-p]')) v[el.dataset.p] = el.tagName === 'SELECT' ? el.value : num(el.value);
    if (Object.entries(v).some(([k, x]) => k !== 'corner' && !(x > 0))) { toast('Please fill in every size.'); return; }
    const outline = presetOutline(presetSel.value, v);
    if (!outline) return;
    dlg.close();
    s.outline = outline.map(([x, y]) => [Math.round(x), Math.round(y)]);
    editor.select(null);
    editor.fit();
    changed();
  });

  renderSel(null);
  renderOpenings();
  refreshQuick();
}

// ---------- results ----------

function renderResults() {
  const p = state.project;
  if (!p.surfaces.length) { state.view = 'home'; render(); return; }
  const res = calculate(p, state.settings);

  const groupCards = res.groups.map(g => {
    const unit = g.type === 'wpc' ? 'panel' : 'tile';
    const coveredPct = g.materialArea ? (g.coveredArea / g.materialArea) * 100 : 0;
    const trimPct = g.materialArea ? (g.trimArea / g.materialArea) * 100 : 0;
    const leftPct = Math.max(0, 100 - coveredPct - trimPct);
    const stockText = g.type === 'wpc'
      ? `${g.stock.width} × ${g.stock.length} mm panel`
      : `${g.stock.width} × ${g.stock.length} mm tile`;
    const leftovers = g.leftovers.filter(l => (l.len ?? Math.min(l.L, l.S)) >= 1);
    return `<section class="card group">
      <div class="g-head"><span class="dot ${g.type}"></span><h2>${esc(g.label)}</h2></div>
      <div class="g-sub">${esc(stockText)} · ${esc(g.surfaces.join(', '))}</div>
      <div class="big-row">
        <div class="big"><b>${g.total}</b><span>${unit}s to order</span></div>
        <div class="big waste"><b>${pct(g.wastePct)}%</b><span>waste</span></div>
      </div>
      <div class="bar" role="img" aria-label="Material use: ${pct(coveredPct)}% installed, ${pct(trimPct)}% trimmed off, ${pct(leftPct)}% left over">
        <span class="b-used" style="width:${coveredPct}%"></span><span class="b-trim" style="width:${trimPct}%"></span><span class="b-left" style="width:${leftPct}%"></span>
      </div>
      <div class="legend"><span><i class="b-used"></i>Installed</span><span><i class="b-trim"></i>Trimmed off</span><span><i class="b-left"></i>Left over</span></div>
      <dl class="stats">
        <div><dt>Full ${unit}s, no cutting</dt><dd>${g.fullCount}</dd></div>
        <div><dt>${unit[0].toUpperCase() + unit.slice(1)}s that get cut</dt><dd>${g.cutCount}</dd></div>
        <div><dt>Pieces cut from leftovers</dt><dd>${g.reusedCount}</dd></div>
        <div><dt>Area to cover</dt><dd>${m2(g.netArea)} m²</dd></div>
        ${Math.abs(g.netArea - g.coveredArea) > 1e4 && g.type === 'tile' ? `<div><dt>Covered by tile (excl. joints)</dt><dd>${m2(g.coveredArea)} m²</dd></div>` : ''}
        <div><dt>Material ordered</dt><dd>${m2(g.materialArea)} m²</dd></div>
        <div><dt>Waste area</dt><dd>${m2(g.wasteArea)} m²</dd></div>
        <div class="sub"><dt>trimmed off (slopes, edges, openings)</dt><dd>${m2(g.trimArea)} m²</dd></div>
        <div class="sub"><dt>left over after the job</dt><dd>${m2(g.leftoverArea)} m²</dd></div>
      </dl>
      ${leftovers.length ? `<details><summary>Leftover pieces (${leftovers.length})</summary>
        <p class="hint">${g.type === 'wpc' ? 'Full-width lengths left after cutting.' : 'Short side × long side of the tile.'}</p>
        <ul class="chips">${leftovers.map(l => `<li>${l.len !== undefined ? `${int(l.len)} mm` : `${int(l.S)} × ${int(l.L)} mm`} <small>from ${g.type === 'wpc' ? 'P' : 'T'}${l.unit}</small></li>`).join('')}</ul>
      </details>` : ''}
      ${g.cutPlan.length ? `<details><summary>Cutting plan (${g.cutPlan.length} ${unit}s)</summary>
        <p class="hint">${g.type === 'wpc'
          ? 'Lengths to cut from each panel, and where each piece goes. Strips count from the left (or rows from the floor).'
          : 'Width × height of each piece as it sits on the wall. Rows count from the floor, columns from the left. “Shaped” pieces need an angled or notched cut.'}</p>
        <ol class="cutplan">${g.cutPlan.map(u => `<li><div class="cp-head"><b>${g.type === 'wpc' ? 'P' : 'T'}${u.no}</b><span>leftover ${esc(u.left)}</span></div>
          <ul>${u.cuts.map(c => `<li><b>${esc(c.size)}</b> → ${esc(c.where)}</li>`).join('')}</ul></li>`).join('')}</ol>
      </details>` : ''}
    </section>`;
  }).join('');

  const drawings = res.surfaces.map(sr => {
    const s = sr.surface;
    const type = s.material.type;
    return `<section class="card drawing">
      <div class="g-head"><span class="dot ${type}"></span><h2>${esc(s.name)}${sr.qty > 1 ? ` <span class="badge">× ${sr.qty}</span>` : ''}</h2></div>
      <div class="g-sub">${esc(surfaceSize(s))} · ${m2(sr.netArea)} m² · ${esc(materialLabel(s.material))}${type === 'wpc' ? `, ${s.material.orientation}` : `, laid ${s.material.orientation}${Number(s.material.gap) ? `, ${s.material.gap} mm joint` : ''}`}</div>
      ${sr.regions.map(r => `${r.name ? `<h3>${esc(r.name)}</h3>` : ''}${layoutSvg(r, type)}`).join('')}
      ${sr.qty > 1 ? '<p class="hint">Labels show the first copy. The cutting plan lists every copy.</p>' : ''}
    </section>`;
  }).join('');

  app.innerHTML = `
    ${topbar('Results')}
    <main class="page results">
      <div class="r-title"><h2>${esc(p.name)}</h2><span>${p.surfaces.length} surface${p.surfaces.length > 1 ? 's' : ''}</span></div>
      ${groupCards}
      <div class="legend pieces"><span><i class="pc-full"></i>Full piece</span><span><i class="pc-cut"></i>Cut from new piece</span><span><i class="pc-reuse"></i>Cut from a leftover</span></div>
      ${drawings}
      <section class="card notes">
        <h2>How this is worked out</h2>
        <ul>
          <li>Each WPC panel covers ${state.settings.wpc[24].width} mm (24 mm profile) or ${state.settings.wpc[10].width} mm (10 mm profile) of wall width. Walls taller than ${state.settings.wpc[24].length} mm get a joined piece on top.</li>
          <li>A leftover is only reused for a piece it covers completely (whole height for WPC, whole piece for tiles). Leftovers can be used on any surface with the same product and colour. Tiles are never turned, so the pattern stays one way.</li>
          <li>Waste = material ordered − area actually covered. It counts cutting waste only, not breakage or mistakes. Labels P1, T1… match the cutting plan.</li>
        </ul>
      </section>
    </main>
    <div class="bottombar three">
      <button class="ghost" data-act="print">Print / PDF</button>
      <button class="ghost" data-act="share">Share</button>
      <button class="primary" data-act="wa">WhatsApp</button>
    </div>`;

  const summary = () => [
    `${p.name} — Balentino material estimate`,
    ...res.groups.map(g => `• ${g.label}: ${g.total} ${g.type === 'wpc' ? 'panels' : 'tiles'} (area ${m2(g.netArea)} m², waste ${pct(g.wastePct)}%)`),
    ...res.surfaces.map(sr => `  - ${sr.surface.name}${sr.qty > 1 ? ` ×${sr.qty}` : ''}: ${surfaceSize(sr.surface)}`),
  ].join('\n');

  on(app, 'back', back);
  on(app, 'print', () => {
    app.querySelectorAll('details').forEach(d => { d.open = true; });
    window.print();
  });
  on(app, 'share', async () => {
    const text = summary();
    try {
      if (navigator.share) await navigator.share({ title: p.name, text });
      else { await navigator.clipboard.writeText(text); toast('Summary copied'); }
    } catch { /* cancelled */ }
  });
  on(app, 'wa', () => {
    window.open(`https://wa.me/${COMPANY.whatsapp}?text=${encodeURIComponent(summary())}`, '_blank', 'noopener');
  });
}

// ---------- settings ----------

function renderSettings() {
  const st = state.settings;
  const f = (label, path, val) => `<label class="field"><span>${label}</span><input data-path="${path}" type="number" inputmode="decimal" value="${val}"></label>`;
  app.innerHTML = `
    ${topbar('Settings')}
    <main class="page">
      <section class="card">
        <h2>Flexible Tile</h2>
        <div class="field-row">${f('Width, mm', 'tile.width', st.tile.width)}${f('Length, mm', 'tile.length', st.tile.length)}</div>
      </section>
      ${['24', '10'].map(p => `<section class="card">
        <h2>WPC Wall Panel, ${p} mm profile</h2>
        <div class="field-row">
          ${f('Width, mm', `wpc.${p}.width`, st.wpc[p].width)}
          ${f('Length, mm', `wpc.${p}.length`, st.wpc[p].length)}
        </div>
      </section>`).join('')}
      <p class="hint">Sizes come from <a href="${COMPANY.site}" target="_blank" rel="noopener">hplbalentino.com</a>.</p>
      <div class="row-actions"><button class="ghost" data-act="reset">Reset to defaults</button></div>
    </main>`;
  app.querySelectorAll('[data-path]').forEach(el => el.addEventListener('change', () => {
    const v = num(el.value);
    if (!v || v <= 0) { toast('Enter a size above 0'); return; }
    const keys = el.dataset.path.split('.');
    let o = st;
    while (keys.length > 1) o = o[keys.shift()];
    o[keys[0]] = v;
    saveSettings(st);
    toast('Saved');
  }));
  on(app, 'back', back);
  on(app, 'reset', () => {
    state.settings = structuredClone(DEFAULT_SETTINGS);
    saveSettings(state.settings);
    render();
    toast('Defaults restored');
  });
}

// ---------- start ----------

history.replaceState({ view: 'home' }, '');
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
