// Coverage with tiered thresholds, because one number hides what matters.
//
// WHY TIERS
//
// The overall figure is dominated by `tool-runtime.js` — twenty-seven tools with eight or so branches each. Chasing a
// single high branch number across the whole tree would mean testing argument variants ("what if `tags` is a string
// instead of an array") that protect almost nothing.
//
// The modules that DO need branch coverage are the ones holding invariants: the group state machine, the invite token
// rules, the membership ledger, the wire format. A missed branch there is a rule that is silently not enforced. So the
// gate is per-tier:
//
//   core invariants   85% lines, 75% branches
//   everything else   80% lines, 60% branches
//
// Usage:
//   node scripts/coverage.mjs            # report
//   node scripts/coverage.mjs --check    # exit 1 when below a threshold
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));

/** Files that hold an invariant, and the levels they must reach. */
const TIERS = [
  {
    name: 'core invariants',
    include: [
      'lib/core/groups.js',
      'lib/core/bridge.js',
      'lib/core/invite.js',
      'lib/core/memberships.js',
      'lib/core/wire.js',
      'lib/core/server.js',
    ],
    lines: 85,
    branches: 75,
  },
  {
    name: 'everything else',
    // The whole tree, minus two kinds of file that cannot be meaningfully unit-tested and are not where a missed
    // branch hides a bug:
    //
    //   lib/index.js        the plugin assembly. Its body is wiring: build these objects, register these routes,
    //                       subscribe these events. A test that "covers" it would assert that the wiring was written
    //                       the way it was written — the real check is the live instances.
    //   lib/shared/tool-specs.js  a declaration table. Its correctness is that the runtime has a handler per name,
    //                       which is asserted directly, and counting thousands of JSON-literal lines as covered code
    //                       distorts the number without saying anything about behaviour.
    //
    // Both are still exercised end to end; they are simply not scored, and the exclusion is named here rather than
    // silently narrowing the glob.
    include: ['lib/**/*.js'],
    exclude: ['lib/index.js', 'lib/shared/tool-specs.js'],
    lines: 80,
    branches: 60,
  },
];

/**
 * Run the suite under coverage and parse the reporter's table.
 *
 * Vitest's text reporter emits `File | % Stmts | % Branch | % Funcs | % Lines | Uncovered`. Columns are read
 * POSITIONALLY and in THAT order: reading them as the old node runner's order silently compares branch coverage
 * against statement coverage, which looks plausible and is wrong.
 *
 * @param {string[]} include - coverage include globs.
 * @returns {{rows: Map<string, object>, all: object|undefined}} parsed coverage.
 */
function measure(include, exclude = []) {
  // Vitest's own entry script, invoked with this node binary.
  //
  // `npx.cmd` cannot be spawned by execFileSync on Windows (EINVAL): a .cmd is not an executable, it needs a shell, and
  // using a shell to interpolate arguments is how quoting bugs get in. Calling the real .mjs file sidesteps both.
  const args = [
    RUNNER,
    'run',
    '--coverage',
    '--coverage.reporter=text',
    ...include.map((pattern) => `--coverage.include=${pattern}`),
    ...exclude.map((pattern) => `--coverage.exclude=${pattern}`),
  ];

  const output = execFileSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    cwd: ROOT,
  }).toString();

  const rows = new Map();
  for (const line of output.split('\n')) {
    const match = /^\s*([\w.-]+\.js)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s*\|/u.exec(line);
    if (match === null) continue;
    rows.set(match[1], {
      statements: Number(match[2]),
      branches: Number(match[3]),
      functions: Number(match[4]),
      lines: Number(match[5]),
    });
  }

  const all = /^\s*All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s*\|/mu.exec(output);
  return {
    rows,
    all: all === null
      ? undefined
      : { statements: Number(all[1]), branches: Number(all[2]), functions: Number(all[3]), lines: Number(all[4]) },
  };
}

/** Report, and optionally enforce. */
function main() {
  const check = process.argv.includes('--check');
  let failed = 0;

  for (const tier of TIERS) {
    const { rows, all } = measure(tier.include, tier.exclude ?? []);
    const isWholeTree = tier.include.length === 1 && tier.include[0] === 'lib/**/*.js';
    const label = isWholeTree ? 'all files' : tier.name;
    const value = all ?? { lines: 0, branches: 0 };

    console.log(`\n${label}  (need ${tier.lines}% lines / ${tier.branches}% branches)`);
    console.log(`  lines ${value.lines.toFixed(2)}%   branches ${value.branches.toFixed(2)}%`);

    if (!isWholeTree) {
      for (const [file, row] of [...rows].sort((left, right) => left[0].localeCompare(right[0]))) {
        const below = row.lines < tier.lines || row.branches < tier.branches ? '  <-- below' : '';
        console.log(`    ${file.padEnd(22)} ${row.lines.toFixed(2).padStart(6)} / ${row.branches.toFixed(2).padStart(6)}${below}`);
      }
    }

    // A tier that measures nothing is a broken gate, not a passing one. Without this, a runner change that produced no
    // table would report 0.00% and could pass a mis-specified comparison while measuring nothing at all.
    if (rows.size === 0) {
      console.error('  FAIL: no coverage table parsed; the runner output shape changed');
      failed += 1;
      continue;
    }

    if (check && (value.lines < tier.lines || value.branches < tier.branches)) {
      console.error('  FAIL: below the threshold for this tier');
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} tier(s) below threshold`);
    process.exit(1);
  }
  if (check) console.log('\nall tiers meet their thresholds');
}

main();
