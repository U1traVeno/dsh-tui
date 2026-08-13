/**
 * Pi-inspired terminal color theme for the dsh TUI front door.
 *
 * The palette and its semantics are ported from the `dark.json` theme shipped
 * with `@earendil-works/pi-coding-agent` (the "Pi" coding agent installed on
 * this machine). We keep the same named tokens so the terminal surfaces read
 * as close siblings: sage/teal accent, blue borders, gray user-message blocks,
 * and status-tinted tool-execution blocks.
 *
 * Colors are emitted as 24-bit (truecolor) ANSI when the terminal advertises
 * support, and as the nearest 256-color index otherwise. `NO_COLOR` and a
 * `dumb` terminal disable styling entirely.
 * @module dsh-tui/theme
 */

const HEX = {
  accent: "#8abeb7",
  cyan: "#00d7ff",
  blue: "#5f87ff",
  green: "#b5bd68",
  red: "#cc6666",
  yellow: "#ffff00",
  text: "#d4d4d4",
  gray: "#808080",
  dimGray: "#666666",
  darkGray: "#505050",
  userMsgBg: "#343541",
  selectedBg: "#3a3a4a",
  toolPendingBg: "#282832",
  toolSuccessBg: "#283228",
  toolErrorBg: "#3c2828",
  toolTitle: "#d4d4d4",
  toolOutput: "#808080",
  customMsgBg: "#2d2838",
  mdHeading: "#f0c674",
  mdLink: "#81a2be",
  mdCode: "#8abeb7",
  mdCodeBlock: "#b5bd68",
  mdCodeBlockBorder: "#808080",
  mdQuote: "#808080",
  mdListBullet: "#8abeb7",
  syntaxComment: "#6A9955",
  syntaxKeyword: "#569CD6",
  syntaxFunction: "#DCDCAA",
  syntaxVariable: "#9CDCFE",
  syntaxString: "#CE9178",
  syntaxNumber: "#B5CEA8",
  syntaxType: "#4EC9B0",
};

/** Terminal color capability resolved once at import time. */
const env = process.env;
const NO_COLOR = env.NO_COLOR !== undefined;
const TERM = env.TERM || "";
const COLORTERM = env.COLORTERM || "";
const KNOWN_TRUECOLOR = /tmux|screen|xterm|kitty|alacritty|wezterm|ghostty|rio|contour|foot|iterm|apple|konsole|st-256/i;
const TRUECOLOR = !NO_COLOR &&
  TERM !== "dumb" &&
  (/truecolor|24bit|direct/i.test(COLORTERM) || KNOWN_TRUECOLOR.test(TERM));

/** Whether any styling is emitted at all. */
export const colorEnabled = !NO_COLOR && TERM !== "dumb";

/** 6x6x6 color cube channel values (indices 0-5). */
const CUBE = [0, 95, 135, 175, 215, 255];
/** 24 grays from 8 to 238 (indices 232-255). */
const GRAYS = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function hexToRgb(hex) {
  const cleaned = hex.replace("#", "");
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

function nearest(value, values) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < values.length; i++) {
    const dist = Math.abs(value - values[i]);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Map an RGB triple to the nearest 256-color palette index. */
function rgbTo256(r, g, b) {
  const cubeIndex = 16 + 36 * nearest(r, CUBE) + 6 * nearest(g, CUBE) + nearest(b, CUBE);
  const cubeR = CUBE[nearest(r, CUBE)];
  const cubeG = CUBE[nearest(g, CUBE)];
  const cubeB = CUBE[nearest(b, CUBE)];
  const cubeDist = (r - cubeR) ** 2 * 0.299 + (g - cubeG) ** 2 * 0.587 + (b - cubeB) ** 2 * 0.114;
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayIdx = nearest(gray, GRAYS);
  const grayVal = GRAYS[grayIdx];
  const grayDist = (r - grayVal) ** 2 * 0.299 + (g - grayVal) ** 2 * 0.587 + (b - grayVal) ** 2 * 0.114;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 10 && grayDist < cubeDist) return 232 + grayIdx;
  return cubeIndex;
}

/** Foreground ANSI prefix for a named color, or "" when color is disabled. */
function fgAnsi(name) {
  if (!colorEnabled) return "";
  const hex = HEX[name];
  if (!hex) throw new Error(`unknown theme color: ${name}`);
  const { r, g, b } = hexToRgb(hex);
  return TRUECOLOR ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`;
}

/** Background ANSI prefix for a named color, or "" when color is disabled. */
function bgAnsi(name) {
  if (!colorEnabled) return "";
  const hex = HEX[name];
  if (!hex) throw new Error(`unknown theme color: ${name}`);
  const { r, g, b } = hexToRgb(hex);
  return TRUECOLOR ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${rgbTo256(r, g, b)}m`;
}

const RESET = "\x1b[0m";

/**
 * Named-color styling helpers. Each returns the styled text (or unstyled text
 * when color is disabled) with a minimal reset suffix.
 */
export const theme = {
  /** Wrap text in the named foreground color. */
  fg(name, text) {
    return colorEnabled ? `${fgAnsi(name)}${text}\x1b[39m` : text;
  },
  /** Wrap text in the named background color. */
  bg(name, text) {
    return colorEnabled ? `${bgAnsi(name)}${text}\x1b[49m` : text;
  },
  /** Raw foreground prefix for manual composition (e.g. padded blocks). */
  fgOpen(name) {
    return fgAnsi(name);
  },
  /** Raw background prefix for manual composition (e.g. padded blocks). */
  bgOpen(name) {
    return bgAnsi(name);
  },
  bold(text) {
    return colorEnabled ? `\x1b[1m${text}\x1b[22m` : text;
  },
  dim(text) {
    return colorEnabled ? `\x1b[2m${text}\x1b[22m` : text;
  },
  italic(text) {
    return colorEnabled ? `\x1b[3m${text}\x1b[23m` : text;
  },
  underline(text) {
    return colorEnabled ? `\x1b[4m${text}\x1b[24m` : text;
  },
  reset: RESET,
  /** True when the terminal renders 24-bit color (vs 256-color). */
  truecolor: TRUECOLOR,
};

/** Display-cell width of one code point (approximates wcwidth for CJK). */
export function wcwidth(cp) {
  if (cp === 0) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Display-cell width of a string (ANSI-free input). */
export function visibleWidth(text) {
  let width = 0;
  for (const ch of text) width += wcwidth(ch.codePointAt(0));
  return width;
}

/** Pad a string with trailing spaces to a target display width. */
export function padToWidth(text, width) {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Truncate a string to a target display width, appending `ellipsis`. */
export function truncateToWidth(text, width, ellipsis = "…") {
  if (visibleWidth(text) <= width) return text;
  const target = Math.max(0, width - visibleWidth(ellipsis));
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = wcwidth(ch.codePointAt(0));
    if (used + w > target) break;
    out += ch;
    used += w;
  }
  return out + ellipsis;
}
