type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  url?: string;
};
type Parse = (source: string) => MarkdownNode;

export function safeMarkdownLink(url: string) {
  if (!url || /[\s\u0000-\u001f\u007f]/.test(url)) return false;
  if (/^(?:https?:\/\/|mailto:)/i.test(url)) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(url) && !/^[\\/]{2}/.test(url);
}

function supported(node: MarkdownNode): boolean {
  if (node.type === 'html') return false;
  if (node.type === 'link' && !safeMarkdownLink(node.url ?? '')) return false;
  return node.children?.every(supported) ?? true;
}

export function visualMarkdownAllowed(source: string) {
  // Leave room for layout and synchronous serialization on each edit.
  return source.length <= 200_000 && source.split('\n', 3001).length <= 3000;
}

function signatures(nodes: MarkdownNode[]) {
  return nodes.map(node => JSON.stringify(node, (key, value) => key === 'position' ? undefined : value));
}

function snapshot(source: string, parse: Parse) {
  const tree = parse(source);
  const blocks = tree.children ?? [];
  return { source, blocks, signatures: signatures(blocks), supported: supported(tree) };
}

function sameBlocks(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function createVisualMarkdownSource(parse: Parse) {
  let current = snapshot('', parse);
  return {
    load(source: string, serialized: string) {
      // Front matter uses Markdown-looking delimiters but has its own syntax.
      if (/^\uFEFF?(?:---|\+\+\+)[ \t]*\n[\s\S]*?\n(?:---|\+\+\+|\.\.\.)[ \t]*(?:\n|$)/.test(source)) return false;
      const next = snapshot(source, parse);
      if (!next.supported || !sameBlocks(next.signatures, snapshot(serialized, parse).signatures)) return false;
      current = next;
      return true;
    },
    edit(serialized: string) {
      const next = snapshot(serialized, parse);
      if (!next.supported) return null;
      if (sameBlocks(current.signatures, next.signatures)) return current.source;

      // Keep the original source for the leading and trailing blocks unaffected
      // by this edit. Check the splice in case Markdown delimiters interact.
      const before = current.signatures;
      const after = next.signatures;
      const shared = Math.min(before.length, after.length);
      let prefix = 0;
      while (prefix < shared && before[prefix] === after[prefix]) prefix++;
      let suffix = 0;
      while (suffix < shared - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      const start = (node?: MarkdownNode) => node?.position?.start.offset ?? 0;
      const end = (node?: MarkdownNode) => node?.position?.end.offset ?? 0;
      const left = current.source.slice(0, prefix ? end(current.blocks[prefix - 1]) : start(current.blocks[0]));
      const right = current.source.slice(suffix ? start(current.blocks[before.length - suffix]) : end(current.blocks.at(-1)));
      const middle = prefix + suffix < after.length
        ? serialized.slice(start(next.blocks[prefix]), end(next.blocks[after.length - 1 - suffix]))
        : '';
      const replacement = [prefix ? left : '', middle, suffix ? right : ''].filter(Boolean).join('\n\n');
      const candidate = snapshot((prefix ? '' : left) + replacement + (suffix ? '' : right), parse);
      if (!sameBlocks(candidate.signatures, after)) return null;
      current = candidate;
      return current.source;
    },
  };
}
