// Product data from hplbalentino.com. Dimensions are editable in Settings.

export const COMPANY = {
  name: 'Balentino',
  site: 'https://hplbalentino.com',
};

// The test version (served from /beta/) keeps its own saved data, so testing never touches the live app's.
export const IS_BETA = /\/beta\//.test(location.pathname);
export const STORAGE_SUFFIX = IS_BETA ? '-beta' : '';

export const TILE_DESIGNS = [
  { code: 'FFT 3000 GT', name: 'White', series: 'Granite' },
  { code: 'FFT 3001 GT', name: 'Beige', series: 'Granite' },
  { code: 'FFT 3002 GT', name: 'Grey', series: 'Granite' },
  { code: 'FFT 1000 TT', name: 'Foglia', series: 'Travertine' },
  { code: 'FFT 1001 TT', name: 'Blath', series: 'Travertine' },
  { code: 'FFT 1002 TT', name: 'Wurzel', series: 'Travertine' },
  { code: 'FFT 1003 TT', name: 'Ramita', series: 'Travertine' },
  { code: 'FFT 1004 TT', name: 'Wana', series: 'Travertine' },
  { code: 'FFT 1005 TT', name: 'Devine', series: 'Travertine' },
  { code: 'FFT 1006 TT', name: 'Santiago', series: 'Travertine' },
];

export const WPC_COLOURS = [
  { code: 'FWPC 001', name: 'Majestic Pino' },
  { code: 'FWPC 002', name: 'Luxe Wenge' },
  { code: 'FWPC 003', name: 'Amber Oak' },
  { code: 'FWPC 004', name: 'Flanel Teak' },
  { code: 'FWPC 005', name: 'Wild Wenge' },
  { code: 'FWPC 006', name: 'Parma Walnut' },
  { code: 'FWPC 007', name: 'Classic Teak' },
  { code: 'FWPC 020', name: 'White' },
  { code: 'FWPC 021', name: 'Black' },
  { code: 'FWPC 022', name: 'Dark Grey' },
  { code: 'FWPC 030', name: 'Stoffa Creana' },
  { code: 'FWPC 031', name: 'Stoffa Grigio' },
  { code: 'FWPC 032', name: 'Silver Brush' },
  { code: 'FWPC 033', name: 'Golden Brush' },
];

export const DEFAULT_SETTINGS = {
  tile: { width: 600, length: 1200 },
  wpc: {
    24: { width: 168, length: 2900 },
    10: { width: 155, length: 2900 },
  },
};

const SETTINGS_KEY = `balentino-calc-settings-v2${STORAGE_SUFFIX}`;

export function loadSettings() {
  const s = structuredClone(DEFAULT_SETTINGS);
  const pick = (into, from) => {
    for (const k of Object.keys(into)) if (Number(from?.[k]) > 0) into[k] = Number(from[k]);
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved) {
      pick(s.tile, saved.tile);
      for (const p of ['24', '10']) pick(s.wpc[p], saved.wpc?.[p]);
    }
  } catch { /* storage unavailable: use defaults */ }
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function tileDesign(code) {
  return TILE_DESIGNS.find(d => d.code === code) || TILE_DESIGNS[0];
}

export function wpcColour(code) {
  return WPC_COLOURS.find(c => c.code === code) || WPC_COLOURS[0];
}

export function materialLabel(m) {
  if (m.type === 'tile') {
    const d = tileDesign(m.design);
    return `Flexible Tile ${d.code} ${d.name}`;
  }
  const c = wpcColour(m.colour);
  return `WPC ${m.profile} mm ${c.code} ${c.name}`;
}
