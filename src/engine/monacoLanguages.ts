import type { Monaco } from '@monaco-editor/react';
import { conf as phpConfiguration, language as phpLanguage } from 'monaco-editor/esm/vs/basic-languages/php/php.js';
import { installFoundryEditorIntelligence } from './editorIntelligence';
import { registerExtraCodeLanguages } from './extraMonacoLanguages';

const configuredMonacoInstances = new WeakSet<object>();

function registerLanguage(monaco: Monaco, id: string) {
  if (!monaco.languages.getLanguages().some((language) => language.id === id)) {
    monaco.languages.register({ id });
  }
}

/**
 * Shared lexical treatment for C-style source files. This intentionally
 * remains a lightweight local highlighter rather than pretending to perform
 * semantic analysis or run an external language server.
 */
function registerCStyleLanguage(monaco: Monaco, id: string, keywords: string[], typeKeywords: string[] = []) {
  registerLanguage(monaco, id);
  monaco.languages.setMonarchTokensProvider(id, {
    keywords,
    typeKeywords,
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, { token: 'comment', next: '@comment' }],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'number'],
        [/[{}[\]()]/, 'delimiter'],
        [/[=><!~?:&|+\-*\/%]+/, 'operator'],
        [/[A-Za-z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'identifier' } }],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, { token: 'comment', next: '@pop' }],
        [/./, 'comment'],
      ],
    },
  });
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

  monaco.languages.setLanguageConfiguration('foundry-metafont', {
    comments: { lineComment: '%' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    wordPattern: /[A-Za-z_][\w@.#]*|\b\d+(?:\.\d+)?\b/g,
    indentationRules: {
      increaseIndentPattern: /^\s*(?:beginchar\b|(?:var)?def\b)/,
      decreaseIndentPattern: /^\s*(?:endchar|enddef)\b/,
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
  monaco.languages.setLanguageConfiguration('foundry-yaml', {
    comments: { lineComment: '#' },
    brackets: [['[', ']'], ['{', '}'], ['(', ')']],
    colorizedBracketPairs: [['[', ']'], ['{', '}'], ['(', ')']],
    autoClosingPairs: [{ open: '[', close: ']' }, { open: '{', close: '}' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    surroundingPairs: [{ open: '[', close: ']' }, { open: '{', close: '}' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    wordPattern: /[A-Za-z_][\w.-]*/g,
    indentationRules: {
      increaseIndentPattern: /^\s*(?:-\s+)?[^#\n][^:]*:\s*(?:#.*)?$/,
      decreaseIndentPattern: /^\s*(?:---|\.\.\.)\s*$/,
    },
  });

  monaco.languages.setLanguageConfiguration('foundry-json', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }],
    wordPattern: /(?:[A-Za-z_$][\w$-]*|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
  });

  for (const id of ['foundry-javascript', 'foundry-typescript', 'foundry-css'] as const) {
    monaco.languages.setLanguageConfiguration(id, {
      comments: { lineComment: '//', blockComment: ['/*', '*/'] },
      brackets: [['{', '}'], ['[', ']'], ['(', ')']],
      colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
      autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
      surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
      wordPattern: /[A-Za-z_$][\w$-]*/g,
    });
  }

  monaco.languages.setLanguageConfiguration('foundry-python', {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    wordPattern: /[A-Za-z_][\w]*/g,
    indentationRules: {
      increaseIndentPattern: /^\s*(?:async\s+)?(?:def|class)\b.*:\s*(?:#.*)?$|^\s*(?:if|elif|else|for|while|try|except|finally|with|match|case)\b.*:\s*(?:#.*)?$/,
      decreaseIndentPattern: /^\s*(?:elif|else|except|finally|case)\b/,
    },
  });

  monaco.languages.setLanguageConfiguration('foundry-fortran', {
    comments: { lineComment: '!' },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    wordPattern: /[A-Za-z_][\w]*/g,
    indentationRules: {
      increaseIndentPattern: /^\s*(?:program|module|subroutine|function|interface|type|do|if|select\s+case|where|associate|block)\b(?!.*\bend\b).*$/i,
      decreaseIndentPattern: /^\s*end(?:\s+(?:program|module|subroutine|function|interface|type|do|if|select|where|associate|block))?\b/i,
    },
  });

  monaco.languages.setLanguageConfiguration('foundry-sql', {
    comments: { lineComment: '--', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
    wordPattern: /[A-Za-z_][\w$]*/g,
  });

  monaco.languages.setLanguageConfiguration('foundry-html', {
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

    registerLanguage(monaco, 'foundry-metafont');
    monaco.languages.setMonarchTokensProvider('foundry-metafont', {
      tokenizer: {
        root: [
          [/%.*$/, 'comment'],
          [/\b(?:beginchar|endchar|def|vardef|enddef|if|fi|for|forsuffixes|forever|endfor|exitif|input|endinput|bye|mode_setup|font_identifier|font_size|define_pixels|pickup|draw|fill|unfill|erase|shipout|special|message|show)\b/, 'keyword'],
          [/\b(?:numeric|pair|path|pen|pencircle|picture|transform|string|boolean|suffix|expr|text|primary|secondary|tertiary|of|until|step|downto|thru|fullcircle|cycle|scaled|xscaled|yscaled|shifted|rotated|slanted)\b/, 'type'],
          [/:=|<=|>=|<>|\.\.|--|\+\+/, 'operator'],
          [/[+\-*/=&]/, 'operator'],
          [/[+-]?(?:\d+\.?\d*|\.\d+)(?:pt|mm|cm|in|bp|dd|cc|pc|em|ex)?#?\b/, 'number'],
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

    registerLanguage(monaco, 'foundry-yaml');
    monaco.languages.setMonarchTokensProvider('foundry-yaml', {
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/^\s*(?:---|\.\.\.)\s*$/, 'keyword'],
          [/^\s*-\s+/, 'delimiter'],
          [/^\s*(?:[A-Za-z_][\w.-]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?=\s*:)/, 'attribute.name'],
          [/[&*][A-Za-z_][\w.-]*/, 'type'],
          [/[!][A-Za-z_][\w.-]*/, 'type'],
          [/\b(?:true|false|null|yes|no|on|off)\b/i, 'keyword'],
          [/\b[+-]?\d+(?:\.\d+)?\b/, 'number'],
          [/"(?:[^"\\]|\\.)*"/, 'string'],
          [/'(?:[^'\\]|\\.)*'/, 'string'],
          [/[{}\[\](),:]/, 'delimiter'],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-json');
    monaco.languages.setMonarchTokensProvider('foundry-json', {
      tokenizer: {
        root: [
          [/\/\/.*$/, 'comment'],
          [/\/\*/, { token: 'comment', next: '@comment' }],
          [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'attribute.name'],
          [/"(?:[^"\\]|\\.)*"/, 'string'],
          [/\b(?:true|false|null)\b/, 'keyword'],
          [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'number'],
          [/[{}\[\],:]/, 'delimiter'],
        ],
        comment: [
          [/[^/*]+/, 'comment'],
          [/\*\//, { token: 'comment', next: '@pop' }],
          [/./, 'comment'],
        ],
      },
    });

    registerCStyleLanguage(
      monaco,
      'foundry-javascript',
      ['as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'true', 'false', 'null', 'undefined'],
      ['Array', 'Boolean', 'Date', 'Error', 'Map', 'Number', 'Object', 'Promise', 'RegExp', 'Set', 'String'],
    );
    registerCStyleLanguage(
      monaco,
      'foundry-typescript',
      ['abstract', 'as', 'asserts', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'constructor', 'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'namespace', 'new', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'super', 'switch', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while', 'yield', 'true', 'false', 'null', 'undefined'],
      ['any', 'bigint', 'boolean', 'never', 'number', 'object', 'string', 'symbol', 'unknown', 'void', 'Array', 'Promise', 'Record', 'ReadonlyArray'],
    );

    registerLanguage(monaco, 'foundry-python');
    monaco.languages.setMonarchTokensProvider('foundry-python', {
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/@[A-Za-z_][\w.]*/, 'type'],
          [/\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/, 'keyword'],
          [/\b(?:True|False|None)\b/, 'keyword'],
          [/\b(?:bool|bytes|dict|float|frozenset|int|list|object|set|str|tuple|type)\b/, 'type'],
          [/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?j?\b/, 'number'],
          [/(?:[rubf]|br|rb|fr|rf)?"""[\s\S]*?"""/i, 'string'],
          [/(?:[rubf]|br|rb|fr|rf)?'''[\s\S]*?'''/i, 'string'],
          [/(?:[rubf]|br|rb|fr|rf)?"(?:[^"\\]|\\.)*"/i, 'string'],
          [/(?:[rubf]|br|rb|fr|rf)?'(?:[^'\\]|\\.)*'/i, 'string'],
          [/[{}\[\]():,]/, 'delimiter'],
          [/[=><!~?:&|+\-*\/%]+/, 'operator'],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-fortran');
    monaco.languages.setMonarchTokensProvider('foundry-fortran', {
      tokenizer: {
        root: [
          [/!.*$/, 'comment'],
          [/^[cC*].*$/, 'comment'],
          [/\b(?:program|end|module|contains|subroutine|function|use|implicit|none|integer|real|complex|logical|character|type|class|interface|procedure|parameter|allocatable|allocate|deallocate|if|then|else|elseif|select|case|where|associate|block|do|cycle|exit|return|call|print|write|read|open|close|stop)\b/i, 'keyword'],
          [/\b(?:intent|in|out|inout|kind|len|size|shape|present|optional|pointer|target|save|public|private)\b/i, 'type'],
          [/\.(?:true|false|and|or|not|eq|ne|lt|le|gt|ge)\./i, 'keyword'],
          [/\b\d+(?:\.\d*)?(?:[eEdD][+-]?\d+)?(?:_[A-Za-z0-9_]+)?\b/, 'number'],
          [/"(?:[^"\\]|\\.)*"/, 'string'],
          [/'(?:[^'\\]|\\.)*'/, 'string'],
          [/::|=>|==|\/=|<=|>=|\*\*|[=+\-*\/<>]/, 'operator'],
          [/[()\[\],:]/, 'delimiter'],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-sql');
    monaco.languages.setMonarchTokensProvider('foundry-sql', {
      tokenizer: {
        root: [
          [/--.*$/, 'comment'],
          [/\/\*/, { token: 'comment', next: '@comment' }],
          [/\b(?:select|from|where|with|as|join|inner|left|right|full|outer|cross|on|group|by|having|order|limit|offset|union|all|insert|into|values|update|set|delete|create|alter|drop|table|view|index|primary|key|foreign|references|constraint|distinct|case|when|then|else|end|exists|and|or|not|null|is|in|between|like|returning|grant|revoke|begin|commit|rollback)\b/i, 'keyword'],
          [/\b(?:bigint|boolean|date|decimal|integer|json|jsonb|numeric|real|serial|text|timestamp|uuid|varchar)\b/i, 'type'],
          [/\b(?:true|false|null|current_date|current_timestamp)\b/i, 'keyword'],
          [/\b\d+(?:\.\d+)?\b/, 'number'],
          [/'(?:[^'\\]|\\.)*'/, 'string'],
          [/"(?:[^"\\]|\\.)*"/, 'attribute.name'],
          [/[=><!~:+\-*\/%]+/, 'operator'],
          [/[()\[\],;.]/, 'delimiter'],
        ],
        comment: [
          [/[^/*]+/, 'comment'],
          [/\*\//, { token: 'comment', next: '@pop' }],
          [/./, 'comment'],
        ],
      },
    });

    registerLanguage(monaco, 'foundry-html');
    monaco.languages.setMonarchTokensProvider('foundry-html', {
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

    registerLanguage(monaco, 'foundry-css');
    monaco.languages.setMonarchTokensProvider('foundry-css', {
      tokenizer: {
        root: [
          [/\/\*/, { token: 'comment', next: '@comment' }],
          [/@(?:charset|container|font-face|import|keyframes|layer|media|property|supports)\b/i, 'keyword'],
          [/(?:--[A-Za-z_][\w-]*|[A-Za-z-]+)(?=\s*:)/, 'attribute.name'],
          [/#(?:[0-9a-fA-F]{3,8})\b/, 'number'],
          [/\b\d+(?:\.\d+)?(?:%|[a-z]+)?\b/i, 'number'],
          [/\b(?:auto|block|flex|grid|inherit|initial|none|relative|absolute|fixed|sticky|transparent|unset)\b/, 'keyword'],
          [/"(?:[^"\\]|\\.)*"/, 'string'],
          [/'(?:[^'\\]|\\.)*'/, 'string'],
          [/[{}[\]():;,]/, 'delimiter'],
          [/[>+~*=|]/, 'operator'],
        ],
        comment: [
          [/[^/*]+/, 'comment'],
          [/\*\//, { token: 'comment', next: '@pop' }],
          [/./, 'comment'],
        ],
      },
    });

    // Reuse the bundled, offline PHP/HTML grammar; never evaluate PHP templates.
    registerLanguage(monaco, 'foundry-php');
    monaco.languages.setMonarchTokensProvider('foundry-php', {
      ...phpLanguage,
      phpKeywords: [...phpLanguage.phpKeywords, 'fn', 'match', 'enum', 'readonly', 'never', 'mixed'],
    });
    monaco.languages.setLanguageConfiguration('foundry-php', phpConfiguration);

    registerExtraCodeLanguages(monaco);
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
      // Monaco's default line-outline paints vertical edges all the way to
      // the viewport. Keep the active-line fill, but avoid colliding with
      // the workbench frame at either side of the editor.
      'editor.lineHighlightBorder': '#00000000',
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
      'editor.lineHighlightBorder': '#00000000',
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
