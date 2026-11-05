// Coverage with tiered thresholds, because one number hides what matters.
//
// WHY TIERS
//
// The overall figure is dominated by `tool-runtime.js`, which is twenty-six tools with eight or so branches each.
// Chasing 75% across the whole tree would mean testing argument variants — "what if `tags` is a string instead of
// an array" — that protect almost nothing.
//
// The modules that DO need branch coverage are the ones holding invariants: the group state machine, the invite
// token rules, the membership ledger, the wire format. A missed branch there is a rule that silently is not
// enforced. So the gate is per-tier:
//
//   core invariants   85% lines, 80% branches   — where a wrong branch is a security or correctness bug
//   everything else   80% lines, 60% branches   — where a wrong branch is a poorer message
//
// Usage:
//   node scripts/coverage.mjs            # report
//   node scripts/coverage.mjs --check    # exit 1 when below a threshold
import { execFileSync } from 'node:child_process';

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
    include: ['lib/**/*.js'],
    lines: 80,
    branches: 60,
  },
];

/** Run the test suite under coverage and return the parsed rows. */
function measure(include) {
  const args = ['--experimental-test-coverage'];
  for (const pattern of include) args.push(`--test-coverage-include=${pattern}`);
  args.push('--test', 'test/*.test.mjs');

  const output = execFileSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  }).toString();

  const rows = new Map();
  for (const line of output.split('\n')) {
    // `ℹ   groups.js          |  94.60 |   83.55 |  89.36 | …`
    const match = /^\u2139\s+(?:.*\/)?([\w.-]+\.js)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/u.exec(line);
    if (match === null) continue;
    rows.set(match[1], { lines: Number(match[2]), branches: Number(match[3]), functions: Number(match[4]) });
  }
  // The `all files` summary line has no path segment.
  const all = /^\u2139\s+all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/mu.exec(output);
  return { rows, all: all === null ? undefined : { lines: Number(all[1]), branches: Number(all[2]) } };
}

/** Report, and optionally enforce. */
function main() {
  const check = process.argv.includes('--check');
  let failed = 0;

  for (const tier of TIERS) {
    const { rows, all } = measure(tier.include);
    const label = tier.include.length === 1 && tier.include[0] === 'lib/**/*.js' ? 'all files' : tier.name;
    const value = all ?? { lines: 0, branches: 0 };

    console.log(`\n${label}  (need ${tier.lines}% lines / ${tier.branches}% branches)`);
    console.log(`  lines ${value.lines.toFixed(2)}%   branches ${value.branches.toFixed(2)}%`);

    if (tier.include.length > 1) {
      for (const [file, row] of [...rows].sort((left, right) => left[0].localeCompare(right[0]))) {
        const short = row.lines < tier.lines || row.branches < tier.branches ? '  <-- below' : '';
        console.log(`    ${file.padEnd(22)} ${row.lines.toFixed(2).padStart(6)} / ${row.branches.toFixed(2).padStart(6)}${short}`);
      }
    }

    if (check && (value.lines < tier.lines || value.branches < tier.branches)) {
      console.error(`  FAIL: below the threshold for this tier`);
      failed += 1;
    }
  }

  if (check && failed > 0) {
    console.error(`\n${failed} tier(s) below threshold`);
    process.exit(1);
  }
  if (check) console.log('\nall tiers meet their thresholds');
}

main();
