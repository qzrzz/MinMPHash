
import * as fs from "fs";
import * as path from "path";

const __dirname = import.meta.dirname;
const mapPath = path.join(__dirname, "test/names-map.json");
const lookupMap = JSON.parse(fs.readFileSync(mapPath, "utf-8"));

const valueToKeys = new Map<string, string[]>();
let isOneToOne = true;
let totalValues = 0;

for (const key in lookupMap) {
  const values = lookupMap[key];
  for (const v of values) {
    totalValues++;
    if (!valueToKeys.has(v)) {
      valueToKeys.set(v, []);
    }
    valueToKeys.get(v)!.push(key);
  }
}

let maxKeysPerValue = 0;
for (const [v, keys] of valueToKeys) {
  if (keys.length > 1) {
    isOneToOne = false;
    // console.log(`Value "${v}" appears in keys: ${keys.join(", ")}`);
  }
  if (keys.length > maxKeysPerValue) {
    maxKeysPerValue = keys.length;
  }
}

console.log(`Total Values: ${totalValues}`);
console.log(`Unique Values: ${valueToKeys.size}`);
console.log(`Is 1-to-1 (Value -> Key): ${isOneToOne}`);
console.log(`Max Keys per Value: ${maxKeysPerValue}`);
