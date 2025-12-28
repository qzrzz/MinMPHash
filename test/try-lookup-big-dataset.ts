import {
  createMinMPLookupDict,
  MinMPLookup,
  IValidationMode,
} from "../src/index";
import * as fs from "fs";
import * as path from "path";
import { compressIBinary } from "../src/util";

const __dirname = import.meta.dirname;
const distDir = path.join(__dirname, "dist", "lookup-big-dataset");

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Configuration
const datasetSize =
  parseInt(process.argv[2] || process.env.DATASET_SIZE || "0", 10) || 100_000;

// ANSI Colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

console.log(
  `\n${c.bold}${c.magenta}=== MinMPLookup Big Dataset Size Benchmark ===${c.reset}`
);
console.log(
  `Generating dataset of size ${c.green}${datasetSize}${c.reset} values...`
);

// Generate Data
// We want to simulate a reverse lookup scenario.
// Let's say we have keys like "Key-X" and values like "Value-Y".
// We'll assign multiple values to each key to simulate a real lookup map.
const valuesPerKey = 20;
const keyCount = Math.ceil(datasetSize / valuesPerKey);
const lookupMap: Record<string, string[]> = {};
const allValues: string[] = [];

for (let i = 0; i < keyCount; i++) {
  const key = `Key-${i.toString(36).padStart(5, "0")}`;
  const values: string[] = [];
  for (let j = 0; j < valuesPerKey; j++) {
    const valIdx = i * valuesPerKey + j;
    if (valIdx >= datasetSize) break;
    // Generate a somewhat realistic value string
    const val = `V-${valIdx}-${getRandomUnicodeString(22)}`;
    values.push(val);
    allValues.push(val);
  }
  lookupMap[key] = values;
}

console.log(
  `${c.bold}Dataset stats:${c.reset} ${c.green}${
    Object.keys(lookupMap).length
  }${c.reset} keys, ${c.green}${allValues.length}${c.reset} values\n`
);

// Calculate raw JSON size
let datasetJson = JSON.stringify(lookupMap);
let datasetGZip = await compressIBinary(Buffer.from(datasetJson, "utf8"));
console.log(
  "Dataset json size:".padEnd(25),
  c.yellow +
    (Buffer.byteLength(datasetJson, "utf8") / 1024).toFixed(2) +
    c.reset +
    " KB"
);
console.log(
  "Dataset json gzip size:".padEnd(25),
  c.green + (datasetGZip.length / 1024).toFixed(2) + c.reset + " KB\n"
);

const onlySetOptions: IValidationMode[] = ["none", "2", "4", "8", "16", "32"];
const level = 5;

(async () => {
  // Group Header
  console.log(`${c.bold}${c.cyan}➤ Optimization Level ${level}${c.reset}`);
  console.log(
    `${c.dim}  ┌──────────┬──────────────┬──────────────────────┬──────────────────────┬──────────────┬──────────────┐${c.reset}`
  );
  console.log(
    `  │ ${c.bold}${"OnlySet".padEnd(9)}${c.reset}│ ${
      c.bold
    }${"JSON Size".padEnd(13)}${c.reset}│ ${
      c.bold
    }${"Binary Size (Ratio)".padEnd(21)}${c.reset}│ ${
      c.bold
    }${"Gzip Size (Ratio)".padEnd(21)}${c.reset}│ ${c.bold}${"vs None".padEnd(
      13
    )}${c.reset}│ ${c.bold}${"Build Time".padEnd(13)}${c.reset}│`
  );
  console.log(
    `${c.dim}  ├──────────┼──────────────┼──────────────────────┼──────────────────────┼──────────────┼──────────────┤${c.reset}`
  );

  let baselineBinarySize = 0;

  for (const onlySet of onlySetOptions) {
    try {
      // 1. Create Dictionary Object (JSON structure)
      const start = performance.now();
      const dictObj = createMinMPLookupDict(lookupMap, {
        level: level,
        onlySet: onlySet,
        outputBinary: false,
        enableCompression: false,
      });
      const end = performance.now();
      const buildTime = (end - start).toFixed(2);

      // Verify correctness (Basic check)
      const lookup = new MinMPLookup(dictObj);
      if (allValues.length > 0) {
        const firstVal = allValues[0];
        const lastVal = allValues[allValues.length - 1];
        if (!lookup.query(firstVal))
          throw new Error(`Validation Failed: ${firstVal} not found`);
        if (!lookup.query(lastVal))
          throw new Error(`Validation Failed: ${lastVal} not found`);
      }

      // Calculate JSON size of the dictionary object
      const jsonString = JSON.stringify(dictObj, (key, value) => {
        if (value instanceof Uint8Array) return Array.from(value);
        return value;
      });
      const jsonSizeVal = jsonString.length / 1024;
      const jsonSizeKB = jsonSizeVal.toFixed(2);

      // 2. Create Binary
      const dictBinary = createMinMPLookupDict(lookupMap, {
        level: level,
        onlySet: onlySet,
        outputBinary: true,
        enableCompression: false,
      }) as Uint8Array;

      // Save Binary
      const binaryFilename = `lookup_L${level}_S${onlySet}.bin`;
      fs.writeFileSync(path.join(distDir, binaryFilename), dictBinary);

      const binarySizeVal = dictBinary.length / 1024;
      const binarySizeKB = binarySizeVal.toFixed(2);

      // 3. Create Compressed Binary (Gzip)
      const dictCompressed = await createMinMPLookupDict(lookupMap, {
        level: level,
        onlySet: onlySet,
        outputBinary: true,
        enableCompression: true,
      });

      // Save Compressed Binary
      const compressedFilename = `lookup_L${level}_S${onlySet}.bin.gz`;
      fs.writeFileSync(path.join(distDir, compressedFilename), dictCompressed);

      const gzipSizeVal = dictCompressed.length / 1024;
      const gzipSizeKB = gzipSizeVal.toFixed(2);

      // Capture baseline
      if (onlySet === "none") {
        baselineBinarySize = binarySizeVal;
      }

      // Calculate Ratio (Binary / JSON)
      const ratio = ((binarySizeVal / jsonSizeVal) * 100).toFixed(0);
      const gzipRatio = ((gzipSizeVal / jsonSizeVal) * 100).toFixed(0);

      // Calculate vs None
      let vsNoneStr = "-";
      let vsNoneColor = c.dim;

      if (baselineBinarySize > 0) {
        const pct = ((binarySizeVal / baselineBinarySize) * 100).toFixed(1);
        vsNoneStr = `${pct} %`;
        vsNoneColor = c.yellow;
        if (onlySet === "none") {
          vsNoneColor = c.dim;
        }
      }

      // Colorize
      let sizeColor = c.reset;
      if (binarySizeVal < 1024) sizeColor = c.green;
      else if (binarySizeVal < 5120) sizeColor = c.yellow;
      else sizeColor = c.red;

      let gzipColor = c.reset;
      if (gzipSizeVal < 1024) gzipColor = c.green;
      else if (gzipSizeVal < 5120) gzipColor = c.yellow;
      else gzipColor = c.red;

      // Column formatting
      const col1 = ` ${onlySet.padEnd(9)}`;
      const col2 = ` ${jsonSizeKB.padStart(9)} KB `;

      const binPart = binarySizeKB.padStart(7);
      const ratioPart = ` KB (${ratio.padStart(3)}%)`;
      const restPart = ratioPart.padEnd(13);
      const col3 = ` ${sizeColor}${binPart}${c.reset}${c.dim}${restPart}${c.reset} `;

      const gzipPart = gzipSizeKB.padStart(7);
      const gzipRatioPart = ` KB (${gzipRatio.padStart(3)}%)`;
      const gzipRestPart = gzipRatioPart.padEnd(13);
      const col4 = ` ${gzipColor}${gzipPart}${c.reset}${c.dim}${gzipRestPart}${c.reset} `;

      const col5 = ` ${vsNoneColor}${vsNoneStr.padStart(12)}${c.reset} `;
      const col6 = ` ${c.green}${buildTime.padStart(9)} ms${c.reset} `;

      console.log(`  │${col1}│${col2}│${col3}│${col4}│${col5}│${col6}│`);
    } catch (e) {
      console.log(
        `  │ ${onlySet.padEnd(9)}│ ${c.red}Error: ${(
          e as Error
        ).message.substring(0, 50)}...${c.reset}`
      );
    }
  }
  console.log(
    `${c.dim}  └──────────┴──────────────┴──────────────────────┴──────────────────────┴──────────────┴──────────────┘${c.reset}\n`
  );
})();

function getRandomUnicodeString(len: number): string {
  let result = "";
  for (let i = 0; i < len; i++) {
    const randomCodePoint =
      Math.floor(Math.random() * (0x9fff - 0x4e00)) + 0x4e00; // CJK Unified Ideographs
    result += String.fromCharCode(randomCodePoint);
  }
  return result;
}
