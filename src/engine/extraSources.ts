import type { ReferenceEntry } from '../types';

export const EXTRA_SOURCE_TYPES = ['c', 'cpp', 'pascal', 'go', 'ruby', 'bash', 'csh', 'powershell', 'batch', 'vbscript', 'swift', 'objectivec', 'kotlin'] as const;
export type ExtraSourceType = typeof EXTRA_SOURCE_TYPES[number];

export const EXTRA_SOURCE_META = {
  c: { label: 'C', short: 'C', color: 'cyan', language: 'foundry-c', extension: 'c' },
  cpp: { label: 'C++', short: 'C++', color: 'indigo', language: 'foundry-cpp', extension: 'cpp' },
  pascal: { label: 'Pascal', short: 'PAS', color: 'violet', language: 'foundry-pascal', extension: 'pas' },
  go: { label: 'Go', short: 'GO', color: 'cyan', language: 'foundry-go', extension: 'go' },
  ruby: { label: 'Ruby', short: 'RB', color: 'rose', language: 'foundry-ruby', extension: 'rb' },
  bash: { label: 'Bash / shell', short: 'SH', color: 'mint', language: 'foundry-bash', extension: 'sh' },
  csh: { label: 'C shell', short: 'CSH', color: 'mint', language: 'foundry-csh', extension: 'csh' },
  powershell: { label: 'PowerShell', short: 'PS', color: 'indigo', language: 'foundry-powershell', extension: 'ps1' },
  batch: { label: 'Windows batch', short: 'BAT', color: 'slate', language: 'foundry-batch', extension: 'bat' },
  vbscript: { label: 'VBScript', short: 'VBS', color: 'amber', language: 'foundry-vbscript', extension: 'vbs' },
  swift: { label: 'Swift', short: 'SW', color: 'amber', language: 'foundry-swift', extension: 'swift' },
  objectivec: { label: 'Objective-C / C++', short: 'OBJ', color: 'cyan', language: 'foundry-objectivec', extension: 'm' },
  kotlin: { label: 'Kotlin', short: 'KT', color: 'violet', language: 'foundry-kotlin', extension: 'kt' },
} as const;

export const EXTRA_EXTENSIONS: Record<ExtraSourceType, readonly string[]> = {
  c: ['c', 'h'], cpp: ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'ipp', 'tpp', 'ixx', 'cppm'],
  pascal: ['pas', 'pp', 'p', 'lpr', 'dpr'], go: ['go'], ruby: ['rb', 'rake', 'gemspec', 'ru'],
  bash: ['sh', 'bash', 'zsh', 'ksh'], csh: ['csh', 'tcsh'], powershell: ['ps1', 'psm1', 'psd1'],
  batch: ['bat', 'cmd'], vbscript: ['vbs'], swift: ['swift'], objectivec: ['m', 'mm'], kotlin: ['kt', 'kts'],
};

export const EXTRA_FENCE_ALIASES: Record<ExtraSourceType, readonly string[]> = {
  c: ['c', 'h'], cpp: ['cpp', 'c++', 'cxx', 'cc'], pascal: ['pascal', 'pas', 'delphi'], go: ['go', 'golang'],
  ruby: ['ruby', 'rb'], bash: ['bash', 'sh', 'shell', 'zsh', 'ksh'], csh: ['csh', 'tcsh'],
  powershell: ['powershell', 'pwsh', 'ps1'], batch: ['bat', 'batch', 'cmd', 'dos'], vbscript: ['vbscript', 'vbs', 'vb'],
  swift: ['swift'], objectivec: ['objectivec', 'objective-c', 'objc', 'objective-c++', 'objcpp'], kotlin: ['kotlin', 'kt', 'kts'],
};

export function isExtraSourceType(type: string): type is ExtraSourceType {
  return (EXTRA_SOURCE_TYPES as readonly string[]).includes(type);
}

/** Filename-only detection, shared by browser open/recovery and creation. */
export function extraSourceTypeForName(name: string): ExtraSourceType | undefined {
  const basename = name.split(/[\\/]/).pop() ?? name;
  // Unix C++ extension conventions are case-sensitive; keep these exceptions
  // before ordinary case-insensitive matching. Shared .h headers default to C.
  if (/\.(?:C|H)$/.test(basename)) return 'cpp';
  const lower = basename.toLowerCase();
  if (['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.kshrc'].includes(lower)) return 'bash';
  if (['.cshrc', '.tcshrc', '.login', '.logout'].includes(lower)) return 'csh';
  if (['rakefile', 'gemfile', 'guardfile', 'vagrantfile'].includes(lower)) return 'ruby';
  const extension = lower.split('.').pop() ?? '';
  if (!lower.includes('.')) return undefined;
  return EXTRA_SOURCE_TYPES.find((type) => EXTRA_EXTENSIONS[type].includes(extension));
}

export const extraSamples: Record<ExtraSourceType, { name: string; source: string }> = {
  c: { name: 'Untitled Program.c', source: '#include <stdio.h>\n\nint main(void) {\n    puts("Hello, Yedit!");\n    return 0;\n}\n' },
  cpp: { name: 'Untitled Program.cpp', source: '#include <iostream>\n\nint main() {\n    std::cout << "Hello, Yedit!\\n";\n    return 0;\n}\n' },
  pascal: { name: 'Untitled Program.pas', source: "program Greeting;\n\nbegin\n  WriteLn('Hello, Yedit!');\nend.\n" },
  go: { name: 'Untitled Program.go', source: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, Yedit!")\n}\n' },
  ruby: { name: 'Untitled Script.rb', source: 'def greet(name)\n  "Hello, #{name}!"\nend\n\nputs greet("Yedit")\n' },
  bash: { name: 'Untitled Script.sh', source: '#!/usr/bin/env bash\n\ngreet() {\n  printf "Hello, %s!\\n" "$1"\n}\n\ngreet "Yedit"\n' },
  csh: { name: 'Untitled Script.csh', source: '#!/bin/csh\n\nset names = (Yedit)\nforeach name ($names)\n  echo "Hello, $name!"\nend\n' },
  powershell: { name: 'Untitled Script.ps1', source: 'function Get-Greeting {\n    param([string]$Name)\n    "Hello, $Name!"\n}\n\nGet-Greeting -Name "Yedit"\n' },
  batch: { name: 'Untitled Script.bat', source: '@echo off\nsetlocal\ncall :greet Yedit\nexit /b\n\n:greet\necho Hello, %~1!\nexit /b\n' },
  vbscript: { name: 'Untitled Script.vbs', source: 'Option Explicit\n\nFunction Greet(name)\n    Greet = "Hello, " & name & "!"\nEnd Function\n\nWScript.Echo Greet("Yedit")\n' },
  swift: { name: 'Untitled Program.swift', source: 'func greet(_ name: String) -> String {\n    return "Hello, \\(name)!"\n}\n\nprint(greet("Yedit"))\n' },
  objectivec: { name: 'Untitled Program.m', source: '#import <Foundation/Foundation.h>\n\nint main(int argc, const char *argv[]) {\n    @autoreleasepool {\n        NSLog(@"Hello, Yedit!");\n    }\n    return 0;\n}\n' },
  kotlin: { name: 'Untitled Program.kt', source: 'fun greet(name: String): String = "Hello, $name!"\n\nfun main() {\n    println(greet("Yedit"))\n}\n' },
};

type Example = { title: string; source: string; description: string };
const examples: Record<ExtraSourceType, Example[]> = {
  c: [
    { title: 'Function', source: 'int add(int left, int right) {\n    return left + right;\n}', description: 'A typed C function with an explicit result.' },
    { title: 'Struct', source: 'struct Point {\n    double x;\n    double y;\n};', description: 'A plain C data structure.' },
  ],
  cpp: [
    { title: 'Function', source: 'int add(int left, int right) {\n    return left + right;\n}', description: 'A typed C++ function.' },
    { title: 'Class', source: 'class Greeting {\npublic:\n    void greet() const;\n};', description: 'A class with an explicit public interface.' },
  ],
  pascal: [
    { title: 'Procedure', source: "procedure Greet;\nbegin\n  WriteLn('Hello');\nend;", description: 'A Pascal procedure delimited by begin and end.' },
    { title: 'Function', source: 'function Add(Left, Right: Integer): Integer;\nbegin\n  Add := Left + Right;\nend;', description: 'A portable Pascal function returning a typed value.' },
  ],
  go: [
    { title: 'Function', source: 'func add(left, right int) int {\n\treturn left + right\n}', description: 'A Go function with explicit parameter and result types.' },
    { title: 'Struct', source: 'type Point struct {\n\tX float64\n\tY float64\n}', description: 'A named Go structure with exported fields.' },
  ],
  ruby: [
    { title: 'Method', source: 'def greet(name)\n  "Hello, #{name}!"\nend', description: 'A Ruby method with string interpolation.' },
    { title: 'Each loop', source: 'items.each do |item|\n  puts item\nend', description: 'Iterates a collection without a manual index.' },
  ],
  bash: [
    { title: 'Function', source: 'greet() {\n  printf "Hello, %s!\\n" "$1"\n}', description: 'A shell function that quotes its argument.' },
    { title: 'For loop', source: 'for item in "${items[@]}"; do\n  printf "%s\\n" "$item"\ndone', description: 'A Bash array loop preserving spaces in each item.' },
  ],
  csh: [
    { title: 'Foreach loop', source: 'foreach item ($items)\n  echo "$item"\nend', description: 'C shell collection iteration; this is not Bash syntax.' },
    { title: 'Conditional', source: 'if ( $?name ) then\n  echo "$name"\nendif', description: 'Tests whether a C shell variable exists.' },
  ],
  powershell: [
    { title: 'Function', source: 'function Get-Greeting {\n    param([string]$Name)\n    "Hello, $Name!"\n}', description: 'A PowerShell function with a named parameter.' },
    { title: 'Pipeline', source: '$items | ForEach-Object {\n    Write-Output $_\n}', description: 'Processes objects, not shell-split strings.' },
  ],
  batch: [
    { title: 'Subroutine', source: 'call :greet Yedit\nexit /b\n\n:greet\necho Hello, %~1!\nexit /b', description: 'A Windows batch label called as a subroutine.' },
    { title: 'Local variables', source: 'setlocal\nset "name=Yedit"\necho Hello, %name%!\nendlocal', description: 'Scopes variables to the current batch file.' },
  ],
  vbscript: [
    { title: 'Function', source: 'Function Greet(name)\n    Greet = "Hello, " & name\nEnd Function', description: 'A VBScript function assigns its return value to its own name.' },
    { title: 'Subroutine', source: 'Sub Greet(name)\n    WScript.Echo "Hello, " & name\nEnd Sub', description: 'A Windows Script Host subroutine, without executing it in Yedit.' },
  ],
  swift: [
    { title: 'Function', source: 'func greet(_ name: String) -> String {\n    return "Hello, \\(name)!"\n}', description: 'A Swift function with a typed return value.' },
    { title: 'Struct', source: 'struct Point {\n    var x: Double\n    var y: Double\n}', description: 'A Swift value type.' },
  ],
  objectivec: [
    { title: 'Interface', source: '@interface Greeting : NSObject\n- (NSString *)greet:(NSString *)name;\n@end', description: 'An Objective-C object interface. Import Foundation in the file.' },
    { title: 'Method', source: '- (NSString *)greet:(NSString *)name {\n    return [NSString stringWithFormat:@"Hello, %@!", name];\n}', description: 'An Objective-C instance method.' },
  ],
  kotlin: [
    { title: 'Function', source: 'fun greet(name: String): String {\n    return "Hello, $name!"\n}', description: 'A Kotlin function with an explicit return type.' },
    { title: 'Data class', source: 'data class Point(val x: Double, val y: Double)', description: 'A Kotlin data class with immutable constructor properties.' },
  ],
};

export const extraReferences = Object.fromEntries(EXTRA_SOURCE_TYPES.map((type) => [type, examples[type].map((example, index): ReferenceEntry => ({
  id: `${type}-${index}`, title: example.title, category: 'Language basics', tags: [type, example.title.toLowerCase()],
  syntax: example.source, description: example.description, example: example.source, insertText: example.source,
}))])) as Record<ExtraSourceType, ReferenceEntry[]>;

/** Small declaration outline, not a compiler or semantic language server. */
export function extraDeclaration(type: ExtraSourceType, line: string): { name: string; group: boolean } | undefined {
  // Minified/generated lines are not useful outline headings. Bound regex work
  // so opening a long source line cannot stall navigation on each keystroke.
  if (line.length > 4096) return undefined;
  let match: RegExpExecArray | null = null;
  if (type === 'c' || type === 'cpp' || type === 'objectivec') {
    match = /^\s*(?:(?:typedef|enum)\s+)*(?:class|struct|union|enum|namespace)\s+([A-Za-z_]\w*)/.exec(line);
    if (match) return { name: match[1], group: true };
    if (type === 'objectivec') {
      match = /^\s*@(?:interface|implementation|protocol)\s+([A-Za-z_]\w*)/.exec(line);
      if (match) return { name: match[1], group: true };
      match = /^\s*[-+]\s*\([^)]*\)\s*([A-Za-z_]\w*)/.exec(line);
      if (match) return { name: match[1], group: false };
    }
    match = /^\s*(?:[A-Za-z_]\w*(?:::\w+)*(?:\s*<[^;{}]+>)?[\s*&]+)+([A-Za-z_]\w*(?:::\w+)*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/.exec(line);
  } else if (type === 'pascal') match = /^\s*(?:program|unit|procedure|function|constructor|destructor)\s+([A-Za-z_]\w*(?:\.\w+)*)/i.exec(line);
  else if (type === 'go') {
    match = /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/.exec(line);
    if (match) return { name: match[1], group: true };
    match = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/.exec(line);
  } else if (type === 'ruby') {
    match = /^\s*(?:class|module)\s+([A-Za-z_]\w*(?:::\w+)*)/.exec(line);
    if (match) return { name: match[1], group: true };
    match = /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/.exec(line);
  } else if (type === 'bash') match = /^\s*(?:function\s+([A-Za-z_]\w*)\s*(?:\(\))?|([A-Za-z_]\w*)\s*\(\))\s*\{?/.exec(line);
  else if (type === 'csh') match = /^\s*alias\s+([A-Za-z_]\w*)/.exec(line);
  else if (type === 'powershell') {
    match = /^\s*(?:class|enum)\s+([A-Za-z_]\w*)/i.exec(line);
    if (match) return { name: match[1], group: true };
    match = /^\s*(?:function|filter|workflow)\s+(?:[\w]+:)?([A-Za-z_][\w-]*)/i.exec(line);
  } else if (type === 'batch') match = /^\s*:(?!:)([A-Za-z_][\w.-]*)/.exec(line);
  else if (type === 'vbscript') {
    match = /^\s*(?:(?:public|private|default)\s+)?class\s+([A-Za-z_]\w*)/i.exec(line);
    if (match) return { name: match[1], group: true };
    match = /^\s*(?:(?:public|private|default)\s+)*(?:sub|function|property\s+(?:get|let|set))\s+([A-Za-z_]\w*)/i.exec(line);
  } else if (type === 'swift' || type === 'kotlin') {
    match = /^\s*(?:(?:public|private|internal|open|final|data|sealed|abstract|enum|indirect|actor)\s+)*(?:class|struct|enum|protocol|interface|object|extension)\s+([A-Za-z_]\w*)/.exec(line);
    if (match) return { name: match[1], group: true };
    match = type === 'swift'
      ? /^\s*(?:(?:public|private|internal|static|class|override|mutating|nonmutating|final)\s+)*func\s+([A-Za-z_]\w*)\s*(?:<[^>]+>)?\s*\(/.exec(line)
      : /^\s*(?:(?:public|private|internal|protected|override|suspend|inline|tailrec|operator|infix|open|final)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/.exec(line);
  }
  return match ? { name: match[1] || match[2], group: false } : undefined;
}
