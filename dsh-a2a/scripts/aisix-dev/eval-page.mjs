// Run an expression in the opencli browser session, reading the expression from a file.
//
// Passing JavaScript through `cmd.exe /c` mangles quotes at roughly the third level of
// nesting. A file sidesteps the whole class of problem.
//
//   node scripts/aisix-dev/eval-page.mjs <session> <exprFile>
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const session = process.argv[2] ?? 'shot4';
const exprFile = process.argv[3];
if (exprFile === undefined) throw new Error('usage: eval-page.mjs <session> <exprFile>');

const expression = readFileSync(exprFile, 'utf8').trim();
const output = execFileSync('cmd.exe', ['/c', 'opencli', 'browser', session, 'eval', expression], {
  encoding: 'utf8',
  timeout: 120_000,
});
process.stdout.write(output);
