import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const PAGE_URL = "https://www.canard.gitd.gov.pl/mapa";
const OUTPUT_FILE = resolve(process.env.CANARD_OUTPUT_FILE ?? "canard.json");
const CONCURRENCY = 8;
const DEFAULT_ITEM_RETRIES = 2;
const DETAIL_REQUEST_DELAY_MS = 1_000;

class DetailUnavailableError extends Error {}
class DetailRequestError extends DetailUnavailableError {}
class EmptyDetailResponseError extends DetailUnavailableError {}

function readItemRetries(args) {
  const inlineOption = args.find((argument) =>
    argument.startsWith("--item-retries="),
  );
  const optionIndex = args.indexOf("--item-retries");
  const value = inlineOption?.split("=", 2)[1] ??
    (optionIndex >= 0 ? args[optionIndex + 1] : undefined) ??
    String(DEFAULT_ITEM_RETRIES);
  const retries = Number(value);

  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error("--item-retries must be a non-negative integer");
  }

  return retries;
}

const ITEM_RETRIES = readItemRetries(process.argv.slice(2));

const definitions = [
  {
    indexPath: "/api/fotoradar/pp",
    detailPath: "/api/fotoradar/",
    category: "point_speed",
    label: "Pomiar punktowy",
  },
  {
    indexPath: "/api/fotoradar/po",
    detailPath: "/api/fotoradar/",
    category: "section_speed",
    label: "Pomiar odcinkowy",
  },
  {
    indexPath: "/api/fotoradar/pc",
    detailPath: "/api/fotoradar/",
    category: "red_light",
    label: "Rejestracja przejazdu na czerwonym świetle",
  },
  {
    indexPath: "/api/punkt",
    detailPath: "/api/punkt/",
    category: "control_point",
    label: "Punkt kontrolny",
  },
];

function decompress(length, resetValue, getNextValue) {
  const dictionary = [0, 1, 2];
  const data = { value: getNextValue(0), position: resetValue, index: 1 };
  let enlargeIn = 4;
  let dictionarySize = 4;
  let bitCount = 3;
  let result = "";

  function readBits(count) {
    let bits = 0;
    let power = 1;
    const maxPower = 2 ** count;

    while (power !== maxPower) {
      const bit = data.value & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.value = getNextValue(data.index);
        data.index += 1;
      }
      if (bit > 0) {
        bits |= power;
      }
      power <<= 1;
    }

    return bits;
  }

  const initialType = readBits(2);
  if (initialType === 2) {
    return "";
  }

  let current = String.fromCharCode(readBits(initialType === 0 ? 8 : 16));
  dictionary[3] = current;
  result = current;

  while (data.index <= length) {
    let code = readBits(bitCount);
    if (code === 0 || code === 1) {
      dictionary[dictionarySize] = String.fromCharCode(
        readBits(code === 0 ? 8 : 16),
      );
      code = dictionarySize;
      dictionarySize += 1;
      enlargeIn -= 1;
    } else if (code === 2) {
      return result;
    }

    if (enlargeIn === 0) {
      enlargeIn = 2 ** bitCount;
      bitCount += 1;
    }

    let entry;
    const dictionaryEntry = dictionary[code];
    if (dictionaryEntry !== undefined) {
      entry = String(dictionaryEntry);
    } else if (code === dictionarySize) {
      entry = current + current.charAt(0);
    } else {
      throw new Error("Invalid LZString payload");
    }

    result += entry;
    dictionary[dictionarySize] = current + entry.charAt(0);
    dictionarySize += 1;
    enlargeIn -= 1;
    current = entry;

    if (enlargeIn === 0) {
      enlargeIn = 2 ** bitCount;
      bitCount += 1;
    }
  }

  throw new Error("Truncated LZString payload");
}

function decompressFromUtf16(input) {
  return decompress(input.length, 16384, (index) => input.charCodeAt(index) - 32);
}

async function fetchResponse(
  url,
  options = {},
  parseResponse = (text) => text,
  attempts = 4,
  request = fetch,
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(url, options);
      const charset = response.headers.get("content-type")
        ?.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1]?.toLowerCase();
      const bytes = new Uint8Array(await response.arrayBuffer());
      const encoding = charset === "utf-16"
        ? (bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : "utf-16be")
        : (charset ?? "utf-8");
      const responseText = new TextDecoder(encoding).decode(bytes);
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}\n${responseText}`,
        );
      }
      return parseResponse(responseText);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(
          `Retrying CANARD request after failed attempt ${attempt}/${attempts}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, attempt * 750),
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("CANARD request failed");
}

function parseApiJson(compressed) {
  const decoded = decompressFromUtf16(compressed);
  if (!decoded) {
    throw new Error("Could not decompress CANARD API response");
  }
  return JSON.parse(decoded);
}

async function createApiSession() {
  const config = await fetchResponse(
    new URL("/config/gui-config.json", PAGE_URL),
    {},
    (text) => {
      const value = JSON.parse(text);
      if (
        typeof value?.api?.urls?.canardPortal !== "string" ||
        !value.api.urls.canardPortal ||
        typeof value?.auth?.enabled !== "boolean" ||
        (value.auth.enabled && (
          typeof value.auth.clientId !== "string" || !value.auth.clientId ||
          typeof value.auth.clientSecret !== "string" || !value.auth.clientSecret
        ))
      ) {
        throw new Error("Invalid CANARD GUI configuration");
      }
      return value;
    },
  );
  const baseUrl = new URL(config.api.urls.canardPortal, PAGE_URL);
  if (baseUrl.origin !== new URL(PAGE_URL).origin) {
    throw new Error("CANARD API must use the device-map origin");
  }
  const apiUrl = (path) => `${baseUrl.href.replace(/\/$/, "")}${path}`;
  const username = `user.${randomUUID()}`;
  let token;
  let pendingLogin;

  async function login() {
    if (!pendingLogin) {
      pendingLogin = fetchResponse(apiUrl("/api/access/authlogin"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: config.auth.clientId,
          client_secret: config.auth.clientSecret,
          username,
          password: randomBytes(8).toString("hex"),
          nonce: randomBytes(16).toString("hex"),
        }),
      }, (text) => {
        const response = JSON.parse(text);
        if (typeof response.access_token !== "string" || !response.access_token) {
          throw new Error("CANARD login did not return an access token");
        }
        token = response.access_token;
      });
    }
    try {
      await pendingLogin;
    } finally {
      pendingLogin = undefined;
    }
  }

  if (config.auth.enabled) {
    await login();
  }

  async function request(url, options) {
    const usedToken = token;
    const send = () => fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        accept: "text/plain;charset=UTF-16",
        referer: PAGE_URL,
        ...(config.auth.enabled ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const response = await send();
    if (response.status !== 401 || !config.auth.enabled) {
      return response;
    }
    await response.arrayBuffer();
    if (token === usedToken) {
      await login();
    }
    return send();
  }

  return { apiUrl, request };
}

async function fetchDetail(item, request) {
  let compressed;
  try {
    compressed = await fetchResponse(
      item.detailUrl, {}, (text) => text, 4, request,
    );
  } catch (error) {
    throw new DetailRequestError(
      `Request failed for ${item.category} object ${item.summary.id}`,
      { cause: error },
    );
  } finally {
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, DETAIL_REQUEST_DELAY_MS),
    );
  }

  if (compressed.length === 0) {
    throw new EmptyDetailResponseError(
      `Empty response for ${item.category} object ${item.summary.id}`,
    );
  }

  const decoded = decompressFromUtf16(compressed);
  if (!decoded) {
    throw new Error(
      `Could not decompress ${item.category} object ${item.summary.id}`,
    );
  }

  const detail = JSON.parse(decoded);
  if (!detail || String(detail.id) !== String(item.summary.id)) {
    throw new Error(
      `ID mismatch for ${item.category}: expected ${item.summary.id}, received ${detail?.id}`,
    );
  }

  return { ...item, detail };
}

async function fetchDetailWithRetry(item, request, previousDetails) {
  for (let attempt = 0; attempt <= ITEM_RETRIES; attempt += 1) {
    try {
      return await fetchDetail(item, request);
    } catch (error) {
      const previousDetail = previousDetails.get(
        `${item.category}:${item.summary.id}`,
      );
      if (
        item.category === "control_point" &&
        error instanceof EmptyDetailResponseError
      ) {
        console.warn(
          `Leaving detail null for ${item.category} object ` +
            `${item.summary.id} after an empty response`,
        );
        return { ...item, detail: null };
      }

      if (error instanceof EmptyDetailResponseError && previousDetail) {
        console.warn(
          `Using previous detail for ${item.category} object ` +
            `${item.summary.id} after an empty response`,
        );
        return { ...item, detail: previousDetail };
      }

      if (attempt === ITEM_RETRIES) {
        if (
          item.category === "control_point" &&
          error instanceof DetailUnavailableError
        ) {
          console.warn(
            `Leaving detail null for ${item.category} object ` +
              `${item.summary.id} after ${ITEM_RETRIES + 1} failed requests`,
          );
          return { ...item, detail: null };
        }

        if (error instanceof DetailUnavailableError && previousDetail) {
          console.warn(
            `Using previous detail for ${item.category} object ` +
              `${item.summary.id} after ${ITEM_RETRIES + 1} failed requests`,
          );
          return { ...item, detail: previousDetail };
        }

        throw error;
      }

      const retryDelayMs = 2 ** attempt * 5_000 + Math.random() * 2_000;
      console.warn(
        `Retrying ${item.category} object ${item.summary.id} ` +
          `after failed attempt ${attempt + 1}/${ITEM_RETRIES + 1}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
    }
  }

  throw new Error(`Could not fetch ${item.category} object ${item.summary.id}`);
}

async function readPreviousDetails() {
  let contents;
  try {
    contents = await readFile(OUTPUT_FILE, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }

  const previousDocument = JSON.parse(contents);
  if (!Array.isArray(previousDocument.records)) {
    throw new Error(`${OUTPUT_FILE} does not contain a records array`);
  }

  return new Map(
    previousDocument.records.map((record) => [
      `${record.category}:${record.summary.id}`,
      record.detail,
    ]),
  );
}

async function fetchAllRecords(previousDetails) {
  const { apiUrl, request } = await createApiSession();
  const items = [];
  for (const definition of definitions) {
    const summaries = await fetchResponse(
      apiUrl(definition.indexPath),
      {},
      (text) => {
        const dataset = parseApiJson(text);
        if (
          !Array.isArray(dataset) ||
          dataset.some((summary) =>
            !summary || typeof summary.id !== "string" || !summary.id ||
            !Number.isFinite(summary.lon) || !Number.isFinite(summary.lat)
          ) ||
          new Set(dataset.map((summary) => summary.id)).size !== dataset.length ||
          (definition.category !== "control_point" && dataset.length === 0)
        ) {
          throw new Error(`Invalid CANARD index for ${definition.category}`);
        }
        return dataset;
      },
      4,
      request,
    );
    if (summaries.length === 0) {
      console.warn("CANARD returned an empty control-point dataset; skipping it");
    }
    items.push(...summaries.map((summary) => ({
      category: definition.category,
      label: definition.label,
      summary,
      detailUrl: apiUrl(definition.detailPath + encodeURIComponent(summary.id)),
    })));
  }
  const records = new Array(items.length);
  let completed = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      records[index] = await fetchDetailWithRetry(
        items[index],
        request,
        previousDetails,
      );
      completed += 1;
      console.info(`CANARD download: ${completed}/${items.length}`);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, items.length) },
      () => worker(),
    ),
  );

  return records;
}

const previousDetails = await readPreviousDetails();
const records = await fetchAllRecords(previousDetails);
const document = {
  schemaVersion: 2,
  count: records.length,
  records,
};

await writeFile(OUTPUT_FILE, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.info(`Wrote ${records.length} CANARD records to ${OUTPUT_FILE}`);
