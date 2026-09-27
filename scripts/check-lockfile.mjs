#!/usr/bin/env node
/**
 * Lockfile reproducibility checks for the Mimir Telegram bot.
 *
 * The bot is a read-only long-running process: deployments rebuild from the
 * committed `package-lock.json` with `npm ci`, so a lockfile that quietly drifts
 * from `package.json` (or that resolves through a mutable URL) is an operational
 * risk. This module verifies the lockfile two ways:
 *
 *   1. Consistency (always, offline): the lockfile is `lockfileVersion` 3, its
 *      root entry matches `package.json`'s dependency ranges exactly, every
 *      package resolves to a `registry.npmjs.org` tarball with a `sha512`
 *      integrity hash, and every direct dependency is pinned at the top level.
 *   2. Regeneration (`--reproduce`): asks npm to rewrite the lockfile from
 *      itself in a scratch directory and fails if the resolved package set
 *      changes. The repository working tree is never written to.
 *
 * Usage:
 *   node scripts/check-lockfile.mjs [--reproduce] [--json] [--root=DIR]
 *
 * Exit code 0 when every enabled check passes, 1 otherwise.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const LOCKFILE_VERSION = 3;
export const REGISTRY = "https://registry.npmjs.org/";
const MAX_REPORTED = 20;

const USAGE = `Usage: node scripts/check-lockfile.mjs [--reproduce] [--json] [--root=DIR]

  --reproduce   also regenerate the lockfile with npm and compare the package set
  --json        print the full report as JSON
  --root=DIR    check DIR instead of the current working directory`;

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortObject(value[key]);
    return out;
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(sortObject(value ?? null));
}

function compareRanges(label, expected, actual, problems) {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const name of [...names].sort()) {
    if (!(name in actual)) {
      problems.push(
        `${label}.${name}: declared in package.json but missing from the lockfile root entry`,
      );
    } else if (!(name in expected)) {
      problems.push(
        `${label}.${name}: present in the lockfile root entry but not in package.json`,
      );
    } else if (expected[name] !== actual[name]) {
      problems.push(
        `${label}.${name}: range drift (package.json ${JSON.stringify(
          expected[name],
        )} vs lockfile ${JSON.stringify(actual[name])})`,
      );
    }
  }
}

/**
 * Pure consistency check. Accepts already-parsed documents so it can be unit
 * tested without touching the filesystem.
 *
 * @param {object} pkg parsed package.json
 * @param {object} lock parsed package-lock.json
 * @returns {{ok: boolean, problems: string[], stats: {packages: number, pinned: number, direct: number}}}
 */
export function checkLockfile(pkg, lock) {
  const emptyStats = { packages: 0, pinned: 0, direct: 0 };
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    return { ok: false, problems: ["package.json is not an object"], stats: emptyStats };
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    return { ok: false, problems: ["package-lock.json is not an object"], stats: emptyStats };
  }

  const problems = [];

  if (lock.lockfileVersion !== LOCKFILE_VERSION) {
    problems.push(
      `lockfileVersion is ${JSON.stringify(
        lock.lockfileVersion,
      )}, expected ${LOCKFILE_VERSION}`,
    );
  }
  if (lock.name !== pkg.name) {
    problems.push(
      `lockfile name ${JSON.stringify(lock.name)} does not match package.json name ${JSON.stringify(
        pkg.name,
      )}`,
    );
  }
  if (lock.version !== pkg.version) {
    problems.push(
      `lockfile version ${JSON.stringify(
        lock.version,
      )} does not match package.json version ${JSON.stringify(pkg.version)}`,
    );
  }

  const packages =
    lock.packages && typeof lock.packages === "object" ? lock.packages : null;
  if (!packages) {
    return {
      ok: false,
      problems: [...problems, 'lockfile is missing the "packages" map'],
      stats: emptyStats,
    };
  }

  const root = packages[""];
  if (!root) {
    problems.push('lockfile is missing the root "" package entry');
  }

  const dependencies = pkg.dependencies ?? {};
  const devDependencies = pkg.devDependencies ?? {};
  compareRanges("dependencies", dependencies, root?.dependencies ?? {}, problems);
  compareRanges("devDependencies", devDependencies, root?.devDependencies ?? {}, problems);

  if (root && pkg.license !== undefined && root.license !== undefined && root.license !== pkg.license) {
    problems.push(
      `lockfile root license ${JSON.stringify(root.license)} does not match package.json license ${JSON.stringify(
        pkg.license,
      )}`,
    );
  }
  if (canonical(pkg.engines ?? {}) !== canonical(root?.engines ?? {})) {
    problems.push("lockfile root engines do not match package.json engines");
  }

  let pinned = 0;
  for (const key of Object.keys(packages).sort()) {
    if (key === "") continue;
    const entry = packages[key];
    if (!entry || typeof entry !== "object") {
      problems.push(`${key}: package entry is not an object`);
      continue;
    }
    if (entry.link) {
      problems.push(`${key}: link: dependencies are not reproducible`);
      continue;
    }
    if (typeof entry.version !== "string" || entry.version.length === 0) {
      problems.push(`${key}: missing version`);
    }
    const resolved = entry.resolved;
    if (typeof resolved !== "string" || resolved.length === 0) {
      problems.push(`${key}: missing resolved tarball URL`);
    } else if (!resolved.startsWith(REGISTRY)) {
      problems.push(`${key}: resolved URL is not pinned to ${REGISTRY} (${resolved})`);
    } else if (!resolved.endsWith(".tgz")) {
      problems.push(`${key}: resolved URL does not point at a tarball (${resolved})`);
    } else {
      pinned += 1;
    }
    const integrity = entry.integrity;
    if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
      problems.push(`${key}: missing sha512 integrity hash`);
    }
  }

  const direct = [...Object.keys(dependencies), ...Object.keys(devDependencies)].sort();
  for (const name of direct) {
    if (!packages[`node_modules/${name}`]) {
      problems.push(
        `node_modules/${name}: direct dependency is not pinned at the top level (unexpected nesting)`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    stats: { packages: Object.keys(packages).length - (root ? 1 : 0), pinned, direct: direct.length },
  };
}

/**
 * Canonical, order-independent snapshot of the resolved package set. Two
 * lockfiles that install the same packages produce the same fingerprint even if
 * npm reorders or reformats the JSON.
 *
 * @param {object} lock parsed package-lock.json
 * @returns {string[]}
 */
export function fingerprint(lock) {
  const packages = lock?.packages && typeof lock.packages === "object" ? lock.packages : {};
  const rows = [];
  for (const key of Object.keys(packages).sort()) {
    const entry = packages[key] ?? {};
    if (key === "") {
      rows.push(
        `ROOT|${canonical({
          name: entry.name ?? null,
          version: entry.version ?? null,
          license: entry.license ?? null,
          dependencies: entry.dependencies ?? {},
          devDependencies: entry.devDependencies ?? {},
          engines: entry.engines ?? {},
        })}`,
      );
      continue;
    }
    rows.push(`${key}|${entry.version ?? ""}|${entry.resolved ?? ""}|${entry.integrity ?? ""}`);
  }
  return rows;
}

/**
 * Human-readable differences between two fingerprints.
 *
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string[]}
 */
export function diffFingerprints(before, after) {
  const index = (rows) => new Map(rows.map((row) => [row.split("|", 1)[0], row]));
  const a = index(before);
  const b = index(after);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const changes = [];
  for (const key of [...keys].sort()) {
    if (!a.has(key)) changes.push(`added ${key}`);
    else if (!b.has(key)) changes.push(`removed ${key}`);
    else if (a.get(key) !== b.get(key)) changes.push(`changed ${key}`);
  }
  return changes;
}

function readJson(file, label) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`${label} not found at ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

/**
 * Ask npm to regenerate the lockfile from itself in a scratch directory and
 * return the parsed result. The source directory is copied, never modified.
 */
function regenerateLockfile(rootDir) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "lockfile-reproduce-"));
  try {
    for (const file of ["package.json", "package-lock.json"]) {
      copyFileSync(path.join(rootDir, file), path.join(scratch, file));
    }
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: scratch, stdio: "inherit", shell: process.platform === "win32" },
    );
    return readJson(path.join(scratch, "package-lock.json"), "regenerated package-lock.json");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), reproduce: false, json: false, help: false };
  for (const arg of argv) {
    if (arg === "--reproduce") opts.reproduce = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--root=")) opts.root = path.resolve(arg.slice("--root=".length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function reportProblems(label, problems) {
  console.log(`${label}: ${problems.length} problem(s)`);
  for (const problem of problems.slice(0, MAX_REPORTED)) console.log(`  - ${problem}`);
  if (problems.length > MAX_REPORTED) {
    console.log(`  … ${problems.length - MAX_REPORTED} more`);
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const pkg = readJson(path.join(opts.root, "package.json"), "package.json");
  const lock = readJson(path.join(opts.root, "package-lock.json"), "package-lock.json");

  const { ok, problems, stats } = checkLockfile(pkg, lock);
  const report = { ok, root: opts.root, stats, problems, reproduce: null };

  console.log(`lockfile: ${path.join(path.relative(process.cwd(), opts.root) || ".", "package-lock.json")}`);
  console.log(`packages: ${stats.packages} (${stats.pinned} pinned to ${REGISTRY})`);
  console.log(`direct dependencies: ${stats.direct}`);
  if (ok) {
    console.log("consistency: ok");
  } else {
    reportProblems("consistency", problems);
  }

  if (opts.reproduce && ok) {
    let regenerated;
    try {
      regenerated = regenerateLockfile(opts.root);
    } catch (err) {
      const message = String(err?.message ?? err);
      report.ok = false;
      report.reproduce = { ok: false, changes: [], problems: [], error: message };
      console.log(`reproducibility: could not regenerate the lockfile (${message})`);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      return 1;
    }

    const changes = diffFingerprints(fingerprint(lock), fingerprint(regenerated));
    const regeneratedCheck = checkLockfile(pkg, regenerated);
    report.reproduce = {
      ok: changes.length === 0 && regeneratedCheck.ok,
      changes: changes.slice(0, MAX_REPORTED),
      problems: regeneratedCheck.problems.slice(0, MAX_REPORTED),
    };

    if (report.reproduce.ok) {
      console.log("reproducibility: ok (npm reproduced an identical package set)");
    } else {
      report.ok = false;
      if (changes.length > 0) reportProblems("reproducibility", changes);
      if (!regeneratedCheck.ok) reportProblems("regenerated lockfile", regeneratedCheck.problems);
    }
  }

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`lockfile check failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
