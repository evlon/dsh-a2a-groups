#!/usr/bin/env node
// Install the DSH Web adapter into opencli's user adapter directory.
//
// opencli loads adapters from `~/.opencli/clis/<site>/`, so "installing" is copying these four files there and
// restarting the daemon (modules are read once at startup). Keeping the sources in this repository means the adapter is
// versioned with the thing it tests — which matters, because its selectors encode this UI's structure.
//
// Usage:
//   node scripts/install-opencli-adapter.mjs            copy and restart the daemon
//   node scripts/install-opencli-adapter.mjs --check    report whether the installed copy matches this one
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = join(import.meta.dirname, '..', 'opencli-adapter');
const target = join(homedir(), '.opencli', 'clis', 'dsh');
const checkOnly = process.argv.includes('--check');

if (!existsSync(source)) {
  console.error(`adapter sources not found at ${source}`);
  process.exit(1);
}

const files = readdirSync(source).filter((name) => name.endsWith('.js'));
if (files.length === 0) {
  console.error(`no .js files in ${source}`);
  process.exit(1);
}

if (checkOnly) {
  let drifted = 0;
  for (const name of files) {
    const from = join(source, name);
    const to = join(target, name);
    if (!existsSync(to)) {
      console.log(`missing  ${name}`);
      drifted += 1;
      continue;
    }
    if (readFileSync(from, 'utf8') !== readFileSync(to, 'utf8')) {
      console.log(`differs  ${name}`);
      drifted += 1;
    }
  }
  console.log(drifted === 0 ? 'installed copy matches this repository' : `${drifted} file(s) differ — run without --check to install`);
  process.exit(drifted === 0 ? 0 : 1);
}

mkdirSync(target, { recursive: true });
for (const name of files) {
  copyFileSync(join(source, name), join(target, name));
  console.log(`installed ${name}`);
}

// The daemon reads adapter modules once, at startup; without this an edit has no effect until the next reboot.
try {
  execFileSync('opencli', ['daemon', 'restart'], { stdio: 'inherit', shell: true });
} catch (error) {
  console.warn(`could not restart the opencli daemon: ${String((error && error.message) || error)}`);
  console.warn('run `opencli daemon restart` yourself, or the old modules stay loaded.');
}

console.log('');
console.log('verify with:');
console.log('  opencli dsh open --port <port> --home <DSH_HOME> -f json');
console.log('  opencli dsh read --last 5 -f json');
