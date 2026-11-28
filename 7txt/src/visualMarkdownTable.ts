import {
  addColumnAfter, addColumnBefore, deleteColumn, deleteRow, deleteTable,
  isInTable, moveTableRow, selectedRect,
} from '@milkdown/prose/tables';
import type { Command } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import type { ContextGroup } from './visualContextMenu';

type RowActions = { before: () => void; after: () => void };

export function tableContextGroups(view: EditorView, rows: RowActions): ContextGroup[] {
  if (!isInTable(view.state)) return [];
  const { top, bottom, left, right, map, table, tableStart } = selectedRect(view.state);
  const bodyRow = top > 0;
  const singleRow = bottom === top + 1;
  const run = (command: Command) => () => command(view.state, view.dispatch, view);
  const alignments = ['left', 'center', 'right'] as const;

  return [
    {
      label: 'Table',
      actions: [
        { label: 'Add row above', enabled: bodyRow, run: rows.before },
        { label: 'Add row below', run: rows.after },
        { label: 'Move row up', enabled: singleRow && top > 1, run: run(moveTableRow({ from: top, to: top - 1 })) },
        { label: 'Move row down', enabled: bodyRow && singleRow && bottom < map.height, run: run(moveTableRow({ from: top, to: top + 1 })) },
        { label: 'Delete row', enabled: bodyRow, run: run(deleteRow) },
        { label: 'Add column to the left', run: run(addColumnBefore) },
        { label: 'Add column to the right', run: run(addColumnAfter) },
        { label: 'Delete column', enabled: right - left < map.width, run: run(deleteColumn) },
        { label: 'Delete table', run: run(deleteTable) },
      ],
    },
    {
      label: 'Column alignment',
      actions: alignments.map(alignment => {
        const cells = map.cellsInRect({ top: 0, bottom: map.height, left, right });
        return {
          label: `Align ${alignment}`,
          checked: cells.every(pos => (table.nodeAt(pos)?.attrs.alignment ?? 'left') === alignment),
          run() {
            const tr = view.state.tr;
            for (const pos of cells) {
              const cell = table.nodeAt(pos);
              if (cell) tr.setNodeMarkup(tableStart + pos, undefined, { ...cell.attrs, alignment });
            }
            view.dispatch(tr);
          },
        };
      }),
    },
  ];
}
