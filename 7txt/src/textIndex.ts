function upperBound(values: readonly number[], offset: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= offset) low = middle + 1; else high = middle;
  }
  return low;
}

/** Textarea offsets use UTF-16 code units, including for emoji and selections. */
export function changedRange(before: string, after: string, hint = 0) {
  const shared = Math.min(before.length, after.length);
  let start = Math.max(0, Math.min(hint, shared));
  if (before.slice(0, start) !== after.slice(0, start)) start = 0;
  // Compare native string chunks before checking individual code units. This
  // also keeps undo, paste, and programmatic replacements fast without a hint.
  while (start + 4096 <= shared && before.slice(start, start + 4096) === after.slice(start, start + 4096)) start += 4096;
  while (start < shared && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let suffix = 0;
  const remaining = shared - start;
  while (suffix + 4096 <= remaining && before.slice(before.length - suffix - 4096, before.length - suffix) === after.slice(after.length - suffix - 4096, after.length - suffix)) suffix += 4096;
  while (suffix < remaining && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)) suffix += 1;
  return { start, end: before.length - suffix, inserted: after.slice(start, after.length - suffix) };
}

/** A single active document's logical line starts; no per-line string copies. */
export class TextIndex {
  private value = '';
  private starts = [0];

  constructor(text = '') { this.reset(text); }
  get text() { return this.value; }
  get lineCount() { return this.starts.length; }

  reset(text: string): void {
    this.value = text;
    this.starts = [0];
    for (let offset = text.indexOf('\n'); offset !== -1; offset = text.indexOf('\n', offset + 1)) this.starts.push(offset + 1);
  }

  update(text: string, hint?: number): void {
    if (text === this.value) return;
    const { start, end, inserted } = changedRange(this.value, text, hint);
    const first = upperBound(this.starts, start);
    const last = upperBound(this.starts, end);
    const delta = inserted.length - (end - start);
    const added: number[] = [];
    for (let offset = inserted.indexOf('\n'); offset !== -1; offset = inserted.indexOf('\n', offset + 1)) added.push(start + offset + 1);
    for (let index = last; index < this.starts.length; index++) this.starts[index] += delta;
    if (first !== last || added.length) {
      // Array concatenation supports large pastes without argument-count limits.
      this.starts = this.starts.slice(0, first).concat(added, this.starts.slice(last));
    }
    this.value = text;
  }

  positionAt(offset: number) {
    const position = Math.max(0, Math.min(offset, this.value.length));
    const index = Math.max(0, upperBound(this.starts, position) - 1);
    return { line: index + 1, column: position - this.starts[index] + 1 };
  }

  rangeForLine(line: number) {
    const index = Math.max(0, Math.min(Math.trunc(line) - 1, this.starts.length - 1));
    return { start: this.starts[index], end: index + 1 < this.starts.length ? this.starts[index + 1] - 1 : this.value.length };
  }
}
