import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LOCKFILE_VERSION,
  REGISTRY,
  checkLockfile,
  diffFingerprints,
  fingerprint,
} from "../scripts/check-lockfile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

async function loadJson(rel) {
  return JSON.parse(await readFile(path.join(root, rel), "utf8"));
}

const realPkg = await loadJson("package.json");
const realLock = await loadJson("package-lock.json");

/** A minimal, fully valid package.json + lockfile pair for mutation tests. */
function sample() {
  return {
    pkg: {
      name: "@mimir/sample",
      version: "1.0.0",
      license: "MIT",
      engines: { node: ">=20" },
      dependencies: { left: "^1.0.0" },
      devDependencies: { right: "^2.0.0" },
    },
    lock: {
      name: "@mimir/sample",
      version: "1.0.0",
      lockfileVersion: LOCKFILE_VERSION,
      requires: true,
      packages: {
        "": {
          name: "@mimir/sample",
          version: "1.0.0",
          license: "MIT",
          dependencies: { left: "^1.0.0" },
          devDependencies: { right: "^2.0.0" },
          engines: { node: ">=20" },
        },
        "node_modules/left": {
          version: "1.0.0",
          resolved: `${REGISTRY}left/-/left-1.0.0.tgz`,
          integrity: `sha512-${"A".repeat(86)}`,
        },
        "node_modules/right": {
          version: "2.0.0",
          resolved: `${REGISTRY}right/-/right-2.0.0.tgz`,
          integrity: `sha512-${"B".repeat(86)}`,
        },
      },
    },
  };
}

function sampleOk() {
  const { pkg, lock } = sample();
  const result = checkLockfile(pkg, lock);
  assert.equal(result.ok, true, result.problems.join("\n"));
  return { pkg, lock, result };
}

test("committed lockfile passes every consistency check", () => {
  const result = checkLockfile(realPkg, realLock);
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.ok(result.stats.packages > 0, "expected pinned packages");
  assert.equal(
    result.stats.direct,
    Object.keys(realPkg.dependencies).length + Object.keys(realPkg.devDependencies).length,
  );
});

test("every committed package is pinned to the registry with sha512 integrity", () => {
  const result = checkLockfile(realPkg, realLock);
  assert.equal(
    result.stats.pinned,
    result.stats.packages,
    "a package is not pinned to a registry tarball",
  );
  for (const [key, entry] of Object.entries(realLock.packages)) {
    if (key === "") continue;
    assert.match(entry.resolved, new RegExp(`^${REGISTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(entry.integrity, /^sha512-/);
  }
});

test("dependency range drift between package.json and the lockfile is rejected", () => {
  const { pkg, lock } = sample();
  lock.packages[""].dependencies.left = "^9.9.9";
  const result = checkLockfile(pkg, lock);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /dependencies\.left: range drift/);
});

test("a dependency declared only in package.json is rejected", () => {
  const { pkg, lock } = sample();
  pkg.dependencies.extra = "^1.0.0";
  const result = checkLockfile(pkg, lock);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /dependencies\.extra: declared in package\.json but missing/);
});

test("a dependency declared only in the lockfile root entry is rejected", () => {
  const { pkg, lock } = sample();
  lock.packages[""].devDependencies.stale = "^3.0.0";
  const result = checkLockfile(pkg, lock);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /devDependencies\.stale: present in the lockfile root entry/);
});

test("non-registry resolutions are rejected", () => {
  const badResolutions = [
    "git+https://github.com/mimir-stellar/left.git",
    "file:../left",
    "link:../left",
    "http://registry.npmjs.org/left/-/left-1.0.0.tgz",
    "https://codeload.github.com/mimir-stellar/left/tar.gz/v1.0.0",
  ];
  for (const resolved of badResolutions) {
    const { pkg, lock } = sample();
    lock.packages["node_modules/left"].resolved = resolved;
    const result = checkLockfile(pkg, lock);
    assert.equal(result.ok, false, `expected rejection for ${resolved}`);
    assert.match(result.problems.join("\n"), /node_modules\/left: resolved URL is not pinned/);
  }
});

test("missing or non-sha512 integrity is rejected", () => {
  for (const integrity of [undefined, "", "sha1-abc", "sha256-abc"]) {
    const { pkg, lock } = sample();
    if (integrity === undefined) delete lock.packages["node_modules/left"].integrity;
    else lock.packages["node_modules/left"].integrity = integrity;
    const result = checkLockfile(pkg, lock);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(integrity)}`);
    assert.match(result.problems.join("\n"), /node_modules\/left: missing sha512 integrity/);
  }
});

test("link: entries are rejected instead of silently accepted", () => {
  const { pkg, lock } = sample();
  lock.packages["node_modules/left"] = { link: true, version: "1.0.0" };
  const result = checkLockfile(pkg, lock);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /node_modules\/left: link: dependencies are not reproducible/);
});

test("a direct dependency nested below the top level is rejected", () => {
  const { pkg, lock } = sample();
  const entry = lock.packages["node_modules/left"];
  delete lock.packages["node_modules/left"];
  lock.packages["node_modules/container/node_modules/left"] = entry;
  const result = checkLockfile(pkg, lock);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /node_modules\/left: direct dependency is not pinned at the top level/);
});

test("boundary: a stale lockfileVersion is rejected", () => {
  const { pkg, lock } = sample();
  lock.lockfileVersion = 2;
  const result = checkLockfile(pkg, lock);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /lockfileVersion is 2, expected 3/);
});

test("boundary: a lockfile without a packages map or root entry is rejected", () => {
  const { pkg, lock } = sample();
  delete lock.packages;
  assert.equal(checkLockfile(pkg, lock).ok, false);

  const second = sample();
  second.lock.packages = {};
  const result = checkLockfile(second.pkg, second.lock);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /missing the root "" package entry/);
});

test("boundary: non-object inputs are rejected without throwing", () => {
  assert.equal(checkLockfile(null, realLock).ok, false);
  assert.equal(checkLockfile(realPkg, null).ok, false);
  assert.equal(checkLockfile([], realLock).ok, false);
  assert.equal(checkLockfile(realPkg, []).ok, false);
});

test("fingerprint is order-independent and stable for identical input", () => {
  const { lock } = sample();
  assert.deepEqual(fingerprint(lock), fingerprint(sample().lock));

  const reordered = { ...lock, packages: {} };
  for (const key of Object.keys(lock.packages).reverse()) reordered.packages[key] = lock.packages[key];
  assert.deepEqual(fingerprint(reordered), fingerprint(lock));
});

test("fingerprint changes when a pinned package changes", () => {
  const { lock } = sample();
  const before = fingerprint(lock);

  const changed = sample().lock;
  changed.packages["node_modules/left"].version = "1.0.1";
  assert.deepEqual(diffFingerprints(before, fingerprint(changed)), ["changed node_modules/left"]);

  const added = sample().lock;
  added.packages["node_modules/extra"] = {
    version: "1.0.0",
    resolved: `${REGISTRY}extra/-/extra-1.0.0.tgz`,
    integrity: `sha512-${"C".repeat(86)}`,
  };
  assert.deepEqual(diffFingerprints(before, fingerprint(added)), ["added node_modules/extra"]);

  const removed = sample().lock;
  delete removed.packages["node_modules/right"];
  assert.deepEqual(diffFingerprints(before, fingerprint(removed)), ["removed node_modules/right"]);
});

test("fingerprint covers the root dependency ranges", () => {
  const { pkg, lock } = sample();
  const changed = sample().lock;
  changed.packages[""].dependencies.left = "^9.9.9";
  assert.deepEqual(diffFingerprints(fingerprint(lock), fingerprint(changed)), ["changed ROOT"]);
  // package.json-only drift is therefore caught by regeneration, not just install.
  assert.equal(checkLockfile(pkg, changed).ok, false);
});

test("the lockfile checks are wired into package.json", () => {
  assert.equal(realPkg.scripts["lockfile:check"], "node scripts/check-lockfile.mjs");
  assert.equal(realPkg.scripts["lockfile:reproduce"], "node scripts/check-lockfile.mjs --reproduce");
});
