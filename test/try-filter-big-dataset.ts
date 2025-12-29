import {
  createMinMPHFilterDict,
  MinMPHFilter,
  IMinMPHFilterOptions,
} from "../src/MinMPHFilter";
import * as fs from "fs";
import * as path from "path";
import { compressIBinary } from "../src/util";

const __dirname = import.meta.dirname;
const distDir = path.join(__dirname, "dist", "filter-big-dataset");

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
  `\n${c.bold}${c.magenta}=== MinMPHFilter Big Dataset Benchmark ===${c.reset}`
);
console.log(`Generating dataset of size ${c.green}${datasetSize}${c.reset}...`);

const names = Array.from(
  { length: datasetSize },
  (_, i) => `item-${i}-${getRandomUnicodeString(33)}`
);

const negativeNames = Array.from(
  { length: datasetSize },
  (_, i) => `not-in-set-${i}-${getRandomUnicodeString(32)}`
);

console.log(
  `${c.bold}Dataset size:${c.reset} ${c.green}${names.length}${c.reset} items\n`
);

// Calculate raw JSON size
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

const bitKeys: IMinMPHFilterOptions["bitKey"][] = [
  "6",
  "8",
  "10",
  "12",
  "14",
  "16",
];

(async () => {
  console.log(
    `${c.dim}  ┌────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐${c.reset}`
  );
  console.log(
    `  │ ${c.bold}${"BitKey".padEnd(7)}${c.reset}│ ${
      c.bold
    }${"Binary Size".padEnd(13)}${c.reset}│ ${c.bold}${"Gzip Size".padEnd(13)}${
      c.reset
    }│ ${c.bold}${"Build (ms)".padEnd(13)}${c.reset}│ ${
      c.bold
    }${"Query 1 (ms)".padEnd(13)}${c.reset}│ ${c.bold}${"FPR (%)".padEnd(13)}${
      c.reset
    }│`
  );
  console.log(
    `${c.dim}  ├────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────┤${c.reset}`
  );

  for (const bitKey of bitKeys) {
    try {
      // 1. Build Filter
      const startBuild = performance.now();
      const dictBinary = createMinMPHFilterDict(names, {
        bitKey,
        outputBinary: true,
        enableCompression: false,
      }) as Uint8Array;
      const endBuild = performance.now();
      const buildTime = endBuild - startBuild;

      // 2. Compressed Size
      const dictCompressed = await compressIBinary(dictBinary);
      const binarySizeKB = dictBinary.length / 1024;
      const gzipSizeKB = dictCompressed.length / 1024;

      // 3. Query Performance & FPR
      const filter = new MinMPHFilter(dictBinary);

      // Positive queries (should all be true)
      const startPositive = performance.now();
      const positiveTestCount = Math.min(names.length, 10000);
      for (let i = 0; i < positiveTestCount; i++) {
        if (!filter.has(names[i])) {
          throw new Error(`False negative at index ${i}`);
        }
      }
      const endPositive = performance.now();
      const positiveQueryTime = endPositive - startPositive;

      // Save Binary
      const binaryFilename = `filter_B${bitKey}.bin`;
      fs.writeFileSync(path.join(distDir, binaryFilename), dictBinary);

      // Negative queries (FPR check)
      let falsePositives = 0;
      const startNegative = performance.now();
      const negativeTestCount = Math.min(negativeNames.length, 100000);
      for (let i = 0; i < negativeTestCount; i++) {
        if (filter.has(negativeNames[i])) {
          falsePositives++;
        }
      }
      const endNegative = performance.now();
      const negativeQueryTime = endNegative - startNegative;

      const fpr = (falsePositives / negativeTestCount) * 100;
      const totalQueryTime = positiveQueryTime + negativeQueryTime;
      const avgQueryTime = (totalQueryTime / (positiveTestCount + negativeTestCount))  

      // Formatting
      const col1 = ` ${bitKey!.padEnd(7)}`;
      const col2 = ` ${binarySizeKB.toFixed(2).padStart(9)} KB `;
      const col3 = ` ${gzipSizeKB.toFixed(2).padStart(9)} KB `;
      const col4 = ` ${buildTime.toFixed(1).padStart(9)} ms `;
      const col5 = ` ${avgQueryTime.toFixed(4).padStart(9)} ms `;

      let fprColor = c.reset;
      if (fpr < 0.1) fprColor = c.green;
      else if (fpr < 1) fprColor = c.yellow;
      else fprColor = c.red;

      const col6 = ` ${fprColor}${fpr.toFixed(4).padStart(11)}%${c.reset} `;

      console.log(`  │${col1}│${col2}│${col3}│${col4}│${col5}│${col6}│`);
    } catch (e) {
      console.log(
        `  │ ${bitKey!.padEnd(7)}│ ${c.red}Error: ${(
          e as Error
        ).message.substring(0, 50)}...${c.reset}`
      );
    }
  }

  console.log(
    `${c.dim}  └────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘${c.reset}\n`
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
