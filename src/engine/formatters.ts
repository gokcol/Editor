import type { SourceType } from '../types';
import { formatJson as formatStrictJson } from './jsonTools';

const trimTrailing = (line: string) => line.replace(/[ \t]+$/g, '');

export function formatSvg(source: string): string {
  const tokens = source
    .replace(/>\s+</g, '><')
    .match(/<[^>]+>|[^<]+/g) ?? [];
  const lines: string[] = [];
  let depth = 0;

  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;
    if (token.startsWith('</')) depth = Math.max(0, depth - 1);
    lines.push(`${'  '.repeat(depth)}${token}`);
    const isOpen = token.startsWith('<') && !token.startsWith('</') && !token.startsWith('<?') && !token.startsWith('<!');
    if (isOpen && !token.endsWith('/>') && !/^<[^/!?>]+>[^<]*<\//.test(token)) depth += 1;
  }
  return `${lines.join('\n')}\n`;
}

export function formatMermaid(source: string): string {
  let depth = 0;
  const formatted = source.split('\n').map((rawLine) => {
    const line = trimTrailing(rawLine).trim();
    if (!line) return '';
    const closesScope = /^(end|end\s+subgraph)$/i.test(line);
    if (closesScope) depth = Math.max(0, depth - 1);
    const result = `${'  '.repeat(depth)}${line}`;
    if (/^(subgraph\b|loop\b|alt\b|opt\b|par\b|critical\b|rect\b)/i.test(line)) depth += 1;
    return result;
  });
  return `${formatted.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/**
 * LaTeX and TikZ share TeX environment structure. Keeping this formatter
 * environment-aware means ordinary LaTeX documents get useful indentation
 * without treating a diagram-only command as special syntax.
 */
function formatTex(source: string): string {
  let depth = 0;
  const formatted = source.split('\n').map((rawLine) => {
    const clean = trimTrailing(rawLine);
    const line = clean.trim();
    if (!line) return '';
    const closes = /\\end\{[^}]+\}/.test(line) || /^\}/.test(line);
    if (closes) depth = Math.max(0, depth - 1);
    const result = `${'  '.repeat(depth)}${line}`;
    const opens = /\\begin\{[^}]+\}/.test(line) || /\{$/.test(line);
    if (opens && !/\\end\{/.test(line)) depth += 1;
    return result;
  });
  return `${formatted.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export function formatTikz(source: string): string {
  return formatTex(source);
}

export function formatLatex(source: string): string {
  return formatTex(source);
}

/**
 * MetaFont source can use deliberately aligned equations and glyph geometry.
 * Only remove trailing whitespace, leaving blank lines and author indentation
 * intact instead of applying TeX's environment-oriented formatter.
 */
export function formatMetafont(source: string): string {
  return source.split('\n').map(trimTrailing).join('\n');
}

export function formatMarkdown(source: string): string {
  const lines = source.split('\n').map(trimTrailing);
  const formatted: string[] = [];
  let previousBlank = false;

  for (const line of lines) {
    const isBlank = !line.trim();
    if (isBlank && previousBlank) continue;
    formatted.push(isBlank ? '' : line);
    previousBlank = isBlank;
  }
  return `${formatted.join('\n').trim()}\n`;
}

/**
 * JSON is the one general-purpose data format we can format losslessly from
 * its parsed value. Invalid JSON deliberately falls back to whitespace-only
 * cleanup so Format Document never destroys an unfinished edit.
 */
export function formatJson(source: string): string {
  if (!source.trim()) return source;
  return formatStrictJson(source) ?? source.split('\n').map(trimTrailing).join('\n');
}

/**
 * YAML is indentation-sensitive and has a much richer scalar grammar than
 * JSON. Without a full YAML CST formatter, changing indentation can silently
 * change meaning; only remove trailing whitespace.
 */
export function formatYaml(source: string): string {
  return source.split('\n').map(trimTrailing).join('\n');
}

/**
 * This conservative formatter is shared by the programming and web source
 * modes. It intentionally avoids speculative reflow of strings, templates,
 * SQL dialects, Fortran continuations, or Python indentation. A user can run
 * their project formatter (Prettier, Ruff, sqlfluff, fprettify, and so on)
 * without Yedit ever changing program behaviour.
 */
export function formatCode(source: string): string {
  return source.split('\n').map(trimTrailing).join('\n');
}

/**
 * Plain text is deliberately preserved byte-for-byte. Unlike structured source
 * formats, trailing spaces and blank lines can be meaningful to a user’s
 * notes, terminal output, or fixed-width snippets.
 */
export function formatText(source: string): string {
  return source;
}

export function formatSource(type: SourceType, source: string): string {
  if (type === 'svg') return formatSvg(source);
  if (type === 'mermaid') return formatMermaid(source);
  if (type === 'markdown') return formatMarkdown(source);
  if (type === 'text') return formatText(source);
  if (type === 'metafont') return formatMetafont(source);
  if (type === 'latex') return formatLatex(source);
  if (type === 'json') return formatJson(source);
  if (type === 'yaml') return formatYaml(source);
  if (type === 'javascript' || type === 'typescript' || type === 'python' || type === 'fortran' || type === 'sql' || type === 'html' || type === 'css') return formatCode(source);
  return formatTikz(source);
}
