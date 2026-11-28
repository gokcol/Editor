import type { Mark, Node } from '@milkdown/prose/model';
import { TextSelection } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import type { ContextGroup } from './visualContextMenu';
import { safeMarkdownLink } from './visualMarkdownSource';

type LinkRange = { from: number; to: number; mark: Mark };

function externalLink(url: string) {
  if (!safeMarkdownLink(url)) return false;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function linkAt(doc: Node, pos: number): LinkRange | undefined {
  const { parent, parentOffset } = doc.resolve(pos);
  const markType = doc.type.schema.marks.link;
  let offset = pos - parentOffset;
  let run: LinkRange | undefined;
  let found: LinkRange | undefined;
  let atEnd: LinkRange | undefined;
  function finish() {
    if (run && pos >= run.from && pos < run.to) found = run;
    if (run && pos === run.to) atEnd = run;
    run = undefined;
  }
  parent.forEach(node => {
    const mark = markType.isInSet(node.marks);
    const end = offset + node.nodeSize;
    if (mark && run?.mark.eq(mark)) run.to = end;
    else {
      finish();
      if (mark) run = { from: offset, to: end, mark };
    }
    offset = end;
  });
  finish();
  return found ?? atEnd;
}

export function createVisualLinkEditor(
  view: EditorView,
  dialog: HTMLDialogElement,
  onOpenLink: (url: string) => void,
  signal: AbortSignal,
) {
  const heading = dialog.querySelector<HTMLElement>('h2')!;
  const address = dialog.querySelector<HTMLInputElement>('[data-link-address]')!;
  const label = dialog.querySelector<HTMLInputElement>('[data-link-text]')!;
  const save = dialog.querySelector<HTMLButtonElement>('button[value="apply"]')!;
  let target: { doc: Node; from: number; to: number; originalText: string; mark?: Mark } | undefined;

  function open(existing?: LinkRange) {
    if (dialog.open) return;
    const { doc, selection } = view.state;
    const { from, to } = existing ?? selection;
    const originalText = doc.textBetween(from, to, ' ');
    target = { doc, from, to, originalText, mark: existing?.mark };
    let containsAtom = false;
    doc.nodesBetween(from, to, node => { if (node.isInline && !node.isText) containsAtom = true; });
    label.disabled = containsAtom || !doc.resolve(from).sameParent(doc.resolve(to));
    label.value = originalText;
    address.value = existing?.mark.attrs.href ?? '';
    address.setCustomValidity('');
    heading.textContent = existing ? 'Edit link' : 'Insert link';
    save.textContent = existing ? 'Apply' : 'Insert';
    dialog.showModal();
    address.focus();
    address.select();
  }

  const options = { signal };
  address.addEventListener('input', () => address.setCustomValidity(''), options);
  dialog.addEventListener('submit', event => {
    event.preventDefault();
    if ((event as SubmitEvent).submitter?.getAttribute('value') === 'cancel') {
      dialog.close();
      return;
    }
    const url = address.value.trim();
    if (!safeMarkdownLink(url)) {
      address.setCustomValidity('Enter a web address, email link, or relative path.');
      address.reportValidity();
      return;
    }
    if (!target || target.doc !== view.state.doc) {
      dialog.close();
      return;
    }
    const { from, to, originalText, mark } = target;
    const { schema, tr, doc } = view.state;
    const link = schema.marks.link.create({ href: url, title: mark?.attrs.title ?? null });
    const newText = label.disabled ? originalText : label.value;
    if (from === to || newText !== originalText) {
      const text = newText.trim() ? newText : url;
      const marks = schema.marks.link.removeFromSet(doc.resolve(from).nodeAfter?.marks ?? []);
      tr.replaceWith(from, to, schema.text(text, link.addToSet(marks)));
      tr.setSelection(TextSelection.create(tr.doc, from + text.length));
    } else {
      tr.removeMark(from, to, schema.marks.link).addMark(from, to, link);
    }
    view.dispatch(tr);
    dialog.close();
  }, options);
  dialog.addEventListener('close', () => { target = undefined; view.focus(); }, options);
  dialog.addEventListener('keydown', event => event.stopPropagation(), options);

  return {
    open,
    at: (pos = view.state.selection.from) => linkAt(view.state.doc, pos),
    group(existing: LinkRange): ContextGroup {
      const { from, to, mark } = existing;
      const url: string = mark.attrs.href;
      return {
        label: 'Link',
        actions: [
          { label: 'Edit link…', run: () => open(existing) },
          { label: 'Open link', enabled: externalLink(url), run: () => onOpenLink(url) },
          { label: 'Remove link', run: () => view.dispatch(view.state.tr.removeMark(from, to, mark)) },
        ],
      };
    },
    close: () => { if (dialog.open) dialog.close(); },
  };
}
