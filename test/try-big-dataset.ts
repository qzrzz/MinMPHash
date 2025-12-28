import { createMinMPHashDict, IValidationMode } from "../src/index";
import * as fs from "fs";
import * as path from "path";
import { compressIBinary } from "../src/util";
const __dirname = import.meta.dirname;
const distDir = path.join(__dirname, "dist", "big-dataset");

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Configuration
const datasetSize = parseInt(
  process.argv[2] || process.env.DATASET_SIZE || "100000",
  10
);

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
  `\n${c.bold}${c.magenta}=== MinMPHash Big Dataset Size Benchmark ===${c.reset}`
);
console.log(`Generating dataset of size ${c.green}${datasetSize}${c.reset}...`);

const names = Array.from(
  { length: datasetSize },
  (_, i) => `item-${i}-${i.toString(16).padStart(8, "0")}-${i.toString(2)}`
);

console.log(
  `${c.bold}Dataset size:${c.reset} ${c.green}${names.length}${c.reset} items\n`
);

let datasetJson = JSON.stringify(names);
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
    // 1. Create Dictionary Object
    const start = performance.now();
    const dictObj = createMinMPHashDict(names, {
      level: level,
      onlySet: onlySet,
      outputBinary: false,
    });
    const end = performance.now();
    const buildTime = (end - start).toFixed(2);

    // Calculate JSON size
    const jsonString = JSON.stringify(dictObj, (key, value) => {
      if (
        value instanceof Uint8Array ||
        value instanceof Uint16Array ||
        value instanceof Uint32Array ||
        value instanceof Int32Array
      ) {
        return Array.from(value);
      }
      return value;
    });
    const jsonSizeVal = jsonString.length / 1024;
    const jsonSizeKB = jsonSizeVal.toFixed(2);

    // 2. Create Binary (CBOR)
    const dictBinary = createMinMPHashDict(names, {
      level: level,
      onlySet: onlySet,
      outputBinary: true,
    }) as Uint8Array;

    // Save Binary
    const binaryFilename = `dict_L${level}_S${onlySet}.bin`;
    fs.writeFileSync(path.join(distDir, binaryFilename), dictBinary);

    const binarySizeVal = dictBinary.length / 1024;
    const binarySizeKB = binarySizeVal.toFixed(2);

    // 3. Create Compressed Binary (Gzip)
    const dictCompressed = await createMinMPHashDict(names, {
      level: level,
      onlySet: onlySet,
      outputBinary: true,
      enableCompression: true,
    });

    // Save Compressed Binary
    const compressedFilename = `dict_L${level}_S${onlySet}.bin.gz`;
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
    const pct = ((binarySizeVal / baselineBinarySize) * 100).toFixed(1);
    let vsNoneStr = `${pct} %`;
    let vsNoneColor = c.yellow;

    if (onlySet === "none") {
      vsNoneColor = c.dim;
    }

    // Colorize based on size (adjusted for big dataset)
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
  }
  console.log(
    `${c.dim}  └──────────┴──────────────┴──────────────────────┴──────────────────────┴──────────────┴──────────────┘${c.reset}\n`
  );
})();
