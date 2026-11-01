import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.SITE_TIMEZONE = "UTC";

const {
  applyConfigPatch,
  configHash,
  createCachedStore,
  createFileStore,
  createMemoryStore,
  defaultSiteConfig,
  parseStoredConfig,
  serializeConfig,
  siteConfigSchema,
  SiteConfigConflictError,
  MAX_AUDIT_ENTRIES,
} = await import("../src/services/site-config.js");

test("a focus mode without a window is rejected", () => {
  const config = defaultSiteConfig(new Date("2026-11-01T00:00:00Z"));
  const result = siteConfigSchema.safeParse({
    ...config,
    policy: { ...config.policy, mode: "focus-only", focus: null },
  });
  assert.equal(result.success, false);
});

test("policy limits are enforced", () => {
  const config = defaultSiteConfig(new Date("2026-11-01T00:00:00Z"));
  const tooWide = siteConfigSchema.safeParse({
    ...config,
    policy: { ...config.policy, bookingWindowDays: 365 },
  });
  assert.equal(tooWide.success, false);

  const badWeekday = siteConfigSchema.safeParse({
    ...config,
    policy: { ...config.policy, closedWeekdays: [7] },
  });
  assert.equal(badWeekday.success, false);
});

test("template times and ids are validated", () => {
  const config = defaultSiteConfig(new Date("2026-11-01T00:00:00Z"));
  const valid = siteConfigSchema.safeParse({
    ...config,
    templates: [
      {
        id: "weekday-mornings",
        label: "Morning tandems",
        weekdays: [1, 2, 3],
        times: ["09:00", "11:30"],
        durationMinutes: 120,
        maxPax: 4,
        enabled: true,
      },
    ],
  });
  assert.equal(valid.success, true);

  const invalidTime = siteConfigSchema.safeParse({
    ...config,
    templates: [
      {
        id: "bad",
        label: "Bad",
        weekdays: [1],
        times: ["9am"],
        durationMinutes: 120,
        maxPax: 4,
        enabled: true,
      },
    ],
  });
  assert.equal(invalidTime.success, false);
});

test("stored config parsing tolerates surrounding prose and rejects rubbish", () => {
  const config = defaultSiteConfig(new Date("2026-11-01T00:00:00Z"));
  const wrapped = `Managed by the admin console.\n${serializeConfig(config)}\nDo not edit by hand.`;
  assert.deepEqual(parseStoredConfig(wrapped)?.policy, config.policy);
  assert.equal(parseStoredConfig(""), null);
  assert.equal(parseStoredConfig(undefined), null);
  assert.equal(parseStoredConfig("not json at all"), null);
  assert.equal(parseStoredConfig('{"version":2}'), null);
});

test("patches merge onto the policy and leave an audit trail", () => {
  const start = defaultSiteConfig(new Date("2026-11-01T00:00:00Z"));
  const next = applyConfigPatch(
    start,
    { policy: { minLeadHours: 24, mode: "focus-first", focus: { label: "Week 45", from: "2026-11-05", to: "2026-11-06" } } },
    "operator",
    "minLeadHours, mode",
    new Date("2026-11-01T10:00:00Z"),
  );
  assert.equal(next.policy.minLeadHours, 24);
  assert.equal(next.policy.mode, "focus-first");
  assert.equal(next.policy.bookingWindowDays, start.policy.bookingWindowDays);
  assert.equal(next.audit.length, 1);
  assert.equal(next.audit[0]!.actor, "operator");
  assert.equal(next.updatedAt, "2026-11-01T10:00:00.000Z");
  assert.equal(next.updatedBy, "operator");
});

test("the audit log is capped", () => {
  let config = defaultSiteConfig(new Date("2026-11-01T00:00:00Z"));
  for (let index = 0; index < MAX_AUDIT_ENTRIES + 5; index += 1) {
    config = applyConfigPatch(config, { policy: { minLeadHours: index } }, "operator", "test");
  }
  assert.equal(config.audit.length, MAX_AUDIT_ENTRIES);
});

test("the memory store enforces its etag on write", async () => {
  const store = createMemoryStore();
  const first = await store.read();
  assert.equal(first.etag, null);
  assert.equal(first.fellBackToDefaults, true);

  const written = await store.write(first.config, null);
  assert.ok(written.etag);
  const reloaded = await store.read();
  assert.equal(reloaded.fellBackToDefaults, false);

  await assert.rejects(store.write(reloaded.config, "stale-etag"), SiteConfigConflictError);
  const after = await store.write(reloaded.config, reloaded.etag);
  assert.equal(after.etag, configHash(serializeConfig(reloaded.config)));
});

test("the cached store serves from memory until the TTL expires", async () => {
  let reads = 0;
  const inner = createMemoryStore();
  const counting = {
    kind: "memory",
    async read() {
      reads += 1;
      return inner.read();
    },
    write: inner.write,
  };
  let clock = 1_000;
  const cached = createCachedStore(counting, 60_000, () => clock);

  await cached.read();
  await cached.read();
  assert.equal(reads, 1);

  clock += 60_001;
  await cached.read();
  assert.equal(reads, 2);

  await cached.write((await inner.read()).config, null);
  await cached.read();
  assert.equal(reads, 2, "a write should refresh the cache");
});

test("the file store round-trips and detects stale writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pg-config-"));
  try {
    const store = createFileStore(join(directory, "site-config.json"));
    const empty = await store.read();
    assert.equal(empty.etag, null);
    assert.equal(empty.fellBackToDefaults, true);

    const saved = await store.write(empty.config, null);
    const loaded = await store.read();
    assert.equal(loaded.fellBackToDefaults, false);
    assert.deepEqual(loaded.config.policy, empty.config.policy);
    assert.equal(loaded.etag, saved.etag);

    await assert.rejects(store.write(loaded.config, "nope"), SiteConfigConflictError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
