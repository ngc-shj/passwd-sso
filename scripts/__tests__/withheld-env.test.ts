/**
 * scripts/checks/lib/withheld-env.ts: the withheld env set W and the role pins. Each
 * deny case is paired with an allow case on the same inputs, and drift lists
 * are compared whole.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { ALLOWLIST } from "../env-allowlist";
import { APP_WITHHELD_ENV_KEYS, envObject } from "@/lib/env-schema";
import { buildDestinationsFromEnv } from "@/lib/audit/anchor-destinations/from-env";
import { createComposeYamlLoader } from "../checks/check-compose-log-caps.mjs";
import {
  WITHHELD_PASS_THROUGH_NAMES,
  appDatabaseUrlFromCompose,
  deriveWithheldEnv,
  derivePublisherOnlyEnv,
  BUILD_KEY_ALLOWLIST,
  FILE_CHANNEL_ALLOWLIST,
  SERVICE_KEY_ALLOWLIST,
  SERVICE_KEY_REFUSAL,
  bindSourceProblem,
  externalEntryProblems,
  isAllowlistedFileSource,
  namedVolumeProblem,
  serviceKeyProblems,
  shortVolumeIsReadOnly,
  ownDatabaseUrlKey,
  ownRoleUser,
  readSmokeMap,
  realRolePasswordInputs,
  realSmokeMapRoleInputs,
  realWithheldInputs,
  rolePasswordBinding,
  roleUserFromComposeUrl,
  smokeMapRoleDrift,
  withheldHolders,
  withheldEnvObjectKeys,
  workerServiceName,
  assertSmokeMapRolesLeastPrivilege,
  type SmokeMap,
  type SmokeMapRoleInputs,
  type WithheldInputs,
} from "../checks/lib/withheld-env";

const REPO_ROOT = resolve(__dirname, "../..");

describe("deriveWithheldEnv", () => {
  const inputs = realWithheldInputs();
  const withheld = deriveWithheldEnv(inputs);

  it("is sorted and holds the floor", () => {
    expect(withheld).toEqual([...withheld].sort());
    for (const name of [
      "AUDIT_ANCHOR_SIGNING_KEY",
      "AUDIT_ANCHOR_TAG_SECRET",
      "GITHUB_TOKEN",
      "PASSWD_SUPERUSER_PASSWORD",
      "OUTBOX_WORKER_DATABASE_URL",
    ]) {
      expect(withheld, name).toContain(name);
    }
  });

  it("keeps the app's own URL and the key the publisher shares with retention-gc out", () => {
    expect(withheld).not.toContain("DATABASE_URL");
    expect(withheld).not.toContain("DEPLOYMENT_ID");
  });

  it("derives the publisher-only secrets from the ECS secrets split", () => {
    expect(inputs.publisherSecrets).toContain("AUDIT_ANCHOR_SIGNING_KEY");
    expect(inputs.appSecrets).not.toContain("AUDIT_ANCHOR_SIGNING_KEY");
    expect(inputs.appSecrets).toContain("DATABASE_URL");
  });

  it("admits a new secret allowlist entry with no other edit, and not a non-secret one", () => {
    const entry = (key: string, secret: boolean) =>
      ({ type: "literal", key, justification: "", consumers: [], reviewedAt: "", secret }) as const;
    const withSecret: WithheldInputs = { ...inputs, allowlist: [...inputs.allowlist, entry("NEW_SECRET_FOR_TEST", true)] };
    const withPlain: WithheldInputs = { ...inputs, allowlist: [...inputs.allowlist, entry("NEW_PLAIN_FOR_TEST", false)] };
    expect(deriveWithheldEnv(withSecret)).toEqual([...withheld, "NEW_SECRET_FOR_TEST"].sort());
    expect(deriveWithheldEnv(withPlain)).toEqual(withheld);
  });

  it("admits a secret only the publisher task receives, and not one both tasks receive", () => {
    const withPublisherOnly: WithheldInputs = { ...inputs, publisherSecrets: [...inputs.publisherSecrets, "NEW_PUBLISHER_SECRET"] };
    const withShared: WithheldInputs = {
      ...inputs,
      publisherSecrets: [...inputs.publisherSecrets, "NEW_SHARED_SECRET"],
      appSecrets: [...inputs.appSecrets, "NEW_SHARED_SECRET"],
    };
    expect(deriveWithheldEnv(withPublisherOnly)).toEqual([...withheld, "NEW_PUBLISHER_SECRET"].sort());
    expect(deriveWithheldEnv(withShared)).toEqual(withheld);
  });

  it("admits another *_DATABASE_URL field of envObject, and not DATABASE_URL", () => {
    const withUrl: WithheldInputs = { ...inputs, envObjectKeys: [...inputs.envObjectKeys, "NEW_ROLE_DATABASE_URL"] };
    expect(deriveWithheldEnv(withUrl)).toEqual([...withheld, "NEW_ROLE_DATABASE_URL"].sort());
    expect(deriveWithheldEnv({ ...inputs, envObjectKeys: [...inputs.envObjectKeys, "DATABASE_URL"] })).toEqual(withheld);
  });

  it("lists the pass-through names by name", () => {
    for (const name of WITHHELD_PASS_THROUGH_NAMES) expect(withheld, name).toContain(name);
  });
});

describe("APP_WITHHELD_ENV_KEYS", () => {
  it("equals W's envObject keys", () => {
    const inputs = realWithheldInputs();
    expect([...APP_WITHHELD_ENV_KEYS].sort()).toEqual(withheldEnvObjectKeys(deriveWithheldEnv(inputs), inputs.envObjectKeys));
  });

  it("is not equal once W gains an envObject key it does not list", () => {
    const inputs = realWithheldInputs();
    const grown: WithheldInputs = { ...inputs, envObjectKeys: [...inputs.envObjectKeys, "NEW_ROLE_DATABASE_URL"] };
    expect([...APP_WITHHELD_ENV_KEYS].sort()).not.toEqual(withheldEnvObjectKeys(deriveWithheldEnv(grown), grown.envObjectKeys));
  });

  it("names only envObject fields", () => {
    for (const key of APP_WITHHELD_ENV_KEYS) expect(Object.keys(envObject.shape), key).toContain(key);
  });
});

describe("the GitHub token names", () => {
  it.each(["AUDIT_ANCHOR_DESTINATION_GH_TOKEN", "GITHUB_TOKEN"] as const)("%s is in W and read by from-env.ts", (name) => {
    expect(deriveWithheldEnv()).toContain(name);
    expect(
      buildDestinationsFromEnv({ AUDIT_ANCHOR_DESTINATION_GH_REPO: "owner/repo", [name]: "ghp_x" }).map((d) => d.name),
    ).toEqual(["github-release"]);
  });

  it("from-env.ts reads no other token name", () => {
    const text = readFileSync(join(REPO_ROOT, "src/lib/audit/anchor-destinations/from-env.ts"), "utf8");
    expect([...text.matchAll(/env\.([A-Z_]*TOKEN)\b/g)].map((m) => m[1]).sort()).toEqual([
      "AUDIT_ANCHOR_DESTINATION_GH_TOKEN",
      "GITHUB_TOKEN",
    ]);
  });
});

describe("isAllowlistedFileSource", () => {
  const root = "/srv/app";

  it("allows exactly <project>/<an allowlisted path>, in any spelling of that path", () => {
    for (const { path } of FILE_CHANNEL_ALLOWLIST) {
      expect(isAllowlistedFileSource(`/srv/app/${path}`, root), path).toBe(true);
      expect(isAllowlistedFileSource(`/srv/app/${path}/`, root), path).toBe(true);
      expect(isAllowlistedFileSource(`/srv/app/./infra/../${path}`, root), path).toBe(true);
    }
  });

  it("refuses the project directory, its ancestors, .env* files and any path not on the list", () => {
    for (const source of ["/srv/app", "/srv/app/", "/srv", "/", "/srv/app/.env", "/elsewhere/.env.local", "/srv/app/infra", "/srv/app/infra/postgres", "/srv/app-data", "/opt/x"]) {
      expect(isAllowlistedFileSource(source, root), source).toBe(false);
    }
  });

  it("refuses an allowlisted path under another root, and one with a longer name", () => {
    expect(isAllowlistedFileSource("/other/infra/postgres/initdb", root)).toBe(false);
    expect(isAllowlistedFileSource("/srv/app/infra/postgres/initdb.d", root)).toBe(false);
    expect(isAllowlistedFileSource("/srv/app/infra/postgres/initdb/01-create-jackson-db.sql", root)).toBe(false);
  });

  it("refuses a relative source, as compose leaves a named volume's device unresolved", () => {
    for (const source of [".", "./infra/postgres/initdb", "infra/postgres/initdb", "~/x", "${X}"]) {
      expect(isAllowlistedFileSource(source, root), source).toBe(false);
    }
  });

  it("compares paths in whatever one absolute form they are written in, and takes another list", () => {
    expect(isAllowlistedFileSource("/tmp/compose-render-x/infra/redis/sentinel.conf", "/tmp/compose-render-x")).toBe(true);
    expect(isAllowlistedFileSource("/srv/app/infra/x", root)).toBe(false);
    expect(isAllowlistedFileSource("/srv/app/infra/x", root, [{ path: "infra/x" }])).toBe(true);
  });
});

describe("bindSourceProblem", () => {
  const root = "/srv/app";
  const initdb = "/srv/app/infra/postgres/initdb";

  it("allows an allowlisted path for a service the entry names, read-only", () => {
    expect(bindSourceProblem(initdb, root, "db", true)).toBeNull();
    expect(bindSourceProblem("/srv/app/infra/redis/sentinel.conf", root, "sentinel-2", true)).toBeNull();
  });

  it("refuses a path that is not on the list, whatever the service and mode", () => {
    expect(bindSourceProblem("/srv/app/.env", root, "db", true)).toBe("is not allowlisted");
  });

  it("refuses a listed path from a service the entry does not name", () => {
    expect(bindSourceProblem(initdb, root, "app", true)).toBe("is not allowlisted for this service");
    expect(bindSourceProblem(initdb, root, "sentinel-1", true)).toBe("is not allowlisted for this service");
  });

  it("refuses a writable mount of a read-only entry, and accepts a writable one for readOnly: false", () => {
    expect(bindSourceProblem(initdb, root, "db", false)).toBe("is allowlisted read-only and is mounted writable");
    const list = [{ path: "infra/postgres/initdb", services: ["db"], readOnly: false, reason: "test" }];
    expect(bindSourceProblem(initdb, root, "db", false, list)).toBeNull();
  });
});

describe("shortVolumeIsReadOnly", () => {
  it("reads ro among the mode options, and nothing else as read-only", () => {
    for (const v of ["./a:/b:ro", "./a:/b:ro,z", "./a:/b:z,ro"]) expect(shortVolumeIsReadOnly(v), v).toBe(true);
    for (const v of ["./a:/b", "./a:/b:rw", "./a:/b:z", "./a:/b:rro", "./ro:/ro"]) expect(shortVolumeIsReadOnly(v), v).toBe(false);
  });
});

describe("FILE_CHANNEL_ALLOWLIST", () => {
  it("names each entry as a normalised repo-relative path with services, a mode and a reason, and none of them .env*", () => {
    expect(FILE_CHANNEL_ALLOWLIST.map((e) => [e.path, e.services, e.readOnly])).toEqual([
      ["infra/postgres/initdb", ["db"], true],
      ["infra/fluent-bit/fluent-bit.conf", ["fluent-bit"], true],
      ["infra/fluent-bit/parsers.conf", ["fluent-bit"], true],
      ["infra/redis/sentinel.conf", ["sentinel-1", "sentinel-2", "sentinel-3"], true],
    ]);
    for (const { path, reason, services } of FILE_CHANNEL_ALLOWLIST) {
      expect(posix.normalize(path), path).toBe(path);
      expect(reason, path).not.toBe("");
      expect(services.length, path).toBeGreaterThan(0);
      expect(posix.basename(path).startsWith(".env"), path).toBe(false);
    }
  });
});

describe("namedVolumeProblem", () => {
  const expected = "compose-render_postgres_data";

  it("allows a plain docker-managed volume, as written or as compose renders it", () => {
    expect(namedVolumeProblem(null, null)).toBeNull();
    expect(namedVolumeProblem({}, null)).toBeNull();
    expect(namedVolumeProblem(null, expected)).toBeNull();
    expect(namedVolumeProblem({ name: expected }, expected)).toBeNull();
  });

  it("refuses any explicit name where the project name is unknown, and a differing one where it is known", () => {
    expect(namedVolumeProblem({ name: expected }, null)).toBe("sets name");
    expect(namedVolumeProblem({ name: "postgres_data" }, expected)).toBe(`sets name (not ${expected})`);
    expect(namedVolumeProblem({ name: "other_postgres_data" }, expected)).toBe(`sets name (not ${expected})`);
    expect(namedVolumeProblem({ name: 5 }, expected)).toBe(`sets name (not ${expected})`);
    expect(namedVolumeProblem({ driver: "local", name: "x" }, expected)).toBe(`sets driver, name (not ${expected})`);
  });

  it("names a driver, driver_opts, an unmodelled definition and an undefined volume", () => {
    expect(namedVolumeProblem({ driver: "local" }, null)).toBe("sets driver");
    expect(namedVolumeProblem({ driver_opts: { device: "." } }, null)).toBe("sets driver_opts");
    expect(namedVolumeProblem(5, null)).toBe("has an unmodelled definition");
    expect(namedVolumeProblem([], null)).toBe("has an unmodelled definition");
    expect(namedVolumeProblem(undefined, null)).toBe("is not defined by any compose file");
  });
});

describe("serviceKeyProblems", () => {
  const isDot = (context: string) => context === ".";
  const real = { build: { context: ".", dockerfile: "Dockerfile", args: { A: "b" } }, security_opt: ["no-new-privileges:true"], read_only: true, command: ["x"] };
  const refused = (what: string) => [`${SERVICE_KEY_REFUSAL}: ${what}`];

  it("allows a service of listed keys, and the build and security_opt the stack ships", () => {
    expect(serviceKeyProblems(real, isDot)).toEqual([]);
    expect(serviceKeyProblems({}, isDot)).toEqual([]);
    expect(serviceKeyProblems({ build: { context: "/tmp/stub", dockerfile: "Dockerfile" } }, (c) => c === "/tmp/stub")).toEqual([]);
  });

  it("lists the keys the stack uses, and none that reaches another container or the host", () => {
    for (const key of ["privileged", "devices", "device_cgroup_rules", "cap_add", "pid", "ipc", "cgroup", "userns_mode", "volumes_from", "extends", "network_mode", "tmpfs", "container_name"]) {
      expect(SERVICE_KEY_ALLOWLIST, key).not.toContain(key);
    }
    expect(BUILD_KEY_ALLOWLIST).toEqual(["context", "dockerfile", "args"]);
  });

  it("refuses each key outside the list by name, in key order, and an unknown or future one", () => {
    expect(serviceKeyProblems({ ...real, privileged: true, pid: "host", x_unknown: 1 }, isDot)).toEqual([
      ...refused("privileged"),
      ...refused("pid"),
      ...refused("x_unknown"),
    ]);
  });

  it("refuses a security_opt that is not exactly no-new-privileges:true", () => {
    for (const value of [["seccomp=unconfined"], ["no-new-privileges:true", "seccomp=unconfined"], [], "no-new-privileges:true"]) {
      expect(serviceKeyProblems({ ...real, security_opt: value }, isDot), JSON.stringify(value)).toEqual(refused('security_opt is not exactly ["no-new-privileges:true"]'));
    }
  });

  it("refuses a build that is not a mapping, has an extra key, another context or another dockerfile", () => {
    expect(serviceKeyProblems({ build: "." }, isDot)).toEqual(refused("build is not a mapping"));
    expect(serviceKeyProblems({ build: { ...real.build, dockerfile_inline: "FROM x" } }, isDot)).toEqual(refused("build.dockerfile_inline is set"));
    expect(serviceKeyProblems({ build: { ...real.build, context: ".." } }, isDot)).toEqual(refused("build.context is not the project root"));
    expect(serviceKeyProblems({ build: { dockerfile: "Dockerfile" } }, isDot)).toEqual(refused("build.context is not the project root"));
    expect(serviceKeyProblems({ build: { ...real.build, dockerfile: "Other" } }, isDot)).toEqual(refused("build.dockerfile is not Dockerfile"));
  });

  it("names a service that is not a mapping", () => {
    expect(serviceKeyProblems(null, isDot)).toEqual(["has an unmodelled service definition"]);
  });
});

describe("externalEntryProblems", () => {
  it("names an external entry of each kind, in the kind order, and none of a plain one", () => {
    expect(externalEntryProblems({ volumes: { v: { external: true } }, secrets: { s: { external: true } }, configs: { c: { external: false } } })).toEqual([
      "volumes entry v is external",
      "secrets entry s is external",
      "configs entry c is external",
    ]);
    expect(externalEntryProblems({ volumes: { v: null, w: { name: "x" } }, secrets: { s: { file: "./x" } }, configs: undefined })).toEqual([]);
    expect(externalEntryProblems({})).toEqual([]);
  });
});

describe("roleUserFromComposeUrl", () => {
  it("reads the user of a URL whose password is a compose interpolation", () => {
    expect(roleUserFromComposeUrl("postgresql://passwd_app:${PASSWD_APP_PASSWORD:?required}@db:5432/passwd_sso")).toBe("passwd_app");
  });

  it.each(["", "not-a-url", "postgres://passwd_app:x@db/d", "postgresql://passwd_app@db/d", "xpostgresql://passwd_app:x@db/d"])(
    "throws on %j",
    (raw) => {
      expect(() => roleUserFromComposeUrl(raw)).toThrow("no role user");
    },
  );
});

describe("smoke-map roles", () => {
  const smoke = readSmokeMap();
  const appCompose = createComposeYamlLoader().then((load) =>
    load(readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8")),
  );

  async function realInputs(): Promise<SmokeMapRoleInputs> {
    return realSmokeMapRoleInputs(await appCompose);
  }

  /** The smoke map with one task's own URL rewritten to `user`. */
  function withUser(task: string, user: string): SmokeMap {
    const copy = structuredClone(smoke);
    const key = ownDatabaseUrlKey(copy.tasks[task]);
    copy.tasks[task].env[key] = `postgresql://${user}:smoke@127.0.0.1:5432/passwd_sso`;
    return copy;
  }

  it("reads each task's own URL key and role", () => {
    expect(Object.fromEntries(Object.entries(smoke.tasks).map(([n, t]) => [n, [ownDatabaseUrlKey(t), ownRoleUser(t)]]))).toEqual({
      audit_outbox_worker: ["OUTBOX_WORKER_DATABASE_URL", "passwd_outbox_worker"],
      retention_gc_worker: ["RETENTION_GC_DATABASE_URL", "passwd_retention_gc_worker"],
      audit_anchor_publisher: ["AUDIT_ANCHOR_PUBLISHER_DATABASE_URL", "passwd_anchor_publisher"],
      audit_chain_verify_worker: ["AUDIT_CHAIN_VERIFY_DATABASE_URL", "passwd_audit_chain_verifier"],
    });
  });

  it("refuses a task with two *_DATABASE_URL keys", () => {
    const copy = structuredClone(smoke);
    copy.tasks.audit_outbox_worker.env.EXTRA_DATABASE_URL = "postgresql://x:y@h/d";
    expect(() => ownDatabaseUrlKey(copy.tasks.audit_outbox_worker)).toThrow("expected one *_DATABASE_URL key");
  });

  it("finds no drift in the real smoke map, manifest and compose file", async () => {
    const inputs = await realInputs();
    expect(smokeMapRoleDrift(inputs)).toEqual([]);
    expect(() => assertSmokeMapRolesLeastPrivilege(inputs)).not.toThrow();
  });

  it("names the missing ROLEATTR rows of a user the manifest does not list (passwd_user)", async () => {
    const inputs = await realInputs();
    const drifted = { ...inputs, smoke: withUser("audit_outbox_worker", "passwd_user") };
    expect(smokeMapRoleDrift(drifted)).toEqual([
      "audit_outbox_worker: role passwd_user lacks manifest row ROLEATTR rolsuper=false",
      "audit_outbox_worker: role passwd_user lacks manifest row ROLEATTR rolbypassrls=false",
      "audit_outbox_worker: role passwd_user lacks manifest row ROLEATTR rolcanlogin=true",
    ]);
    expect(() => assertSmokeMapRolesLeastPrivilege(drifted)).toThrow("passwd_user lacks manifest row");
  });

  it("names only the row that is absent when the user has the others", async () => {
    const inputs = await realInputs();
    const manifestGrants = inputs.manifestGrants.filter((g) => g !== "ROLEATTR:passwd_outbox_worker\trolbypassrls\tfalse");
    expect(manifestGrants.length).toBe(inputs.manifestGrants.length - 1);
    expect(smokeMapRoleDrift({ ...inputs, manifestGrants })).toEqual([
      "audit_outbox_worker: role passwd_outbox_worker lacks manifest row ROLEATTR rolbypassrls=false",
    ]);
  });

  it("refuses a worker that connects as the app's role (passwd_app)", async () => {
    const inputs = await realInputs();
    expect(smokeMapRoleDrift({ ...inputs, smoke: withUser("retention_gc_worker", "passwd_app") })).toEqual([
      "retention_gc_worker: role passwd_app is the app DATABASE_URL role",
    ]);
  });

  it("refuses two workers that share a role", async () => {
    const inputs = await realInputs();
    expect(smokeMapRoleDrift({ ...inputs, smoke: withUser("retention_gc_worker", "passwd_outbox_worker") })).toEqual([
      "audit_outbox_worker and retention_gc_worker share role passwd_outbox_worker",
    ]);
  });

  it("refuses an app URL it cannot read, and accepts the same inputs with a readable one", async () => {
    const inputs = await realInputs();
    expect(smokeMapRoleDrift({ ...inputs, appDatabaseUrl: "${DATABASE_URL}" })).toEqual([
      "app DATABASE_URL: no role user could be read",
    ]);
    expect(smokeMapRoleDrift({ ...inputs, appDatabaseUrl: "postgresql://passwd_app:x@db/d" })).toEqual([]);
  });

  it("refuses a smoke-map URL it cannot read", async () => {
    const inputs = await realInputs();
    const copy = structuredClone(smoke);
    copy.tasks.audit_outbox_worker.env.OUTBOX_WORKER_DATABASE_URL = "not-a-url";
    expect(smokeMapRoleDrift({ ...inputs, smoke: copy })).toEqual([
      "audit_outbox_worker: no role user could be read from its smoke-map URL",
    ]);
  });

  it("reads the app URL from a list or a map environment, and refuses a compose file without one", () => {
    const url = "postgresql://passwd_app:x@db/d";
    expect(appDatabaseUrlFromCompose({ services: { app: { environment: ["A=b", `DATABASE_URL=${url}`] } } })).toBe(url);
    expect(appDatabaseUrlFromCompose({ services: { app: { environment: { DATABASE_URL: url } } } })).toBe(url);
    expect(() => appDatabaseUrlFromCompose({ services: { app: { environment: ["A=b"] } } })).toThrow("no DATABASE_URL");
  });
});

describe("role-password binding", () => {
  const inputs = realRolePasswordInputs();

  it("binds each service to the password variables of its role", () => {
    expect(rolePasswordBinding(inputs)).toEqual({
      app: ["PASSWD_APP_PASSWORD"],
      jackson: ["PASSWD_JACKSON_PASSWORD"],
      migrate: ["PASSWD_SUPERUSER_PASSWORD"],
      db: [
        "PASSWD_ANCHOR_PUBLISHER_PASSWORD",
        "PASSWD_APP_PASSWORD",
        "PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD",
        "PASSWD_JACKSON_PASSWORD",
        "PASSWD_OUTBOX_WORKER_PASSWORD",
        "PASSWD_RETENTION_GC_WORKER_PASSWORD",
        "PASSWD_SUPERUSER_PASSWORD",
      ],
      "audit-outbox-worker": ["PASSWD_OUTBOX_WORKER_PASSWORD"],
      "retention-gc-worker": ["PASSWD_RETENTION_GC_WORKER_PASSWORD"],
      "audit-anchor-publisher": ["PASSWD_ANCHOR_PUBLISHER_PASSWORD"],
      "audit-chain-verify-worker": ["PASSWD_AUDIT_CHAIN_VERIFIER_PASSWORD"],
    });
  });

  it("follows a worker whose smoke-map user changes", () => {
    const smoke = structuredClone(inputs.smoke);
    smoke.tasks.audit_outbox_worker.env.OUTBOX_WORKER_DATABASE_URL = "postgresql://passwd_retention_gc_worker:smoke@h:5432/d";
    expect(rolePasswordBinding({ ...inputs, smoke })["audit-outbox-worker"]).toEqual(["PASSWD_RETENTION_GC_WORKER_PASSWORD"]);
  });

  it("refuses a worker whose role the bootstrap does not know", () => {
    const smoke = structuredClone(inputs.smoke);
    smoke.tasks.audit_outbox_worker.env.OUTBOX_WORKER_DATABASE_URL = "postgresql://passwd_user:smoke@h:5432/d";
    expect(() => rolePasswordBinding({ ...inputs, smoke })).toThrow("role passwd_user has no password variable");
  });

  it("holds every PASSWD_* allowlist key in db, so a new one enters db without another edit", () => {
    const grown = {
      ...inputs,
      allowlist: [...ALLOWLIST, { type: "literal", key: "PASSWD_NEW_PASSWORD", justification: "", consumers: [], reviewedAt: "" } as const],
    };
    expect(rolePasswordBinding(grown).db).toContain("PASSWD_NEW_PASSWORD");
    expect(rolePasswordBinding(inputs).db).not.toContain("PASSWD_NEW_PASSWORD");
  });

  it("names each worker service by its bundle", () => {
    expect(Object.values(inputs.smoke.tasks).map(workerServiceName)).toEqual([
      "audit-outbox-worker",
      "retention-gc-worker",
      "audit-anchor-publisher",
      "audit-chain-verify-worker",
    ]);
  });
});

describe("withheldHolders", () => {
  const inputs = realWithheldInputs();
  const withheld = deriveWithheldEnv(inputs);
  const holders = withheldHolders(withheld, derivePublisherOnlyEnv(inputs), rolePasswordBinding(realRolePasswordInputs()));

  it("names a holder list for every W key", () => {
    expect(Object.keys(holders)).toEqual(withheld);
  });

  it("gives a role password to the services bound to it, and the publisher-only keys to the publisher", () => {
    expect(holders.PASSWD_OUTBOX_WORKER_PASSWORD).toEqual(["audit-outbox-worker", "db"]);
    expect(holders.AUDIT_ANCHOR_SIGNING_KEY).toEqual(["audit-anchor-publisher"]);
  });

  it("gives JACKSON_API_KEY to jackson and the other principals' URLs and SENTRY_AUTH_TOKEN to nobody", () => {
    expect(holders.JACKSON_API_KEY).toEqual(["jackson"]);
    expect(holders.MIGRATION_DATABASE_URL).toEqual([]);
    expect(holders.SENTRY_AUTH_TOKEN).toEqual([]);
  });
});
