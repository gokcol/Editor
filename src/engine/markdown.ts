import DOMPurify from 'dompurify';
import { marked } from 'marked';

export type PreviewAppearance = 'dark' | 'light';

const markdownSanitizeOptions = { USE_PROFILES: { html: true } } as const;
const svgSanitizeOptions = { USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['style'] };

export async function renderMarkdownSource(source: string, renderMermaid: (source: string) => Promise<string>) {
  const parsed = marked.parse(source, { gfm: true, breaks: false }) as string;
  const document = new DOMParser().parseFromString(DOMPurify.sanitize(parsed, markdownSanitizeOptions), 'text/html');
  const mermaidBlocks = Array.from(document.querySelectorAll<HTMLElement>('pre > code.language-mermaid'));

  for (const code of mermaidBlocks) {
    const pre = code.parentElement;
    if (!pre) continue;
    const diagram = document.createElement('div');
    diagram.className = 'markdown-mermaid';
    try {
      const svg = await renderMermaid(code.textContent || '');
      diagram.innerHTML = DOMPurify.sanitize(svg, svgSanitizeOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagram.classList.add('markdown-mermaid-error');
      diagram.textContent = `Mermaid preview error: ${message}`;
    }
    pre.replaceWith(diagram);
  }

  return document.body.innerHTML;
}

export function markdownPreviewDocument(html: string, appearance: PreviewAppearance) {
  const isLight = appearance === 'light';
  const palette = isLight
    ? { page: '#fbfcff', ink: '#202a38', muted: '#68758a', edge: '#dce4ef', code: '#f0f4f8', quote: '#eef8f8', link: '#066c94' }
    : { page: '#111722', ink: '#e1e9f6', muted: '#9ba9bd', edge: '#29364a', code: '#0b111b', quote: '#152b31', link: '#76e0dd' };

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
<style>
  :root { color-scheme: ${appearance}; }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; background: ${palette.page}; color: ${palette.ink}; }
  body { padding: 30px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.65; }
  .markdown-body { width: min(880px, 100%); margin: 0 auto; overflow-wrap: anywhere; }
  h1, h2, h3, h4, h5, h6 { color: ${palette.ink}; line-height: 1.25; letter-spacing: -.02em; }
  h1 { margin: 0 0 .7em; padding-bottom: .45em; border-bottom: 1px solid ${palette.edge}; font-size: 2em; }
  h2 { margin-top: 1.85em; padding-bottom: .32em; border-bottom: 1px solid ${palette.edge}; font-size: 1.45em; }
  h3 { margin-top: 1.55em; font-size: 1.15em; }
  p, ul, ol { margin: .75em 0; } li + li { margin-top: .2em; }
  a { color: ${palette.link}; } blockquote { margin: 1em 0; padding: .65em 1em; border-left: 3px solid ${palette.link}; border-radius: 0 7px 7px 0; background: ${palette.quote}; color: ${palette.muted}; }
  code, pre { font-family: "SF Mono", Menlo, Monaco, Consolas, monospace; } code { padding: .13em .34em; border-radius: 4px; background: ${palette.code}; font-size: .88em; }
  pre { margin: 1em 0; padding: 14px; overflow: auto; border: 1px solid ${palette.edge}; border-radius: 8px; background: ${palette.code}; } pre code { padding: 0; background: transparent; }
  table { display: block; width: max-content; max-width: 100%; margin: 1em 0; overflow: auto; border-collapse: collapse; } th, td { padding: .5em .7em; border: 1px solid ${palette.edge}; text-align: left; } th { background: ${palette.code}; }
  hr { border: 0; border-top: 1px solid ${palette.edge}; } img { max-width: 100%; } .markdown-mermaid { margin: 1.25em 0; overflow: auto; text-align: center; } .markdown-mermaid svg { width: min(100%, 820px); height: auto; }
  .markdown-mermaid-error { padding: 12px; border: 1px solid #e28a8a; border-radius: 8px; color: #a32626; background: #fff0f0; font: 12px/1.5 "SF Mono", monospace; text-align: left; white-space: pre-wrap; }
</style></head><body><main class="markdown-body">${html}</main></body></html>`;
}
