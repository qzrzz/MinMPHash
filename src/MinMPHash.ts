import {
  dictFromCBOR,
  dictToCBOR,
  compressIBinary,
  decompressIBinary,
} from "./util";

/**
 * 最小完美哈希字典的原始数据结构。
 *
 * 通常通过 `createMinMPHashDict` 生成，并传递给 `MinMPHash` 构造函数。
 */
export interface IMinMPHashDict {
  n: number;
  m: number;
  seed0: number;
  hashSeed?: number;
  seedStream: Uint8Array;
  bucketSizes: Uint8Array;
  seedZeroBitmap?: Uint8Array;
  fingerprints?: Uint8Array | Uint16Array | Uint32Array | number[];
  validationMode: IValidationMode;
}

/** 验证模式，当字典在 onlySet 模式下启用 */
export type IValidationMode = "none" | "2" | "4" | "8" | "16" | "32";

export interface IMinMPHashDictOptions {
  /**
   * 启用校验模式，使 hash 函数仅对原始数据集中的数据有效。
   *
   * 如果传入不在数据集中的数据：
   * - 启用后：hash 值返回 `-1`（有一定误判率）。
   * - 未启用：hash 值会返回一个 [0, n-1] 之间的索引（即产生冲突）。
   *
   * **原理**：字典会额外存储每条数据的指纹（Fingerprint）。这会增加字典体积。
   *
   * **误判率说明**：
   * - `"2"`  - 2-bit 指纹 (0.25 byte/key) ~25% 误判率
   * - `"4"`  - 4-bit 指纹 (0.5 byte/key)  ~6.25% 误判率
   * - `"8"`  - 8-bit 指纹 (1 byte/key)    ~0.39% 误判率
   * - `"16"` - 16-bit 指纹 (2 bytes/key)  ~0.0015% 误判率
   * - `"32"` - 32-bit 指纹 (4 bytes/key)  ~0.00000002% 误判率
   *
   * @default "none" (或 false)
   * @example
   * onlySet: "8" // 启用 8-bit 校验，平衡体积与准确性
   */
  onlySet?: boolean | IValidationMode;

  /**
   * 字典优化级别 [1-10]。
   *
   * level 越大，字典体积越小，但构建（Build）时间越长。
   *
   * @example
   * - level 1: 快速构建，体积较大 (约 112 KB)
   * - level 5: 默认平衡点 (约 24 KB)
   * - level 10: 极致压缩，构建极慢 (约 17 KB)
   * @default 5
   */
  level?: number;

  /**
   * 是否输出二进制 CBOR 格式的字典。
   *
   * 如果为 `true`，`createMinMPHashDict` 将返回 `Uint8Array`。
   * @default false
   */
  outputBinary?: boolean;

  /**
   * 是否启用 Gzip 压缩。
   *
   * **注意**：仅当 `outputBinary` 为 `true` 时有效。
   * 启用后返回 `Promise<Uint8Array>`，需使用 `MinMPHash.fromCompressed()` 加载。
   * @default false
   */
  enableCompression?: boolean;
}

/**
 * 创建最小完美哈希 (MPHF) 字典。
 */
export function createMinMPHashDict(
  dataSet: string[],
  options?: IMinMPHashDictOptions & {
    outputBinary?: false;
  }
): IMinMPHashDict;

/**
 * 创建最小完美哈希 (MPHF) 字典。
 *
 * @param options.outputBinary 输出二进制格式
 */
export function createMinMPHashDict(
  dataSet: string[],
  options: IMinMPHashDictOptions & {
    outputBinary: true;
    enableCompression?: false;
  }
): Uint8Array;

/**
 * 创建最小完美哈希 (MPHF) 字典。
 *
 * @param options.outputBinary 输出二进制格式
 * @param options.enableCompression 启用压缩
 */
export function createMinMPHashDict(
  dataSet: string[],
  options: IMinMPHashDictOptions & {
    outputBinary: true;
    enableCompression: true;
  }
): Promise<Uint8Array>;

/**
 * 创建二进制格式的最小完美哈希字典。
 */
export function createMinMPHashDict(
  dataSet: string[],
  options?: IMinMPHashDictOptions
): IMinMPHashDict | Uint8Array | Promise<Uint8Array> {
  const n = dataSet.length;

  if (n === 0) {
    const emptyDict: IMinMPHashDict = {
      n: 0,
      m: 0,
      seed0: 0,
      seedStream: new Uint8Array(0),
      bucketSizes: new Uint8Array(0),
      validationMode: "none",
    };
    return options?.outputBinary ? dictToCBOR(emptyDict) : emptyDict;
  }

  const targetRate = options?.level ?? 5.0;
  let validationMode: IValidationMode = "none";
  if (options?.onlySet === true) validationMode = "8";
  else if (typeof options?.onlySet === "string")
    validationMode = options.onlySet;

  // For very large datasets, slightly relax the target rate to reduce max bucket size probability
  const adjustedRate = n > 500000 ? Math.max(1, targetRate * 0.90) : targetRate;
  const m = Math.max(1, Math.ceil(n / adjustedRate));

  // -------------------------------------------------
  // Phase 0: Pre-hashing
  // -------------------------------------------------
  const hashesL = new Uint32Array(n);
  const hashesH = new Uint32Array(n);
  let hashSeed = 0;

  // Try to find a seed that produces no collisions
  while (true) {
    // Use Map<h1, h2> to detect collisions without BigInt overhead
    // If h1 collides, we check h2. If h2 also collides, it's a real collision.
    // Since h1 collisions are rare, we optimize for the common case (unique h1).
    const seen = new Map<number, number>(); 
    const complexSeen = new Map<number, Set<number>>(); // For cases where h1 collides

    let collision = false;
    for (let i = 0; i < n; i++) {
      const h1 = murmurHash3_32(dataSet[i], hashSeed);
      const h2 = murmurHash3_32(dataSet[i], ~hashSeed);
      
      // Check for collision
      let isDuplicate = false;
      if (complexSeen.has(h1)) {
          const set = complexSeen.get(h1)!;
          if (set.has(h2)) isDuplicate = true;
          else set.add(h2);
      } else if (seen.has(h1)) {
          const existingH2 = seen.get(h1)!;
          if (existingH2 === h2) {
              isDuplicate = true;
          } else {
              // Upgrade to complex
              const set = new Set<number>();
              set.add(existingH2);
              set.add(h2);
              complexSeen.set(h1, set);
              seen.delete(h1);
          }
      } else {
          seen.set(h1, h2);
      }

      if (isDuplicate) {
        collision = true;
        break;
      }
      
      hashesL[i] = h1;
      hashesH[i] = h2;
    }

    if (!collision) break;

    hashSeed++;
    if (hashSeed > 100) {
      // Should be extremely rare with 64-bit hashes
      throw new Error(
        `Could not find a collision-free hash seed after ${hashSeed} attempts.`
      );
    }
  }

  // -------------------------------------------------
  // Phase 1: Best-Fit buckets using flat arrays (head/next)
  // -------------------------------------------------
  let bestHead = new Int32Array(m).fill(-1);
  let bestNext = new Int32Array(n).fill(-1);
  let bestSeed0 = 0;
  let minMaxLen = Infinity;

  const currentHead = new Int32Array(m);
  const currentNext = new Int32Array(n);
  const bucketCounts = new Int32Array(m);

  // Increase attempts for large datasets to ensure we find a balanced distribution
  // We MUST find a distribution where max bucket size < 16, otherwise bucketSizes (4-bit) will overflow.
  const maxAttempts = 2000;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentSeed = Math.floor(Math.random() * 0xffffffff);
    currentHead.fill(-1);
    bucketCounts.fill(0);

    let currentMaxLen = 0;

    for (let i = 0; i < n; i++) {
      // Fast 64-bit hash simulation for bucket placement
      // bIdx = ((scramble(low, seed) ^ high) >>> 0) % m
      const h = (scramble(hashesL[i], currentSeed) ^ hashesH[i]) >>> 0;
      // Fast range reduction: (x * N) >> 32
      // Since m can be up to ~10^6, h * m fits in 53-bit float safe integer range
      const bIdx = Math.floor((h / 4294967296) * m);
      
      currentNext[i] = currentHead[bIdx];
      currentHead[bIdx] = i;
      bucketCounts[bIdx]++;
      if (bucketCounts[bIdx] > currentMaxLen)
        currentMaxLen = bucketCounts[bIdx];
    }

    // Ideal case: small buckets
    if (currentMaxLen < 13) {
      bestSeed0 = currentSeed;
      bestHead.set(currentHead);
      bestNext.set(currentNext);
      minMaxLen = currentMaxLen;
      break;
    }

    if (currentMaxLen < minMaxLen) {
      minMaxLen = currentMaxLen;
      bestSeed0 = currentSeed;
      bestHead.set(currentHead);
      bestNext.set(currentNext);
    }
    
    // If we've tried enough times and still haven't found a valid distribution (<16), keep trying
    // But if we have a valid one (e.g. 14 or 15), we can stop early if we've tried a reasonable amount
    if (minMaxLen < 16 && attempt > 50) {
        break;
    }
  }

  if (minMaxLen >= 16) {
      throw new Error(`MPHF Build Failed: Could not find a bucket distribution with max size < 16 (best: ${minMaxLen}). Try reducing the optimization level (current: ${options?.level ?? 5}).`);
  }

  // -------------------------------------------------
  // Phase 2: Build bucketSizes (nibble packed)
  // -------------------------------------------------
  const bucketSizes = new Uint8Array(Math.ceil(m / 2));
  for (let i = 0; i < m; i++) {
    let count = 0;
    let ptr = bestHead[i];
    while (ptr !== -1) {
      count++;
      ptr = bestNext[ptr];
    }
    const byteIdx = i >>> 1;
    if ((i & 1) === 0) bucketSizes[byteIdx] |= count;
    else bucketSizes[byteIdx] |= count << 4;
  }

  // -------------------------------------------------
  // Phase 3: Level 1 Consensus using integer hashes
  // -------------------------------------------------
  const seedWriter = new VarIntBuffer();
  const seedZeroBitmap = new Uint8Array(Math.ceil(m / 8));

  for (let i = 0; i < m; i++) {
    let k = 0;
    let p = bestHead[i];
    while (p !== -1) {
      k++;
      p = bestNext[p];
    }

    if (k <= 1) {
      seedZeroBitmap[i >>> 3] |= 1 << (i & 7);
      continue;
    }

    let s = 0;
    let found = false;
    const MAX_TRIALS = k > 14 ? 50_000_000 : 5_000_000;

    while (!found) {
      let visited = 0;
      let collision = false;

      let ptr = bestHead[i];
      while (ptr !== -1) {
        // Fast 64-bit hash simulation for slot placement
        // pos = ((scramble(low, s) ^ high) >>> 0) % k
        const h = (scramble(hashesL[ptr], s) ^ hashesH[ptr]) >>> 0;
        const pos = h % k;
        
        if ((visited & (1 << pos)) !== 0) {
          collision = true;
          break;
        }
        visited |= 1 << pos;
        ptr = bestNext[ptr];
      }

      if (!collision) {
        if (s === 0) seedZeroBitmap[i >>> 3] |= 1 << (i & 7);
        else seedWriter.write(s);
        found = true;
      } else {
        s++;
        if (s > MAX_TRIALS)
          throw new Error(`MPHF Failed: Bucket ${i} (size ${k}) is too hard.`);
      }
    }
  }

  const dict: IMinMPHashDict = {
    n,
    m,
    seed0: bestSeed0,
    hashSeed,
    seedStream: seedWriter.toUint8Array(),
    bucketSizes,
    seedZeroBitmap,
    validationMode,
  };

  // -------------------------------------------------
  // Phase 4: fingerprints
  // -------------------------------------------------
  if (validationMode !== "none") {
    let fingerprints: Uint8Array | Uint16Array | Uint32Array;
    if (validationMode === "2") fingerprints = new Uint8Array(Math.ceil(n / 4));
    else if (validationMode === "4")
      fingerprints = new Uint8Array(Math.ceil(n / 2));
    else if (validationMode === "8") fingerprints = new Uint8Array(n);
    else if (validationMode === "16") fingerprints = new Uint16Array(n);
    else fingerprints = new Uint32Array(n);

    const tempHasher = new MinMPHash({ ...dict, validationMode: "none" });
    const FP_SEED = 0x1234abcd;

    for (let i = 0; i < n; i++) {
      const key = dataSet[i];
      const idx = tempHasher.hash(key);
      if (idx >= 0 && idx < n) {
        const fullHash = murmurHash3_32(key, FP_SEED);
        if (validationMode === "2") {
          const fp2 = fullHash & 0x03;
          const byteIdx = idx >>> 2;
          const shift = (idx & 3) << 1;
          fingerprints[byteIdx] |= fp2 << shift;
        } else if (validationMode === "4") {
          const fp4 = fullHash & 0x0f;
          const byteIdx = idx >>> 1;
          if ((idx & 1) === 0) fingerprints[byteIdx] |= fp4;
          else fingerprints[byteIdx] |= fp4 << 4;
        } else if (validationMode === "8") {
          fingerprints[idx] = fullHash & 0xff;
        } else if (validationMode === "16") {
          fingerprints[idx] = fullHash & 0xffff;
        } else {
          fingerprints[idx] = fullHash >>> 0;
        }
      }
    }
    dict.fingerprints = fingerprints;
  }

  if (options?.outputBinary) {
    const binary = dictToCBOR(dict);
    if (options.enableCompression) return compressIBinary(binary);
    return binary;
  }
  return dict;
}

/**
 * 最小完美哈希 (Minimal Perfect Hash) 查询类。
 *
 * 该类用于加载由 `createMinMPHashDict` 生成的字典，并提供高效的哈希查询。
 *
 * @example
 * ```ts
 * const dict = createMinMPHashDict(["apple", "banana"]);
 * const mph = new MinMPHash(dict);
 * console.log(mph.hash("apple")); // 0 或 1
 * ```
 */
export class MinMPHash {
  public n: number;
  private m: number;
  private seed0: number;
  private hashSeed: number;

  // 运行时解压的数据
  private offsets: Uint32Array;
  private seeds: Int32Array;

  // 校验相关
  private validationMode: IValidationMode;
  private fingerprints: Uint8Array | Uint16Array | Uint32Array | null = null;
  private static readonly FP_SEED = 0x1234abcd;

  /**
   * 从经过 Gzip 压缩的二进制数据加载字典。
   *
   * @param data 压缩后的 Uint8Array 数据
   * @returns MinMPHash 实例
   */
  static async fromCompressed(data: Uint8Array): Promise<MinMPHash> {
    const decompressed = await decompressIBinary(data);
    return new MinMPHash(decompressed);
  }

  /**
   * 构造函数。
   *
   * @param dict 字典对象 (`IMinMPHashDict`) 或二进制 CBOR 数据 (`Uint8Array`)
   */
  constructor(dict: IMinMPHashDict | Uint8Array) {
    if (dict instanceof Uint8Array) {
      dict = dictFromCBOR(dict);
    }
    this.n = dict.n;
    this.m = dict.m;
    this.seed0 = dict.seed0;
    this.hashSeed = dict.hashSeed || 0;
    this.validationMode = dict.validationMode || "none";

    if (this.n === 0) {
      this.offsets = new Uint32Array(0);
      this.seeds = new Int32Array(0);
      return;
    }

    // 1. 重建 offsets 表 (O(m))
    // 利用 bucketSizes 累加
    this.offsets = new Uint32Array(this.m + 1);
    let currentOffset = 0;
    for (let i = 0; i < this.m; i++) {
      this.offsets[i] = currentOffset;

      // Unpack Nibble
      const byte = dict.bucketSizes[i >>> 1];
      const len = i & 1 ? byte >>> 4 : byte & 0x0f;

      currentOffset += len;
    }
    this.offsets[this.m] = currentOffset; // 应该等于 n

    // 2. 解压 seeds (O(m))
    this.seeds = new Int32Array(this.m);
    let ptr = 0;
    const buf = dict.seedStream;
    const bitmap = dict.seedZeroBitmap;

    for (let i = 0; i < this.m; i++) {
      // Check Zero Bitmap
      let isZero = false;
      if (bitmap) {
        if ((bitmap[i >>> 3] & (1 << (i & 7))) !== 0) {
          isZero = true;
        }
      }

      if (isZero) {
        this.seeds[i] = 0;
      } else {
        let result = 0;
        let shift = 0;
        // VarInt 读取
        while (true) {
          const byte = buf[ptr++];
          result |= (byte & 0x7f) << shift;
          if ((byte & 0x80) === 0) break;
          shift += 7;
        }
        this.seeds[i] = result;
      }
    }

    // 3. 恢复指纹数据
    if (this.validationMode !== "none" && dict.fingerprints) {
      const raw = dict.fingerprints;
      // 处理 JSON 序列化后变成普通数组的情况
      if (
        this.validationMode === "2" ||
        this.validationMode === "4" ||
        this.validationMode === "8"
      ) {
        this.fingerprints =
          raw instanceof Uint8Array ? raw : new Uint8Array(raw as number[]);
      } else if (this.validationMode === "16") {
        this.fingerprints =
          raw instanceof Uint16Array ? raw : new Uint16Array(raw as number[]);
      } else {
        this.fingerprints =
          raw instanceof Uint32Array ? raw : new Uint32Array(raw as number[]);
      }
    }
  }

  /**
   * 计算输入字符串的哈希值。
   *
   * @param input 要查询的字符串
   * @returns
   * - 如果字符串在原始数据集中：返回其唯一的索引 `[0, n-1]`。
   * - 如果字符串不在数据集中：
   *   - 启用了 `onlySet`：返回 `-1` (有极低概率误判为有效索引)。
   *   - 未启用 `onlySet`：返回一个冲突的索引 `[0, n-1]`。
   */
  public hash(input: string): number {
    if (this.n === 0) return -1;

    // --- 优化后的哈希计算 ---
    // 1. 只进行一次字符串哈希 (Base Hash)
    const h1 = murmurHash3_32(input, this.hashSeed);
    const h2 = murmurHash3_32(input, ~this.hashSeed);

    // 2. Level 0: 整数混淆定位桶
    // bIdx = ((scramble(low, seed0) ^ high) >>> 0) % m
    const h0 = (scramble(h1, this.seed0) ^ h2) >>> 0;
    const bIdx = Math.floor((h0 / 4294967296) * this.m);

    const offset = this.offsets[bIdx];
    const nextOffset = this.offsets[bIdx + 1];
    const bucketSize = nextOffset - offset;

    if (bucketSize === 0) return -1;

    let resultIdx = 0;
    if (bucketSize === 1) {
      resultIdx = offset;
    } else {
      const s = this.seeds[bIdx];
      // pos = ((scramble(low, s) ^ high) >>> 0) % k
      const h = (scramble(h1, s) ^ h2) >>> 0;
      resultIdx = offset + (h % bucketSize);
    }

    // --- 指纹校验 (保持原逻辑) ---
    if (this.validationMode !== "none" && this.fingerprints) {
      const fpHash = murmurHash3_32(input, MinMPHash.FP_SEED);

      if (this.validationMode === "2") {
        const expectedFp2 = fpHash & 0x03;
        const byteIdx = resultIdx >>> 2;
        const shift = (resultIdx & 3) << 1;
        // Revert to original failing code but with logging
        if (((this.fingerprints[byteIdx] >>> shift) & 0x03) !== expectedFp2)
          return -1;
      } else if (this.validationMode === "4") {
        const expectedFp4 = fpHash & 0x0f;
        const byteIdx = resultIdx >>> 1;
        const storedByte = this.fingerprints[byteIdx];
        const storedFp4 =
          (resultIdx & 1) === 0 ? storedByte & 0x0f : (storedByte >>> 4) & 0x0f;
        if (storedFp4 !== expectedFp4) return -1;
      } else if (this.validationMode === "8") {
        if (this.fingerprints[resultIdx] !== (fpHash & 0xff)) return -1;
      } else if (this.validationMode === "16") {
        if (this.fingerprints[resultIdx] !== (fpHash & 0xffff)) return -1;
      } else {
        if (this.fingerprints[resultIdx] !== fpHash >>> 0) return -1;
      }
    }

    return resultIdx;
  }
}
// ---------------------------------------------------------
// 核心哈希 (MurmurHash3 32-bit 简化版)
// ---------------------------------------------------------
// ---------------------------------------------------------
// 整数混淆函数 (Scramble)
// 用于在已预计算的 hash 基础上根据不同 seed 生成新的伪随机值
// ---------------------------------------------------------
function scramble(k: number, seed: number): number {
  k ^= seed;
  k = Math.imul(k, 0x85ebca6b);
  k ^= k >>> 13;
  k = Math.imul(k, 0xc2b2ae35);
  k ^= k >>> 16;
  return k >>> 0;
}

function murmurHash3_32(key: string, seed: number): number {
  let h1 = seed;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  for (let i = 0; i < key.length; i++) {
    let k1 = key.charCodeAt(i);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = Math.imul(h1, 5) + 0xe6546b64;
  }
  h1 ^= key.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

// ---------------------------------------------------------
// VarInt 写入工具 (用于压缩 Seed)
// ---------------------------------------------------------
class VarIntBuffer {
  buffer: number[] = [];
  write(value: number) {
    // 小于 128 的数只占 1 byte
    while (value >= 0x80) {
      this.buffer.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    this.buffer.push(value);
  }
  toUint8Array() {
    return new Uint8Array(this.buffer);
  }
}
