import type { Monaco } from '@monaco-editor/react';
import type { languages } from 'monaco-editor';
import { conf as cppConf, language as cppLanguage } from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js';
import { conf as pascalConf, language as pascalLanguage } from 'monaco-editor/esm/vs/basic-languages/pascal/pascal.js';
import { conf as goConf, language as goLanguage } from 'monaco-editor/esm/vs/basic-languages/go/go.js';
import { conf as rubyConf, language as rubyLanguage } from 'monaco-editor/esm/vs/basic-languages/ruby/ruby.js';
import { conf as shellConf, language as shellLanguage } from 'monaco-editor/esm/vs/basic-languages/shell/shell.js';
import { conf as powershellConf, language as powershellLanguage } from 'monaco-editor/esm/vs/basic-languages/powershell/powershell.js';
import { conf as batchConf, language as batchLanguage } from 'monaco-editor/esm/vs/basic-languages/bat/bat.js';
import { conf as swiftConf, language as swiftLanguage } from 'monaco-editor/esm/vs/basic-languages/swift/swift.js';
import { conf as objcConf, language as objcLanguage } from 'monaco-editor/esm/vs/basic-languages/objective-c/objective-c.js';
import { conf as kotlinConf, language as kotlinLanguage } from 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js';
import { EXTRA_SOURCE_META, EXTRA_SOURCE_TYPES, type ExtraSourceType } from './extraSources.ts';

const cKeywords = 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local alignas alignof bool constexpr false nullptr static_assert thread_local true typeof typeof_unqual'.split(' ');
const cshKeywords = 'alias break breaksw case continue default else end endif endsw exit foreach goto if label logout onintr repeat set setenv shift source switch then unalias unset unsetenv while'.split(' ');
const vbscriptKeywords = 'and as byref byval call case class const dim do each else elseif empty end eqv erase error event exit explicit false for function get goto if imp in is let loop mod new next not nothing null on option or preserve private property public redim rem resume select set step stop sub then to true until wend while with xor'.split(' ');

const vbscriptLanguage: languages.IMonarchLanguage = {
  ignoreCase: true, keywords: vbscriptKeywords, tokenPostfix: '.vbs',
  tokenizer: { root: [
    [/'[^\n]*$/, 'comment'], [/\brem\b.*$/i, 'comment'],
    [/"(?:[^"\n]|"")*"/, 'string'], [/&[hH][0-9a-fA-F]+|\b\d+(?:\.\d+)?\b/, 'number'],
    [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
    [/[()]/, '@brackets'], [/[=<>+\-*/\\^&]+/, 'operator'], [/[.,:]/, 'delimiter'],
  ] },
};

export const extraMonacoModes: Record<ExtraSourceType, { language: languages.IMonarchLanguage; conf: languages.LanguageConfiguration }> = {
  c: { language: { ...cppLanguage, keywords: cKeywords, tokenPostfix: '.c' }, conf: cppConf },
  cpp: { language: cppLanguage, conf: cppConf },
  pascal: { language: pascalLanguage, conf: pascalConf },
  go: { language: goLanguage, conf: goConf },
  ruby: { language: rubyLanguage, conf: rubyConf },
  bash: { language: { ...shellLanguage, ignoreCase: false }, conf: shellConf },
  csh: { language: { ...shellLanguage, ignoreCase: false, keywords: cshKeywords, tokenPostfix: '.csh' }, conf: {
    ...shellConf, indentationRules: { increaseIndentPattern: /^\s*(?:foreach|while|switch)\b|^\s*if\b.*\bthen\s*$/, decreaseIndentPattern: /^\s*(?:end|endif|endsw|else)\b/ },
  } },
  powershell: { language: powershellLanguage, conf: powershellConf },
  batch: { language: batchLanguage, conf: batchConf },
  vbscript: { language: vbscriptLanguage, conf: {
    comments: { lineComment: "'" }, brackets: [['(', ')']],
    autoClosingPairs: [{ open: '(', close: ')' }, { open: '"', close: '"', notIn: ['string', 'comment'] }],
    surroundingPairs: [{ open: '(', close: ')' }, { open: '"', close: '"' }],
    indentationRules: { increaseIndentPattern: /^\s*(?:(?:public|private)\s+)?(?:sub|function|class|for|do|while|with)\b|^\s*if\b.*\bthen\s*$/i, decreaseIndentPattern: /^\s*(?:end\b|next\b|loop\b|wend\b|else\b)/i },
  } },
  swift: { language: swiftLanguage, conf: swiftConf },
  objectivec: { language: objcLanguage, conf: objcConf },
  kotlin: { language: kotlinLanguage, conf: kotlinConf },
};

/** All lexical grammars ship in the app. No CDN, LSP, compiler, or runner. */
export function registerExtraCodeLanguages(monaco: Monaco) {
  for (const type of EXTRA_SOURCE_TYPES) {
    const id = EXTRA_SOURCE_META[type].language;
    if (!monaco.languages.getLanguages().some((language) => language.id === id)) monaco.languages.register({ id });
    const mode = extraMonacoModes[type];
    monaco.languages.setMonarchTokensProvider(id, mode.language);
    monaco.languages.setLanguageConfiguration(id, mode.conf);
  }
}
