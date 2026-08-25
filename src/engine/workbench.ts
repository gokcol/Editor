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

export type TextStatistics = {
  lines: number;
  words: number;
  characters: number;
};

export type SourceDiffLine = {
  kind: 'context' | 'added' | 'removed';
  text: string;
};

function cleanLabel(value: string) {
  return value.replace(/\s+/g, ' ').replace(/[{}]/g, '').trim().slice(0, 96) || 'Untitled';
}

/**
 * Small, deterministic fuzzy score for local navigation. It keeps Quick Open
 * responsive without pulling in a search package: contiguous matches and
 * filename/path-boundary matches rank above scattered characters.
 */
export function fuzzyScore(value: string, query: string): number {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;
  const haystack = value.toLocaleLowerCase();
  let position = 0;
  let score = 0;
  let previous = -2;

  for (const character of needle) {
    const next = haystack.indexOf(character, position);
    if (next < 0) return Number.NEGATIVE_INFINITY;
    score += 8;
    if (next === previous + 1) score += 12;
    if (next === 0 || /[\\/_.\-\s]/.test(haystack[next - 1])) score += 7;
    score -= Math.min(5, next - position);
    previous = next;
    position = next + 1;
  }

  return score - Math.min(12, haystack.length / 24);
}

export function textStatistics(source: string): TextStatistics {
  return {
    lines: source ? source.split('\n').length : 0,
    words: (source.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length,
    characters: [...source].length,
  };
}

/** Build a stable, portable Markdown TOC enclosed in replaceable markers. */
export function upsertMarkdownTableOfContents(source: string): { source: string; count: number } {
  const lines = source.split('\n');
  const headings: Array<{ depth: number; label: string; slug: string }> = [];
  const seenSlugs = new Map<string, number>();
  let fence: string | undefined;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^(#{2,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const label = match[2].replace(/[`*_~]/g, '').trim();
    if (!label) continue;
    const base = label
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/[\s-]+/g, '-') || 'section';
    const occurrence = (seenSlugs.get(base) ?? 0) + 1;
    seenSlugs.set(base, occurrence);
    headings.push({ depth: match[1].length, label, slug: occurrence === 1 ? base : `${base}-${occurrence}` });
  }

  const toc = [
    '<!-- yedit:toc:start -->',
    ...headings.map((heading) => `${'  '.repeat(Math.max(0, heading.depth - 2))}- [${heading.label}](#${heading.slug})`),
    '<!-- yedit:toc:end -->',
  ].join('\n');
  const marker = /<!-- yedit:toc:start -->[\s\S]*?<!-- yedit:toc:end -->/;
  if (marker.test(source)) return { source: source.replace(marker, toc), count: headings.length };

  const firstHeading = lines.findIndex((line) => /^#\s+/.test(line));
  const insertAt = firstHeading >= 0 ? firstHeading + 1 : 0;
  const next = [...lines.slice(0, insertAt), '', toc, '', ...lines.slice(insertAt)].join('\n');
  return { source: next, count: headings.length };
}

/**
 * A compact review diff. Long documents retain unchanged leading/trailing
 * context while the changed middle remains explicit and copyable.
 */
export function sourceReviewDiff(before: string, after: string, context = 3): SourceDiffLine[] {
  if (before === after) return [{ kind: 'context', text: 'No source changes proposed.' }];
  const left = before.split('\n');
  const right = after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]
  ) suffix += 1;
  const leading = left.slice(Math.max(0, prefix - context), prefix).map((text) => ({ kind: 'context' as const, text }));
  const removed = left.slice(prefix, left.length - suffix).map((text) => ({ kind: 'removed' as const, text }));
  const added = right.slice(prefix, right.length - suffix).map((text) => ({ kind: 'added' as const, text }));
  const trailing = right.slice(right.length - suffix, Math.min(right.length, right.length - suffix + context)).map((text) => ({ kind: 'context' as const, text }));
  return [...leading, ...removed, ...added, ...trailing];
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

    if (type === 'yaml' || type === 'json') {
      const key = type === 'yaml'
        ? /^\s*(?:-\s+)?([A-Za-z_][\w.-]*)\s*:/.exec(line)
        : /^\s*"((?:[^"\\]|\\.)+)"\s*:/.exec(line);
      if (key) {
        const depth = Math.max(0, Math.floor((line.match(/^\s*/)?.[0].length ?? 0) / 2));
        entries.push({ id: type + '-key-' + lineNumber, line: lineNumber, depth, label: cleanLabel(key[1]), kind: depth ? 'element' : 'section' });
      }
      return;
    }

    if (type === 'javascript' || type === 'typescript' || type === 'python') {
      const declaration = type === 'python'
        ? /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/.exec(line)
        : /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (declaration) {
        const declarationKind = declaration[1].toLowerCase();
        entries.push({
          id: type + '-' + declarationKind + '-' + lineNumber,
          line: lineNumber,
          depth: /^\s+/.test(line) ? 1 : 0,
          label: cleanLabel(declaration[2]),
          kind: declarationKind === 'class' || declarationKind === 'interface' ? 'group' : 'node',
        });
      }
      return;
    }

    if (type === 'fortran') {
      const declaration = /^\s*(program|module|subroutine|function|type)\s+([A-Za-z_][\w]*)/i.exec(line.replace(/!.*/, ''));
      if (declaration) {
        const declarationKind = declaration[1].toLowerCase();
        entries.push({
          id: 'fortran-' + declarationKind + '-' + lineNumber,
          line: lineNumber,
          depth: declarationKind === 'program' || declarationKind === 'module' ? 0 : 1,
          label: cleanLabel(declaration[2]),
          kind: declarationKind === 'module' || declarationKind === 'type' ? 'group' : 'node',
        });
      }
      return;
    }

    if (type === 'sql') {
      const cte = /^\s*with\s+([A-Za-z_][\w$]*)\s+as\s*\(/i.exec(line);
      const relation = /^\s*create\s+(?:table|view)\s+([A-Za-z_][\w$]*)/i.exec(line);
      const name = cte?.[1] ?? relation?.[1];
      if (name) entries.push({ id: 'sql-' + lineNumber, line: lineNumber, depth: 0, label: cleanLabel(name), kind: cte ? 'node' : 'group' });
      return;
    }

    if (type === 'html') {
      const heading = /<h([1-6])\b[^>]*>(.*?)<\/h\1>/i.exec(line);
      const id = /\bid\s*=\s*(["'])([^"']+)\1/.exec(line);
      if (heading) {
        entries.push({ id: 'html-heading-' + lineNumber, line: lineNumber, depth: Number(heading[1]) - 1, label: cleanLabel(heading[2].replace(/<[^>]+>/g, '')), kind: 'section' });
      } else if (id) {
        entries.push({ id: 'html-id-' + lineNumber, line: lineNumber, depth: 1, label: cleanLabel(id[2]), kind: 'element' });
      }
      return;
    }

    if (type === 'css') {
      const variable = /^\s*(--[A-Za-z_][\w-]*)\s*:/.exec(line);
      const selector = /^\s*([^@][^{]+?)\s*\{\s*$/.exec(line);
      if (variable) {
        entries.push({ id: 'css-var-' + lineNumber, line: lineNumber, depth: 1, label: cleanLabel(variable[1]), kind: 'element' });
      } else if (selector) {
        entries.push({ id: 'css-selector-' + lineNumber, line: lineNumber, depth: 0, label: cleanLabel(selector[1]), kind: 'group' });
      }
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
          : type === 'yaml'
            ? '(?:yaml|yml)?'
            : type === 'json'
              ? '(?:json|json-schema|jsonschema)?'
              : type === 'javascript'
                ? '(?:js|javascript|cjs|mjs|jsx)?'
                : type === 'typescript'
                  ? '(?:ts|typescript|tsx|mts|cts)?'
                  : type === 'python'
                    ? '(?:py|python)?'
                    : type === 'fortran'
                      ? '(?:fortran|f90|f95|f03|f08)?'
                      : type === 'sql'
                        ? '(?:sql|postgres|mysql)?'
                        : type === 'html'
                          ? '(?:html|htm|xhtml)?'
                          : type === 'css'
                            ? '(?:css|scss)?'
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
