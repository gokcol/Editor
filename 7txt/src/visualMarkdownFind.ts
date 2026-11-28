import type { Node } from '@milkdown/prose/model';
import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

type Match = { from: number; to: number };

function matchesIn(doc: Node, expression: RegExp) {
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    let text = '';
    let start = pos + 1;
    function collect() {
      expression.lastIndex = 0;
      for (const match of text.matchAll(expression)) {
        if (!match[0].length) continue;
        matches.push({ from: start + match.index, to: start + match.index + match[0].length });
      }
      text = '';
    }
    // Join adjacent text nodes across marks. Stop at an image, hard break,
    // or other inline node that a text replacement should never remove.
    node.forEach((child, offset) => {
      if (child.isText) {
        if (!text) start = pos + 1 + offset;
        text += child.text;
      } else collect();
    });
    collect();
    return false;
  });
  return matches;
}

export function createVisualFind(view: EditorView) {
  let highlight: Match | undefined;
  let highlightDoc: Node | undefined;
  view.setProps({
    decorations: state => {
      if (!highlight || highlightDoc !== state.doc) return null;
      if (state.selection.from !== highlight.from || state.selection.to !== highlight.to) return null;
      return DecorationSet.create(state.doc, [Decoration.inline(highlight.from, highlight.to, { class: 'visual-find-match' })]);
    },
  });

  function next(matches: Match[]) {
    return matches.find(match => match.from >= view.state.selection.to) ?? matches[0];
  }

  return {
    clear() {
      if (!highlight) return;
      highlight = undefined;
      highlightDoc = undefined;
      view.updateState(view.state);
    },
    next(expression: RegExp) {
      const match = next(matchesIn(view.state.doc, expression));
      if (!match) return false;
      highlight = match;
      highlightDoc = view.state.doc;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView());
      return true;
    },
    replace(expression: RegExp, text: string, all: boolean) {
      const state = view.state;
      const matches = matchesIn(state.doc, expression);
      if (!matches.length) return 0;
      const selected = matches.find(match => match.from === state.selection.from && match.to === state.selection.to);
      const targets = all ? matches : [selected ?? next(matches)];
      const tr = state.tr;
      highlight = undefined;
      highlightDoc = undefined;
      for (const { from, to } of [...targets].reverse()) {
        if (!text) tr.delete(from, to);
        else tr.replaceWith(from, to, state.schema.text(text, state.doc.resolve(from).nodeAfter?.marks));
      }
      if (!all) {
        tr.setSelection(TextSelection.create(tr.doc, targets[0].from + text.length)).scrollIntoView();
      }
      view.dispatch(tr);
      return view.state === state ? null : targets.length;
    },
  };
}
