import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EXTRA_EXTENSIONS, EXTRA_FENCE_ALIASES, EXTRA_SOURCE_META, EXTRA_SOURCE_TYPES, extraDeclaration } from '../src/engine/extraSources.ts';
import { CODE_SOURCE_TYPES, ORIGINAL_SOURCE_TYPES, SOURCE_FILENAME_PATTERN, SOURCE_TYPES, SOURCE_TYPES_VERSION, normalizedEnabledSourceTypes, sourceTypeForName } from '../src/engine/sourceTypes.ts';
import { samples } from '../src/engine/samples.ts';
import { references } from '../src/engine/references.ts';
import { formatSource } from '../src/engine/formatters.ts';
import { documentOutline, sourceFromAssistantReply } from '../src/engine/workbench.ts';
import { extraMonacoModes, registerExtraCodeLanguages } from '../src/engine/extraMonacoLanguages.ts';

test('all 30 formats have offline editor metadata, samples, references and round-trip filenames', () => {
  assert.equal(SOURCE_TYPES.length, 30);
  assert.equal(new Set(SOURCE_TYPES).size, SOURCE_TYPES.length);
  for (const type of EXTRA_SOURCE_TYPES) {
    assert.equal(sourceTypeForName(samples[type].name), type);
    assert.equal(EXTRA_SOURCE_META[type].language, `foundry-${type}`);
    assert.ok(CODE_SOURCE_TYPES.includes(type));
    assert.ok(samples[type].source.trim());
    assert.ok(references[type].length >= 2);
    assert.ok(extraMonacoModes[type].language.tokenizer.root.length);
  }
});

test('new extensions are detected consistently without stealing unrelated text files', () => {
  for (const type of EXTRA_SOURCE_TYPES) {
    for (const extension of EXTRA_EXTENSIONS[type]) {
      assert.equal(sourceTypeForName(`folder/program.${extension}`), type);
      assert.equal(`program.${extension}`.replace(SOURCE_FILENAME_PATTERN, ''), 'program');
      if (!['c', 'h'].includes(extension)) assert.equal(sourceTypeForName(`program.${extension.toUpperCase()}`), type);
    }
  }
  assert.equal(sourceTypeForName('program.C'), 'cpp');
  assert.equal(sourceTypeForName('program.H'), 'cpp');
  assert.equal(sourceTypeForName('program.h'), 'c');
  for (const name of ['README', 'example.cpp.bak', 'file.kt.txt', 'notes.csh-old', 'program.cplus', 'Gemfile.lock', 'folder.cpp/README']) assert.equal(sourceTypeForName(name), 'text');
});

test('Ruby project files and shell startup files are detected by exact basename', () => {
  for (const name of ['Gemfile', 'Rakefile', 'Guardfile', 'Vagrantfile']) assert.equal(sourceTypeForName(`folder/${name}`), 'ruby');
  for (const name of ['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile', '.kshrc']) assert.equal(sourceTypeForName(`folder/${name}`), 'bash');
  for (const name of ['.cshrc', '.tcshrc', '.login', '.logout']) assert.equal(sourceTypeForName(`folder/${name}`), 'csh');
  assert.equal(sourceTypeForName('.bashrc.backup'), 'text');
  assert.equal(sourceTypeForName('Gemfile.txt'), 'text');
});

test('SQL remains a source-only mode, including DDL, DML and DQL files', () => {
  for (const extension of ['sql', 'ddl', 'dml', 'dql', 'SQL']) assert.equal(sourceTypeForName(`query.${extension}`), 'sql');
  assert.ok(references.sql.some((entry) => entry.tags.includes('select')));
});

test('versioned migration upgrades defaults once and preserves custom subsets and opt-outs', () => {
  assert.equal(SOURCE_TYPES_VERSION, 2);
  assert.deepEqual(normalizedEnabledSourceTypes(ORIGINAL_SOURCE_TYPES, 1), SOURCE_TYPES);
  assert.deepEqual(normalizedEnabledSourceTypes(ORIGINAL_SOURCE_TYPES.filter((type) => type !== 'php'), 0), SOURCE_TYPES);
  assert.deepEqual(normalizedEnabledSourceTypes(['text', 'sql', 'php'], 1), ['text', 'php', 'sql']);
  const optedOut = SOURCE_TYPES.filter((type) => type !== 'swift');
  assert.deepEqual(normalizedEnabledSourceTypes(optedOut, 2), optedOut);
  assert.deepEqual(normalizedEnabledSourceTypes(ORIGINAL_SOURCE_TYPES, 2), ORIGINAL_SOURCE_TYPES);
  assert.deepEqual(normalizedEnabledSourceTypes([], 1), ['text']);
});

test('new code formatting preserves multiline strings, heredocs, continuations and line endings exactly', () => {
  const sensitive = '  literal with spaces  \r\n\tcontinued \\  \r\n"""\n  literal content  \n"""\n\n';
  for (const type of EXTRA_SOURCE_TYPES) assert.equal(formatSource(type, sensitive), sensitive);
  assert.equal(formatSource('php', sensitive), sensitive);
});

test('Prompt Studio removes matching language fences, including escaped C++ aliases', () => {
  for (const type of EXTRA_SOURCE_TYPES) {
    for (const alias of EXTRA_FENCE_ALIASES[type]) assert.equal(sourceFromAssistantReply(`\`\`\`${alias}\n${samples[type].source}\`\`\``, type), samples[type].source);
  }
  assert.ok(sourceFromAssistantReply('```python\nprint(1)\n```', 'cpp').startsWith('```python'));
});

test('lightweight outlines recognize declarations across all new languages', () => {
  const declarations = {
    c: 'int greet(void) {', cpp: 'class Greeting {', pascal: 'procedure Greet;', go: 'func (g Greeting) Greet(name string) string {',
    ruby: 'def greet(name)', bash: 'greet() {', csh: 'alias greet echo', powershell: 'function Get-Greeting {',
    batch: ':greet', vbscript: 'Private Function Greet(name)', swift: 'public func greet(_ name: String) -> String {',
    objectivec: '- (NSString *)greet:(NSString *)name {', kotlin: 'suspend fun greet(name: String): String {',
  };
  for (const type of EXTRA_SOURCE_TYPES) {
    const outline = documentOutline(type, `\n${declarations[type]}\n`);
    assert.equal(outline.length, 1, type);
    assert.equal(outline[0].line, 2);
    assert.ok(outline[0].label.toLowerCase().includes('greet'), type);
  }
  assert.equal(extraDeclaration('c', '    return greet();'), undefined);
  assert.equal(extraDeclaration('batch', ':: This is a comment'), undefined);
  assert.equal(extraDeclaration('vbscript', "' Function Greet(name)"), undefined);
  assert.equal(extraDeclaration('cpp', 'word '.repeat(2000)), undefined);
});

test('language registration includes a tokenizer and comment configuration for each new mode', () => {
  const registered = new Set<string>();
  const grammars = new Set<string>();
  const configs = new Set<string>();
  const monaco = { languages: {
    getLanguages: () => [...registered].map((id) => ({ id })),
    register: ({ id }: { id: string }) => registered.add(id),
    setMonarchTokensProvider: (id: string, grammar: { tokenizer: unknown }) => { assert.ok(grammar.tokenizer); grammars.add(id); },
    setLanguageConfiguration: (id: string, conf: { comments: unknown }) => { assert.ok(conf.comments); configs.add(id); },
  } };
  registerExtraCodeLanguages(monaco as never);
  registerExtraCodeLanguages(monaco as never);
  assert.equal(registered.size, EXTRA_SOURCE_TYPES.length);
  assert.deepEqual(grammars, registered);
  assert.deepEqual(configs, registered);
  assert.equal(extraMonacoModes.bash.language.ignoreCase, false);
  assert.equal(extraMonacoModes.csh.language.ignoreCase, false);
  assert.ok(extraMonacoModes.csh.language.keywords.includes('endif'));
  assert.ok(!extraMonacoModes.c.language.keywords.includes('namespace'));
  assert.ok(extraMonacoModes.cpp.language.keywords.includes('namespace'));
});

test('native source IDs, save extensions, menus and escaped export routing stay aligned with frontend modes', () => {
  const models = readFileSync(new URL('../src-tauri/src/models.rs', import.meta.url), 'utf8');
  const nativeIds = [...models.match(/pub const SOURCE_TYPE_IDS:.*?= &\[([\s\S]*?)\];/)![1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(nativeIds, SOURCE_TYPES);
  const menu = readFileSync(new URL('../src-tauri/src/menu.rs', import.meta.url), 'utf8');
  const tools = readFileSync(new URL('../src-tauri/src/tools.rs', import.meta.url), 'utf8');
  const exportRoute = tools.match(/"markdown" \| "text"[\s\S]*?=> \{/)![0];
  for (const type of EXTRA_SOURCE_TYPES) {
    assert.ok(new RegExp(`source_item\\(\\s*app,\\s*"${type}"`).test(menu), type);
    assert.ok(exportRoute.includes(`"${type}"`), type);
    assert.ok(models.includes(`"${type}" => "${EXTRA_SOURCE_META[type].extension}"`), type);
  }
  assert.ok(tools.includes('crate::models::source_kind_for_path(path)'));
});
