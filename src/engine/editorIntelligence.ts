import type { Monaco } from '@monaco-editor/react';
import type * as MonacoEditor from 'monaco-editor';
import type {
  EditorDiagnostic,
  EditorDiagnosticSeverity,
  FoundryLanguageId,
  ReferenceEntry,
  SourceType,
} from '../types';
import { formatSource } from './formatters';
import { references } from './references';

/** IDs used by the Monaco configuration and by model diagnostics. */
export const FOUNDRY_LANGUAGE_IDS: Record<SourceType, FoundryLanguageId> = {
  tikz: 'foundry-tikz',
  latex: 'foundry-latex',
  svg: 'foundry-svg',
  mermaid: 'foundry-mermaid',
  markdown: 'foundry-markdown',
  text: 'foundry-text',
};

export const FOUNDRY_MARKER_OWNER = 'diagram-foundry';

const LANGUAGE_TO_SOURCE_TYPE: Record<FoundryLanguageId, SourceType> = {
  'foundry-tikz': 'tikz',
  'foundry-latex': 'latex',
  'foundry-svg': 'svg',
  'foundry-mermaid': 'mermaid',
  'foundry-markdown': 'markdown',
  'foundry-text': 'text',
};

type CatalogItem = {
  label: string;
  detail: string;
  description: string;
  insertText: string;
  kind: 'snippet' | 'keyword' | 'reference';
  aliases: string[];
  example?: string;
};

type LineWithOffset = {
  text: string;
  lineNumber: number;
  offset: number;
};

type ScopedLine = {
  name: string;
  lineNumber: number;
};

export type FoundryEditorIntelligence = {
  /** Re-run validation immediately and return the source-local diagnostics. */
  validateModel: (model: MonacoEditor.editor.ITextModel) => EditorDiagnostic[];
  /** Dispose all Monaco providers and model listeners registered by this layer. */
  dispose: () => void;
};

const coreCatalog: Record<SourceType, CatalogItem[]> = {
  tikz: [
    {
      label: '\\begin{tikzpicture}',
      detail: 'TikZ picture environment',
      description: 'Starts an isolated TikZ drawing with local styles and layout options.',
      insertText: '\\begin{tikzpicture}[${1:options}]\n  ${0}\n\\end{tikzpicture}',
      kind: 'snippet',
      aliases: ['tikzpicture', 'begin', 'picture'],
    },
    {
      label: '\\node',
      detail: 'TikZ node',
      description: 'Places named content at a coordinate. Use the name later in paths and relative positioning.',
      insertText: '\\node[${1:options}] (${2:name}) {${3:Label}};${0}',
      kind: 'snippet',
      aliases: ['node', 'tikz-node', 'label'],
    },
    {
      label: '\\draw',
      detail: 'TikZ path',
      description: 'Draws a path between coordinates or named node anchors.',
      insertText: '\\draw[-{Stealth}] (${1:from}) -- (${2:to});${0}',
      kind: 'snippet',
      aliases: ['draw', 'path', 'arrow', 'edge'],
    },
    {
      label: '\\coordinate',
      detail: 'Named coordinate',
      description: 'Creates a reusable named point without drawing visible content.',
      insertText: '\\coordinate (${1:name}) at (${2:0}, ${3:0});${0}',
      kind: 'snippet',
      aliases: ['coordinate', 'point'],
    },
    {
      label: '\\foreach',
      detail: 'TikZ loop',
      description: 'Repeats a drawing operation for each item in a list or numeric range.',
      insertText: '\\foreach \\item in {${1:a,b,c}} {\n  ${0}\n}',
      kind: 'snippet',
      aliases: ['foreach', 'loop', 'repeat'],
    },
    {
      label: '\\tikzset',
      detail: 'Reusable styles',
      description: 'Defines reusable TikZ keys and styles outside or before a picture.',
      insertText: '\\tikzset{\n  ${1:style name}/.style={${2:draw, rounded corners}}\n}${0}',
      kind: 'snippet',
      aliases: ['tikzset', 'style', 'styles'],
    },
    {
      label: '\\usetikzlibrary',
      detail: 'TikZ library',
      description: 'Loads TikZ libraries such as arrows.meta, positioning, and shapes.geometric.',
      insertText: '\\usetikzlibrary{${1:arrows.meta,positioning}}${0}',
      kind: 'snippet',
      aliases: ['usetikzlibrary', 'library', 'arrows.meta', 'positioning'],
    },
  ],
  latex: [
    {
      label: '\\documentclass',
      detail: 'LaTeX document class',
      description: 'Starts a standalone document with its global layout and typographic defaults.',
      insertText: '\\documentclass[${1:11pt}]{${2:article}}${0}',
      kind: 'snippet',
      aliases: ['documentclass', 'class', 'article', 'report'],
    },
    {
      label: '\\usepackage',
      detail: 'LaTeX package',
      description: 'Loads a deliberate dependency in the document preamble.',
      insertText: '\\usepackage[${1:options}]{${2:package}}${0}',
      kind: 'snippet',
      aliases: ['usepackage', 'package', 'preamble'],
    },
    {
      label: '\\section',
      detail: 'Document section',
      description: 'Adds a numbered heading to structure a longer LaTeX document.',
      insertText: '\\section{${1:Section title}}\n\n${0}',
      kind: 'snippet',
      aliases: ['section', 'heading', 'subsection'],
    },
    {
      label: '\\begin{document}',
      detail: 'Document environment',
      description: 'Wraps the visible document body after preamble packages and metadata.',
      insertText: '\\begin{document}\n  ${0}\n\\end{document}',
      kind: 'snippet',
      aliases: ['document', 'begin', 'end', 'environment'],
    },
    {
      label: 'Display equation',
      detail: 'Unnumbered math block',
      description: 'Places a short equation on its own line without assigning a reference number.',
      insertText: '\\[\n  ${1:equation}\n\\]${0}',
      kind: 'snippet',
      aliases: ['equation', 'math', 'display', 'formula'],
    },
    {
      label: '\\begin{itemize}',
      detail: 'Bullet list',
      description: 'Creates a compact bulleted list in the document body.',
      insertText: '\\begin{itemize}\n  \\item ${1:First point}\n  \\item ${2:Second point}\n\\end{itemize}${0}',
      kind: 'snippet',
      aliases: ['itemize', 'item', 'list', 'bullet'],
    },
  ],
  svg: [
    {
      label: '<svg>',
      detail: 'Responsive SVG root',
      description: 'Creates a standalone SVG canvas with a responsive viewBox and accessible text alternatives.',
      insertText: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${1:800} ${2:480}" role="img" aria-labelledby="${3:title} ${4:desc}">\n  <title id="${3:title}">${5:Diagram title}</title>\n  <desc id="${4:desc}">${6:Diagram description}</desc>\n  ${0}\n</svg>',
      kind: 'snippet',
      aliases: ['svg', 'canvas', 'root', 'viewbox'],
    },
    {
      label: '<rect>',
      detail: 'Rectangle shape',
      description: 'Draws a rectangle; add rx and ry for rounded corners.',
      insertText: '<rect x="${1:0}" y="${2:0}" width="${3:160}" height="${4:96}" rx="${5:12}" fill="${6:#9ff4ed}" />${0}',
      kind: 'snippet',
      aliases: ['rect', 'rectangle', 'shape'],
    },
    {
      label: '<path>',
      detail: 'SVG path',
      description: 'Draws arbitrary geometry with move, line, curve, and close path commands.',
      insertText: '<path d="M${1:40} ${2:40} H${3:260} V${4:180} H${1} Z" fill="${5:none}" stroke="${6:currentColor}" />${0}',
      kind: 'snippet',
      aliases: ['path', 'curve', 'line', 'd'],
    },
    {
      label: '<g>',
      detail: 'SVG group',
      description: 'Groups vector elements so transforms and common presentation attributes can be applied together.',
      insertText: '<g transform="translate(${1:40} ${2:40})">\n  ${0}\n</g>',
      kind: 'snippet',
      aliases: ['g', 'group', 'transform'],
    },
    {
      label: '<defs>',
      detail: 'Reusable SVG definitions',
      description: 'Stores gradients, markers, filters, and other reusable definitions outside the visible drawing order.',
      insertText: '<defs>\n  ${0}\n</defs>',
      kind: 'snippet',
      aliases: ['defs', 'gradient', 'marker', 'filter'],
    },
    {
      label: '<text>',
      detail: 'SVG text label',
      description: 'Adds a text label at a coordinate. Use text-anchor="middle" for centered labels.',
      insertText: '<text x="${1:0}" y="${2:0}" text-anchor="${3:middle}" font-size="${4:18}">${5:Label}</text>${0}',
      kind: 'snippet',
      aliases: ['text', 'label', 'font'],
    },
  ],
  mermaid: [
    {
      label: 'flowchart',
      detail: 'Flowchart diagram',
      description: 'Creates a directed graph. Common directions are LR, RL, TB, and BT.',
      insertText: 'flowchart ${1:LR}\n  ${2:A}[${3:Start}] --> ${4:B}[${5:Finish}]${0}',
      kind: 'snippet',
      aliases: ['flowchart', 'graph', 'flow', 'lr', 'tb'],
    },
    {
      label: 'sequenceDiagram',
      detail: 'Sequence diagram',
      description: 'Shows ordered messages between participants.',
      insertText: 'sequenceDiagram\n  participant ${1:Client}\n  participant ${2:API}\n  ${1}->>${2}: ${3:Request}\n  ${2}-->>${1}: ${4:Response}${0}',
      kind: 'snippet',
      aliases: ['sequencediagram', 'sequence', 'participant', 'message'],
    },
    {
      label: 'subgraph',
      detail: 'Flowchart group',
      description: 'Visually groups related flowchart nodes.',
      insertText: 'subgraph ${1:Group title}\n  ${0}\nend',
      kind: 'snippet',
      aliases: ['subgraph', 'group', 'cluster', 'end'],
    },
    {
      label: 'classDef',
      detail: 'Reusable node style',
      description: 'Defines and applies a reusable flowchart node class.',
      insertText: 'classDef ${1:accent} fill:${2:#9ff4ed},stroke:${3:#119e9b},color:${4:#08201f},stroke-width:${5:2px}\nclass ${6:nodeId} ${1}${0}',
      kind: 'snippet',
      aliases: ['classdef', 'class', 'style', 'theme'],
    },
    {
      label: 'erDiagram',
      detail: 'Entity relationship diagram',
      description: 'Models entities, attributes, and relationships for a data domain.',
      insertText: 'erDiagram\n  ${1:CUSTOMER} ||--o{ ${2:ORDER} : ${3:places}\n  ${1} {\n    int id PK\n    string name\n  }${0}',
      kind: 'snippet',
      aliases: ['erdiagram', 'er', 'entity', 'relationship', 'database'],
    },
    {
      label: 'stateDiagram-v2',
      detail: 'State diagram',
      description: 'Models states and transitions, including a start/end pseudo-state.',
      insertText: 'stateDiagram-v2\n  [*] --> ${1:Idle}\n  ${1} --> ${2:Working}: ${3:start}\n  ${2} --> [*]${0}',
      kind: 'snippet',
      aliases: ['statediagram', 'state', 'transition'],
    },
  ],
  markdown: [
    {
      label: 'Heading',
      detail: 'Markdown heading',
      description: 'Adds a navigable section heading. Keep hierarchy sequential for a useful outline.',
      insertText: '## ${1:Section title}\n\n${0}',
      kind: 'snippet',
      aliases: ['heading', 'header', 'section', '#'],
    },
    {
      label: 'Mermaid fence',
      detail: 'Embedded Mermaid diagram',
      description: 'Embeds a Mermaid source block that the Markdown preview can render as a diagram.',
      insertText: '```mermaid\nflowchart ${1:LR}\n  ${2:A}[${3:Start}] --> ${4:B}[${5:Finish}]\n```\n${0}',
      kind: 'snippet',
      aliases: ['mermaid', 'diagram', 'fence', 'code'],
    },
    {
      label: 'Link',
      detail: 'Markdown link',
      description: 'Creates an inline link with readable link text.',
      insertText: '[${1:Link label}](${2:https://example.com})${0}',
      kind: 'snippet',
      aliases: ['link', 'url', 'reference'],
    },
    {
      label: 'Image',
      detail: 'Markdown image',
      description: 'Embeds an image and includes alternative text for readers using assistive technology.',
      insertText: '![${1:Description}](${2:image-url})${0}',
      kind: 'snippet',
      aliases: ['image', 'img', 'alt'],
    },
    {
      label: 'Table',
      detail: 'Markdown table',
      description: 'Creates a compact comparison table.',
      insertText: '| ${1:Column A} | ${2:Column B} |\n| --- | --- |\n| ${3:Value} | ${4:Value} |${0}',
      kind: 'snippet',
      aliases: ['table', 'columns', 'comparison'],
    },
    {
      label: 'Task list',
      detail: 'Markdown checklist',
      description: 'Creates an actionable checklist item.',
      insertText: '- [ ] ${1:Task}${0}',
      kind: 'snippet',
      aliases: ['task', 'todo', 'checklist'],
    },
  ],
  text: [
    {
      label: 'TODO',
      detail: 'Plain-text task marker',
      description: 'Marks a concrete next action. TODO, NOTE, and FIXME remain readable in any editor and are lightly highlighted here.',
      insertText: 'TODO: ${1:Describe the next action}${0}',
      kind: 'snippet',
      aliases: ['todo', 'task', 'next', 'fixme'],
    },
    {
      label: 'Section heading',
      detail: 'Plain-text underline heading',
      description: 'Uses an underline to separate a readable text section without adding a markup dependency.',
      insertText: '${1:Section title}\n${2:-------------}\n\n${0}',
      kind: 'snippet',
      aliases: ['heading', 'section', 'title', 'underline'],
    },
    {
      label: 'Key: value',
      detail: 'Plain-text metadata',
      description: 'Keeps a small decision, owner, or status in a grep-friendly key/value form.',
      insertText: '${1:Key}: ${2:value}${0}',
      kind: 'snippet',
      aliases: ['key', 'value', 'metadata', 'status'],
    },
  ],
};

const installations = new WeakMap<object, FoundryEditorIntelligence>();

/** Returns a source type only for Diagram Foundry's Monaco language IDs. */
export function sourceTypeForFoundryLanguage(languageId: string): SourceType | undefined {
  return Object.hasOwn(LANGUAGE_TO_SOURCE_TYPE, languageId)
    ? LANGUAGE_TO_SOURCE_TYPE[languageId as FoundryLanguageId]
    : undefined;
}

/** Maps a source type to its Monaco language ID. */
export function foundryLanguageForSourceType(sourceType: SourceType): FoundryLanguageId {
  return FOUNDRY_LANGUAGE_IDS[sourceType];
}

/** Exposes the same stable formatter used by toolbar and Monaco Format Document. */
export function formatFoundrySource(sourceType: SourceType, source: string): string {
  return formatSource(sourceType, source);
}

/**
 * Performs fast, local validation without requiring a renderer or external
 * compiler. Diagnostics intentionally favor clear structural mistakes over
 * exhaustive language parsing.
 */
export function lintSource(sourceType: SourceType, source: string): EditorDiagnostic[] {
  const diagnostics = sourceType === 'tikz'
    ? lintTikz(source)
    : sourceType === 'latex'
      ? lintLatex(source)
    : sourceType === 'svg'
      ? lintSvg(source)
      : sourceType === 'mermaid'
        ? lintMermaid(source)
        : sourceType === 'markdown'
          ? lintMarkdown(source)
          : [];

  return dedupeDiagnostics(diagnostics);
}

/**
 * Converts source-local diagnostics into Monaco markers for one supported
 * model. It is exported so callers can validate immediately after applying a
 * programmatic edit or renderer error.
 */
export function applyFoundryDiagnostics(monaco: Monaco, model: MonacoEditor.editor.ITextModel): EditorDiagnostic[] {
  const sourceType = sourceTypeForFoundryLanguage(model.getLanguageId());
  if (!sourceType) {
    monaco.editor.setModelMarkers(model, FOUNDRY_MARKER_OWNER, []);
    return [];
  }

  const diagnostics = lintSource(sourceType, model.getValue());
  monaco.editor.setModelMarkers(model, FOUNDRY_MARKER_OWNER, diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    source: 'Diagram Foundry',
    message: diagnostic.message,
    severity: markerSeverity(monaco, diagnostic.severity),
    startLineNumber: diagnostic.startLineNumber,
    startColumn: diagnostic.startColumn,
    endLineNumber: diagnostic.endLineNumber,
    endColumn: diagnostic.endColumn,
  })));
  return diagnostics;
}

/**
 * Registers snippets, completions, hovers, document formatting, folding,
 * symbols, and live source markers. It is idempotent for a Monaco instance.
 */
export function installFoundryEditorIntelligence(monaco: Monaco): FoundryEditorIntelligence {
  const key = monaco as unknown as object;
  const existing = installations.get(key);
  if (existing) return existing;

  let disposed = false;
  const providerDisposables: MonacoEditor.IDisposable[] = [];
  const modelDisposables = new Map<MonacoEditor.editor.ITextModel, MonacoEditor.IDisposable>();
  const validationTimers = new Map<MonacoEditor.editor.ITextModel, ReturnType<typeof globalThis.setTimeout>>();

  const clearScheduledValidation = (model: MonacoEditor.editor.ITextModel) => {
    const timer = validationTimers.get(model);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    validationTimers.delete(model);
  };

  const validateModel = (model: MonacoEditor.editor.ITextModel) => {
    clearScheduledValidation(model);
    return applyFoundryDiagnostics(monaco, model);
  };

  const untrackModel = (model: MonacoEditor.editor.ITextModel) => {
    clearScheduledValidation(model);
    modelDisposables.get(model)?.dispose();
    modelDisposables.delete(model);
    monaco.editor.setModelMarkers(model, FOUNDRY_MARKER_OWNER, []);
  };

  const scheduleValidation = (model: MonacoEditor.editor.ITextModel) => {
    clearScheduledValidation(model);
    const timer = globalThis.setTimeout(() => {
      validationTimers.delete(model);
      if (!disposed && modelDisposables.has(model)) validateModel(model);
    }, 180);
    validationTimers.set(model, timer);
  };

  const trackModel = (model: MonacoEditor.editor.ITextModel) => {
    if (modelDisposables.has(model)) return;
    if (!sourceTypeForFoundryLanguage(model.getLanguageId())) return;
    validateModel(model);
    modelDisposables.set(model, model.onDidChangeContent(() => scheduleValidation(model)));
  };

  for (const sourceType of Object.keys(FOUNDRY_LANGUAGE_IDS) as SourceType[]) {
    const languageId = foundryLanguageForSourceType(sourceType);
    // Plain text is intentionally free of code completion. It still receives
    // Foundry's lightweight highlighting, outline, and preview support, but
    // typing prose must never open a code-oriented suggestion widget.
    if (sourceType !== 'text') {
      providerDisposables.push(
        monaco.languages.registerCompletionItemProvider(languageId, {
          triggerCharacters: completionTriggerCharacters(sourceType),
          provideCompletionItems(model, position) {
            const range = completionRange(monaco, model, position, sourceType);
            return {
              suggestions: completionItems(monaco, sourceType, range),
            };
          },
        }),
      );
    }

    providerDisposables.push(
      monaco.languages.registerHoverProvider(languageId, {
        provideHover(model, position) {
          const token = tokenAtPosition(model, position, sourceType);
          const item = findHoverItem(sourceType, token?.value ?? '', model.getLineContent(position.lineNumber));
          if (!item) return null;
          return {
            range: token ? new monaco.Range(position.lineNumber, token.startColumn, position.lineNumber, token.endColumn) : undefined,
            contents: [{ value: hoverMarkdown(sourceType, item) }],
          };
        },
      }),
      monaco.languages.registerDocumentFormattingEditProvider(languageId, {
        displayName: 'Diagram Foundry formatter',
        provideDocumentFormattingEdits(model) {
          const source = model.getValue();
          const formatted = formatFoundrySource(sourceType, source);
          return formatted === source ? [] : [{ range: model.getFullModelRange(), text: formatted }];
        },
      }),
      monaco.languages.registerDocumentRangeFormattingEditProvider(languageId, {
        displayName: 'Diagram Foundry formatter',
        provideDocumentRangeFormattingEdits(model) {
          // These languages are structurally sensitive, so formatting the full
          // model is safer than trying to re-indent a pasted fragment in
          // isolation. Monaco still invokes this through Format Selection and
          // format-on-paste when those options are enabled.
          const source = model.getValue();
          const formatted = formatFoundrySource(sourceType, source);
          return formatted === source ? [] : [{ range: model.getFullModelRange(), text: formatted }];
        },
      }),
      monaco.languages.registerFoldingRangeProvider(languageId, {
        provideFoldingRanges(model) {
          return buildFoldingRanges(sourceType, model.getLinesContent());
        },
      }),
      monaco.languages.registerDocumentSymbolProvider(languageId, {
        displayName: 'Diagram Foundry outline',
        provideDocumentSymbols(model) {
          return buildDocumentSymbols(monaco, sourceType, model.getLinesContent());
        },
      }),
    );
  }

  providerDisposables.push(
    monaco.editor.onDidCreateModel(trackModel),
    monaco.editor.onWillDisposeModel(untrackModel),
    monaco.editor.onDidChangeModelLanguage(({ model }) => {
      untrackModel(model);
      trackModel(model);
    }),
  );
  monaco.editor.getModels().forEach(trackModel);

  const installation: FoundryEditorIntelligence = {
    validateModel,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const model of Array.from(modelDisposables.keys())) untrackModel(model);
      providerDisposables.forEach((disposable) => disposable.dispose());
      installations.delete(key);
    },
  };
  installations.set(key, installation);
  return installation;
}

function completionTriggerCharacters(sourceType: SourceType): string[] {
  if (sourceType === 'tikz') return ['\\', '[', ','];
  if (sourceType === 'latex') return ['\\', '[', '{'];
  if (sourceType === 'svg') return ['<', ' ', '='];
  if (sourceType === 'mermaid') return [' ', '-'];
  if (sourceType === 'text') return [];
  return ['#', '`', '[', '!'];
}

function completionItems(monaco: Monaco, sourceType: SourceType, range: MonacoEditor.IRange): MonacoEditor.languages.CompletionItem[] {
  return catalogFor(sourceType).map((item, index) => ({
    label: item.label,
    detail: item.detail,
    documentation: { value: hoverMarkdown(sourceType, item) },
    kind: item.kind === 'snippet'
      ? monaco.languages.CompletionItemKind.Snippet
      : item.kind === 'reference'
        ? monaco.languages.CompletionItemKind.Reference
        : monaco.languages.CompletionItemKind.Keyword,
    insertText: item.insertText,
    insertTextRules: item.kind === 'snippet' ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range,
    sortText: `${item.kind === 'snippet' ? '0' : item.kind === 'reference' ? '2' : '1'}${String(index).padStart(3, '0')}`,
    filterText: [item.label, ...item.aliases].join(' '),
  }));
}

function completionRange(
  monaco: Monaco,
  model: MonacoEditor.editor.ITextModel,
  position: MonacoEditor.Position,
  sourceType: SourceType,
): MonacoEditor.IRange {
  const line = model.getLineContent(position.lineNumber);
  let startOffset = Math.min(line.length, Math.max(0, position.column - 1));
  while (startOffset > 0 && /[\w@.:-]/.test(line[startOffset - 1])) startOffset -= 1;
  if ((sourceType === 'tikz' || sourceType === 'latex') && startOffset > 0 && line[startOffset - 1] === '\\') startOffset -= 1;
  return new monaco.Range(position.lineNumber, startOffset + 1, position.lineNumber, position.column);
}

function tokenAtPosition(
  model: MonacoEditor.editor.ITextModel,
  position: MonacoEditor.Position,
  sourceType: SourceType,
): { value: string; startColumn: number; endColumn: number } | undefined {
  const line = model.getLineContent(position.lineNumber);
  if (!line) return undefined;
  const cursorOffset = Math.min(line.length, Math.max(0, position.column - 1));
  let start = cursorOffset;
  let end = cursorOffset;

  if (start === line.length || !/[\w@.:-]/.test(line[start])) start -= 1;
  if (start < 0 || !/[\w@.:-]/.test(line[start])) return undefined;
  while (start > 0 && /[\w@.:-]/.test(line[start - 1])) start -= 1;
  while (end < line.length && /[\w@.:-]/.test(line[end])) end += 1;
  if ((sourceType === 'tikz' || sourceType === 'latex') && start > 0 && line[start - 1] === '\\') start -= 1;

  return { value: line.slice(start, end), startColumn: start + 1, endColumn: end + 1 };
}

function catalogFor(sourceType: SourceType): CatalogItem[] {
  return [...coreCatalog[sourceType], ...references[sourceType].map(referenceCatalogItem)];
}

function referenceCatalogItem(entry: ReferenceEntry): CatalogItem {
  const syntaxTerms = entry.syntax.match(/\\?[A-Za-z][\w.-]*/g) ?? [];
  return {
    label: entry.title,
    detail: `${entry.category} reference`,
    description: entry.description,
    insertText: entry.insertText,
    kind: 'reference',
    aliases: [entry.id, entry.title, entry.category, ...entry.tags, ...syntaxTerms].map(normalizeToken),
    example: entry.example,
  };
}

function findHoverItem(sourceType: SourceType, value: string, line: string): CatalogItem | undefined {
  const token = normalizeToken(value);
  const fromReference = catalogFor(sourceType).filter((item) => item.kind === 'reference').find((item) => item.aliases.includes(token));
  if (fromReference) return fromReference;

  const direct = coreCatalog[sourceType].find((item) => item.aliases.includes(token) || normalizeToken(item.label) === token);
  if (direct) return direct;

  const normalizedLine = line.trim().toLowerCase();
  if (sourceType === 'markdown' && /^#{1,6}\s+/.test(normalizedLine)) {
    return coreCatalog.markdown.find((item) => item.label === 'Heading');
  }
  if (sourceType === 'markdown' && /^```mermaid\b/.test(normalizedLine)) {
    return coreCatalog.markdown.find((item) => item.label === 'Mermaid fence');
  }
  if (sourceType === 'svg' && /<svg\b/i.test(line)) {
    return coreCatalog.svg.find((item) => item.label === '<svg>');
  }
  return undefined;
}

function hoverMarkdown(sourceType: SourceType, item: CatalogItem): string {
  const language = sourceType === 'tikz' || sourceType === 'latex' ? 'tex' : sourceType === 'mermaid' ? 'mermaid' : sourceType;
  const sample = item.example || item.insertText.replace(/\$\{\d+(?::[^}]*)?\}/g, '…').replace(/\$0/g, '');
  return [
    `**${item.label}** — ${item.detail}`,
    item.description,
    sample ? `\`\`\`${language}\n${sample}\n\`\`\`` : '',
  ].filter(Boolean).join('\n\n');
}

function normalizeToken(value: string): string {
  return value.trim().replace(/^\\/, '').replace(/^</, '').replace(/[>{}()[\],]/g, '').toLowerCase();
}

function lintTikz(source: string): EditorDiagnostic[] {
  const diagnostics = lintBalancedDelimiters(source, stripTikzComments(source), 'tikz', [['{', '}'], ['[', ']']]);
  const clean = stripTikzComments(source);
  const environments: Array<{ name: string; offset: number }> = [];
  const environmentPattern = /\\(begin|end)\s*\{([^}]+)\}/g;
  let environmentMatch: RegExpExecArray | null;

  while ((environmentMatch = environmentPattern.exec(clean))) {
    const command = environmentMatch[1];
    const name = environmentMatch[2].trim();
    const nameOffset = environmentMatch.index + environmentMatch[0].lastIndexOf(environmentMatch[2]);
    if (command === 'begin') {
      environments.push({ name, offset: nameOffset });
      continue;
    }

    const top = environments.at(-1);
    if (!top) {
      diagnostics.push(diagnosticAt(source, nameOffset, name.length, 'error', 'tikz-unexpected-end', `Unexpected \\end{${name}}; no environment is open.`));
      continue;
    }
    if (top.name === name) {
      environments.pop();
      continue;
    }

    diagnostics.push(diagnosticAt(
      source,
      nameOffset,
      name.length,
      'error',
      'tikz-mismatched-environment',
      `Expected \\end{${top.name}} before \\end{${name}}.`,
    ));
    const matchingIndex = environments.map((environment) => environment.name).lastIndexOf(name);
    if (matchingIndex >= 0) environments.splice(matchingIndex);
  }

  for (const environment of environments) {
    diagnostics.push(diagnosticAt(
      source,
      environment.offset,
      environment.name.length,
      'error',
      'tikz-unclosed-environment',
      `Missing \\end{${environment.name}} for this \\begin{${environment.name}}.`,
    ));
  }

  for (const line of linesWithOffsets(source)) {
    const uncommented = stripTikzComments(line.text).trim();
    if (!/\\(?:node|coordinate|draw|path|fill|filldraw|shade|clip)\b/.test(uncommented)) continue;
    if (/;\s*$/.test(uncommented)) continue;
    if (!/(?:\}|\))\s*$/.test(uncommented)) continue;
    const lastCharacter = line.offset + line.text.lastIndexOf(uncommented.at(-1) ?? '');
    diagnostics.push(diagnosticAt(
      source,
      lastCharacter,
      1,
      'warning',
      'tikz-missing-semicolon',
      'TikZ drawing commands usually end with a semicolon.',
    ));
  }

  return diagnostics;
}

/** Generic LaTeX diagnostics intentionally avoid TikZ-specific semicolon rules. */
function lintLatex(source: string): EditorDiagnostic[] {
  const diagnostics = lintBalancedDelimiters(source, stripTikzComments(source), 'latex', [['{', '}'], ['[', ']']]);
  const clean = stripTikzComments(source);
  const environments: Array<{ name: string; offset: number }> = [];
  const environmentPattern = /\\(begin|end)\s*\{([^}]+)\}/g;
  let environmentMatch: RegExpExecArray | null;

  while ((environmentMatch = environmentPattern.exec(clean))) {
    const command = environmentMatch[1];
    const name = environmentMatch[2].trim();
    const nameOffset = environmentMatch.index + environmentMatch[0].lastIndexOf(environmentMatch[2]);
    if (command === 'begin') {
      environments.push({ name, offset: nameOffset });
      continue;
    }

    const top = environments.at(-1);
    if (!top) {
      diagnostics.push(diagnosticAt(source, nameOffset, name.length, 'error', 'latex-unexpected-end', `Unexpected \\end{${name}}; no environment is open.`));
      continue;
    }
    if (top.name === name) {
      environments.pop();
      continue;
    }

    diagnostics.push(diagnosticAt(
      source,
      nameOffset,
      name.length,
      'error',
      'latex-mismatched-environment',
      `Expected \\end{${top.name}} before \\end{${name}}.`,
    ));
    const matchingIndex = environments.map((environment) => environment.name).lastIndexOf(name);
    if (matchingIndex >= 0) environments.splice(matchingIndex);
  }

  for (const environment of environments) {
    diagnostics.push(diagnosticAt(
      source,
      environment.offset,
      environment.name.length,
      'error',
      'latex-unclosed-environment',
      `Missing \\end{${environment.name}} for this \\begin{${environment.name}}.`,
    ));
  }

  return diagnostics;
}

function lintSvg(source: string): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  const scanned = maskSvgComments(source);
  const root = /<svg\b([^>]*)>/i.exec(scanned);
  if (!root || root.index === undefined) {
    diagnostics.push(diagnosticAt(source, 0, 1, 'error', 'svg-missing-root', 'SVG source needs an opening <svg> root element.'));
  } else {
    const attributes = root[1];
    const viewBox = /\bviewBox\s*=\s*(["'])(.*?)\1/i.exec(attributes);
    if (!viewBox) {
      diagnostics.push(diagnosticAt(source, root.index, root[0].length, 'warning', 'svg-missing-viewbox', 'Add a viewBox so this SVG scales responsively.'));
    } else {
      const values = viewBox[2].trim().split(/[\s,]+/).map(Number);
      if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[2] <= 0 || values[3] <= 0) {
        const viewBoxOffset = root.index + root[0].indexOf(viewBox[0]);
        diagnostics.push(diagnosticAt(source, viewBoxOffset, viewBox[0].length, 'error', 'svg-invalid-viewbox', 'viewBox needs four numbers with a positive width and height.'));
      }
    }
  }

  const scriptOffset = scanned.search(/<script\b/i);
  if (scriptOffset >= 0) {
    diagnostics.push(diagnosticAt(source, scriptOffset, 7, 'error', 'svg-script', 'Scripts are not supported in preview or exported SVG.'));
  }
  const eventAttribute = /\son[a-z]+\s*=/i.exec(scanned);
  if (eventAttribute?.index !== undefined) {
    diagnostics.push(diagnosticAt(source, eventAttribute.index, eventAttribute[0].length, 'warning', 'svg-event-attribute', 'Inline event attributes are removed from the safe preview.'));
  }

  const ids = new Map<string, number>();
  const idPattern = /\bid\s*=\s*(["'])([^"']+)\1/g;
  let idMatch: RegExpExecArray | null;
  while ((idMatch = idPattern.exec(scanned))) {
    const id = idMatch[2];
    const idOffset = idMatch.index + idMatch[0].indexOf(id);
    if (ids.has(id)) {
      diagnostics.push(diagnosticAt(source, idOffset, id.length, 'warning', 'svg-duplicate-id', `The id "${id}" is already defined elsewhere in this SVG.`));
    } else {
      ids.set(id, idOffset);
    }
  }

  const urlPattern = /url\(\s*#([A-Za-z_][\w:.-]*)\s*\)/g;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlPattern.exec(scanned))) {
    const referencedId = urlMatch[1];
    if (!ids.has(referencedId)) {
      const idOffset = urlMatch.index + urlMatch[0].indexOf(referencedId);
      diagnostics.push(diagnosticAt(source, idOffset, referencedId.length, 'warning', 'svg-unknown-url-id', `No element with id "${referencedId}" was found for this url(#...) reference.`));
    }
  }

  const tags: Array<{ name: string; offset: number }> = [];
  const tagPattern = /<\/?([A-Za-z_][\w:.-]*)\b[^>]*>/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagPattern.exec(scanned))) {
    const raw = tagMatch[0];
    const name = tagMatch[1];
    const nameOffset = tagMatch.index + raw.indexOf(name);
    const closing = /^<\//.test(raw);
    const selfClosing = /\/\s*>$/.test(raw);

    const unquotedAttribute = /\s([A-Za-z_:][\w:.-]*)\s*=\s*([^\s"'=<>`][^\s<>`]*)/.exec(raw);
    if (unquotedAttribute) {
      const attributeOffset = tagMatch.index + unquotedAttribute.index + unquotedAttribute[0].indexOf(unquotedAttribute[1]);
      diagnostics.push(diagnosticAt(source, attributeOffset, unquotedAttribute[1].length, 'warning', 'svg-unquoted-attribute', 'Quote SVG attribute values to keep the markup valid XML.'));
    }

    if (closing) {
      const top = tags.at(-1);
      if (!top) {
        diagnostics.push(diagnosticAt(source, nameOffset, name.length, 'error', 'svg-unexpected-close-tag', `Unexpected closing tag </${name}>.`));
      } else if (top.name === name) {
        tags.pop();
      } else {
        diagnostics.push(diagnosticAt(source, nameOffset, name.length, 'error', 'svg-mismatched-close-tag', `Expected </${top.name}> before </${name}>.`));
        const matchingIndex = tags.map((tag) => tag.name).lastIndexOf(name);
        if (matchingIndex >= 0) tags.splice(matchingIndex);
      }
    } else if (!selfClosing) {
      tags.push({ name, offset: nameOffset });
    }
  }

  for (const tag of tags) {
    diagnostics.push(diagnosticAt(source, tag.offset, tag.name.length, 'error', 'svg-unclosed-tag', `Missing closing tag for <${tag.name}>.`));
  }
  return diagnostics;
}

function lintMermaid(source: string): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  const lines = linesWithOffsets(source);
  const firstMeaningful = lines.find((line) => {
    const text = line.text.trim();
    return Boolean(text) && !text.startsWith('%%');
  });
  const headerPattern = /^(flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|journey|pie|timeline|mindmap|gitGraph|quadrantChart|xychart-beta|architecture-beta|block-beta|sankey-beta)\b/;
  const header = firstMeaningful ? headerPattern.exec(firstMeaningful.text.trim()) : null;
  if (!firstMeaningful || !header) {
    diagnostics.push(diagnosticAt(source, firstMeaningful?.offset ?? 0, Math.max(1, firstMeaningful?.text.length ?? 1), 'error', 'mermaid-missing-diagram', 'Start Mermaid source with a supported diagram declaration such as flowchart LR.'));
    return diagnostics;
  }

  const diagramKind = header[1].toLowerCase();
  if ((diagramKind === 'flowchart' || diagramKind === 'graph') && /^\s*(?:flowchart|graph)\s*$/i.test(firstMeaningful.text)) {
    diagnostics.push(diagnosticAt(source, firstMeaningful.offset, firstMeaningful.text.length, 'warning', 'mermaid-missing-direction', 'Add a direction such as LR, RL, TB, or BT after the flowchart declaration.'));
  }

  const scopes: ScopedLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text || text.startsWith('%%') || line === firstMeaningful) continue;
    const scopeStart = /^(subgraph|alt|opt|loop|par|critical|rect|box)\b/i.exec(text);
    if (scopeStart) {
      scopes.push({ name: scopeStart[1], lineNumber: line.lineNumber });
      continue;
    }
    if (/^end\b/i.test(text)) {
      const scope = scopes.pop();
      if (!scope) diagnostics.push(diagnosticAt(source, line.offset, 3, 'error', 'mermaid-unexpected-end', 'Unexpected end; no Mermaid scope is open.'));
    }
    if ((diagramKind === 'flowchart' || diagramKind === 'graph') && /\b[\w.-]+\s*->\s*[\w.-]+\b/.test(text)) {
      const arrowOffset = line.offset + text.indexOf('->');
      diagnostics.push(diagnosticAt(source, arrowOffset, 2, 'warning', 'mermaid-flow-arrow', 'Flowchart links usually use --> rather than ->.'));
    }
  }
  for (const scope of scopes) {
    const line = lines[scope.lineNumber - 1];
    diagnostics.push(diagnosticAt(source, line.offset, line.text.length, 'error', 'mermaid-unclosed-scope', `Missing end for this ${scope.name} block.`));
  }
  return diagnostics;
}

function lintMarkdown(source: string): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  const lines = linesWithOffsets(source);
  let fence: { marker: '`' | '~'; length: number; line: LineWithOffset } | undefined;
  let previousHeadingLevel = 0;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line.text);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length, line };
      } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.text);
    if (heading) {
      const level = heading[1].length;
      if (previousHeadingLevel && level > previousHeadingLevel + 1) {
        diagnostics.push(diagnosticAt(source, line.offset, level, 'warning', 'markdown-skipped-heading', `Heading level jumps from H${previousHeadingLevel} to H${level}; use sequential levels for a clearer outline.`));
      }
      previousHeadingLevel = level;
    }

    const imagePattern = /!\[([^\]]*)\]\(([^)]*)\)/g;
    let image: RegExpExecArray | null;
    while ((image = imagePattern.exec(line.text))) {
      if (!image[1].trim()) {
        diagnostics.push(diagnosticAt(source, line.offset + image.index + 2, 1, 'warning', 'markdown-image-alt', 'Add concise alternative text to describe this image.'));
      }
      if (!image[2].trim()) {
        diagnostics.push(diagnosticAt(source, line.offset + image.index + image[0].lastIndexOf('(') + 1, 1, 'warning', 'markdown-empty-image-url', 'This image has an empty URL.'));
      }
    }

    const linkPattern = /\[([^\]]*)\]\(([^)]*)\)/g;
    let link: RegExpExecArray | null;
    while ((link = linkPattern.exec(line.text))) {
      if (link.index > 0 && line.text[link.index - 1] === '!') continue;
      if (!link[2].trim()) {
        diagnostics.push(diagnosticAt(source, line.offset + link.index + link[0].lastIndexOf('(') + 1, 1, 'warning', 'markdown-empty-link-url', 'This link has an empty URL.'));
      }
    }
  }

  if (fence) {
    diagnostics.push(diagnosticAt(source, fence.line.offset, fence.length, 'error', 'markdown-unclosed-fence', 'This fenced code block is missing its closing fence.'));
  }
  return diagnostics;
}

function lintBalancedDelimiters(
  source: string,
  scanned: string,
  prefix: string,
  pairs: Array<[string, string]>,
): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  const opening = new Map(pairs);
  const closing = new Map(pairs.map(([start, end]) => [end, start]));
  const stack: Array<{ delimiter: string; offset: number }> = [];

  for (let offset = 0; offset < scanned.length; offset += 1) {
    const character = scanned[offset];
    if (isEscaped(scanned, offset)) continue;
    if (opening.has(character)) {
      stack.push({ delimiter: character, offset });
      continue;
    }
    const expectedOpening = closing.get(character);
    if (!expectedOpening) continue;
    const top = stack.at(-1);
    if (!top) {
      diagnostics.push(diagnosticAt(source, offset, 1, 'error', `${prefix}-unexpected-delimiter`, `Unexpected closing ${character}.`));
    } else if (top.delimiter === expectedOpening) {
      stack.pop();
    } else {
      diagnostics.push(diagnosticAt(source, offset, 1, 'error', `${prefix}-mismatched-delimiter`, `Expected ${opening.get(top.delimiter)} before ${character}.`));
    }
  }

  for (const item of stack) {
    diagnostics.push(diagnosticAt(source, item.offset, 1, 'error', `${prefix}-unclosed-delimiter`, `Missing closing ${opening.get(item.delimiter)} for this ${item.delimiter}.`));
  }
  return diagnostics;
}

function stripTikzComments(source: string): string {
  let stripped = '';
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n') {
      stripped += character;
      inComment = false;
    } else if (!inComment && character === '%' && !isEscaped(source, index)) {
      stripped += ' ';
      inComment = true;
    } else {
      stripped += inComment ? ' ' : character;
    }
  }
  return stripped;
}

function maskSvgComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (cdata) => cdata.replace(/[^\n]/g, ' '))
    .replace(/<\?[\s\S]*?\?>/g, (instruction) => instruction.replace(/[^\n]/g, ' '));
}

function isEscaped(source: string, offset: number): boolean {
  let slashCount = 0;
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function markerSeverity(monaco: Monaco, severity: EditorDiagnosticSeverity): MonacoEditor.MarkerSeverity {
  if (severity === 'error') return monaco.MarkerSeverity.Error;
  if (severity === 'warning') return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

function diagnosticAt(
  source: string,
  offset: number,
  length: number,
  severity: EditorDiagnosticSeverity,
  code: string,
  message: string,
): EditorDiagnostic {
  const startOffset = Math.max(0, Math.min(offset, source.length));
  const endOffset = source.length === 0
    ? 0
    : Math.max(startOffset + 1, Math.min(source.length, startOffset + Math.max(1, length)));
  const start = positionAt(source, startOffset);
  const end = positionAt(source, endOffset);
  return {
    code,
    message,
    severity,
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

function positionAt(source: string, offset: number): { lineNumber: number; column: number } {
  let lineNumber = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      lineNumber += 1;
      lineStart = index + 1;
    }
  }
  return { lineNumber, column: offset - lineStart + 1 };
}

function linesWithOffsets(source: string): LineWithOffset[] {
  const lines = source.split('\n');
  let offset = 0;
  return lines.map((text, index) => {
    const result = { text, lineNumber: index + 1, offset };
    offset += text.length + 1;
    return result;
  });
}

function dedupeDiagnostics(diagnostics: EditorDiagnostic[]): EditorDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = [diagnostic.code, diagnostic.startLineNumber, diagnostic.startColumn, diagnostic.message].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildFoldingRanges(sourceType: SourceType, lines: string[]): MonacoEditor.languages.FoldingRange[] {
  const ranges = sourceType === 'tikz'
    ? foldTikz(lines)
    : sourceType === 'latex'
      ? foldTikz(lines)
    : sourceType === 'svg'
      ? foldSvg(lines)
      : sourceType === 'mermaid'
        ? foldMermaid(lines)
        : sourceType === 'markdown'
          ? foldMarkdown(lines)
          : [];
  return ranges.filter((range) => range.end > range.start);
}

function foldTikz(lines: string[]): MonacoEditor.languages.FoldingRange[] {
  const ranges: MonacoEditor.languages.FoldingRange[] = [];
  const scopes: ScopedLine[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const pattern = /\\(begin|end)\s*\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripTikzComments(line)))) {
      if (match[1] === 'begin') scopes.push({ name: match[2], lineNumber });
      else {
        const matchingIndex = scopes.map((scope) => scope.name).lastIndexOf(match[2]);
        if (matchingIndex >= 0) {
          const scope = scopes[matchingIndex];
          ranges.push({ start: scope.lineNumber, end: lineNumber });
          scopes.splice(matchingIndex);
        }
      }
    }
  });
  return ranges;
}

function foldSvg(lines: string[]): MonacoEditor.languages.FoldingRange[] {
  const ranges: MonacoEditor.languages.FoldingRange[] = [];
  const scopes: ScopedLine[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const pattern = /<\/?([A-Za-z_][\w:.-]*)\b[^>]*>/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      const raw = match[0];
      const name = match[1];
      if (/^<\//.test(raw)) {
        const matchingIndex = scopes.map((scope) => scope.name).lastIndexOf(name);
        if (matchingIndex >= 0) {
          const scope = scopes[matchingIndex];
          ranges.push({ start: scope.lineNumber, end: lineNumber });
          scopes.splice(matchingIndex);
        }
      } else if (!/\/\s*>$/.test(raw)) {
        scopes.push({ name, lineNumber });
      }
    }
  });
  return ranges;
}

function foldMermaid(lines: string[]): MonacoEditor.languages.FoldingRange[] {
  const ranges: MonacoEditor.languages.FoldingRange[] = [];
  const scopes: ScopedLine[] = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const text = line.trim();
    const start = /^(subgraph|alt|opt|loop|par|critical|rect|box)\b/i.exec(text);
    if (start) scopes.push({ name: start[1], lineNumber });
    else if (/^end\b/i.test(text)) {
      const scope = scopes.pop();
      if (scope) ranges.push({ start: scope.lineNumber, end: lineNumber });
    }
  });
  return ranges;
}

function foldMarkdown(lines: string[]): MonacoEditor.languages.FoldingRange[] {
  const ranges: MonacoEditor.languages.FoldingRange[] = [];
  const headings: Array<{ lineNumber: number; level: number }> = [];
  let fenceStart: number | undefined;
  let fenceMarker: '`' | '~' | undefined;
  let fenceLength = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1][0] as '`' | '~';
      if (!fenceStart) {
        fenceStart = lineNumber;
        fenceMarker = marker;
        fenceLength = fence[1].length;
      } else if (marker === fenceMarker && fence[1].length >= fenceLength) {
        ranges.push({ start: fenceStart, end: lineNumber });
        fenceStart = undefined;
      }
      return;
    }
    if (fenceStart) return;
    const heading = /^(#{1,6})\s+/.exec(line);
    if (heading) headings.push({ lineNumber, level: heading[1].length });
  });

  headings.forEach((heading, index) => {
    const nextAtSameOrHigherLevel = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const end = (nextAtSameOrHigherLevel?.lineNumber ?? lines.length + 1) - 1;
    if (end > heading.lineNumber) ranges.push({ start: heading.lineNumber, end });
  });
  return ranges;
}

function buildDocumentSymbols(monaco: Monaco, sourceType: SourceType, lines: string[]): MonacoEditor.languages.DocumentSymbol[] {
  if (sourceType === 'markdown') return markdownSymbols(monaco, lines);
  if (sourceType === 'tikz') return tikzSymbols(monaco, lines);
  if (sourceType === 'latex') return latexSymbols(monaco, lines);
  if (sourceType === 'svg') return svgSymbols(monaco, lines);
  if (sourceType === 'mermaid') return mermaidSymbols(monaco, lines);
  return textSymbols(monaco, lines);
}

function symbolForLine(monaco: Monaco, line: string, lineNumber: number, name: string, detail: string, kind: MonacoEditor.languages.SymbolKind): MonacoEditor.languages.DocumentSymbol {
  const index = Math.max(0, line.indexOf(name));
  return {
    name,
    detail,
    kind,
    tags: [],
    range: new monaco.Range(lineNumber, 1, lineNumber, line.length + 1),
    selectionRange: new monaco.Range(lineNumber, index + 1, lineNumber, index + name.length + 1),
  };
}

function markdownSymbols(monaco: Monaco, lines: string[]): MonacoEditor.languages.DocumentSymbol[] {
  const symbols: MonacoEditor.languages.DocumentSymbol[] = [];
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) symbols.push(symbolForLine(monaco, line, index + 1, heading[2], `Heading ${heading[1].length}`, monaco.languages.SymbolKind.String));
  });
  return symbols;
}

function tikzSymbols(monaco: Monaco, lines: string[]): MonacoEditor.languages.DocumentSymbol[] {
  const symbols: MonacoEditor.languages.DocumentSymbol[] = [];
  lines.forEach((line, index) => {
    const node = /\\(?:node|coordinate)\b(?:\[[^\]]*\])?\s*\(([^)]+)\)/.exec(stripTikzComments(line));
    if (node) symbols.push(symbolForLine(monaco, line, index + 1, node[1], '\\node / \\coordinate', monaco.languages.SymbolKind.Variable));
  });
  return symbols;
}

function latexSymbols(monaco: Monaco, lines: string[]): MonacoEditor.languages.DocumentSymbol[] {
  const symbols: MonacoEditor.languages.DocumentSymbol[] = [];
  lines.forEach((line, index) => {
    const section = /\\(section|subsection|subsubsection|chapter|part)\*?\{([^}]+)\}/.exec(stripTikzComments(line));
    const environment = /\\begin\{([^}]+)\}/.exec(stripTikzComments(line));
    if (section) {
      symbols.push(symbolForLine(monaco, line, index + 1, section[2], `LaTeX ${section[1]}`, monaco.languages.SymbolKind.String));
    } else if (environment) {
      symbols.push(symbolForLine(monaco, line, index + 1, environment[1], 'LaTeX environment', monaco.languages.SymbolKind.Module));
    }
  });
  return symbols;
}

function svgSymbols(monaco: Monaco, lines: string[]): MonacoEditor.languages.DocumentSymbol[] {
  const symbols: MonacoEditor.languages.DocumentSymbol[] = [];
  lines.forEach((line, index) => {
    const id = /\bid\s*=\s*(["'])([^"']+)\1/.exec(line);
    if (id) symbols.push(symbolForLine(monaco, line, index + 1, id[2], 'SVG id', monaco.languages.SymbolKind.Field));
  });
  return symbols;
}

function mermaidSymbols(monaco: Monaco, lines: string[]): MonacoEditor.languages.DocumentSymbol[] {
  const symbols: MonacoEditor.languages.DocumentSymbol[] = [];
  lines.forEach((line, index) => {
    const declaration = /^(flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|journey|pie|timeline|mindmap|gitGraph|quadrantChart|xychart-beta)\b/i.exec(line.trim());
    if (declaration) symbols.push(symbolForLine(monaco, line, index + 1, declaration[1], 'Mermaid diagram', monaco.languages.SymbolKind.Namespace));
    const subgraph = /^\s*subgraph\s+(.+)$/i.exec(line);
    if (subgraph) symbols.push(symbolForLine(monaco, line, index + 1, subgraph[1], 'Mermaid subgraph', monaco.languages.SymbolKind.Module));
  });
  return symbols;
}

function textSymbols(monaco: Monaco, lines: string[]): MonacoEditor.languages.DocumentSymbol[] {
  const symbols: MonacoEditor.languages.DocumentSymbol[] = [];
  lines.forEach((line, index) => {
    const next = lines[index + 1] ?? '';
    const underlinedHeading = line.trim() && /^\s*[=-]{3,}\s*$/.test(next);
    const key = /^\s*([A-Za-z][\w .-]{0,72}):\s*\S/.exec(line);
    if (underlinedHeading) symbols.push(symbolForLine(monaco, line, index + 1, line.trim(), 'Plain-text section', monaco.languages.SymbolKind.String));
    else if (key) symbols.push(symbolForLine(monaco, line, index + 1, key[1], 'Plain-text key', monaco.languages.SymbolKind.Property));
  });
  return symbols;
}
