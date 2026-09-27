/**
 * Deployment-packaging tests: `railway.json` must stay consistent with the
 * runtime that ships in this repo — the start command, the healthcheck path the
 * server actually serves, and a persistent volume covering the default cursor
 * directory. Pure and deterministic: no network, no credentials.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const rail = JSON.parse(await readFile(new URL("../railway.json", import.meta.url), "utf8"));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

describe("railway.json", () => {
  it("declares the official schema", () => {
    assert.match(rail.$schema, /^https:\/\/railway\.com\/railway\.schema\.json$/);
  });

  it("compiles the gitignored dist/ in the image", () => {
    assert.equal(rail.build.buildCommand, "npm run build");
  });

  it("starts the built entry point via the documented npm start", () => {
    assert.equal(rail.deploy.startCommand, "npm start");
    assert.equal(pkg.scripts.start, "node dist/index.js");
  });

  it("probes the same /health route the health module serves", async () => {
    assert.equal(rail.deploy.healthcheckPath, "/health");
    const healthSrc = await readFile(new URL("../dist/health.js", import.meta.url), "utf8");
    assert.ok(healthSrc.includes('"/health"'), "dist/health.js must serve the /health route");
  });

  it("requires a volume at /app/data so the cursor survives restarts", () => {
    assert.equal(rail.deploy.requiredMountPath, "/app/data");
  });

  it("mounts the volume inside Railway's /app working directory", () => {
    assert.ok(rail.deploy.requiredMountPath.startsWith("/app/"));
  });

  it("restarts on crash only, with bounded retries", () => {
    assert.equal(rail.deploy.restartPolicyType, "ON_FAILURE");
    assert.ok(Number.isInteger(rail.deploy.restartPolicyMaxRetries));
    assert.ok(rail.deploy.restartPolicyMaxRetries > 0);
  });

  it("pins a single replica (volumes cannot be used with multiple replicas)", () => {
    assert.equal(rail.deploy.numReplicas, 1);
  });
});

describe("railway.json vs repo defaults", () => {
  it("the mounted directory is the default cursor directory (data/)", async () => {
    assert.equal(path.posix.basename(rail.deploy.requiredMountPath), "data");
    const configSrc = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");
    assert.ok(
      configSrc.includes('cursorFile: "./data/cursor.json"'),
      "DEFAULTS.cursorFile must live under the mounted data/ directory",
    );
  });

  it("the default cursor epilogue path reaches the volume on Railway", () => {
    // Railway runs the app from /app, so ./data/cursor.json resolves to
    // /app/data/cursor.json — exactly the requiredMountPath.
    assert.equal(
      path.posix.normalize(`/app/${"data"}/${"cursor.json"}`),
      `${rail.deploy.requiredMountPath}/cursor.json`,
    );
  });
});