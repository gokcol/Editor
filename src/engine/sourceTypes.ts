import type { SourceType } from '../types';
import { EXTRA_EXTENSIONS, EXTRA_SOURCE_TYPES, extraSourceTypeForName } from './extraSources.ts';

export const ORIGINAL_SOURCE_TYPES: SourceType[] = ['tikz', 'latex', 'metafont', 'svg', 'mermaid', 'markdown', 'text', 'yaml', 'json', 'javascript', 'typescript', 'python', 'php', 'fortran', 'sql', 'html', 'css'];
export const SOURCE_TYPES: SourceType[] = [...ORIGINAL_SOURCE_TYPES, ...EXTRA_SOURCE_TYPES];
export const SOURCE_TYPES_VERSION = 2;
const extraExtensions = Object.values(EXTRA_EXTENSIONS).flat().map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
export const SOURCE_FILENAME_PATTERN = new RegExp(`\\.(?:tikz|tex|latex|ltx|mf|svg|mmd|mermaid|md|markdown|txt|ya?ml|json|(?:c|m)?js|jsx|(?:c|m)?ts|tsx|pyw?|php[3-8]?|phtml|f(?:or|90|95|03|08|18)?|sql|ddl|dml|dql|x?html?|css|${extraExtensions})$`, 'i');
export const CODE_SOURCE_TYPES: SourceType[] = ['javascript', 'typescript', 'python', 'php', 'fortran', 'sql', 'html', 'css', ...EXTRA_SOURCE_TYPES];

/** Upgrade only an older all-enabled default; preserve custom subsets/opt-outs. */
export function normalizedEnabledSourceTypes(value: unknown, version = SOURCE_TYPES_VERSION): SourceType[] {
  const requested = Array.isArray(value) ? value : SOURCE_TYPES;
  const oldTypes = version < 1 ? ORIGINAL_SOURCE_TYPES.filter((type) => type !== 'php') : ORIGINAL_SOURCE_TYPES;
  const upgradeDefault = version < SOURCE_TYPES_VERSION && oldTypes.every((type) => requested.includes(type));
  const enabled = SOURCE_TYPES.filter((type) => requested.includes(type) || upgradeDefault);
  return enabled.length ? enabled : ['text'];
}

export function sourceTypeForName(name: string): SourceType {
  const extra = extraSourceTypeForName(name);
  if (extra) return extra;
  const lower = name.toLowerCase();
  if (lower.endsWith('.tikz')) return 'tikz';
  if (/\.(?:tex|latex|ltx)$/.test(lower)) return 'latex';
  if (lower.endsWith('.mf')) return 'metafont';
  if (lower.endsWith('.svg')) return 'svg';
  if (/\.(?:mmd|mermaid)$/.test(lower)) return 'mermaid';
  if (/\.(?:md|markdown)$/.test(lower)) return 'markdown';
  if (lower.endsWith('.txt')) return 'text';
  if (/\.ya?ml$/.test(lower)) return 'yaml';
  if (lower.endsWith('.json')) return 'json';
  if (/\.(?:js|mjs|cjs|jsx)$/.test(lower)) return 'javascript';
  if (/\.(?:ts|mts|cts|tsx)$/.test(lower)) return 'typescript';
  if (/\.pyw?$/.test(lower)) return 'python';
  if (/\.(?:php[3-8]?|phtml)$/.test(lower)) return 'php';
  if (/\.f(?:or|90|95|03|08|18)?$/.test(lower)) return 'fortran';
  if (/\.(?:sql|ddl|dml|dql)$/.test(lower)) return 'sql';
  if (/\.(?:html?|xhtml)$/.test(lower)) return 'html';
  if (lower.endsWith('.css')) return 'css';
  return 'text';
}
