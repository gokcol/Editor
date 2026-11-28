const groups = [
  [
    ['strong', 'Bold', 'M7 12h6a4 4 0 0 1 0 8H7V4h5a4 4 0 0 1 0 8'],
    ['emphasis', 'Italic', 'M11 4h8M5 20h8M15 4 9 20'],
    ['strike_through', 'Strikethrough', 'M18 6c-2-3-12-3-12 2 0 5 12 2 12 8s-10 5-13 2M3 12h18'],
    ['inlineCode', 'Inline code', 'm8 7-5 5 5 5m8-10 5 5-5 5m-2-13-4 16'],
    ['link', 'Insert link', 'M10 13.5a4 4 0 0 0 5.7.1l2-2a4 4 0 0 0-5.7-5.7l-1.1 1.1M14 10.5a4 4 0 0 0-5.7-.1l-2 2a4 4 0 0 0 5.7 5.7l1.1-1.1'],
  ],
  [
    ['bullet', 'Bulleted list', 'M4 6h.1M4 12h.1M4 18h.1M9 6h11M9 12h11M9 18h11'],
    ['ordered', 'Numbered list', 'M3 6l2-2v6M3 10h4m-4 4c0-2 4-2 4 0s-4 3-4 6h4M10 7h10M10 17h10'],
    ['task', 'Task list', 'M3 6h6v6H3zM4 8.5l2 2 5-5M13 9h8M3 15h6v6H3zM13 18h8'],
    ['quote', 'Block quote', 'M9 7H4v6h5v-3c0 5-2 7-5 7m15-10h-5v6h5v-3c0 5-2 7-5 7'],
    ['codeBlock', 'Code block', 'M3 4h18v16H3zM9 9l-3 3 3 3m6-6 3 3-3 3'],
  ],
  [
    ['table', 'Insert table', 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14M15 5v14'],
  ],
];

export const visualMarkdownMarkup = `
  <section class="visual-markdown" aria-label="Visual Markdown" hidden>
    <div class="visual-format" role="group" aria-label="Visual formatting">
      <label class="visual-heading">
        <svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14m10-14v14M5 12h10m3-1 2 2 2-2"/></svg>
        <select aria-label="Paragraph or heading" title="Paragraph or heading">
          <option value="0">Paragraph</option>
          ${Array.from({ length: 6 }, (_, i) => `<option value="${i + 1}">Heading ${i + 1}</option>`).join('')}
        </select>
      </label>
      ${groups.map(group => `<div class="visual-format-group">${group.map(([key, label, icon]) =>
        `<button type="button" class="toolbar-icon-button" data-format="${key}" aria-label="${label}" title="${label}"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${icon}"/></svg></button>`).join('')}</div>`).join('')}
      <button type="button" class="toolbar-icon-button visual-find-button" data-action="find" aria-label="Find and replace" title="Find and replace"><svg class="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="5.5"/><path d="m16 16 4 4"/></svg></button>
    </div>
    <p class="visual-loading" role="status" hidden>Opening visual editor…</p>
    <div class="visual-document markdown-preview"></div>
    <dialog class="visual-link-dialog" aria-labelledby="visual-link-heading">
      <form method="dialog">
        <h2 id="visual-link-heading">Insert link</h2>
        <label>Link address<input data-link-address type="text" placeholder="https://example.com" autocomplete="off" spellcheck="false" required /></label>
        <label>Link text<input data-link-text type="text" autocomplete="off" /></label>
        <div class="visual-link-actions">
          <button value="cancel" formnovalidate>Cancel</button><button value="apply">Insert</button>
        </div>
      </form>
    </dialog>
  </section>`;
