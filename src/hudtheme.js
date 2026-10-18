// HUD themes: how both HUDs (terminal and web) look, as data. The user changes it by
// giving FRIDAY an image ("make the HUD look like this") or a description; Claude
// turns that into a theme, FRIDAY checks it and both HUDs repaint live. The theme is
// hud-theme.json in FRIDAY's config folder, so it can also be edited by hand.
import fs from 'node:fs';
import path from 'node:path';
import { cap, userPossessive } from './user.js';

export const DEFAULT_THEME = Object.freeze({
  name: 'FRIDAY',
  title: 'F.R.I.D.A.Y.',
  subtitle: 'PROJECT HUD',
  colors: {
    accent: [95, 225, 255], // headings, the map, the core
    warn: [255, 176, 59], // highlights, hot files, wikilinks
    error: [255, 95, 95],
    ok: [110, 231, 140],
    text: [200, 230, 240],
    dim: [93, 131, 153],
    line: [38, 92, 112], // panel borders
    bg: null, // null: the terminal's own background (the web HUD uses #02060c)
  },
  panels: { directive: true, telemetry: true, composition: true, agents: true, activity: true, commits: true, projects: true, comms: true },
  map: { rings: true, sweep: true },
  // Web only: the uploaded image behind the HUD, 0 (hidden) to 1.
  background: { image: null, opacity: 0.18 },
});

const COLOR_KEYS = Object.keys(DEFAULT_THEME.colors);

// "#5fe1ff", "5fe1ff", "rgb(95,225,255)" or [95,225,255] -> [r,g,b]; anything else null.
export function toRgb(v) {
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(+n))) return v.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(+n))));
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  return m ? toRgb([m[1], m[2], m[3]]) : null;
}

const str = (v, max, dflt) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : dflt);

// Any object -> a complete, safe theme. Unknown keys are dropped; bad values fall back.
export function normalizeTheme(t) {
  t = t && typeof t === 'object' ? t : {};
  const d = DEFAULT_THEME;
  const colors = {};
  for (const k of COLOR_KEYS) {
    const v = t.colors?.[k];
    colors[k] = k === 'bg' && (v === null || v === undefined) ? null : toRgb(v) || d.colors[k];
  }
  const panels = {};
  for (const k of Object.keys(d.panels)) panels[k] = typeof t.panels?.[k] === 'boolean' ? t.panels[k] : d.panels[k];
  const op = Number(t.background?.opacity);
  const img = t.background?.image;
  return {
    name: str(t.name, 40, d.name),
    title: str(t.title, 30, d.title),
    subtitle: str(t.subtitle, 30, d.subtitle),
    colors,
    panels,
    map: { rings: t.map?.rings !== false, sweep: t.map?.sweep !== false },
    background: {
      // Only a bare file name in FRIDAY's asset folder, never a path or a URL.
      image: typeof img === 'string' && /^[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(img) ? img : null,
      opacity: Number.isFinite(op) ? Math.max(0, Math.min(1, op)) : d.background.opacity,
    },
  };
}

// Contrast ratio of two colors (WCAG); the text must stay readable on the background.
export function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Problems worth refusing a generated theme for (the HUD would be unreadable).
export function themeProblems(t) {
  const bg = t.colors.bg || [2, 6, 12];
  const out = [];
  if (contrast(t.colors.text, bg) < 4) out.push(`text on the background is hard to read (contrast ${contrast(t.colors.text, bg).toFixed(1)}:1, needs 4)`);
  if (contrast(t.colors.accent, bg) < 3) out.push(`the accent color disappears into the background (contrast ${contrast(t.colors.accent, bg).toFixed(1)}:1, needs 3)`);
  return out;
}

// On disk, colors are "#rrggbb": easier to read and edit by hand.
const hexOf = (c) => (c ? '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('') : null);
const pretty = (t) => JSON.stringify({ ...t, colors: Object.fromEntries(Object.entries(t.colors).map(([k, v]) => [k, hexOf(v)])) }, null, 2) + '\n';

export function createThemeStore(configDir) {
  const file = path.join(configDir, 'hud-theme.json');
  const prev = path.join(configDir, 'hud-theme.prev.json');
  const assets = path.join(configDir, 'hud-assets');
  const read = (f) => { try { return normalizeTheme(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))); } catch { return null; } };
  return {
    file,
    assets,
    get: () => read(file) || normalizeTheme(),
    // Saves a theme; the one it replaces is kept for undo.
    save(t) {
      fs.mkdirSync(configDir, { recursive: true });
      // The first theme replaces the built-in one: undo goes back to that.
      if (fs.existsSync(file)) fs.copyFileSync(file, prev);
      else fs.writeFileSync(prev, pretty(normalizeTheme()));
      fs.writeFileSync(file + '.tmp', pretty(normalizeTheme(t)));
      fs.renameSync(file + '.tmp', file);
      return this.get();
    },
    undo() {
      if (!fs.existsSync(prev)) return null;
      const before = read(prev);
      fs.copyFileSync(file, prev + '.swap');
      fs.renameSync(prev, file);
      fs.renameSync(prev + '.swap', prev);
      return before;
    },
    reset() { return this.save(normalizeTheme()); },
    // Copy an image into the asset folder under a safe name; returns that name.
    addImage(src) {
      const ext = (path.extname(src).toLowerCase().match(/^\.(png|jpe?g|gif|webp)$/) || [])[0];
      if (!ext) throw new Error('the HUD takes a .png, .jpg, .gif or .webp image');
      fs.mkdirSync(assets, { recursive: true });
      const name = `theme-${Date.now()}${ext}`;
      fs.copyFileSync(src, path.join(assets, name));
      return name;
    },
    // Calls fn(theme) whenever the file changes (hand edits apply live).
    watch(fn) {
      let last = JSON.stringify(this.get());
      fs.watchFile(file, { interval: 1000 }, () => {
        const t = this.get();
        const s = JSON.stringify(t);
        if (s !== last) { last = s; fn(t); }
      });
      return () => fs.unwatchFile(file);
    },
  };
}

// An image path somewhere in a message (dragging a file into the terminal pastes it,
// sometimes quoted).
export function findImagePath(text) {
  const re = /(["']?)((?:[a-zA-Z]:[\\/]|~[\\/]|\.{0,2}[\\/])[^"'\n]*?\.(?:png|jpe?g|gif|webp))\1(?=\s|$)/i;
  return re.exec(text)?.[2] || null;
}

// The request to Claude. It reads the image itself (its Read tool shows images).
export function themePrompt({ image = null, request = '', current }) {
  return [
    'You are designing the look of FRIDAY\'s project HUD: a sci-fi dashboard with panels (directive, telemetry, composition, agents, activity, commits, projects, comms) around a radial map of a code repository. It is drawn in a terminal (truecolor text on a background) and in a browser.',
    image ? `Read the image at ${image} and design a theme that matches its palette and mood.` : '',
    request ? `${cap(userPossessive())} request, in their words: ${request}` : '',
    'The current theme is below. Change what the request asks for and keep the rest.',
    '```json', JSON.stringify(current, null, 2), '```',
    'Rules: colors are "#rrggbb". text must be readable on bg (contrast at least 4.5:1) and accent at least 3:1; bg null means the terminal\'s own background (use a real color when matching an image). panels and map values are true/false. title and subtitle are short (title up to 30 characters).',
    image ? `background.image may be "${path.basename(image)}" to show the image itself faintly behind the web HUD (opacity 0.05-0.4), or null.` : 'Leave background.image as it is unless the request is about it.',
    'Give a new look a short name of its own (name, up to 3 words); keep the name for small tweaks.',
    'Reply with the complete theme as one ```json block, then one short line saying what you changed. No other text.',
  ].filter(Boolean).join('\n');
}

// The JSON block out of Claude's reply -> { theme, note } or { error }.
export function parseThemeReply(text) {
  const m = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text || '') || /(\{[\s\S]*\})/.exec(text || '');
  if (!m) return { error: 'no theme in the reply' };
  try {
    const theme = normalizeTheme(JSON.parse(m[1]));
    const note = (text.slice((m.index || 0) + m[0].length).trim().split('\n').find((l) => l.trim()) || '').slice(0, 200);
    return { theme, note };
  } catch (e) { return { error: `bad theme JSON: ${e.message}` }; }
}

// Is this message asking to change how the HUD looks (rather than about a HUD bug)?
export function isThemeRequest(text) {
  if (!/\bhud\b/i.test(text)) return false;
  if (/\b(bug|broken|crash|error|fix|issue|why|doesn'?t|isn'?t|not working|fails?)\b/i.test(text)) return false;
  return !!findImagePath(text) || /\b(make|change|turn|set|use|give|style|restyle|theme|recolou?r|reskin)\b[\s\S]*\b(looks?|theme|colou?rs?|accents?|style|background|skin|palette|vibe|aesthetic|feel|glow|dark|darker|light|lighter|title|panels?)\b/i.test(text);
}
