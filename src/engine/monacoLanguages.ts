import type { Monaco } from '@monaco-editor/react';
import { installFoundryEditorIntelligence } from './editorIntelligence';

const configuredMonacoInstances = new WeakSet<object>();

function registerLanguage(monaco: Monaco, id: string) {
  if (!monaco.languages.getLanguages().some((language) => language.id === id)) {
    monaco.languages.register({ id });
  }
}

function configureFoundryLanguageBehavior(monaco: Monaco) {
  monaco.languages.setLanguageConfiguration('foundry-tikz', {
    comments: { lineComment: '%' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    wordPattern: /\\?[A-Za-z@][\w@.-]*|\b\d+(?:\.\d+)?\b/g,
    indentationRules: {
      increaseIndentPattern: /^\s*(?:\\begin\{[^}]+\}|\\foreach\b.*\{|[^%]*\{)\s*$/,
      decreaseIndentPattern: /^\s*(?:\\end\{[^}]+\}|\})/,
    },
  });

  monaco.languages.setLanguageConfiguration('foundry-latex', {
    comments: { lineComment: '%' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    wordPattern: /\\?[A-Za-z@][\w@.-]*|\b\d+(?:\.\d+)?\b/g,
    indentationRules: {
      increaseIndentPattern: /^\s*(?:\\begin\{[^}]+\}|[^%]*\{)\s*$/,
      decreaseIndentPattern: /^\s*(?:\\end\{[^}]+\}|\})/,
    },
  });

  monaco.languages.setLanguageConfiguration('foundry-svg', {
    comments: { blockComment: ['<!--', '-->'] },
    brackets: [['<', '>'], ['{', '}'], ['(', ')']],
    colorizedBracketPairs: [['{', '}'], ['(', ')']],
    autoClosingPairs: [{ open: '"', close: '"' }, { open: "'", close: "'" }, { open: '{', close: '}' }, { open: '(', close: ')' }],
    surroundingPairs: [{ open: '"', close: '"' }, { open: "'", close: "'" }, { open: '{', close: '}' }, { open: '(', close: ')' }],
    wordPattern: /[A-Za-z_:][\w:.-]*/g,
    indentationRules: {
      increaseIndentPattern: /^\s*<(?!\/|!|\?)[^>]*[^/\s]>\s*$/,
      decreaseIndentPattern: /^\s*<\//,
    },
  });

  monaco.languages.setLanguageConfiguration('foundry-mermaid', {
    comments: { lineComment: '%%' },
    brackets: [['[', ']'], ['{', '}'], ['(', ')']],
    colorizedBracketPairs: [['[', ']'], ['{', '}'], ['(', ')']],
    autoClosingPairs: [{ open: '[', close: ']' }, { open: '{', close: '}' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    surroundingPairs: [{ open: '[', close: ']' }, { open: '{', close: '}' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    wordPattern: /[A-Za-z_][\w.-]*/g,
    indentationRules: {
      increaseIndentPattern: /^\s*(?:subgraph|alt|opt|loop|par|critical|rect|box)\b/i,
      decreaseIndentPattern: /^\s*end\b/i,
    },
  });

  monaco.languages.setLanguageConfiguration('foundry-markdown', {
    brackets: [['[', ']'], ['(', ')'], ['{', '}']],
    colorizedBracketPairs: [['[', ']'], ['(', ')'], ['{', '}']],
    autoClosingPairs: [{ open: '[', close: ']' }, { open: '(', close: ')' }, { open: '`', close: '`' }, { open: '"', close: '"' }],
    surroundingPairs: [{ open: '[', close: ']' }, { open: '(', close: ')' }, { open: '`', close: '`' }, { open: '"', close: '"' }],
    wordPattern: /[^\s`~!@#$%^&*()=+[{\]}\\|;:'",.<>/?]+/g,
  });

  monaco.languages.setLanguageConfiguration('foundry-text', {
    brackets: [['[', ']'], ['(', ')'], ['{', '}']],
    colorizedBracketPairs: [['[', ']'], ['(', ')'], ['{', '}']],
    autoClosingPairs: [{ open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    surroundingPairs: [{ open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    wordPattern: /[^\s`~!@#$%^&*()=+[{\]}\\|;:'",.<>/?]+/g,
  });
}

export function registerFoundryLanguages(monaco: Monaco) {
  const monacoKey = monaco as unknown as object;
  if (!configuredMonacoInstances.has(monacoKey)) {
    registerLanguage(monaco, 'foundry-tikz');
    monaco.languages.setMonarchTokensProvider('foundry-tikz', {
      tokenizer: {
        root: [
          [/%.*$/, 'comment'],
          [/\\(?:documentclass|usepackage|usetikzlibrary|begin|end|node|draw|path|fill|filldraw|shade|clip|coordinate|foreach|tikzset|def|newcommand|renewcommand|title|author)\b/, 'keyword'],
          [/\\[a-zA-Z@]+/, 'keyword'],
          [/\b(?:tikzpicture|scope|matrix|axis|groupplot|node|coordinate|path|draw|fill|style|color)\b/, 'type'],
          [/-\{|->|<-|--|\.{2,}|\|/, 'operator'],
          [/[+-]?(?:\d+\.?\d*|\.\d+)(?:pt|mm|cm|in|ex|em|deg)?\b/, 'number'],
          [/[{}\[\]()]/, 'delimiter'],
          [/"[^"\\]*(?:\\.[^"\\]*)*"/, 'string'],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-latex');
    monaco.languages.setMonarchTokensProvider('foundry-latex', {
      tokenizer: {
        root: [
          [/%.*$/, 'comment'],
          [/\\(?:documentclass|usepackage|begin|end|title|author|date|maketitle|section|subsection|subsubsection|chapter|part|label|ref|cite|includegraphics|tableofcontents|item|emph|textbf|textit|newcommand|renewcommand)\b/, 'keyword'],
          [/\\(?:frac|sqrt|sum|prod|int|left|right|mathrm|text|mathbf|mathcal)\b/, 'type'],
          [/\\[a-zA-Z@]+/, 'keyword'],
          [/\$\$?|\\\[|\\\]|\\\(|\\\)/, 'operator'],
          [/[+-]?(?:\d+\.?\d*|\.\d+)(?:pt|mm|cm|in|ex|em|deg)?\b/, 'number'],
          [/[{}\[\]()]/, 'delimiter'],
          [/"[^"\\]*(?:\\.[^"\\]*)*"/, 'string'],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-svg');
    monaco.languages.setMonarchTokensProvider('foundry-svg', {
      tokenizer: {
        root: [
          [/<!--[\s\S]*?-->/, 'comment'],
          [/<\/?[\w:-]+/, { token: 'tag', next: '@tag' }],
          [/<!DOCTYPE[^>]*>/i, 'metatag'],
          [/&[\w#]+;/, 'string'],
        ],
        tag: [
          [/\s+[\w:-]+/, 'attribute.name'],
          [/=/, 'delimiter'],
          [/"[^"\\]*(?:\\.[^"\\]*)*"/, 'attribute.value'],
          [/'[^'\\]*(?:\\.[^'\\]*)*'/, 'attribute.value'],
          [/>/, { token: 'tag', next: '@pop' }],
          [/\/>/, { token: 'tag', next: '@pop' }],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-mermaid');
    monaco.languages.setMonarchTokensProvider('foundry-mermaid', {
      tokenizer: {
        root: [
          [/%%.*$/, 'comment'],
          [/\b(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|gantt|mindmap|gitGraph|journey|pie|timeline|quadrantChart|xychart-beta|subgraph|end)\b/, 'keyword'],
          [/\b(?:classDef|class|style|linkStyle|click|participant|actor|note|alt|opt|loop|par|critical|rect|activate|deactivate)\b/, 'type'],
          [/-->|---|-.->|==>|-->>|->>|<-->|<--|--x|x--/, 'operator'],
          [/\|[^|]+\|/, 'string'],
          [/[\[\]{}()]/, 'delimiter'],
          [/#(?:[0-9a-fA-F]{3,8})\b/, 'number'],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-markdown');
    monaco.languages.setMonarchTokensProvider('foundry-markdown', {
      tokenizer: {
        root: [
          [/^\s*#{1,6}\s+.*$/, 'keyword'],
          [/^\s*>\s+.*$/, 'comment'],
          [/^(\s*)(?:[-+*]|\d+\.)\s+/, 'type'],
          [/^\s*```[\w-]*\s*$/, { token: 'string', next: '@codeblock' }],
          [/^\s*(?:---+|\*\*\*+|___+)\s*$/, 'delimiter'],
          [/\*\*[^*]+\*\*/, 'strong'],
          [/(?:^|[^*])\*[^*]+\*/, 'emphasis'],
          [/`[^`]+`/, 'string'],
          [/!?\[[^\]]*\]\([^\s)]+(?:\s+"[^"]*")?\)/, 'link'],
          [/\|/, 'delimiter'],
        ],
        codeblock: [
          [/^\s*```\s*$/, { token: 'string', next: '@pop' }],
          [/.*$/, 'comment'],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-text');
    monaco.languages.setMonarchTokensProvider('foundry-text', {
      tokenizer: {
        root: [
          [/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, 'type'],
          [/^\s*>.*$/, 'comment'],
          [/^\s*[=-]{3,}\s*$/, 'delimiter'],
          [/\b(?:TODO|FIXME|NOTE|IMPORTANT)\b:?/i, 'keyword'],
          [/(?:https?|file):\/\/[^\s<>()]+/, 'link'],
        ],
      },
    });

    configureFoundryLanguageBehavior(monaco);

    configuredMonacoInstances.add(monacoKey);
  }

  monaco.editor.defineTheme('foundry-night', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '75819a', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c8bbff' },
      { token: 'type', foreground: '8ee7e0' },
      { token: 'string', foreground: 'a8e6b4' },
      { token: 'strong', foreground: 'ffd48c', fontStyle: 'bold' },
      { token: 'emphasis', foreground: 'd8caff', fontStyle: 'italic' },
      { token: 'link', foreground: '72ddec' },
      { token: 'tag', foreground: '8ae7e2' },
      { token: 'attribute.name', foreground: 'c7a9ff' },
      { token: 'attribute.value', foreground: 'a8e6b4' },
      { token: 'number', foreground: 'ffc978' },
      { token: 'operator', foreground: '9dc9ff' },
      { token: 'delimiter', foreground: 'a7b4cb' },
    ],
    colors: {
      'editor.background': '#111622',
      'editor.foreground': '#d9e3f8',
      'editor.lineHighlightBackground': '#1a2232',
      'editorCursor.foreground': '#83f1e8',
      'editor.selectionBackground': '#31466599',
      'editor.inactiveSelectionBackground': '#27394f99',
      'editorLineNumber.foreground': '#536079',
      'editorLineNumber.activeForeground': '#aebbd5',
      'editorIndentGuide.background1': '#202b3c',
      'editorIndentGuide.activeBackground1': '#44526c',
    },
  });

  monaco.editor.defineTheme('foundry-day', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '748198', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7046bf' },
      { token: 'type', foreground: '007f83' },
      { token: 'string', foreground: '167451' },
      { token: 'strong', foreground: 'a85b00', fontStyle: 'bold' },
      { token: 'emphasis', foreground: '774fc2', fontStyle: 'italic' },
      { token: 'link', foreground: '0068bf' },
      { token: 'tag', foreground: '007d82' },
      { token: 'attribute.name', foreground: '7a45c9' },
      { token: 'attribute.value', foreground: '157151' },
      { token: 'number', foreground: 'a45a00' },
      { token: 'operator', foreground: '156aa8' },
      { token: 'delimiter', foreground: '5c6878' },
    ],
    colors: {
      'editor.background': '#fbfcff',
      'editor.foreground': '#1c2635',
      'editor.lineHighlightBackground': '#edf3fb',
      'editorCursor.foreground': '#087d82',
      'editor.selectionBackground': '#bcdcf199',
      'editor.inactiveSelectionBackground': '#d7e5f099',
      'editorLineNumber.foreground': '#a4afbf',
      'editorLineNumber.activeForeground': '#526074',
      'editorIndentGuide.background1': '#e5eaf2',
      'editorIndentGuide.activeBackground1': '#b9c5d3',
    },
  });

  // The language configuration is intentionally separate from the UI so every
  // foundry model gets completions, reference hovers, formatting, folding, and
  // lightweight live markers as soon as Monaco is mounted.
  installFoundryEditorIntelligence(monaco);
}
