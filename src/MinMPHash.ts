import {
  dictFromCBOR,
  dictToCBOR,
  compressIBinary,
  decompressIBinary,
} from "./util";

export interface IMinMPHashDict {
  /** 元素总数 */
  n: number;
  /** 桶数量 */
  m: number;
  /** 全局种子 (Level 0) */
  seed0: number;
  /** * 压缩的种子数据流 (VarInt)
   * 存储构建每个桶所需的双射种子
   */
  seedStream: Uint8Array;
  /** * 桶的大小数组 (Uint8)
   * 替代了庞大的 offsets 数组。运行时通过累加此数组恢复 offsets。
   * 空间占用从 N*4 bytes 降至 (N/BucketRate) bytes
   *
   * [优化] 采用 Nibble Packing (4-bit) 存储，长度为 ceil(m/2)
   */
  bucketSizes: Uint8Array;

  /**
   * [优化] 种子零值位图
   * 长度为 ceil(m/8)
   * 如果某位为 1，表示对应桶的种子为 0，不再存储在 seedStream 中
   */
  seedZeroBitmap?: Uint8Array;

  /** * 指纹数组
   * - 4-bit: Uint8Array (长度为 n/2)
   * - 8-bit: Uint8Array (长度为 n)
   * ...
   */
  fingerprints?: Uint8Array | Uint16Array | Uint32Array | number[];

  /** 校验模式 */
  validationMode: IValidationMode;
}

export type IValidationMode = "none" | "2" | "4" | "8" | "16" | "32";
export interface IMinMPHashDictOptions {
    /** 让 hash 函数只对数据集中数据有效
     *  如果有无效数据传入，hash 值是 -1
     *
     *  启用后，字典会额外存储每条数据的指纹，用于验证输入数据是否合法
     *
     *  这会增加字典体积，并且有一定的误判率（即错误地将非数据集的数据误判为数据集内的数据，但数据集内的数据一定正确）
     *  你可以手动选择指纹的位数以权衡体积和误判率
     *    - "2"  - 2-bit 指纹  (0.25 byte) ~25% 误判率
     *    - "4"  - 4-bit 指纹  (0.5 byte) ~6.25% 误判率
     *    - "8"  - 8-bit 指纹  (1 byte)   ~0.39%
     *    - "16" - 16-bit 指纹 (2 bytes)  ~0.0015%
     *    - "32" - 32-bit 指纹 (4 bytes)  ~0.00000002% 误判率
     *
     *
     *  示例字典体积变化 (6000 个数短名字)：
     * | onlySet 模式 | 体积 | 体积变化 | 百分比 |
     * | :--- | :--- | :--- | :--- |
     * | none            | 24.04 KB   | +0 B       | 100%     |
     * | 4               | 56.50 KB   | +32.46 KB  | 135.0%   |
     * | 8               | 90.26 KB   | +66.23 KB  | 275.5%   |
     * | 16              | 104.36 KB  | +80.32 KB  | 334.1%   |
     */
    onlySet?: boolean | IValidationMode;

    /** 字典优化级别 [1-10] , 默认为 5
     *  level 越大字典体积越小，但是字典构建时间越长
     * @example
     * level 1:      112.39 KB   (7.04 ms)
     * level 2:       55.54 KB   (10.17 ms)
     * level 3:       37.16 KB   (14.54 ms)
     * level 4:       28.45 KB   (52.34 ms)
     * level 5:       24.06 KB   (147.72 ms) (默认)
     * level 6:       21.30 KB   (446.77 ms)
     * level 7:       19.76 KB   (922.98 ms)
     * level 8:       18.72 KB   (4300.21 ms)
     * level 9:       18.02 KB   (13055.98 ms)
     * level 10:      17.61 KB   (42884.85 ms)
     */
    level?: number;

    /** 是否输出二进制 CBOR 格式的字典 */
    outputBinary?: boolean;

    /** 是否启用 Gzip 压缩 (仅当 outputBinary 为 true 时有效)
     *  启用后会返回一个压缩后的 Promise<Uint8Array>，而不是原始 CBOR 二进制数据
     *  注意：启用后返回的是 Promise<Uint8Array>
     *
     *  使用时需要调用 await MinMPHash.fromCompressed() 方法来加载压缩后的字典
     *
     */
    enableCompression?: boolean;
  }

/**
 * 创建最小完美哈希字典
 */
export function createMinMPHashDict(
  dataSet: string[],
  options?: {
    onlySet?: boolean | IValidationMode;
    level?: number;
    outputBinary?: false;
  }
): IMinMPHashDict;
export function createMinMPHashDict(
  dataSet: string[],
  options?: {
    onlySet?: boolean | IValidationMode;
    level?: number;
    outputBinary: true;
    enableCompression?: false;
  }
): Uint8Array;
export function createMinMPHashDict(
  dataSet: string[],
  options: {
    onlySet?: boolean | IValidationMode;
    level?: number;
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
 * 最小完美哈希的哈希函数类
 * 使用时请先通过 createMinMPHashDict 创建字典，然后把字典传入本类构造函数。
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

  static async fromCompressed(data: Uint8Array): Promise<MinMPHash> {
    const decompressed = await decompressIBinary(data);
    return new MinMPHash(decompressed);
  }

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
   * 计算哈希值
   * * @returns [0, n-1] 如果在集合中
   * @returns -1 如果 key 无效 (且启用了 validationMode)
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
