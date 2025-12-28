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
  /** 原始数据集中的元素总数 */
  n: number;
  /** 分桶数量 */
  m: number;
  /** 全局哈希种子 (Level 0) */
  seed0: number;
  /**
   * 压缩后的种子数据流 (VarInt)。
   * 存储每个桶所需的 Level 1 种子。
   */
  seedStream: Uint8Array;
  /**
   * 桶大小数组 (Nibble Packing)。
   * 存储每个桶的元素数量，用于运行时恢复偏移量。
   */
  bucketSizes: Uint8Array;

  /**
   * 种子零值位图。
   * 标记哪些桶的种子为 0，以节省 `seedStream` 空间。
   */
  seedZeroBitmap?: Uint8Array;

  /**
   * 校验指纹数组。
   * 根据 `validationMode` 的不同，可能为 `Uint8Array`, `Uint16Array` 或 `Uint32Array`。
   */
  fingerprints?: Uint8Array | Uint16Array | Uint32Array | number[];

  /** 当前字典使用的校验模式 */
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
 * 创建二进制格式的最小完美哈希字典。
 */
export function createMinMPHashDict(
  dataSet: string[],
  options: IMinMPHashDictOptions & {
    outputBinary: true;
    enableCompression?: false;
  }
): Uint8Array;
/**
 * 创建经过 Gzip 压缩的二进制最小完美哈希字典。
 */
export function createMinMPHashDict(
  dataSet: string[],
  options: IMinMPHashDictOptions & {
    outputBinary: true;
    enableCompression: true;
  }
): Promise<Uint8Array>;
export function createMinMPHashDict(
  /** 创建字典的数据 */
  dataSet: string[],
  options?: IMinMPHashDictOptions
): IMinMPHashDict | Uint8Array | Promise<Uint8Array> {
  const n = dataSet.length;

  // 空数据集处理
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
  if (options?.onlySet === true) {
    validationMode = "8";
  } else if (typeof options?.onlySet === "string") {
    validationMode = options.onlySet;
  }
  const m = Math.max(1, Math.ceil(n / targetRate));

  // -------------------------------------------------
  // Phase 1: Level 0 Best-Fit 分桶
  // 寻找一个 seed0，使得最大桶的尺寸最小，防止极端哈希冲突
  // -------------------------------------------------
  let bestBuckets: string[][] = [];
  let bestSeed0 = 0;
  let minMaxLen = Infinity;

  // 尝试次数：如果 n 很大，尝试次数少一点以免在这里耗时太久；n 小则多试几次
  const balanceAttempts = n > 100000 ? 20 : 50;

  for (let i = 0; i < balanceAttempts; i++) {
    const currentSeed = Math.floor(Math.random() * 0xffffffff);
    const currentBuckets: string[][] = Array.from({ length: m }, () => []);
    let currentMaxLen = 0;

    for (const key of dataSet) {
      const h = murmurHash3_32(key, currentSeed);
      const bIdx = Math.floor((h / 0x100000000) * m);
      currentBuckets[bIdx].push(key);
      if (currentBuckets[bIdx].length > currentMaxLen) {
        currentMaxLen = currentBuckets[bIdx].length;
      }
    }

    // 早期退出：如果分布已经非常好了
    if (currentMaxLen < 13) {
      bestSeed0 = currentSeed;
      bestBuckets = currentBuckets;
      minMaxLen = currentMaxLen;
      break;
    }

    if (currentMaxLen < minMaxLen) {
      minMaxLen = currentMaxLen;
      bestSeed0 = currentSeed;
      bestBuckets = currentBuckets;
    }
  }

  // -------------------------------------------------
  // Phase 2: 构建 Bucket Sizes 元数据 (Nibble Packing)
  // -------------------------------------------------
  const bucketSizes = new Uint8Array(Math.ceil(m / 2));
  for (let i = 0; i < m; i++) {
    const len = bestBuckets[i].length;

    const byteIdx = i >>> 1;
    if ((i & 1) === 0) {
      bucketSizes[byteIdx] |= len;
    } else {
      bucketSizes[byteIdx] |= len << 4;
    }
  }

  // -------------------------------------------------
  // Phase 3: Level 1 Consensus 寻找双射种子
  // -------------------------------------------------
  const seedWriter = new VarIntBuffer();
  const seedZeroBitmap = new Uint8Array(Math.ceil(m / 8));

  for (let i = 0; i < m; i++) {
    const bucket = bestBuckets[i];
    const k = bucket.length;

    // 空桶或单元素桶不需要搜索，种子存 0
    if (k <= 1) {
      // Mark as zero
      seedZeroBitmap[i >>> 3] |= 1 << (i & 7);
      continue;
    }

    let s = 0;
    let found = false;

    // 动态调整最大尝试次数，避免死循环
    // k 越大，需要的尝试次数呈指数级增长
    const MAX_TRIALS = k > 14 ? 50_000_000 : 5_000_000;

    while (!found) {
      let visited = 0;
      let collision = false;

      for (const key of bucket) {
        const h = murmurHash3_32(key, s);
        const pos = h % k;

        // 检查位是否被占用
        if ((visited & (1 << pos)) !== 0) {
          collision = true;
          break;
        }
        visited |= 1 << pos;
      }

      if (!collision) {
        if (s === 0) {
          seedZeroBitmap[i >>> 3] |= 1 << (i & 7);
        } else {
          seedWriter.write(s);
        }
        found = true;
      } else {
        s++;
        if (s > MAX_TRIALS) {
          throw new Error(
            `MPHF Failed: Bucket ${i} (size ${k}) is too hard to hash.`
          );
        }
      }
    }
  }

  // 基础字典构建完成
  const dict: IMinMPHashDict = {
    n,
    m,
    seed0: bestSeed0,
    seedStream: seedWriter.toUint8Array(),
    bucketSizes,
    seedZeroBitmap,
    validationMode,
  };

  // -------------------------------------------------
  // Phase 4: 生成校验指纹 (如果启用)
  // -------------------------------------------------
  if (validationMode !== "none") {
    // 分配内存
    let fingerprints: Uint8Array | Uint16Array | Uint32Array;
    if (validationMode === "2") {
      fingerprints = new Uint8Array(Math.ceil(n / 4));
    } else if (validationMode === "4") {
      fingerprints = new Uint8Array(Math.ceil(n / 2));
    } else if (validationMode === "8") {
      fingerprints = new Uint8Array(n);
    } else if (validationMode === "16") {
      fingerprints = new Uint16Array(n);
    } else if (validationMode === "32") {
      fingerprints = new Uint32Array(n);
    } else {
      throw new Error(`Invalid validationMode: ${validationMode}`);
    }

    // 创建临时 Hasher 计算索引
    // 为了避免把 `dict` 带入 fingerprints 字段导致循环，我们复制一份 clean 的 config
    const tempHasher = new MinMPHash({ ...dict, validationMode: "none" });
    const FP_SEED = 0x1234abcd; // 固定的指纹种子

    for (const key of dataSet) {
      const idx = tempHasher.hash(key);

      // 只有当 key 确实在集合中 (理论上必定在) 且索引有效时
      if (idx >= 0 && idx < n) {
        const fullHash = murmurHash3_32(key, FP_SEED);

        if (validationMode === "2") {
          // --- 2-bit 紧凑存储 ---
          const fp2 = fullHash & 0x03; // 取低 2 位
          const byteIdx = idx >>> 2; // idx / 4
          const shift = (idx & 3) << 1; // (idx % 4) * 2

          fingerprints[byteIdx] |= fp2 << shift;
        } else if (validationMode === "4") {
          // --- 4-bit 紧凑存储 ---
          const fp4 = fullHash & 0x0f; // 取低 4 位
          const byteIdx = idx >>> 1; // idx / 2

          if ((idx & 1) === 0) {
            // 偶数索引：存低 4 位
            fingerprints[byteIdx] |= fp4;
          } else {
            // 奇数索引：存高 4 位
            fingerprints[byteIdx] |= fp4 << 4;
          }
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
    if (options.enableCompression) {
      return compressIBinary(binary);
    }
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
  private n: number;
  private m: number;
  private seed0: number;

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

    // --- Step 1: 最小完美哈希计算 ---

    // Level 0: 定位桶
    const h1 = murmurHash3_32(input, this.seed0);
    const bIdx = Math.floor((h1 / 0x100000000) * this.m);

    // 获取桶元数据
    const offset = this.offsets[bIdx];
    const nextOffset = this.offsets[bIdx + 1];
    const bucketSize = nextOffset - offset;

    // 空桶检查
    if (bucketSize === 0) return -1;

    let resultIdx = 0;

    // Level 1: 桶内定位
    if (bucketSize === 1) {
      resultIdx = offset;
    } else {
      const s = this.seeds[bIdx];
      const h2 = murmurHash3_32(input, s);
      resultIdx = offset + (h2 % bucketSize);
    }

    // --- Step 2: 指纹校验 ---
    if (this.validationMode !== "none" && this.fingerprints) {
      const fpHash = murmurHash3_32(input, MinMPHash.FP_SEED);

      if (this.validationMode === "2") {
        // 2-bit 校验
        const expectedFp2 = fpHash & 0x03;
        const byteIdx = resultIdx >>> 2;
        const shift = (resultIdx & 3) << 1;
        const storedFp2 = (this.fingerprints[byteIdx] >>> shift) & 0x03;

        if (storedFp2 !== expectedFp2) return -1;
      } else if (this.validationMode === "4") {
        // 4-bit 校验
        const expectedFp4 = fpHash & 0x0f;

        const byteIdx = resultIdx >>> 1;
        const storedByte = this.fingerprints[byteIdx];

        let storedFp4 = 0;
        if ((resultIdx & 1) === 0) {
          storedFp4 = storedByte & 0x0f; // 偶数: 低4位
        } else {
          storedFp4 = (storedByte >>> 4) & 0x0f; // 奇数: 高4位
        }

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
