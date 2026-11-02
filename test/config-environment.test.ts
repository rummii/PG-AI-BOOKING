import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * `config` is validated once per process at import time (see `src/config/site.ts`), so this file
 * feeds it a deliberately messy environment and imports afterwards. Railway's variable editor — and
 * any copy-paste — happily stores `Production` or a value carrying a trailing space; the container
 * used to crash on both, with a multi-line `zod` JSON dump that never revealed the offending value.
 * Hence a dedicated file, for the same reason `proxy-trust.test.ts` has one.
 */

process.env.NODE_ENV = " Production ";
process.env.LOG_LEVEL = "INFO\r";
process.env.SITE_LAT = "45.0";
process.env.SITE_LON = "7.0";
process.env.SITE_TIMEZONE = "UTC";
delete process.env.SITE_CONFIG_FILE;

const { config, DEFAULT_CONFIG_EVENT_ID, withoutBlanks } = await import("../src/config/site.js");

test("NODE_ENV forgives surrounding whitespace and unexpected capitalisation", () => {
  assert.equal(config.NODE_ENV, "production");
});

test("LOG_LEVEL forgives a trailing carriage return from a Windows paste", () => {
  assert.equal(config.LOG_LEVEL, "info");
});

test("an unrecognised environment value still fails fast, on one readable line", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", "await import('./src/config/site.ts');"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "staging" },
    },
  );

  assert.notEqual(result.status, 0, "expected the module to refuse to load");

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const messageLine = output
    .split(/\r?\n/)
    .find((line) => /^\s*Error: Invalid environment configuration/.test(line));

  assert.ok(messageLine, `expected a configuration error, got:\n${output}`);
  assert.match(messageLine, /NODE_ENV: Invalid option/);
  assert.match(messageLine, /received "staging"/, "the offending value must be in the message");
  assert.doesNotMatch(
    messageLine,
    /^\s*\[/,
    "the error must not be a multi-line zod dump that log pipelines shred into fragments",
  );
});

test("a blank variable means unset, not an empty string that must still pass its checks", () => {
  const stripped = withoutBlanks({
    ADMIN_SESSION_SECRET: "",
    SITE_CONFIG_FILE: "",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "   ",
    DEEPSEEK_API_KEY: "",
    SITE_LAT: "45.0",
    UNSET: undefined,
  });

  assert.deepEqual(stripped, { SITE_LAT: "45.0", UNSET: undefined });
});

/**
 * The id is handed to Google as a custom event id, and Google only accepts base32hex there — so an
 * invalid default would not show up until the first admin save, as a bare "Invalid resource id
 * value". The shipped default used to be `pgpolicy01`, whose `y` is exactly that trap.
 */
test("the default config event id satisfies the id rule the schema enforces", () => {
  assert.match(DEFAULT_CONFIG_EVENT_ID, /^[a-v0-9]{5,1024}$/);
  assert.equal(config.ADMIN_CONFIG_EVENT_ID, DEFAULT_CONFIG_EVENT_ID);
});

test("an unusable config event id still stops the process, naming the key", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", "await import('./src/config/site.ts');"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ADMIN_CONFIG_EVENT_ID: "policy01" },
    },
  );

  assert.notEqual(result.status, 0, "expected the module to refuse to load");

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const messageLine = output
    .split(/\r?\n/)
    .find((line) => /^\s*Error: Invalid environment configuration/.test(line));

  assert.ok(messageLine, `expected a configuration error, got:\n${output}`);
  assert.match(messageLine, /ADMIN_CONFIG_EVENT_ID: must be a valid Google Calendar event id/);
});
