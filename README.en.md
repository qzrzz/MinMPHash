# MinMPHash & MinMPLookup

> Mini Minimal Perfect Hash & Mini Minimal Perfect Lookup

[中文 README](./README.zh.md)

`MinMPHash` can map a set of n strings to the integer range `[0, n-1]` without any collisions.

`MinMPLookup` is a minimal perfect lookup table tool implemented based on `MinMPHash`.

It can minimize the storage of maps in the form of `{ key1: [value1, value2, ...], key2: [value3, value4, ...] }`, thereby achieving the requirement of looking up the corresponding `key` based on `value`.

Compared to raw storage, the minimized lookup table can reduce the volume to less than 10% of the original (the specific compression rate depends on the information entropy of the values in the dataset; the higher the entropy, the better the compression effect).

## What is Minimal Perfect Hash?

Hash functions can map data to a range, generating a fixed-length "fingerprint". However, ordinary hash functions have two common problems:

- Space waste caused by sparsity: The hash range is usually much larger than the actual amount of data, resulting in a very sparse hash table.
- Different inputs may conflict: Different inputs may map to the same hash value. To reduce the collision rate, longer hash values are usually required, which wastes space.

Minimal Perfect Hash Function (MPHF) is a special class of hash functions:

- It guarantees no collisions for a given n distinct inputs;
- The output range is exactly `[0, n-1]`, making space utilization optimal.

In other words, if you have n different strings, MPHF will map them one-to-one to the integer range `[0, n-1]`, with each string corresponding to a unique index.

```
    text set               Hash              Hash Table (Sparse)
  +----------+        +------------+        +-------------------+
  |  Apple   | ---->  |    h(x)    | ---->  | 0: [ Apple ]      |
  |  Banana  |        +------------+        | 1:                | <--- Gap
  |  Cherry  |                              | 2: [ Banana ]     |
  +----------+                              | 3:                | <--- Gap
                                            |       ...         | <--- Gap
                                            | 9: [ Cherry ]     |
                                            +-------------------+
                                              (Waste of Space)


    text set      🤩 Minimal Perfect Hash      Hash Table (Compact)
  +----------+        +--------------+        +-------------------+
  |  Apple   | ---->  |   mmph(x)    | ---->  | 0: [ Apple ]      |
  |  Banana  |        +--------------+        | 1: [ Banana ]     |
  |  Cherry  |                                | 2: [ Cherry ]     |
  +----------+                                +-------------------+
                                             ( 100% Space Utilization )

```

## When to use Minimal Perfect Hash?

Minimal Perfect Hash is suitable for scenarios where a set of deterministic keys (Keys) needs to be mapped to compact integer indices. Compared with ordinary mapping tables, using MPHF can save the overhead of storing complete keys: only the integer index corresponding to the key needs to be stored to achieve the same mapping function.

In other words, as long as the keys in the dataset are deterministic (will not change), no matter how long the key itself is, it can be stored and uniquely identified by a `number` based on the dataset size without conflict.

This is exactly what common hashes (such as MD5, SHA-1) cannot do: the hash values they produce are long (e.g., MD5 is 16 bytes, SHA-1 is 20 bytes), while MPHF can choose the smallest integer range based on the dataset size, thereby achieving higher space utilization.

For example, there is a list of font names, and you want to map from the font name to the font family name.
The general method is to complete all this through a mapping table:

```js
let FontMap = {
  "Source Sans": "Source Sans",
  "Source Sans Black": "Source Sans",
  "Source Sans Bold": "Source Sans",
  "思源黑体 CN ExtraLight": "Source Sans",
  "思源黑体 TW Light": "Source Sans",
  // ... 6000+
};

let query = "思源黑体 TW Light";
let found = FontMap[query]; // 'Source Sans'
```

Such a mapping table needs to store all keys (such as font names), which takes up a lot of space when the number of keys is large. After using minimal perfect hash, we can only store the index (hash value) corresponding to the font name, instead of the full name:

```js
// Create a set containing all font names
let values = [
  "Source Sans",
  "Source Sans Black",
  "Source Sans Bold",
  "思源黑体 CN ExtraLight",
  "思源黑体 TW Light",
  // ... 6000+
];

// Create minimal perfect hash dictionary based on values
let dict = createMinMPHashDict(values);
// Create hash function instance based on dictionary
let minHash = new MinMPHash(dict);

// Then we use hash values to replace full font names:
let FontMapWithHash = {
  "Source Sans": [1, 2, 3, 21 /* ... */],
  Heiti: [12, 12 /* ... */],
  "JetBrains Mono": [32, 112 /* ... */],
  // ...
};

// When querying, first calculate the hash value, then find the corresponding font family name through the hash value
let query = "思源黑体 TW Light";
let query_hash = minHash.hash(query, dict); // e.g. 42

let found = Object.entries(FontMapWithHash).find(([family, hashes]) =>
  hashes.includes(query_hash)
)[0]; // 'Source Sans'
```

This can significantly reduce storage space because there is no longer a need to save the full key text, only a shorter integer index.

You might think that hash functions like MD5 or SHA-1 can also generate identifiers, but their hash values are long (e.g., MD5 is 16 bytes, SHA-1 is 20 bytes). FNV-1a can be used to a minimum of 4 bytes in some scenarios, but its collision rate is high. Minimal perfect hash can choose the minimum range based on the dataset size, ensuring no conflicts and achieving extreme space utilization.

## Usage

### Installation

```bash
npm install min-mphash
```

### MinMPHash Usage

This is the core function, used to map a set of strings to integers in `[0, n-1]`.

#### Step 1: Create Dictionary (Build Time)

Generate the hash dictionary in your build script or server-side code.

```typescript
import { createMinMPHashDict } from "min-mphash";
import * as fs from "fs";

// Example string set
const mySet = ["Apple", "Banana", "Cherry", "Date", "Elderberry"];

// Create dictionary binary data
// outputBinary: true returns Uint8Array, suitable for storage or network transmission
const dictBuffer = createMinMPHashDict(mySet, {
  outputBinary: true,
  level: 5, // Optimization level [1-10], higher is smaller but slower to build
});

fs.writeFileSync("mph-dict.bin", dictBuffer);
```

#### Step 2: Use Dictionary to Generate Hash (Runtime)

Load the dictionary and perform hash queries in your application (e.g., browser side).

```typescript
import { MinMPHash } from "min-mphash";

// Assume you have already loaded the binary data
const dictBuffer = await fetch("mph-dict.bin").then((res) => res.arrayBuffer());
const dict = new Uint8Array(dictBuffer);

const mph = new MinMPHash(dict);

console.log(mph.hash("Apple")); // 0 (or other unique value between 0-4)
console.log(mph.hash("Banana")); // 2
console.log(mph.hash("Cherry")); // 4

// Note: For strings not in the set, it will also return a value in [0, n-1] (this is a property of MPHF),
// unless you enable **Validation Mode** (see below).
console.log(mph.hash("sdfsd94jx#*")); // May return 1
```

#### Validation Mode `onlySet`

Standard minimal perfect hash functions will also return an index within the range for inputs **not in the set** (this is a property of MPHF). If your application needs to identify queries outside the set as "misses", you can enable validation mode `onlySet` when creating the dictionary.

`onlySet` will store the fingerprint of each key at the cost of extra space. When querying, the fingerprint will be verified: if the verification fails, `-1` is returned indicating a miss.

```typescript
let dict = createMinMPHashDict(mySet, { onlySet: "8" });
```

| onlySet | Space Usage (per key) | False Positive Rate |
| ------- | --------------------- | ------------------- |
| 2       | 0.25 byte             | ~25%                |
| 4       | 0.5 byte              | ~6.25%              |
| 8       | 1 byte                | ~0.39%              |
| 16      | 2 bytes               | ~0.0015%            |
| 32      | 4 bytes               | ~0.00000002%        |

Note: "False Positive Rate" in the table refers to the probability that an input not in the set is incorrectly judged to be in the set; if the key is indeed in the set, the verification always succeeds.

#### Dictionary Format: JSON/CBOR/CBOR.Gzip

`createMinMPHashDict` can output dictionaries in multiple formats:

- **Binary**
  `{ outputBinary: true }`
  Returns CBOR `Uint8Array`
- **Compressed Binary**
  `{ outputBinary: true, enableCompression: true}`
  Gzip compressed CBOR `Uint8Array`
- **JSON**
  `Default`
  JavaScript object, suitable for debugging and viewing.

Generally speaking, it is recommended to use the compressed binary format, which has the smallest volume.
But JSON is more convenient during development. If the server/CDN supports transparent compression,
you can use the JSON format directly, and the final volume difference is not big.

### MinMPLookup Usage

If you have a `Value -> Key` lookup requirement (for example: look up `font family name` by `font file name`, or look up `country` by `city`), and the amount of data is large, you can use `MinMPLookup`. It uses MPHF and differential encoding to greatly compress the mapping relationship.

#### Scenario

Suppose you have the following mapping:

```js
const lookupMap = {
  China: ["Beijing", "Shanghai", "Guangzhou"],
  USA: ["New York", "Los Angeles"],
  Japan: ["Tokyo"],
};
// Goal: Input "Shanghai" -> Get "China"
```

#### Create Lookup Dictionary

```typescript
import { createMinMPLookupDict } from "min-mphash";

const lookupMap = {
  China: ["Beijing", "Shanghai", "Guangzhou"],
  USA: ["New York", "Los Angeles"],
  Japan: ["Tokyo"],
};

// Generate compressed binary dictionary
const lookupDictBin = createMinMPLookupDict(lookupMap, {
  outputBinary: true,
  enableCompression: true, // Enable built-in Gzip compression (Node/Bun environment or browsers supporting CompressionStream only)
});

// Save to file
// fs.writeFileSync("lookup.bin", lookupDictBin);
```

#### Query

```typescript
import { MinMPLookup } from "min-mphash";

// Load dictionary
const lookup = await MinMPLookup.fromCompressed(lookupDictBin);
// If enableCompression is not enabled, use MinMPLookup.fromBinary(bin)

console.log(lookup.query("Shanghai")); // "China"
console.log(lookup.queryAll("New York")); // ["USA"]
console.log(lookup.query("Unknown City")); // null
console.log(lookup.keys()); // ["China", "USA", "Japan"]
```

#### Validation Mode `onlySet`

Standard minimal perfect hash functions will also return an index within the range for inputs **not in the set**. To solve this problem, `MinMPHash` supports a built-in validation mode to ensure that lookups outside the set return `null`.

```ts
const lookupDictBin = createMinMPLookupDict(lookupMap, {
  onlySet: "8", // Enable 8-bit validation mode
});
```

## Benchmark

### MinMPHash Dictionary Size Benchmark

```

=== MinMPHash Big Dataset Size Benchmark ===
Generating dataset of size 1000000...
Dataset size: 1000000 items

Dataset json size:        41836.25 KB
Dataset json gzip size:   6473.48 KB

➤ Optimization Level 5
  ┌──────────┬──────────────┬──────────────────────┬──────────────────────┬──────────────┬──────────────┐
  │ OnlySet  │ JSON Size    │ Binary Size (Ratio)  │ Gzip Size (Ratio)    │ vs None      │ Build Time   │
  ├──────────┼──────────────┼──────────────────────┼──────────────────────┼──────────────┼──────────────┤
  │ none     │    979.18 KB │  341.37 KB ( 35%)    │  268.36 KB ( 27%)    │      100.0 % │   2502.35 ms │
  │ 2        │   1849.51 KB │  585.38 KB ( 32%)    │  512.86 KB ( 28%)    │      171.5 % │   2981.46 ms │
  │ 4        │   2721.75 KB │  829.94 KB ( 30%)    │  757.49 KB ( 28%)    │      243.1 % │   3109.38 ms │
  │ 8        │   4465.27 KB │ 1318.06 KB ( 30%)    │ 1245.64 KB ( 28%)    │      386.1 % │   3132.11 ms │
  │ 16       │   6672.22 KB │ 2293.96 KB ( 34%)    │ 2222.43 KB ( 33%)    │      672.0 % │   3559.02 ms │
  │ 32       │  11468.63 KB │ 4247.06 KB ( 37%)    │ 4176.07 KB ( 36%)    │     1244.1 % │   2900.32 ms │
  └──────────┴──────────────┴──────────────────────┴──────────────────────┴──────────────┴──────────────┘

```

### MinMPLookup Dictionary Size Benchmark

```

=== MinMPLookup Big Dataset Size Benchmark ===
Generating dataset of size 100000 values...
Dataset stats: 5000 keys, 100000 values

Dataset json size:        7577.04 KB
Dataset json gzip size:   5141.74 KB

➤ Optimization Level 5
  ┌──────────┬──────────────┬──────────────────────┬──────────────────────┬──────────────┬──────────────┐
  │ OnlySet  │ JSON Size    │ Binary Size (Ratio)  │ Gzip Size (Ratio)    │ vs None      │ Build Time   │
  ├──────────┼──────────────┼──────────────────────┼──────────────────────┼──────────────┼──────────────┤
  │ none     │    709.67 KB │  254.85 KB ( 36%)    │  199.59 KB ( 28%)    │      100.0 % │    412.65 ms │
  │ 2        │    797.00 KB │  279.23 KB ( 35%)    │  225.14 KB ( 28%)    │      109.6 % │    393.94 ms │
  │ 4        │    884.32 KB │  303.63 KB ( 34%)    │  248.92 KB ( 28%)    │      119.1 % │    408.93 ms │
  │ 8        │   1058.92 KB │  352.48 KB ( 33%)    │  297.58 KB ( 28%)    │      138.3 % │    477.32 ms │
  │ 16       │   1406.98 KB │  450.21 KB ( 32%)    │  395.21 KB ( 28%)    │      176.7 % │    421.70 ms │
  │ 32       │   2104.73 KB │  645.45 KB ( 31%)    │  591.02 KB ( 28%)    │      253.3 % │    374.06 ms │
  └──────────┴──────────────┴──────────────────────┴──────────────────────┴──────────────┴──────────────┘
```
