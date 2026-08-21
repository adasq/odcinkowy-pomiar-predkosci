import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PAGE_URL = "https://www.canard.gitd.gov.pl/cms/o-nas/mapa-urzadzen";
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const OUTPUT_FILE = resolve(process.env.CANARD_OUTPUT_FILE ?? "canard.json");
const CONCURRENCY = 8;

const definitions = [
  {
    configKey: "fotoradaryPP",
    detailUrlKey: "objPPDataURL",
    legacyType: "PP",
    category: "point_speed",
    label: "Pomiar punktowy",
  },
  {
    configKey: "fotoradaryOPP",
    detailUrlKey: "objOPPDataURL",
    legacyType: "OPP",
    category: "section_speed",
    label: "Pomiar odcinkowy",
  },
  {
    configKey: "fotoradaryRL",
    detailUrlKey: "objRLDataURL",
    legacyType: "RL",
    category: "red_light",
    label: "Rejestracja przejazdu na czerwonym świetle",
  },
  {
    configKey: "punktyKontrolne",
    detailUrlKey: "objPKDataURL",
    legacyType: "PK",
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

function decompressFromBase64(input) {
  return decompress(input.length, 32, (index) =>
    BASE64_ALPHABET.indexOf(input.charAt(index)),
  );
}

function decompressFromUtf16(input) {
  return decompress(input.length, 16384, (index) => input.charCodeAt(index) - 32);
}

function extractDataset(html, key) {
  const configured = html.match(new RegExp(`${key}\\s*:\\s*"([^"]*)"`));
  if (configured) {
    return configured[1];
  }

  const legacy = html.match(
    new RegExp(
      `const\\s+${key}\\s*=\\s*LZString\\.decompressFromBase64\\("([^"]+)"\\)`,
    ),
  );
  if (!legacy) {
    throw new Error(`Could not find map dataset: ${key}`);
  }
  return legacy[1];
}

function extractNamespace(html) {
  const configured = html.match(/namespace\s*:\s*"([^"]*)"/);
  if (configured) {
    return configured[1];
  }

  const legacy = html.match(/([A-Za-z0-9_]+_)id\s*:\s*id/);
  if (!legacy) {
    throw new Error("Could not find map configuration key: namespace");
  }
  return legacy[1];
}

function extractDetailUrl(html, key, legacyType) {
  const configured = html.match(new RegExp(`${key}\\s*:\\s*"([^"]*)"`));
  if (configured) {
    return configured[1].replaceAll("&amp;", "&");
  }

  const legacy = html.match(
    new RegExp(
      `showObjDataById\\("([^"]*[?&][^"]*_type=${legacyType})"`,
    ),
  );
  if (!legacy) {
    throw new Error(`Could not find map configuration key: ${key}`);
  }
  return legacy[1].replaceAll("&amp;", "&");
}

async function fetchText(url, options = {}, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
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

function parseIndex(html) {
  const namespace = extractNamespace(html);
  const items = definitions.flatMap((definition) => {
    const detailUrl = extractDetailUrl(
      html,
      definition.detailUrlKey,
      definition.legacyType,
    );
    const decoded = decompressFromBase64(
      extractDataset(html, definition.configKey),
    );
    if (!decoded) {
      throw new Error(
        `Could not decompress map dataset: ${definition.configKey}`,
      );
    }

    return JSON.parse(decoded).map((summary) => ({
      category: definition.category,
      label: definition.label,
      summary,
      detailUrl,
    }));
  });

  return { namespace, items };
}

async function fetchDetail(item, namespace) {
  const compressed = await fetchText(item.detailUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      referer: PAGE_URL,
    },
    body: new URLSearchParams({
      [`${namespace}id`]: String(item.summary.id),
    }),
  });
  const decoded = decompressFromUtf16(compressed);
  if (!decoded) {
    throw new Error(
      `Could not decompress ${item.category} object ${item.summary.id}`,
    );
  }

  const detail = JSON.parse(decoded);
  if (String(detail.id) !== String(item.summary.id)) {
    throw new Error(
      `ID mismatch for ${item.category}: expected ${item.summary.id}, received ${detail.id}`,
    );
  }

  return { ...item, detail };
}

async function fetchAllRecords() {
  const html = await fetchText(PAGE_URL);
  const { namespace, items } = parseIndex(html);
  const records = new Array(items.length);
  let completed = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      records[index] = await fetchDetail(items[index], namespace);
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

const records = await fetchAllRecords();
const document = {
  count: records.length,
  records,
};

await writeFile(OUTPUT_FILE, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.info(`Wrote ${records.length} CANARD records to ${OUTPUT_FILE}`);
