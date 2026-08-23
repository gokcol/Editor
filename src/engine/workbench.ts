import type { SourceType } from '../types';

export type OutlineEntry = {
  id: string;
  line: number;
  depth: number;
  label: string;
  kind: 'section' | 'node' | 'group' | 'element';
};

export type SearchResult = {
  line: number;
  column: number;
  excerpt: string;
};

function cleanLabel(value: string) {
  return value.replace(/\s+/g, ' ').replace(/[{}]/g, '').trim().slice(0, 96) || 'Untitled';
}

export function documentOutline(type: SourceType, source: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const lines = source.split('\n');

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (type === 'markdown') {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (match) entries.push({ id: `md-${lineNumber}`, line: lineNumber, depth: match[1].length - 1, label: cleanLabel(match[2]), kind: 'section' });
      return;
    }

    if (type === 'tikz' || type === 'latex') {
      const begin = /\\begin\{([^}]+)\}/.exec(line);
      const node = /\\node(?:\[[^\]]*\])?\s*(?:\(([^)]+)\))?\s*\{([^}]*)\}/.exec(line);
      const section = /\\(?:section|subsection|subsubsection)\*?\{([^}]+)\}/.exec(line);
      const prefix = type === 'tikz' ? 'tikz' : 'latex';
      if (section) entries.push({ id: `${prefix}-section-${lineNumber}`, line: lineNumber, depth: /\\subsubsection/.test(line) ? 2 : /\\subsection/.test(line) ? 1 : 0, label: cleanLabel(section[1]), kind: 'section' });
      else if (begin) entries.push({ id: `${prefix}-group-${lineNumber}`, line: lineNumber, depth: begin[1] === 'document' ? 0 : 1, label: `\\begin{${begin[1]}}`, kind: 'group' });
      else if (type === 'tikz' && node) entries.push({ id: `tikz-node-${lineNumber}`, line: lineNumber, depth: 2, label: cleanLabel(node[1] || node[2]), kind: 'node' });
      return;
    }

    if (type === 'metafont') {
      const glyph = /^\s*beginchar\s*\(\s*(?:"([^"]+)"|'([^']+)'|([^,\s)]+))/.exec(line);
      const definition = /^\s*(?:vardef|def)\s+([A-Za-z_][\w@]*(?:#)?)/.exec(line);
      if (glyph) {
        const name = glyph[1] ?? glyph[2] ?? glyph[3] ?? 'glyph';
        entries.push({ id: `mf-glyph-${lineNumber}`, line: lineNumber, depth: 0, label: `Glyph ${cleanLabel(name)}`, kind: 'node' });
      } else if (definition) {
        entries.push({ id: `mf-definition-${lineNumber}`, line: lineNumber, depth: 1, label: cleanLabel(definition[1]), kind: 'group' });
      }
      return;
    }

    if (type === 'mermaid') {
      const diagram = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|mindmap|timeline|quadrantChart|pie|gitGraph)\b/i.exec(line);
      const group = /^\s*(subgraph|participant|section)\s+(.+)/i.exec(line);
      if (diagram) entries.push({ id: `mmd-root-${lineNumber}`, line: lineNumber, depth: 0, label: cleanLabel(diagram[1]), kind: 'section' });
      else if (group) entries.push({ id: `mmd-group-${lineNumber}`, line: lineNumber, depth: 1, label: cleanLabel(group[2]), kind: 'group' });
      return;
    }

    if (type === 'text') {
      const next = lines[index + 1] ?? '';
      const heading = line.trim() && /^\s*[=-]{3,}\s*$/.test(next);
      const key = /^\s*([A-Za-z][\w .-]{0,72}):\s*\S/.exec(line);
      if (heading) entries.push({ id: `text-section-${lineNumber}`, line: lineNumber, depth: 0, label: cleanLabel(line), kind: 'section' });
      else if (key) entries.push({ id: `text-key-${lineNumber}`, line: lineNumber, depth: 1, label: cleanLabel(key[1]), kind: 'element' });
      return;
    }

    const svg = /^\s*<(svg|g|defs|symbol|(?:linear|radial)Gradient|pattern|clipPath|mask|text|path|rect|circle|ellipse|polygon|polyline)\b[^>]*(?:\sid=["']([^"']+)["'])?[^>]*>/i.exec(line);
    if (svg) {
      const tag = svg[1];
      const depth = tag === 'svg' ? 0 : ['defs', 'g', 'symbol'].includes(tag) ? 1 : 2;
      entries.push({ id: `svg-${lineNumber}`, line: lineNumber, depth, label: svg[2] ? `<${tag} id="${svg[2]}">` : `<${tag}>`, kind: ['g', 'defs', 'symbol'].includes(tag) ? 'group' : 'element' });
    }
  });

  return entries.slice(0, 120);
}

export function findInSource(source: string, query: string, maxResults = 80): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: SearchResult[] = [];
  source.split('\n').forEach((line, index) => {
    let from = 0;
    const lower = line.toLocaleLowerCase();
    while (matches.length < maxResults) {
      const found = lower.indexOf(needle, from);
      if (found < 0) break;
      matches.push({ line: index + 1, column: found + 1, excerpt: line.trim().slice(0, 180) || 'Blank line' });
      from = found + Math.max(1, needle.length);
    }
  });
  return matches;
}

export function sourceFromAssistantReply(reply: string, type: SourceType): string {
  const trimmed = reply.trim();
  const preferred = type === 'tikz'
    ? '(?:tikz|tex|latex)?'
    : type === 'latex'
      ? '(?:tex|latex|ltx)?'
    : type === 'metafont'
      ? '(?:metafont|mf)?'
    : type === 'mermaid'
      ? '(?:mermaid|mmd)?'
      : type === 'markdown'
        ? '(?:markdown|md)?'
        : type === 'text'
          ? '(?:text|txt)?'
          : '(?:svg|xml)?';
  const fenced = new RegExp(`^\\s*\`\`\`${preferred}\\s*\\n([\\s\\S]*?)\\n?\`\`\`\\s*$`, 'i').exec(trimmed);
  return (fenced?.[1] ?? trimmed).trimEnd() + '\n';
}

export function compactPath(path: string, maxLength = 42) {
  if (path.length <= maxLength) return path;
  const pieces = path.split('/');
  const tail = pieces.slice(-2).join('/');
  return tail.length >= maxLength ? `…${tail.slice(-(maxLength - 1))}` : `…/${tail}`;
}
