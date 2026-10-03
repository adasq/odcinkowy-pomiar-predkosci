import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(new URL("./fetch-canard.mjs", import.meta.url));
const COMPRESSED_RECORD = "NobwRAlgJmBcCMBfAukA";
const COMPRESSED_CONTROL_POINT = "NobwRAlgJmBcBMBfAukA";
const DATASETS = ["fotoradaryPP", "fotoradaryOPP", "fotoradaryRL", "punktyKontrolne"];
const DETAIL_URLS = ["objPPDataURL", "objOPPDataURL", "objRLDataURL", "objPKDataURL"];
const TYPES = ["PP", "OPP", "RL", "PK"];

function mapHtml(controlPoints, legacy) {
  const configuration = legacy
    ? 'map_id:id'
    : 'namespace:"map_"';

  return [
    configuration,
    ...DATASETS.map((key, index) => {
      const dataset = index === 3 ? controlPoints : COMPRESSED_RECORD;
      return legacy
        ? `const ${key} = LZString.decompressFromBase64("${dataset}")`
        : `${key}:"${dataset}"`;
    }),
    ...DETAIL_URLS.map((key, index) => {
      const url = `https://example.test/details?map_type=${TYPES[index]}`;
      return legacy
        ? `showObjDataById("${url}", id)`
        : `${key}:"${url}"`;
    }),
  ].join("\n");
}

async function runUpdater(controlPoints, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), "fetch-canard-test-"));
  const outputFile = join(directory, "canard.json");
  const previousContents = '{"count":0,"records":[]}\n';
  const preload = `
    globalThis.setTimeout = (callback) => callback();
    globalThis.fetch = async (url, options) => {
      if (options?.method !== "POST") {
        return new Response(${JSON.stringify(mapHtml(controlPoints, legacy))});
      }
      const id = options.body.get("map_id");
      if (id !== "1" && id !== "2") {
        throw new Error("Unexpected detail request for ID " + id);
      }
      const details = {
        "1": "\\u1be1\\u0845\\u406c\\u207c\\u0480\\u2fb0 ",
        "2": "\\u1be1\\u0845\\u406c\\u207c\\u0280\\u2fb0 ",
      };
      return new Response(details[id]);
    };
  `;

  try {
    await writeFile(outputFile, previousContents);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        SCRIPT_FILE,
        "--item-retries",
        "0",
      ],
      {
        env: { ...process.env, CANARD_OUTPUT_FILE: outputFile },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    const contents = await readFile(outputFile, "utf8");
    if (result.status !== 0) {
      assert.equal(contents, previousContents);
    }
    return { ...result, document: JSON.parse(contents) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const placeholder of ["[{}]", "[]"]) {
  test(`skips the uncompressed control-point placeholder ${placeholder}`, async () => {
    const result = await runUpdater(placeholder);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.document.count, 3);
    assert.deepEqual(
      result.document.records.map((record) => record.category),
      ["point_speed", "section_speed", "red_light"],
    );
    assert.ok(result.document.records.every((record) => record.detail.id === 1));
    assert.match(result.stderr, /empty control-point dataset/);
  });
}

test("preserves compressed empty control-point datasets", async () => {
  const result = await runUpdater("NoXSA===");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.document.count, 3);
});

for (const legacy of [false, true]) {
  test(`downloads compressed control points with ${legacy ? "legacy" : "configured"} map data`, async () => {
    const result = await runUpdater(COMPRESSED_CONTROL_POINT, legacy);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.document.count, 4);
    assert.equal(result.document.records[3].category, "control_point");
    assert.equal(result.document.records[3].summary.id, 2);
    assert.equal(result.document.records[3].detail.id, 2);
  });
}

test("rejects malformed control-point data without overwriting the output", async () => {
  const result = await runUpdater("[invalid]");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid LZString payload/);
});
