/**
 * Lightweight Markdown renderer for the dsh TUI, styled to read like the Pi
 * coding agent's terminal output: code fences in the `mdCodeBlock` green,
 * inline code in the `mdCode` accent, headings in `mdHeading` gold, block
 * quotes in gray, list bullets in accent, and links in blue.
 *
 * It is deliberately line-oriented and ANSI-aware: each returned line is an
 * already-styled string whose display width (once control codes are stripped)
 * never exceeds `width`.
 * @module dsh-tui/markdown
 */

import { theme, visibleWidth, truncateToWidth } from "./theme.js";

/** Inline style bits. */
const S = {
  BOLD: 1,
  ITALIC: 2,
  CODE: 4,
  LINK: 8,
};

/**
 * Tokenize one prose line into styled segments. Only the constructs that LLM
 * prose actually uses are recognized: `` `code` ``, `***bold-italic***`,
 * `**bold**`, `*italic*`, and `[text](url)`. Underscore emphasis is ignored so
 * snake_case identifiers are never mangled.
 * @param {string} text - plain line.
 * @returns {{text:string,style:number}[]} styled segments.
 */
function tokenizeInline(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  const push = (t, style) => {
    if (t !== "") tokens.push({ text: t, style });
  };
  while (i < n) {
    const c = text[i];
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        push(text.slice(i + 1, end), S.CODE);
        i = end + 1;
        continue;
      }
    } else if (c === "*" && text[i + 1] === "*" && text[i + 2] === "*") {
      const end = text.indexOf("***", i + 3);
      if (end !== -1) {
        push(text.slice(i + 3, end), S.BOLD | S.ITALIC);
        i = end + 3;
        continue;
      }
    } else if (c === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        push(text.slice(i + 2, end), S.BOLD);
        i = end + 2;
        continue;
      }
    } else if (c === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1) {
        push(text.slice(i + 1, end), S.ITALIC);
        i = end + 1;
        continue;
      }
    } else if (c === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          push(text.slice(i + 1, close), S.LINK);
          i = urlEnd + 1;
          continue;
        }
      }
    }
    // Always advance at least one character, even when the current char is an
    // unmatched `*` / `` ` `` / `[` that none of the branches above consumed;
    // otherwise a lone marker would make `i` stall and spin the process.
    let j = i + 1;
    while (j < n && text[j] !== "`" && text[j] !== "*" && text[j] !== "[") j++;
    push(text.slice(i, j), 0);
    i = j;
  }
  return tokens;
}

/** Apply inline styling to one styled segment. */
function renderToken(tok) {
  const { text, style } = tok;
  if (style & S.CODE) return theme.fg("mdCode", text);
  if (style & S.LINK) return theme.underline(theme.fg("mdLink", text));
  let out = text;
  if (style & S.BOLD) out = theme.bold(out);
  if (style & S.ITALIC) out = theme.italic(out);
  return out;
}

/** Split a string into chunks no wider than `width` display cells. */
function hardChunk(text, width) {
  const chunks = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (curW + w > width && cur !== "") {
      chunks.push(cur);
      cur = "";
      curW = 0;
    }
    cur += ch;
    curW += w;
  }
  if (cur !== "") chunks.push(cur);
  return chunks;
}

/**
 * Wrap styled tokens into display lines, each an array of `{text, style}`.
 * @param {{text:string,style:number}[]} tokens
 * @param {number} width
 * @returns {{text:string,style:number}[][]}
 */
function wrapTokens(tokens, width) {
  const words = [];
  for (const tok of tokens) {
    for (const part of tok.text.split(/\s+/)) {
      if (part !== "") words.push({ text: part, style: tok.style });
    }
  }
  const lines = [];
  let cur = [];
  let curW = 0;
  const flush = () => {
    if (cur.length) lines.push(cur);
    cur = [];
    curW = 0;
  };
  for (const w of words) {
    const ww = visibleWidth(w.text);
    if (cur.length === 0) {
      if (ww <= width) {
        cur.push(w);
        curW = ww;
      } else {
        const chunks = hardChunk(w.text, width);
        for (let k = 0; k < chunks.length; k++) {
          if (k > 0) flush();
          cur.push({ text: chunks[k], style: w.style });
        }
        curW = visibleWidth(cur[cur.length - 1].text);
      }
    } else if (curW + 1 + ww <= width) {
      cur.push({ text: " ", style: 0 });
      cur.push(w);
      curW += 1 + ww;
    } else {
      flush();
      if (ww <= width) {
        cur.push(w);
        curW = ww;
      } else {
        const chunks = hardChunk(w.text, width);
        for (let k = 0; k < chunks.length; k++) {
          if (k > 0) flush();
          cur.push({ text: chunks[k], style: w.style });
        }
        curW = visibleWidth(cur[cur.length - 1].text);
      }
    }
  }
  flush();
  return lines;
}

/** Render one prose line into one or more display-width-bounded styled lines. */
function renderInline(text, width) {
  const tokens = tokenizeInline(text);
  const wrapped = wrapTokens(tokens, width);
  return wrapped.map((segments) => segments.map(renderToken).join(""));
}

/**
 * Render a Markdown string into styled, width-bounded terminal lines.
 * @param {string} text - the markdown source.
 * @param {number} width - terminal width in display cells.
 * @returns {string[]} styled lines (no trailing newline).
 */
export function renderMarkdown(text, width) {
  const out = [];
  let inFence = false;
  let fenceLang = "";
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (/^```/.test(trimmed)) {
      if (!inFence) {
        inFence = true;
        fenceLang = trimmed.slice(3).trim();
        out.push(theme.fg("mdCodeBlockBorder", fenceLang ? `\`\`\` ${fenceLang}` : "```"));
        continue;
      }
      inFence = false;
      out.push(theme.fg("mdCodeBlockBorder", "```"));
      continue;
    }
    if (inFence) {
      // Code block lines: green, width-bounded without reflow.
      const chunks = hardChunk(trimmed, Math.max(1, width));
      for (const chunk of chunks) out.push(theme.fg("mdCodeBlock", chunk));
      continue;
    }
    if (/^\s*$/.test(line)) {
      out.push("");
      continue;
    }
    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const body = heading[2];
      for (const ln of renderInline(body, Math.max(1, width))) {
        out.push(theme.bold(theme.fg("mdHeading", ln)));
      }
      continue;
    }
    // Horizontal rule
    if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
      out.push(theme.fg("mdQuote", "─".repeat(Math.max(1, width))));
      continue;
    }
    // Block quote
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const body = quote[1] === "" ? " " : quote[1];
      for (const ln of renderInline(body, Math.max(1, width - 2))) {
        out.push(theme.fg("mdQuote", "│ ") + theme.fg("mdQuote", ln));
      }
      continue;
    }
    // Unordered list
    const list = /^\s*([-*+])\s+(.*)$/.exec(line);
    if (list) {
      const body = list[2];
      for (const ln of renderInline(body, Math.max(1, width - 2))) {
        out.push(theme.fg("mdListBullet", "• ") + ln);
      }
      continue;
    }
    // Ordered list
    const olist = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (olist) {
      const body = olist[2];
      const num = `${olist[1]}.`;
      for (const ln of renderInline(body, Math.max(1, width - visibleWidth(num) - 1))) {
        out.push(theme.fg("mdListBullet", num) + " " + ln);
      }
      continue;
    }
    // Plain prose
    for (const ln of renderInline(line, Math.max(1, width))) {
      out.push(ln);
    }
  }
  return out;
}

/** Render a single short string inline (no block constructs), width-bounded. */
export function renderInlineText(text, width) {
  return renderInline(text, Math.max(1, width));
}

export { truncateToWidth };
