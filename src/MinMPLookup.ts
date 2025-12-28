import { MinMPHash, createMinMPHashDict, IValidationMode } from "./MinMPHash";
import {
  compressIBinary,
  decompressIBinary,
  writeVarInt,
  readVarInt,
} from "./util";

export type ILookupMap = Record<string, string[]>;

export interface IMinMPLookupDict {
  mmpHashDictBin: Uint8Array;
  keys: string[];
  /**
   * 存储每个 Key 对应的 Value Hash 列表。
   * 这是一个稀疏的映射结构，用于支持 1-to-Many (Value -> Keys) 的反向查找。
   *
   * 结构: KeyIndex -> Sorted Hash List
   */
  keyToHashes: Uint32Array[];
}

export interface IMinMPLookupDictOptions {
  /**
   * 字典优化级别 [1-10]。
   * @default 5
   */
  level?: number;
  outputBinary?: boolean;
  enableCompression?: boolean;
  /**
   * 启用校验模式，使 hash 函数仅对原始数据集中的数据有效。
   * @default "8"
   */
  onlySet?: boolean | IValidationMode;
}

/**
 * 创建 MinMPLookup 字典
 * 把一个普通的查找表 Record<string, string[]> 转换为 IMinMPLookupDict，减小体积并且完成快速查询
 *
 * 通过 MinMPLookup 配合字典，可以实现输入 lookupMap 中任意 values 查找到对应的 key
 *
 * @param lookupMap 普通查找表
 */
export function createMinMPLookupDict(
  lookupMap: ILookupMap,
  options?: IMinMPLookupDictOptions & {
    outputBinary?: false;
    enableCompression?: false;
  }
): IMinMPLookupDict;

export function createMinMPLookupDict(
  lookupMap: ILookupMap,
  options: IMinMPLookupDictOptions & {
    outputBinary?: false;
    enableCompression: true;
  }
): Promise<IMinMPLookupDict>;

export function createMinMPLookupDict(
  lookupMap: ILookupMap,
  options: IMinMPLookupDictOptions & {
    outputBinary: true;
    enableCompression?: false;
  }
): Uint8Array;

export function createMinMPLookupDict(
  lookupMap: ILookupMap,
  options: IMinMPLookupDictOptions & {
    outputBinary: true;
    enableCompression: true;
  }
): Promise<Uint8Array>;

export function createMinMPLookupDict(
  lookupMap: ILookupMap,
  options?: IMinMPLookupDictOptions
): IMinMPLookupDict | Uint8Array | Promise<IMinMPLookupDict | Uint8Array> {
  const keys = Object.keys(lookupMap);

  // 1. Collect unique values for MPHF
  const uniqueValuesSet = new Set<string>();
  for (const key of keys) {
    const values = lookupMap[key];
    for (const v of values) {
      uniqueValuesSet.add(v);
    }
  }
  const allValues = Array.from(uniqueValuesSet);

  // 2. Create MPHF
  const mphBin = createMinMPHashDict(allValues, {
    level: options?.level,
    outputBinary: true,
    onlySet: options?.onlySet ?? "8",
  }) as Uint8Array;

  const mph = new MinMPHash(mphBin);

  // 3. Build Key -> Hashes Map
  // We iterate over keys and hash their values.
  const keyToHashes: Uint32Array[] = [];

  for (const key of keys) {
    const values = lookupMap[key];
    const hashes: number[] = [];
    for (const v of values) {
      const h = mph.hash(v);
      // Note: h could be -1 if something is wrong, but here we are using the dataset used to create MPHF, so it should be valid.
      if (h >= 0) {
        hashes.push(h);
      }
    }
    // Sort for delta encoding and deterministic order
    hashes.sort((a, b) => a - b);
    keyToHashes.push(new Uint32Array(hashes));
  }

  const dict: IMinMPLookupDict = {
    mmpHashDictBin: mphBin,
    keys,
    keyToHashes,
  };

  if (options?.outputBinary) {
    const serialized = serializeMinMPLookupDict(dict);
    if (options?.enableCompression) {
      return compressIBinary(serialized);
    }
    return serialized;
  }

  if (options?.enableCompression) {
    return Promise.resolve(dict);
  }

  return dict;
}

/**
 * Serializes the lookup dictionary to a binary format.
 */
export function serializeMinMPLookupDict(dict: IMinMPLookupDict): Uint8Array {
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  const writeU32 = (val: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, val, false);
    return b;
  };

  // 1. MPHF
  parts.push(writeU32(dict.mmpHashDictBin.length));
  parts.push(dict.mmpHashDictBin);

  // 2. Keys
  parts.push(writeU32(dict.keys.length));
  for (const key of dict.keys) {
    const keyBytes = encoder.encode(key);
    parts.push(writeU32(keyBytes.length));
    parts.push(keyBytes);
  }

  // 3. KeyToHashes (Delta Encoded)
  // Format: [TotalBytes] [Count1] [Delta1_1] [Delta1_2] ... [Count2] ...
  const hashBuffer: number[] = [];
  for (const hashes of dict.keyToHashes) {
    writeVarInt(hashes.length, hashBuffer);
    let prev = 0;
    for (let i = 0; i < hashes.length; i++) {
      const h = hashes[i];
      writeVarInt(h - prev, hashBuffer);
      prev = h;
    }
  }
  const hashBytes = new Uint8Array(hashBuffer);
  parts.push(writeU32(hashBytes.length));
  parts.push(hashBytes);

  const totalLen = parts.reduce((sum, b) => sum + b.length, 0);
  const res = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of parts) {
    res.set(b, offset);
    offset += b.length;
  }
  return res;
}

function deserializeLookupDict(data: Uint8Array): IMinMPLookupDict {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  const decoder = new TextDecoder();

  const readU32 = () => {
    const val = view.getUint32(offset, false);
    offset += 4;
    return val;
  };

  // 1. MPHF
  const mphLen = readU32();
  const mmpHashDictBin = data.subarray(offset, offset + mphLen);
  offset += mphLen;

  // 2. Keys
  const keysCount = readU32();
  const keys: string[] = [];
  for (let i = 0; i < keysCount; i++) {
    const kLen = readU32();
    const kBytes = data.subarray(offset, offset + kLen);
    offset += kLen;
    keys.push(decoder.decode(kBytes));
  }

  // 3. KeyToHashes
  const hashBytesLen = readU32();
  const hashBytes = data.subarray(offset, offset + hashBytesLen);
  offset += hashBytesLen;

  const keyToHashes: Uint32Array[] = [];
  let hOffset = 0;
  // We know there are `keysCount` entries
  for (let i = 0; i < keysCount; i++) {
    const { value: count, bytes: b1 } = readVarInt(hashBytes, hOffset);
    hOffset += b1;

    const hashes = new Uint32Array(count);
    let prev = 0;
    for (let j = 0; j < count; j++) {
      const { value: delta, bytes: b2 } = readVarInt(hashBytes, hOffset);
      hOffset += b2;
      prev += delta;
      hashes[j] = prev;
    }
    keyToHashes.push(hashes);
  }

  return {
    mmpHashDictBin,
    keys,
    keyToHashes,
  };
}

/**
 * MinMPLookup 查找表类
 * 用来实现基于 IMinMPLookupDict 的快速查询
 *
 * @example
 * ```js
 *
 *  let lookupMap = {
 *    "China": ["Beijing", "Shanghai", "Guangzhou"],
 *    "USA": ["New York", "Los Angeles", "Chicago"],
 *    "Japan": ["Tokyo", "Osaka", "Kyoto"]
 *  }
 *
 * let dict = createMinMPLookupDict(lookupMap);
 * let lookup = new MinMPLookup(dict);
 *
 *  lookup.query("Beijing"); // "China"
 *
 *```
 */
export class MinMPLookup {
  private mph: MinMPHash;
  private _invertedIndex: number[][] | null = null;

  static async fromCompressed(data: Uint8Array): Promise<MinMPLookup> {
    const decompressed = await decompressIBinary(data);
    const dict = deserializeLookupDict(decompressed);
    return new MinMPLookup(dict);
  }

  static fromBinary(data: Uint8Array): MinMPLookup {
    const dict = deserializeLookupDict(data);
    return new MinMPLookup(dict);
  }

  constructor(private dict: IMinMPLookupDict) {
    this.mph = new MinMPHash(dict.mmpHashDictBin);
    this.buildInvertedIndex();
  }

  private buildInvertedIndex() {
    const n = this.mph.n;
    // Initialize array of arrays
    this._invertedIndex = Array.from({ length: n }, () => []);
    
    for (let i = 0; i < this.dict.keys.length; i++) {
      const hashes = this.dict.keyToHashes[i];
      for (let j = 0; j < hashes.length; j++) {
        const h = hashes[j];
        if (h < n) {
          this._invertedIndex![h].push(i);
        }
      }
    }
  }

  /**
   * 查找 value 对应的第一个 key
   */
  query(value: string): string | null {
    const keys = this.queryAll(value);
    return keys && keys.length > 0 ? keys[0] : null;
  }

  /**
   * 获取拥有 value 的所有 keys
   */
  queryAll(value: string): string[] | null {
    const idx = this.mph.hash(value);
    if (idx < 0 || !this._invertedIndex) return null;

    if (idx >= this._invertedIndex.length) return null;

    const keyIndices = this._invertedIndex[idx];
    if (keyIndices.length === 0) return null;

    const results: string[] = [];

    for (const keyIdx of keyIndices) {
      results.push(this.dict.keys[keyIdx]);
    }

    return results.length > 0 ? results : null;
  }
}
