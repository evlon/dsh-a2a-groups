#!/usr/bin/env node
/**
 * Publish a package AND its whole dependency tree to the internal Verdaccio, or repair a
 * profile's tree.
 *
 * WHY THIS EXISTS
 *
 * Most colleagues cannot reach the public registry: the company firewall blocks outbound npm,
 * and only special means get around it. So the internal registry is not a convenience — for them
 * it is the only way to install anything.
 *
 * The internal registry has no uplink to npm, which means publishing OUR package there is not
 * enough. `dsh plugin add <pkg> --registry=<internal>` makes pnpm resolve the ENTIRE profile
 * against that registry, so one missing transitive package becomes
 *
 *   ERR_PNPM_FETCH_404  GET http://registry.ict.cmcc/dsh-plugin: Not Found
 *
 * — and the failure names a package the publishing developer never heard of.
 *
 * WHY `npm install --package-lock-only`
 *
 * "Which concrete version satisfies ^5.3.0 for this tree" is a semver solver. Reusing npm's own
 * lockfile resolver means the versions pushed are the ones a consumer would actually get, without
 * this script shipping a second, subtly different implementation.
 *
 * WHAT IT DOES NOT DO
 *
 * It publishes third-party packages under their own names into our PRIVATE registry — ordinary
 * private-registry mirroring, not a claim of ownership — and never touches the public registry
 * except to download tarballs.
 *
 * USAGE
 *
 *   # one package + its tree
 *   node scripts/publish-internal.mjs dsh-a2a-groups@0.1.31
 *
 *   # audit a profile against the internal registry (read-only)
 *   node scripts/publish-internal.mjs --profile "$DSH_HOME/profiles/web"
 *
 *   # repair it: publish everything that profile needs and the registry lacks
 *   node scripts/publish-internal.mjs --profile "$DSH_HOME/profiles/web" --fix
 *
 *   # flags
 *   --dry-run       计划，不发布
 *   --verify-only   只检查，不发布（等于 --profile 的只读模式）
 *   --allow-failures 即使有失败也返回 0（用于批量补历史依赖）
 *
 * EXIT: 0 when everything asked for is present internally afterwards.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const onWindows = process.platform === 'win32';
const PUBLIC_REGISTRY = process.env.PUBLIC_REGISTRY ?? 'https://registry.npmjs.org';
const INTERNAL_REGISTRY = process.env.INTERNAL_REGISTRY ?? 'http://registry.ict.cmcc';
const npm = onWindows ? 'npm.cmd' : 'npm';

/** Quote one argument for cmd.exe. */
function quoteArg(value) {
  const text = String(value);
  return /[\s"]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/**
 * Run a command, returning combined output; throws with the output on failure.
 *
 * Goes through cmd.exe explicitly rather than `execFileSync({ shell: true })`: on Windows the
 * shell form leaves a handle that libuv asserts about during exit, turning a good run into exit
 * code 1.
 */
function run(command, args, options = {}) {
  const line = [command, ...args.map(quoteArg)].join(' ');
  const result = onWindows
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', line], { encoding: 'utf8', ...options })
    : spawnSync(command, args, { encoding: 'utf8', ...options });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    const error = new Error(`${line} failed (exit ${result.status}):\n${output.trim()}`);
    error.output = output;
    throw error;
  }
  return output;
}

/** Parse argv into a spec plus flags. */
function parseArgs(argv) {
  const flags = { dryRun: false, verifyOnly: false, fix: false, profile: undefined, allowFailures: false };
  let spec;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--verify-only') flags.verifyOnly = true;
    else if (arg === '--fix') flags.fix = true;
    else if (arg === '--allow-failures') flags.allowFailures = true;
    else if (arg === '--profile') {
      flags.profile = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    else spec = arg;
  }
  if (spec === undefined && flags.profile === undefined) {
    throw new Error('usage: publish-internal.mjs <name@version> [flags] | --profile <dir> [--fix]');
  }
  return { spec, flags };
}

/**
 * Resolve the exact production dependency tree of `spec` into name@version pairs.
 *
 * `--package-lock-only` writes a lockfile without populating node_modules, and `--omit=dev` keeps
 * the package's own devDependencies out — those are not needed to RUN it, and mirroring them would
 * push hundreds of unrelated packages.
 */
function resolveTree(spec) {
  const work = mkdtempSync(join(tmpdir(), 'publish-internal-resolve-'));
  try {
    run(npm, [
      'install',
      '--package-lock-only',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--prefix', work,
      '--registry', PUBLIC_REGISTRY,
      spec,
    ]);
    const lock = JSON.parse(readFileSync(join(work, 'package-lock.json'), 'utf8'));
    const packages = [];
    for (const [key, meta] of Object.entries(lock.packages ?? {})) {
      if (key === '') continue; // the root entry describes the requested package itself
      const name = meta.name ?? key.replace(/^.*node_modules\//u, '');
      const version = meta.version;
      if (typeof name !== 'string' || typeof version !== 'string') continue;
      packages.push({ name, version });
    }
    return packages;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Whether the internal registry can serve one exact version. */
async function hasInternally(name, version) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name;
  try {
    const response = await fetch(`${INTERNAL_REGISTRY}/${encoded}/${version}`, { signal: AbortSignal.timeout(20000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Every version the internal registry already has for one package. */
async function internalVersions(name) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name;
  try {
    const response = await fetch(`${INTERNAL_REGISTRY}/${encoded}`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) return [];
    const body = await response.json();
    return Object.keys(body.versions ?? {});
  } catch {
    return [];
  }
}

/**
 * Pick a dist-tag that cannot damage `latest`.
 *
 * Two cases need one: a prerelease cannot carry `latest`, and a version older than what the
 * registry already serves must not claim to be current.
 */
function tagFor(version, existing) {
  const prerelease = /-(.+)$/u.exec(version);
  if (prerelease !== null) return prerelease[1].split('.')[0];
  if (existing.length === 0) return undefined;
  const toNumbers = (value) => value.split('-')[0].split('.').map(Number);
  const highest = existing
    .map(toNumbers)
    .sort((left, right) => (right[0] - left[0]) || (right[1] - left[1]) || (right[2] - left[2]))[0];
  const current = toNumbers(version);
  const delta = (current[0] - highest[0]) || (current[1] - highest[1]) || (current[2] - highest[2]);
  return delta < 0 ? `legacy-${version}` : undefined;
}

/**
 * Download one tarball from the public registry.
 *
 * Packs into a FRESH subdirectory per package. Sharing one directory made `readdir` return the
 * previous package's tarball — the run then published hono's tarball under undici's name, and the
 * only evidence was a failure message naming the wrong file. A per-package directory makes that
 * class of mistake impossible rather than merely unlikely.
 */
function pack(name, version, root) {
  const work = mkdtempSync(join(root, 'pack-'));
  run(npm, ['pack', `${name}@${version}`, '--registry', PUBLIC_REGISTRY], { cwd: work });
  const tarballs = readdirSync(work).filter((entry) => entry.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`npm pack for ${name}@${version} produced ${tarballs.length} tarballs, expected 1`);
  }
  return join(work, tarballs[0]);
}

/** Publish one tarball internally, optionally under an explicit tag. */
function publish(tarball, tag) {
  // --provenance=false is required, not optional: some upstream packages set
  // publishConfig.provenance, and npm then refuses with
  //   EUSAGE Automatic provenance generation not supported for provider: null
  // against a registry that cannot mint a sigstore attestation. Our own package gets its
  // provenance from GitHub Actions on the PUBLIC registry, which is where it matters.
  const args = ['publish', tarball, '--registry', INTERNAL_REGISTRY, '--access', 'public', '--provenance=false'];
  if (tag !== undefined) args.push('--tag', tag);
  return run(npm, args);
}

/** Read a pnpm lockfile into name@version pairs (peer context stripped). */
function profilePackages(lockPath) {
  const text = readFileSync(lockPath, 'utf8');
  const found = new Map();
  for (const match of text.matchAll(/^ {2}'?([@a-z0-9][^':]*?)'?:\s*$/gmu)) {
    // pnpm writes peer context as a suffix: name@1.2.3(peer@4.5.6). Strip it BEFORE splitting on
    // the last @, or the peer's version is mistaken for this package's.
    const clean = match[1].split('(')[0];
    if (!clean.includes('@')) continue;
    const at = clean.lastIndexOf('@');
    const name = clean.slice(0, at);
    const version = clean.slice(at + 1);
    if (!name || !/^\d/u.test(version)) continue;
    found.set(`${name}@${version}`, { name, version });
  }
  return [...found.values()];
}

/** Publish every package in `list` that the internal registry lacks, and report a summary. */
async function mirror(list, flags) {
  const work = mkdtempSync(join(tmpdir(), 'publish-internal-work-'));
  const summary = { published: [], alreadyThere: [], failed: [], wouldPublish: [] };
  try {
    for (const item of list) {
      const label = `${item.name}@${item.version}`;
      if (await hasInternally(item.name, item.version)) {
        // Idempotent on purpose: re-running a release must not fail because the tree is mirrored.
        summary.alreadyThere.push(label);
        continue;
      }
      if (flags.verifyOnly) { summary.failed.push(`${label}（缺失）`); continue; }
      if (flags.dryRun) { summary.wouldPublish.push(label); continue; }
      try {
        const existing = await internalVersions(item.name);
        const tag = tagFor(item.version, existing);
        const tarball = pack(item.name, item.version, work);
        publish(tarball, tag);
        rmSync(tarball, { force: true });
        if (!(await hasInternally(item.name, item.version))) throw new Error('发布后仍查不到该版本');
        summary.published.push(label);
        console.log(`  ✓ ${label}${tag === undefined ? '' : `  [${tag}]`}`);
      } catch (error) {
        summary.failed.push(`${label}: ${String(error.message).split('\n').slice(-8).join(' | ')}`);
        console.log(`  ✗ ${label} — ${String(error.message).split('\n').slice(-8).join(' | ')}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return summary;
}

/** Print a summary and map it to an exit code. */
function report(summary, flags, { profileMode }) {
  console.log('');
  console.log(`已存在   : ${summary.alreadyThere.length}`);
  console.log(`本次发布 : ${summary.published.length}`);
  if (flags.dryRun) console.log(`待发布   : ${summary.wouldPublish.length}`);
  for (const item of summary.wouldPublish) console.log(`  · ${item}`);
  console.log(`失败     : ${summary.failed.length}`);
  for (const item of summary.failed) console.log(`  ✗ ${item}`);
  if (profileMode && summary.failed.length === 0 && summary.wouldPublish.length === 0) {
    console.log('');
    console.log('内网源可以完整支撑这个 profile。');
  }
  return summary.failed.length > 0 && !flags.allowFailures ? 1 : 0;
}

async function main() {
  const { spec, flags } = parseArgs(process.argv.slice(2));

  // --- profile mode -----------------------------------------------------------------------
  if (flags.profile !== undefined) {
    const packages = profilePackages(join(flags.profile, 'pnpm-lock.yaml'));
    console.log(`profile ${flags.profile}`);
    console.log(`  依赖总数 ${packages.length}`);
    const summary = await mirror(packages, flags);
    return report(summary, flags, { profileMode: true });
  }

  // --- single package mode ----------------------------------------------------------------
  const at = spec.lastIndexOf('@');
  if (at <= 0) throw new Error(`expected name@version, got ${spec}`);
  console.log(`解析 ${spec} 的依赖树（官方源 ${PUBLIC_REGISTRY}）…`);
  const tree = resolveTree(spec);
  console.log(`依赖树共 ${tree.length} 个包（含自身）`);
  const summary = await mirror(tree, flags);
  return report(summary, flags, { profileMode: false });
}

// Setting exitCode and letting the process drain, rather than calling process.exit(): on Windows,
// exiting while child pipes and undici sockets are still closing trips a libuv assertion
// (uv_async, "!(handle->flags & UV_HANDLE_CLOSING)") that reports failure for a run which in fact
// succeeded.
process.exitCode = await main();
