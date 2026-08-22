const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const destination = path.join(root, 'public', 'vs');

fs.cpSync(source, destination, { recursive: true, force: true });
