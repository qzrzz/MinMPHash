import { MinMPHash, createMinMPHashDict, IValidationMode } from "./MinMPHash";
import {
  compressIBinary,
  decompressIBinary,
  writeVarInt,
  readVarInt,
  BitWriter,
  BitReader,
  readBitsAt,
} from "./util";

export type ILookupMap = Record<string, string[]>;

export interface IMinMPLookupDict {
  mmpHashDictBin: Uint8Array;
  keys: string[];
  /**
   * Mode 0: Key -> Hashes (Original, for M-to-N)
   * 存储每个 Key 对应的 Value Hash 列表。
   * 这是一个稀疏的映射结构，用于支持 1-to-Many (Value -> Keys) 的反向查找。
   *
   * 结构: KeyIndex -> Sorted Hash List
   */
  keyToHashes?: Uint32Array[];

  /**
   * Mode 1: Value -> Key (Direct 1-to-1)
   * 存储每个 Value Hash 对应的 Key Index。
   * 这是一个紧凑的数组，长度为 TotalValues。
   *
   * 结构: ValueHash -> KeyIndex (Bit-packed)
   */
  valueToKeyIndexes?: Uint8Array;
  bitsPerKey?: number;

  /**
   * Mode 2: Hybrid (Mostly 1-to-1, with some collisions)
   * Used when valueToKeyIndexes is present.
   * If a value in valueToKeyIndexes equals `keys.length`, it means there are multiple keys.
   * This map stores the actual keys for those collision cases.
   *
   * Structure: ValueHash -> KeyIndex[]
   */
  collisionMap?: Map<number, number[]>;
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

  // Check if 1-to-1 mapping is possible or mostly possible
  // We need to check if any value is associated with multiple keys.
  const valueToKeys = new Map<string, number[]>();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const values = lookupMap[key];
    for (const v of values) {
      if (!valueToKeys.has(v)) {
        valueToKeys.set(v, []);
      }
      valueToKeys.get(v)!.push(i);
    }
  }

  // Check collision rate
  let collisionCount = 0;
  for (const [_, kIndices] of valueToKeys) {
    if (kIndices.length > 1) {
      collisionCount++;
    }
  }

  // Heuristic: If collisions are rare (< 10%?), use Hybrid Mode (Mode 1 + Collision Map)
  // Otherwise use Mode 0.
  // For very small datasets, Mode 0 might be better anyway.
  const isMostlyOneToOne = collisionCount < allValues.length * 0.1;

  let dict: IMinMPLookupDict;

  if (isMostlyOneToOne) {
    // Mode 1 / Hybrid: Value -> Key Direct Index
    // We need enough bits to store keys.length (as the collision marker)
    // So range is [0, keys.length]. Max value is keys.length.
    const bitsPerKey = Math.ceil(Math.log2(keys.length + 1));
    const bw = new BitWriter();
    const collisionMap = new Map<number, number[]>();

    // We need to map ValueHash -> KeyIndex
    // Since we can't iterate by hash easily without storing, let's build a temporary array.
    const valueToKeyMap = new Int32Array(mph.n).fill(-1);

    for (const [v, kIndices] of valueToKeys) {
      const h = mph.hash(v);
      if (h >= 0) {
        if (kIndices.length === 1) {
          valueToKeyMap[h] = kIndices[0];
        } else {
          // Collision
          valueToKeyMap[h] = keys.length; // Marker
          collisionMap.set(h, kIndices);
        }
      }
    }

    for (let i = 0; i < mph.n; i++) {
      const keyIdx = valueToKeyMap[i];
      // If keyIdx is -1, it means this hash slot is not used (shouldn't happen if MPH is perfect for the set)
      // Default to 0 or marker? 0 is a valid key.
      // If MPH is perfect for the set, every slot is filled.
      bw.write(keyIdx >= 0 ? keyIdx : 0, bitsPerKey);
    }

    dict = {
      mmpHashDictBin: mphBin,
      keys,
      valueToKeyIndexes: bw.getData(),
      bitsPerKey,
      collisionMap: collisionMap.size > 0 ? collisionMap : undefined,
    };
  } else {
    // Mode 0: Key -> Hashes (Original)
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

    dict = {
      mmpHashDictBin: mphBin,
      keys,
      keyToHashes,
    };
  }

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

  if (dict.valueToKeyIndexes && dict.bitsPerKey !== undefined) {
    // Mode 1 / Hybrid: Value -> Key
    parts.push(writeU32(0xffffffff));
    parts.push(writeU32(dict.bitsPerKey));
    parts.push(writeU32(dict.valueToKeyIndexes.length));
    parts.push(dict.valueToKeyIndexes);

    // Serialize Collision Map
    // Format: [Count] [Hash1] [KeyCount1] [KeyIndex1_1] ...
    if (dict.collisionMap && dict.collisionMap.size > 0) {
      const colBuffer: number[] = [];
      writeVarInt(dict.collisionMap.size, colBuffer);
      // Sort by hash for determinism
      const sortedHashes = Array.from(dict.collisionMap.keys()).sort(
        (a, b) => a - b
      );

      let prevHash = 0;
      for (const h of sortedHashes) {
        writeVarInt(h - prevHash, colBuffer);
        prevHash = h;

        const kIndices = dict.collisionMap.get(h)!;
        writeVarInt(kIndices.length, colBuffer);
        // Key indices are likely small and close? Maybe not. Just VarInt them.
        // Or delta encode them too.
        kIndices.sort((a, b) => a - b);
        let prevKey = 0;
        for (const k of kIndices) {
          writeVarInt(k - prevKey, colBuffer);
          prevKey = k;
        }
      }
      const colBytes = new Uint8Array(colBuffer);
      parts.push(writeU32(colBytes.length));
      parts.push(colBytes);
    } else {
      parts.push(writeU32(0)); // No collision map
    }
  } else if (dict.keyToHashes) {
    // Mode 0: Key -> Hashes
    // 3. KeyToHashes (Delta Encoded with Bit Packing)
    // Format: [TotalBytes] [Count1] [Bits1] [Delta1_1] ... [Count2] ...
    const hashBuffer: number[] = [];
    for (const hashes of dict.keyToHashes) {
      writeVarInt(hashes.length, hashBuffer);
      if (hashes.length === 0) continue;

      // Calculate max delta
      let maxDelta = 0;
      let prev = 0;
      const deltas: number[] = [];
      for (let i = 0; i < hashes.length; i++) {
        const h = hashes[i];
        const delta = h - prev;
        deltas.push(delta);
        if (delta > maxDelta) maxDelta = delta;
        prev = h;
      }

      // Calculate bits needed
      let bits = 0;
      if (maxDelta > 0) {
        bits = Math.ceil(Math.log2(maxDelta + 1));
      }

      hashBuffer.push(bits);

      // Write deltas
      const bw = new BitWriter();
      for (const d of deltas) {
        bw.write(d, bits);
      }
      const packed = bw.getData();
      for (let i = 0; i < packed.length; i++) {
        hashBuffer.push(packed[i]);
      }
    }
    const hashBytes = new Uint8Array(hashBuffer);
    parts.push(writeU32(hashBytes.length));
    parts.push(hashBytes);
  }

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

  // 3. KeyToHashes or ValueToKey
  const sectionLen = readU32();

  if (sectionLen === 0xffffffff) {
    // Mode 1 / Hybrid: Value -> Key
    const bitsPerKey = readU32();
    const dataLen = readU32();
    const valueToKeyIndexes = data.subarray(offset, offset + dataLen);
    offset += dataLen;

    // Read Collision Map
    const colMapLen = readU32();
    let collisionMap: Map<number, number[]> | undefined;

    if (colMapLen > 0) {
      const colBytes = data.subarray(offset, offset + colMapLen);
      offset += colMapLen;

      collisionMap = new Map();
      let cOffset = 0;
      const { value: count, bytes: b1 } = readVarInt(colBytes, cOffset);
      cOffset += b1;

      let prevHash = 0;
      for (let i = 0; i < count; i++) {
        const { value: deltaHash, bytes: b2 } = readVarInt(colBytes, cOffset);
        cOffset += b2;
        const h = prevHash + deltaHash;
        prevHash = h;

        const { value: kCount, bytes: b3 } = readVarInt(colBytes, cOffset);
        cOffset += b3;

        const kIndices: number[] = [];
        let prevKey = 0;
        for (let j = 0; j < kCount; j++) {
          const { value: deltaKey, bytes: b4 } = readVarInt(colBytes, cOffset);
          cOffset += b4;
          const k = prevKey + deltaKey;
          prevKey = k;
          kIndices.push(k);
        }
        collisionMap.set(h, kIndices);
      }
    }

    return {
      mmpHashDictBin,
      keys,
      valueToKeyIndexes,
      bitsPerKey,
      collisionMap,
    };
  } else {
    // Mode 0: Key -> Hashes
    const hashBytesLen = sectionLen;
    const hashBytes = data.subarray(offset, offset + hashBytesLen);
    offset += hashBytesLen;

    const keyToHashes: Uint32Array[] = [];
    let hOffset = 0;
    // We know there are `keysCount` entries
    for (let i = 0; i < keysCount; i++) {
      const { value: count, bytes: b1 } = readVarInt(hashBytes, hOffset);
      hOffset += b1;

      if (count === 0) {
        keyToHashes.push(new Uint32Array(0));
        continue;
      }

      const bits = hashBytes[hOffset];
      hOffset += 1;

      // Calculate bytes used by packed deltas
      const totalBits = bits * count;
      const packedBytesLen = Math.ceil(totalBits / 8);

      const packedData = hashBytes.subarray(hOffset, hOffset + packedBytesLen);
      hOffset += packedBytesLen;

      const br = new BitReader(packedData);
      const hashes = new Uint32Array(count);
      let prev = 0;
      for (let j = 0; j < count; j++) {
        const delta = br.read(bits);
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
  private dict: IMinMPLookupDict;
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

  constructor(dict: IMinMPLookupDict | Uint8Array) {
    if (dict instanceof Uint8Array) {
      dict = deserializeLookupDict(dict);
    }

    this.dict = dict;

    this.mph = new MinMPHash(dict.mmpHashDictBin);
    if (dict.keyToHashes) {
      this.buildInvertedIndex();
    }
  }

  private buildInvertedIndex() {
    if (!this.dict.keyToHashes) return;

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
    // Mode 1 / Hybrid: Direct Lookup
    if (this.dict.valueToKeyIndexes && this.dict.bitsPerKey) {
      const h = this.mph.hash(value);
      if (h < 0 || h >= this.mph.n) return null;

      const keyIdx = readBitsAt(
        this.dict.valueToKeyIndexes,
        h * this.dict.bitsPerKey,
        this.dict.bitsPerKey
      );

      // Check for collision marker
      if (keyIdx === this.dict.keys.length) {
        // Look in collision map
        if (this.dict.collisionMap && this.dict.collisionMap.has(h)) {
          const indices = this.dict.collisionMap.get(h)!;
          return indices.length > 0 ? this.dict.keys[indices[0]] : null;
        }
        return null; // Should not happen if marker is set
      }

      // Check bounds just in case
      if (keyIdx >= this.dict.keys.length) return null;
      return this.dict.keys[keyIdx];
    }

    // Mode 0: Inverted Index
    const keys = this.queryAll(value);
    return keys && keys.length > 0 ? keys[0] : null;
  }

  /**
   * 获取拥有 value 的所有 keys
   */
  queryAll(value: string): string[] | null {
    // Mode 1 / Hybrid: Direct Lookup
    if (this.dict.valueToKeyIndexes && this.dict.bitsPerKey) {
      const h = this.mph.hash(value);
      if (h < 0 || h >= this.mph.n) return null;

      const keyIdx = readBitsAt(
        this.dict.valueToKeyIndexes,
        h * this.dict.bitsPerKey,
        this.dict.bitsPerKey
      );

      // Check for collision marker
      if (keyIdx === this.dict.keys.length) {
        // Look in collision map
        if (this.dict.collisionMap && this.dict.collisionMap.has(h)) {
          const indices = this.dict.collisionMap.get(h)!;
          return indices.map((i) => this.dict.keys[i]);
        }
        return null;
      }

      if (keyIdx >= this.dict.keys.length) return null;
      return [this.dict.keys[keyIdx]];
    }

    // Mode 0: Inverted Index
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

  /**
   * 获取所有的 keys 列表
   */
  keys(): string[] {
    return this.dict.keys;
  }
}
