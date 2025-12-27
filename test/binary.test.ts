import { createMinMPHashDict, MinMPHash } from "../src/index";
import fullData from "./names.json";

describe("MinMPHash 二进制 (CBOR) 功能测试", () => {
  it("基础功能：应该能生成二进制字典并正确初始化", () => {
    const dataSet = ["apple", "banana", "cherry", "date", "elderberry"];
    const bin = createMinMPHashDict(dataSet, { outputBinary: true });

    expect(bin).toBeInstanceOf(Uint8Array);

    const hasher = new MinMPHash(bin);
    const results = new Set<number>();
    for (const item of dataSet) {
      const hash = hasher.hash(item);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(dataSet.length);
      results.add(hash);
    }
    expect(results.size).toBe(dataSet.length);
  });

  it("空数据集：二进制模式应能处理空数据集", () => {
    const bin = createMinMPHashDict([], { outputBinary: true });
    expect(bin).toBeInstanceOf(Uint8Array);

    const hasher = new MinMPHash(bin);
    expect(hasher.hash("anything")).toBe(-1);
  });

  it("验证模式：二进制字典应保留校验功能", () => {
    const dataSet = ["one", "two", "three"];
    const modes = ["4", "8", "16", "32"] as const;

    for (const mode of modes) {
      const bin = createMinMPHashDict(dataSet, {
        onlySet: mode,
        outputBinary: true,
      });
      const hasher = new MinMPHash(bin);

      // 集合内的元素
      for (const item of dataSet) {
        expect(hasher.hash(item)).not.toBe(-1);
      }

      // 集合外的元素
      expect(hasher.hash("not-in-set")).toBe(-1);
    }
  });

  it("全量数据测试 (二进制模式)", () => {
    const keys = Array.from(new Set(fullData as string[])).slice(0, 5000); // 取前 5000 个以加快测试

    const bin = createMinMPHashDict(keys, { level: 5, outputBinary: true });
    const mph = new MinMPHash(bin);

    const seen = new Set<number>();
    for (const key of keys) {
      const hash = mph.hash(key);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(keys.length);

      if (seen.has(hash)) {
        throw new Error(`检测到碰撞: key="${key}", hash=${hash}`);
      }
      seen.add(hash);
    }
    expect(seen.size).toBe(keys.length);
  });

  it("类型推导测试", () => {
    const dataSet = ["a", "b"];

    // 显式指定 outputBinary 为 true 时，返回类型应为 Uint8Array
    const bin = createMinMPHashDict(dataSet, { outputBinary: true });
    // @ts-expect-error: bin 应该是 Uint8Array，没有 n 属性
    const _n = bin.n;
    expect(bin).toBeInstanceOf(Uint8Array);

    // 显式指定 outputBinary 为 false 或不指定时，返回类型应为 IMinMPHashDict
    const dict = createMinMPHashDict(dataSet, { outputBinary: false });
    expect(dict.n).toBe(2);
  });
});
