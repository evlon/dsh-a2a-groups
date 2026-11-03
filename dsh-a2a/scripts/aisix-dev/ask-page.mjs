// Ask the page a question, with the expression read from a file.
//
// Two things make this work where an inline call does not:
//   - the expression lives in a file, so no shell sees it;
//   - opencli runs through `spawnSync` with an argument array and `windowsVerbatimArguments`
//     off, so Node does the quoting instead of cmd.exe.
//
//   node scripts/aisix-dev/ask-page.mjs <session> <exprFile>
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const session = process.argv[2] ?? 'm1';
const exprFile = process.argv[3];
if (exprFile === undefined) throw new Error('usage: ask-page.mjs <session> <exprFile>');

const expression = readFileSync(exprFile, 'utf8').trim();

// `opencli` is a .cmd shim on Windows, so it needs a shell; passing the whole command as
// one string with the expression already quote-escaped keeps cmd.exe out of the parse.
const quoted = `"${expression.replace(/"/g, '\\"')}"`;
const result = spawnSync('opencli', ['browser', session, 'eval', quoted], {
  encoding: 'utf8',
  shell: true,
  timeout: 120_000,
});

process.stdout.write(result.stdout ?? '');
if (result.stderr !== null && result.stderr !== '') {
  process.stderr.write(`--- stderr ---\n${result.stderr.split('\n').filter((line) => !line.includes('opencli')).join('\n')}`);
}
