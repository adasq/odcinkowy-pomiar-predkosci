import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(new URL("./fetch-canard.mjs", import.meta.url));
const SUMMARY = "\u1b63\u3c31\u014c\u0286\u0303\u012c\u602d\u0c21\u583e\u605b\u1c24\u6043\u1554\u0822\u73a0\u2b4e\u019c\u0309\u0020\u0020";
const CONTROL = "\u1b63\u3c31\u014c\u0286\u0303\u00ac\u602d\u0c21\u583e\u605b\u1c24\u660a\u3424\u1822\u73a0\u2b20\u6621\u3e22\u74a0\u0020";
const DETAIL = "\u1be1\u0845\u406c\u207c\u1063\u0823\u2120\u7622\u3839\u2073\u1a29\u7035\u457c\u30a0\u18ee\u00d6\u1c36\u202d\u4c2a\u6022\u75e0\u02ba\u2c40\u0d80\u1ee0\u33c9\u1838\u00fa\u5021\u6e90\u68bb\u7ab1\u102a\u6020\u6120\u0c00\u0bcc\u5420\u0020";
const CONTROL_DETAIL = "\u1be1\u0845\u406c\u207c\u1043\u082b\u7220\u0020";
const EMPTY = "\u1b62\u74a0\u0020";
const INVALID_SUMMARY = "\u1b63\u3c4f\u4194\u4020\u0020";
const WRONG_DETAIL = "\u1be1\u0845\u406c\u207c\u1097\u00bc\u07d0\u0ee0\u7330\u0c04\u0020\u0020";

async function runUpdater(settings = {}) {
  const directory = await mkdtemp(join(fileURLToPath(new URL("../", import.meta.url)), ".fetch-canard-test-"));
  const outputFile = join(directory, "canard.json");
  const previousContents = JSON.stringify(settings.previousDocument ?? { count: 0, records: [] });
  const preload = `
    globalThis.setTimeout = (callback) => callback();
    const settings = ${JSON.stringify(settings)};
    const summary = ${JSON.stringify(SUMMARY)};
    const detail = ${JSON.stringify(DETAIL)};
    const control = ${JSON.stringify(CONTROL)};
    const controlDetail = ${JSON.stringify(CONTROL_DETAIL)};
    const empty = ${JSON.stringify(EMPTY)};
    const counts = new Map();
    let logins = 0;
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname;
      const count = (counts.get(path) ?? 0) + 1;
      counts.set(path, count);
      console.info("Request " + path + " " + count);
      if (path === "/config/gui-config.json") {
        return Response.json(settings.config ?? {
          api: { urls: { canardPortal: "/portal" } },
          auth: { enabled: settings.authEnabled !== false, clientId: "test-client", clientSecret: "test-secret" },
        });
      }
      if (path === "/portal/api/access/authlogin") {
        const body = JSON.parse(options.body);
        if (options.method !== "POST" || body.client_id !== "test-client" ||
            body.client_secret !== "test-secret" || !/^user\\.[a-f0-9-]{36}$/.test(body.username) ||
            !/^[a-f0-9]{16}$/.test(body.password) || !/^[a-f0-9]{32}$/.test(body.nonce)) {
          throw new Error("Invalid anonymous login request");
        }
        console.info("Login " + (++logins));
        return Response.json(settings.invalidLogin ? {} : { access_token: "token-" + logins });
      }
      if (options.method && options.method !== "GET") throw new Error("API requests must use GET");
      if (options.headers.accept !== "text/plain;charset=UTF-16" ||
          options.headers.referer !== "https://www.canard.gitd.gov.pl/mapa") {
        throw new Error("Invalid API headers");
      }
      if (settings.authEnabled !== false && options.headers.authorization !== "Bearer token-" + logins) {
        throw new Error("Invalid bearer token");
      }
      if (settings.authEnabled === false && options.headers.authorization) throw new Error("Unexpected bearer token");
      const isDetail = path === "/portal/api/fotoradar/a" || path === "/portal/api/punkt/b";
      if (isDetail) {
        console.info("Detail request");
        if (settings.expireToken && options.headers.authorization === "Bearer token-1") {
          return new Response("", { status: 401 });
        }
      }
      let text;
      const responses = settings.responses?.[path];
      if (responses) {
        const entry = responses[Math.min(count - 1, responses.length - 1)];
        if (entry.status) return new Response("Unavailable", { status: entry.status });
        text = entry.body;
      } else if (path === "/portal/api/punkt") {
        text = settings.controlPoints ? control : empty;
      } else if (["/portal/api/fotoradar/pp", "/portal/api/fotoradar/po", "/portal/api/fotoradar/pc"].includes(path)) {
        text = summary;
      } else if (isDetail) {
        text = path.endsWith("/b") ? controlDetail : detail;
      } else {
        throw new Error("Unexpected URL " + path);
      }
      const encoding = settings.encoding ?? "utf-16be";
      if (encoding === "utf-8") return new Response(text);
      const bytes = Buffer.from((settings.noBom ? "" : "\\ufeff") + text, "utf16le");
      if (encoding === "utf-16be") bytes.swap16();
      return new Response(bytes, { headers: { "content-type": "text/plain;charset=UTF-16" } });
    };
  `;

  try {
    await writeFile(outputFile, previousContents);
    const result = spawnSync(process.execPath, [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      SCRIPT_FILE,
      "--item-retries",
      "0",
    ], {
      env: { ...process.env, CANARD_OUTPUT_FILE: outputFile },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    const contents = await readFile(outputFile, "utf8");
    if (result.status !== 0) assert.equal(contents, previousContents);
    return { ...result, document: JSON.parse(contents) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const encoding of ["utf-16be", "utf-16le", "utf-8"]) {
  test(`downloads all API categories with ${encoding} transport`, async () => {
    const result = await runUpdater({ controlPoints: true, encoding });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.document.schemaVersion, 2);
    assert.equal(result.document.count, 4);
    assert.deepEqual(result.document.records.map((record) => record.category),
      ["point_speed", "section_speed", "red_light", "control_point"]);
    assert.deepEqual(result.document.records[0], {
      category: "point_speed",
      label: "Pomiar punktowy",
      summary: { id: "a", lon: 21, lat: 52 },
      detailUrl: "https://www.canard.gitd.gov.pl/portal/api/fotoradar/a",
      detail: { id: "a", nrSeryjny: "camera", limityPredkosci: [{ wartosc: "50" }] },
    });
    assert.equal(result.document.records[3].detail.id, "b");
    assert.match(result.stdout, /Login 1/);
    assert.doesNotMatch(JSON.stringify(result.document), /test-secret|token-1/);
  });
}

test("supports UTF-16 big-endian responses without a BOM", async () => {
  const result = await runUpdater({ noBom: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.document.count, 3);
});

test("skips an empty control-point index with a warning", async () => {
  const result = await runUpdater();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.document.count, 3);
  assert.match(result.stderr, /empty control-point dataset/);
});

test("supports disabled API authentication", async () => {
  const result = await runUpdater({ authEnabled: false });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Login/);
});

test("renews an expired token once for concurrent detail requests", async () => {
  const result = await runUpdater({ expireToken: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Login 2/);
  assert.doesNotMatch(result.stdout, /Login 3/);
  assert.equal(result.document.count, 3);
});

test("retries an invalid API index before downloading details", async () => {
  const result = await runUpdater({
    responses: { "/portal/api/fotoradar/pp": [{ body: INVALID_SUMMARY }, { body: SUMMARY }] },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Request \/portal\/api\/fotoradar\/pp 2/);
  assert.match(result.stderr, /Invalid CANARD index for point_speed/);
});

for (const body of [INVALID_SUMMARY, EMPTY, "malformed compressed response"]) {
  test(`rejects invalid or empty required index ${JSON.stringify(body)}`, async () => {
    const result = await runUpdater({
      responses: { "/portal/api/fotoradar/pp": [{ body }] },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Request \/portal\/api\/fotoradar\/pp 4/);
    assert.doesNotMatch(result.stdout, /Detail request/);
    assert.equal(result.document.count, 0);
  });
}

test("rejects invalid GUI configuration without downloading details", async () => {
  const result = await runUpdater({ config: {} });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid CANARD GUI configuration/);
  assert.doesNotMatch(result.stdout, /Detail request/);
});

test("rejects a cross-origin API configuration", async () => {
  const result = await runUpdater({
    config: { api: { urls: { canardPortal: "https://example.test" } }, auth: { enabled: false } },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use the device-map origin/);
});

test("rejects a login response without a token", async () => {
  const result = await runUpdater({ invalidLogin: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not return an access token/);
  assert.doesNotMatch(result.stdout, /Detail request/);
});

test("rejects mismatched detail IDs without overwriting the output", async () => {
  const result = await runUpdater({
    responses: { "/portal/api/fotoradar/a": [{ body: WRONG_DETAIL }] },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ID mismatch/);
});

for (const response of [{ body: "" }, { status: 503 }]) {
  test(`preserves previous details after unavailable response ${JSON.stringify(response)}`, async () => {
    const previousDetail = { id: "a", nrSeryjny: "previous" };
    const result = await runUpdater({
      previousDocument: {
        schemaVersion: 2,
        count: 3,
        records: ["point_speed", "section_speed", "red_light"].map((category) => ({
          category, summary: { id: "a" }, detail: previousDetail,
        })),
      },
      responses: { "/portal/api/fotoradar/a": [response] },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.document.records.every((record) => record.detail.nrSeryjny === "previous"));
    assert.match(result.stderr, /Using previous detail/);
  });
}

test("stores unavailable control-point details as null", async () => {
  const result = await runUpdater({
    controlPoints: true,
    responses: { "/portal/api/punkt/b": [{ body: "" }] },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.document.records[3].detail, null);
  assert.match(result.stderr, /Leaving detail null/);
});

test("fails when required details are unavailable without a previous record", async () => {
  const result = await runUpdater({
    responses: { "/portal/api/fotoradar/a": [{ body: "" }] },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Empty response/);
});
