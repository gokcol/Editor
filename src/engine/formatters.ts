import type { SourceType } from '../types';

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
  if (type === 'latex') return formatLatex(source);
  return formatTikz(source);
}
