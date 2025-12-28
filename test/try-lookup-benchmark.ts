import { createMinMPLookupDict, IValidationMode } from "../src/index";
import * as fs from "fs";
import * as path from "path";
import { writeVarInt } from "../src/util";

const __dirname = import.meta.dirname;
const distDir = path.join(__dirname, "dist", "benchmark-lookup");

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Load names-map.json
const mapPath = path.join(__dirname, "names-map.json");
const lookupMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));

const levels = [5, 7];
const onlySetOptions: IValidationMode[] = ["none", "4", "8", "16"];

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

// Calculate total items
let totalValues = 0;
for (const key in lookupMap) {
  totalValues += lookupMap[key].length;
}

console.log(
  `\n${c.bold}${c.magenta}=== MinMPLookup Dictionary Size Benchmark ===${c.reset}`
);
console.log(
  `${c.bold}Dataset:${c.reset} ${c.green}${Object.keys(lookupMap).length}${
    c.reset
  } keys, ${c.green}${totalValues}${c.reset} values\n`
);

(async () => {
  for (const level of levels) {
    console.log(`${c.bold}${c.cyan}➤ Optimization Level ${level}${c.reset}`);

    const results: any[] = [];

    for (const onlySet of onlySetOptions) {
      try {
        // 1. Create Dict Object
        const dictObj = createMinMPLookupDict(lookupMap, {
          level,
          onlySet,
          outputBinary: false,
          enableCompression: false,
        });

        // Calculate JSON Size
        const jsonString = JSON.stringify(dictObj, (key, value) => {
          if (value instanceof Uint8Array) return Array.from(value);
          return value;
        });
        const jsonSizeVal = jsonString.length / 1024;

        // Calculate Component Sizes
        const encoder = new TextEncoder();

        // MPHF Size
        const mphfSize = dictObj.mmpHashDictBin.length + 4;

        // Keys Size
        let keysSize = 4;
        for (const key of dictObj.keys) {
          const keyBytes = encoder.encode(key);
          keysSize += 4 + keyBytes.length;
        }

        // KeyToHashes Size
        const hashBuffer: number[] = [];
        for (const hashes of dictObj.keyToHashes) {
          writeVarInt(hashes.length, hashBuffer);
          let prev = 0;
          for (let i = 0; i < hashes.length; i++) {
            const h = hashes[i];
            writeVarInt(h - prev, hashBuffer);
            prev = h;
          }
        }
        const keyToHashesSize = 4 + hashBuffer.length;

        const totalCalculated = mphfSize + keysSize + keyToHashesSize;

        // 2. Binary Size (Actual)
        const dictBinary = createMinMPLookupDict(lookupMap, {
          level,
          onlySet,
          outputBinary: true,
          enableCompression: false,
        }) as Uint8Array;

        const binarySizeVal = dictBinary.length / 1024;

        // 3. Compressed Size
        const dictCompressed = await createMinMPLookupDict(lookupMap, {
          level,
          onlySet,
          outputBinary: true,
          enableCompression: true,
        });

        const gzipSizeVal = dictCompressed.length / 1024;

        results.push({
          onlySet,
          jsonSizeVal,
          binarySizeVal,
          gzipSizeVal,
          mphfSize,
          keysSize,
          keyToHashesSize,
          totalCalculated,
        });
      } catch (e) {
        results.push({ onlySet, error: e });
      }
    }

    // --- Table 1: General Stats ---
    console.log(
      `${c.dim}  ┌──────────┬──────────────┬──────────────────────┬──────────────────────┐${c.reset}`
    );
    console.log(
      `  │ ${c.bold}${"OnlySet".padEnd(9)}${c.reset}│ ${
        c.bold
      }${"JSON Size".padEnd(13)}${c.reset}│ ${
        c.bold
      }${"Binary Size (Ratio)".padEnd(21)}${c.reset}│ ${
        c.bold
      }${"Gzip Size (Ratio)".padEnd(21)}${c.reset}│`
    );
    console.log(
      `${c.dim}  ├──────────┼──────────────┼──────────────────────┼──────────────────────┤${c.reset}`
    );

    for (const res of results) {
      if (res.error) {
        console.log(
          `  │ ${res.onlySet.padEnd(9)}│ ${c.red}Error: ${(
            res.error as Error
          ).message.substring(0, 50)}...${c.reset}`
        );
        continue;
      }

      const jsonSizeKB = res.jsonSizeVal.toFixed(2);
      const binarySizeKB = res.binarySizeVal.toFixed(2);
      const gzipSizeKB = res.gzipSizeVal.toFixed(2);
      const ratio = ((res.binarySizeVal / res.jsonSizeVal) * 100).toFixed(0);
      const gzipRatio = ((res.gzipSizeVal / res.jsonSizeVal) * 100).toFixed(0);

      let sizeColor = c.reset;
      if (res.binarySizeVal < 100) sizeColor = c.green;
      else if (res.binarySizeVal < 500) sizeColor = c.yellow;
      else sizeColor = c.red;

      let gzipColor = c.reset;
      if (res.gzipSizeVal < 50) gzipColor = c.green;
      else if (res.gzipSizeVal < 200) gzipColor = c.yellow;
      else gzipColor = c.red;

      const col1 = ` ${res.onlySet.padEnd(9)}`;
      const col2 = ` ${jsonSizeKB.padStart(9)} KB `;
      const binPart = binarySizeKB.padStart(7);
      const ratioPart = ` KB (${ratio.padStart(3)}%)`;
      const restPart = ratioPart.padEnd(13);
      const col3 = ` ${sizeColor}${binPart}${c.reset}${c.dim}${restPart}${c.reset} `;
      const gzipPart = gzipSizeKB.padStart(7);
      const gzipRatioPart = ` KB (${gzipRatio.padStart(3)}%)`;
      const gzipRestPart = gzipRatioPart.padEnd(13);
      const col4 = ` ${gzipColor}${gzipPart}${c.reset}${c.dim}${gzipRestPart}${c.reset} `;

      console.log(`  │${col1}│${col2}│${col3}│${col4}│`);
    }
    console.log(
      `${c.dim}  └──────────┴──────────────┴──────────────────────┴──────────────────────┘${c.reset}`
    );

    // --- Table 2: Component Breakdown ---
    console.log(""); // Spacer
    console.log(
      `${c.dim}  ┌──────────┬──────────────┬──────────────────────┬──────────────────────┬──────────────────────┐${c.reset}`
    );
    console.log(
      `  │ ${c.bold}${"OnlySet".padEnd(9)}${c.reset}│ ${
        c.bold
      }${"Binary Size".padEnd(13)}${c.reset}│ ${c.bold}${"MPHF %".padEnd(21)}${
        c.reset
      }│ ${c.bold}${"Keys %".padEnd(21)}${c.reset}│ ${c.bold}${"Map %".padEnd(
        21
      )}${c.reset}│`
    );
    console.log(
      `${c.dim}  ├──────────┼──────────────┼──────────────────────┼──────────────────────┼──────────────────────┤${c.reset}`
    );

    for (const res of results) {
      if (res.error) continue;

      const binarySizeKB = res.binarySizeVal.toFixed(2);
      const mphfPct =
        ((res.mphfSize / res.totalCalculated) * 100).toFixed(1) + "%";
      const keysPct =
        ((res.keysSize / res.totalCalculated) * 100).toFixed(1) + "%";
      const mapPct =
        ((res.keyToHashesSize / res.totalCalculated) * 100).toFixed(1) + "%";

      let sizeColor = c.reset;
      if (res.binarySizeVal < 100) sizeColor = c.green;
      else if (res.binarySizeVal < 500) sizeColor = c.yellow;
      else sizeColor = c.red;

      const col1 = ` ${res.onlySet.padEnd(9)}`;
      const col2 = ` ${sizeColor}${binarySizeKB.padStart(9)} KB${c.reset} `;

      const mphfPart = `${(res.mphfSize / 1024).toFixed(2)} KB (${mphfPct})`;
      const col3 = ` ${mphfPart.padEnd(21)}`;

      const keysPart = `${(res.keysSize / 1024).toFixed(2)} KB (${keysPct})`;
      const col4 = ` ${keysPart.padEnd(21)}`;

      const mapPart = `${(res.keyToHashesSize / 1024).toFixed(
        2
      )} KB (${mapPct})`;
      const col5 = ` ${mapPart.padEnd(21)}`;

      console.log(`  │${col1}│${col2}│${col3}│${col4}│${col5}│`);
    }
    console.log(
      `${c.dim}  └──────────┴──────────────┴──────────────────────┴──────────────────────┴──────────────────────┘${c.reset}\n`
    );
  }
})();
