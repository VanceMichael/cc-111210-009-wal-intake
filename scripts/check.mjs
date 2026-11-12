import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) await walk(path);
    else if (path.endsWith('.mjs')) { const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' }); if (result.status) process.exit(result.status); }
  }
}
for (const directory of ['src', 'fixtures', 'test']) await walk(directory);
console.log('源码语法检查通过');
