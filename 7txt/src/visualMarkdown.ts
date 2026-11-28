import { Editor, editorViewCtx, editorViewOptionsCtx, parserCtx, remarkCtx, rootCtx, serializerCtx } from '@milkdown/core';
import { gfm, insertTableCommand, addRowAfterCommand, addRowBeforeCommand, tableSchema } from '@milkdown/preset-gfm';
import { commonmark, remarkPreserveEmptyLinePlugin, wrapInHeadingCommand } from '@milkdown/preset-commonmark';
import { callCommand } from '@milkdown/utils';
import { lift, setBlockType, toggleMark, wrapIn } from '@milkdown/prose/commands';
import { liftListItem, sinkListItem, wrapInList } from '@milkdown/prose/schema-list';
import { Selection } from '@milkdown/prose/state';
import type { Command } from '@milkdown/prose/state';
import type { Node, ResolvedPos } from '@milkdown/prose/model';
import type { EditorView, NodeViewConstructor } from '@milkdown/prose/view';
import '@milkdown/prose/view/style/prosemirror.css';
import '@milkdown/prose/tables/style/tables.css';
import { createVisualMarkdownSource } from './visualMarkdownSource';
import { createVisualContextMenu } from './visualContextMenu';
import type { ContextGroup } from './visualContextMenu';
import { createVisualFind } from './visualMarkdownFind';
import { createVisualLinkEditor } from './visualMarkdownLink';
import { tableContextGroups } from './visualMarkdownTable';

// Milkdown's empty paragraph placeholder is raw HTML, including on Enter in
// a list. Use plain Markdown for empty items and keep the HTML guard intact.
const visualCommonmark = commonmark.filter(plugin =>
  plugin !== remarkPreserveEmptyLinePlugin.plugin && plugin !== remarkPreserveEmptyLinePlugin.options
);
// GFM allows a header-only table. Keep its header when the last body row is deleted.
const visualTableSchema = tableSchema.extendSchema(previous => ctx => ({
  ...previous(ctx),
  content: 'table_header_row table_row*',
}));
const visualGfm = gfm.map(plugin =>
  plugin === tableSchema.node ? visualTableSchema.node : plugin === tableSchema.ctx ? visualTableSchema.ctx : plugin
);

function findAncestor(position: ResolvedPos, name: string) {
  for (let depth = position.depth; depth > 0; depth--) {
    const node = position.node(depth);
    if (node.type.name === name) return { node, pos: position.before(depth) };
  }
  return null;
}

function ancestor(view: EditorView, name: string) {
  return findAncestor(view.state.selection.$from, name);
}

function hasMark(view: EditorView, name: string) {
  const { selection, storedMarks, doc, schema } = view.state;
  const mark = schema.marks[name];
  return selection.empty
    ? Boolean(mark.isInSet(storedMarks ?? selection.$from.marks()))
    : doc.rangeHasMark(selection.from, selection.to, mark);
}

const listItemView: NodeViewConstructor = (node, view, getPos) => {
  const li = document.createElement('li');
  if (node.attrs.checked == null) return { dom: li, contentDOM: li };
  li.className = 'visual-task';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = Boolean(node.attrs.checked);
  check.contentEditable = 'false';
  check.setAttribute('aria-label', 'Task complete');
  const content = document.createElement('div');
  li.append(check, content);
  check.addEventListener('change', () => {
    const pos = getPos();
    if (pos === undefined) return;
    const item = view.state.doc.nodeAt(pos);
    if (!item) return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: check.checked }));
    check.checked = Boolean(view.state.doc.nodeAt(pos)?.attrs.checked);
  });
  return {
    dom: li,
    contentDOM: content,
    stopEvent: event => event.target === check,
    ignoreMutation: mutation => mutation.target === check,
    update(next) {
      if (next.type !== node.type || next.attrs.checked == null) return false;
      check.checked = Boolean(next.attrs.checked);
      return true;
    },
  };
};

// Show image alt text without loading remote or local file URLs.
const imageView: NodeViewConstructor = (node) => {
  const dom = document.createElement('span');
  dom.className = 'visual-image';
  dom.contentEditable = 'false';
  dom.textContent = node.attrs.alt ? `Image: ${node.attrs.alt}` : 'Image';
  return { dom };
};

function preventLinkNavigation(_view: EditorView, event: Event) {
  if (!(event.target instanceof Element) || !event.target.closest('a')) return false;
  event.preventDefault();
  return true;
}

export async function mountVisualMarkdown(
  host: HTMLElement,
  toolbar: HTMLElement,
  source: string,
  { onChange, onUnsafeEdit, onOpenLink }: {
    onChange: (source: string) => void;
    onUnsafeEdit: () => void;
    onOpenLink: (url: string) => void;
  },
) {
  let appliedSource = source;
  let commit: ((doc: Node) => boolean) | undefined;
  let reflectToolbar = () => {};
  const editor = Editor.make()
    .config(ctx => {
      ctx.set(rootCtx, host);
      ctx.set(editorViewOptionsCtx, {
        attributes: { 'aria-label': 'Visual Markdown editor', 'aria-multiline': 'true', spellcheck: 'true' },
        nodeViews: { list_item: listItemView, image: imageView },
        handleDOMEvents: { click: preventLinkNavigation, auxclick: preventLinkNavigation },
        dispatchTransaction(this: EditorView, transaction) {
          const next = this.state.applyTransaction(transaction).state;
          if (next.doc !== this.state.doc && !this.state.doc.eq(next.doc) && !commit?.(next.doc)) return;
          this.updateState(next);
          reflectToolbar();
        },
      });
    })
    .use(visualCommonmark)
    .use(visualGfm);

  try {
    await editor.create();
    return editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const parse = ctx.get(parserCtx);
      const serialize = ctx.get(serializerCtx);
      const remark = ctx.get(remarkCtx);
      const markdown = createVisualMarkdownSource(text => remark.parse(text));
      const controls = new AbortController();
      view.dom.classList.remove('editor'); // Milkdown's class is also 7TXT's textarea selector.

      function load(text: string) {
        const doc = parse(text);
        if (!doc || !markdown.load(text, serialize(doc))) return false;
        appliedSource = text;
        const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
        const position = Math.min(view.state.selection.from, tr.doc.content.size);
        tr.setSelection(Selection.near(tr.doc.resolve(position)));
        view.updateState(view.state.applyTransaction(tr).state);
        reflectToolbar();
        return true;
      }
      if (!load(source)) throw new Error('This Markdown uses syntax that Visual can’t safely edit. It’s open in Source.');
      commit = doc => {
        try {
          const next = markdown.edit(serialize(doc));
          if (next !== null) {
            if (next !== appliedSource) {
              appliedSource = next;
              onChange(next);
            }
            return true;
          }
        } catch {
          // Keep the current document and selection if conversion failed.
        }
        onUnsafeEdit();
        return false;
      };

      function apply(command: Command) {
        command(view.state, view.dispatch, view);
      }
      function list(name: 'bullet_list' | 'ordered_list') {
        const current = ancestor(view, 'bullet_list') || ancestor(view, 'ordered_list');
        if (current?.node.type.name === name) {
          apply(liftListItem(view.state.schema.nodes.list_item));
        } else if (current) {
          view.dispatch(view.state.tr.setNodeMarkup(current.pos, view.state.schema.nodes[name]));
        } else {
          apply(wrapInList(view.state.schema.nodes[name]));
        }
      }
      function task() {
        const item = ancestor(view, 'list_item');
        if (item) {
          const checked = item.node.attrs.checked == null ? false : null;
          view.dispatch(view.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked }));
          return;
        }
        wrapInList(view.state.schema.nodes.bullet_list)(view.state, tr => {
          const wrapped = findAncestor(tr.selection.$from, 'list_item');
          if (wrapped) view.dispatch(tr.setNodeMarkup(wrapped.pos, undefined, { ...wrapped.node.attrs, checked: false }));
        }, view);
      }

      const headings = toolbar.querySelector<HTMLSelectElement>('select')!;
      const pane = toolbar.parentElement!;
      const linkDialog = pane.querySelector<HTMLDialogElement>('.visual-link-dialog')!;
      const links = createVisualLinkEditor(view, linkDialog, onOpenLink, controls.signal);
      const menu = createVisualContextMenu(pane, () => view.focus(), controls.signal);
      const search = createVisualFind(view);
      const table = () => Boolean(ancestor(view, 'table'));
      const tableButton = toolbar.querySelector<HTMLButtonElement>('[data-format="table"]')!;
      const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button[data-format]'));
      reflectToolbar = () => {
        menu.close();
        headings.value = String(ancestor(view, 'heading')?.node.attrs.level ?? 0);
        const item = ancestor(view, 'list_item');
        const active: Record<string, boolean> = {
          strong: hasMark(view, 'strong'),
          emphasis: hasMark(view, 'emphasis'),
          strike_through: hasMark(view, 'strike_through'),
          inlineCode: hasMark(view, 'inlineCode'),
          bullet: Boolean(ancestor(view, 'bullet_list')),
          ordered: Boolean(ancestor(view, 'ordered_list')),
          task: item != null && item.node.attrs.checked != null,
          quote: Boolean(ancestor(view, 'blockquote')),
          codeBlock: Boolean(ancestor(view, 'code_block')),
        };
        for (const button of buttons) {
          const command = button.dataset.format!;
          if (command in active) button.setAttribute('aria-pressed', String(active[command]));
        }
        const tableLabel = table() ? 'Table actions' : 'Insert table';
        tableButton.title = tableLabel;
        tableButton.setAttribute('aria-label', tableLabel);
      };
      const options = { signal: controls.signal };
      function contextGroups(at: number, linkOnly: boolean): ContextGroup[] {
        const groups: ContextGroup[] = [];
        const link = links.at(at);
        if (link) groups.push(links.group(link));
        if (linkOnly) return groups;
        groups.push(...tableContextGroups(view, {
          before: () => editor.action(callCommand(addRowBeforeCommand.key)),
          after: () => editor.action(callCommand(addRowAfterCommand.key)),
        }));
        if (ancestor(view, 'list_item')) {
          const type = view.state.schema.nodes.list_item;
          const indent = sinkListItem(type);
          const outdent = liftListItem(type);
          groups.push({
            label: 'List',
            actions: [
              { label: 'Indent list item', enabled: indent(view.state), run: () => apply(indent) },
              { label: 'Outdent list item', enabled: outdent(view.state), run: () => apply(outdent) },
            ],
          });
        }
        return groups;
      }

      function openPointerMenu(event: MouseEvent, linkOnly = false) {
        if (!(event.target instanceof Element)) return;
        const anchor = event.target.closest('a');
        if (linkOnly && !anchor) return;
        if (!anchor && !event.target.closest('td, th, li')) return;
        const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const at = anchor ? view.posAtDOM(anchor, 0) : hit?.pos;
        if (at === undefined) return;
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(at))));
        const groups = contextGroups(at, linkOnly);
        if (!groups.length) return;
        event.preventDefault();
        const caret = view.coordsAtPos(view.state.selection.head);
        menu.show(groups, event.clientX || caret.left, event.clientY || caret.bottom);
      }

      view.dom.addEventListener('contextmenu', event => openPointerMenu(event), options);
      view.dom.addEventListener('click', event => {
        if (event.button === 0) openPointerMenu(event, true);
      }, options);
      view.dom.addEventListener('keydown', event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        const at = view.state.selection.head;
        const groups = contextGroups(at, false);
        if (!groups.length) return;
        event.preventDefault();
        event.stopPropagation();
        const caret = view.coordsAtPos(at);
        menu.show(groups, caret.left, caret.bottom);
      }, options);
      toolbar.addEventListener('mousedown', event => {
        if (event.target instanceof Element && event.target.closest('button')) event.preventDefault();
      }, options);
      toolbar.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const format = event.target.closest<HTMLButtonElement>('button[data-format]')?.dataset.format;
        if (!format) return;
        const { schema } = view.state;
        switch (format) {
          case 'strong': case 'emphasis': case 'strike_through': case 'inlineCode':
            apply(toggleMark(schema.marks[format]));
            break;
          case 'bullet': list('bullet_list'); break;
          case 'ordered': list('ordered_list'); break;
          case 'task': task(); break;
          case 'quote': apply(ancestor(view, 'blockquote') ? lift : wrapIn(schema.nodes.blockquote)); break;
          case 'codeBlock': apply(setBlockType(ancestor(view, 'code_block') ? schema.nodes.paragraph : schema.nodes.code_block)); break;
          case 'table':
            if (table()) {
              const bounds = tableButton.getBoundingClientRect();
              menu.show(contextGroups(view.state.selection.head, false), bounds.left, bounds.bottom + 4);
              return;
            }
            editor.action(callCommand(insertTableCommand.key, { row: 3, col: 2 }));
            break;
          case 'link':
            links.open(links.at());
            return;
        }
        view.focus();
      }, options);
      headings.addEventListener('change', () => {
        editor.action(callCommand(wrapInHeadingCommand.key, Number(headings.value)));
        view.focus();
      }, options);
      reflectToolbar();
      return {
        focus: () => view.focus(),
        search,
        selectedText: () => {
          const { doc, selection } = view.state;
          return doc.textBetween(selection.from, selection.to, '\n');
        },
        sync: (text: string) => text === appliedSource || load(text),
        destroy: () => {
          controls.abort();
          links.close();
          return editor.destroy();
        },
      };
    });
  } catch (error) {
    await editor.destroy();
    throw error;
  }
}
