import { describe, it, expect } from "bun:test";
import {
  createMinMPLookupDict,
  MinMPLookup,
  serializeMinMPLookupDict,
} from "../src/MinMPLookup";
import { readFileSync } from "fs";
import { join } from "path";

const lookupMap = {
  China: ["Beijing", "Shanghai", "Guangzhou"],
  USA: ["New York", "Los Angeles", "Chicago"],
  Japan: ["Tokyo", "Osaka", "Kyoto"],
};

describe("MinMPLookup 查找表详细测试", () => {
  describe("基础功能", () => {
    it("应能正确创建并查询 (对象模式)", () => {
      const dict = createMinMPLookupDict(lookupMap);
      const lookup = new MinMPLookup(dict);

      expect(lookup.query("Beijing")).toBe("China");
      expect(lookup.query("New York")).toBe("USA");
      expect(lookup.query("Osaka")).toBe("Japan");
      expect(lookup.query("London")).toBe(null);

      // queryAll 是反向查找：输入 Value，返回 Keys
      expect(lookup.queryAll("Beijing")).toEqual(["China"]);
      // "China" 是 Key，不是 Value，所以查不到
      expect(lookup.queryAll("China")).toBe(null);
      expect(lookup.queryAll("UK")).toBe(null);
    });

    it("应能处理空数据集", () => {
      const dict = createMinMPLookupDict({});
      const lookup = new MinMPLookup(dict);
      expect(lookup.query("anything")).toBe(null);
      expect(lookup.queryAll("anyKey")).toBe(null);
    });
  });

  describe("特殊字符支持", () => {
    const specialMap = {
      Emoji: ["😀", "🚀", "中文测试"],
      Symbols: ["@#$%", " ", ""], // 空字符串测试
      Mixed: ["Key_Value", "Line\nBreak"],
    };

    it("应能正确处理 Emoji 和特殊符号", () => {
      const dict = createMinMPLookupDict(specialMap);
      const lookup = new MinMPLookup(dict);

      expect(lookup.query("😀")).toBe("Emoji");
      expect(lookup.query("中文测试")).toBe("Emoji");
      expect(lookup.query("@#$%")).toBe("Symbols");
      expect(lookup.query(" ")).toBe("Symbols");
      expect(lookup.query("")).toBe("Symbols");
      expect(lookup.query("Line\nBreak")).toBe("Mixed");
    });
  });

  describe("数据冲突与重复处理", () => {
    it("当不同 Key 包含相同 Value 时，queryAll 应能返回所有 Keys", () => {
      const duplicateMap = {
        A: ["Common"],
        B: ["Common", "UniqueB"],
        C: ["UniqueC", "Common"]
      };

      const dict = createMinMPLookupDict(duplicateMap);
      const lookup = new MinMPLookup(dict);

      // query 只返回第一个找到的 (依赖于 keys 的遍历顺序，通常是定义顺序)
      expect(lookup.query("Common")).toBe("A");
      
      // queryAll 返回所有
      const results = lookup.queryAll("Common");
      expect(results).not.toBeNull();
      expect(results!.length).toBe(3);
      expect(results).toContain("A");
      expect(results).toContain("B");
      expect(results).toContain("C");

      expect(lookup.queryAll("UniqueB")).toEqual(["B"]);
    });
  });

  describe("二进制序列化与压缩", () => {
    it("应能处理二进制输出 (同步)", () => {
      const binary = createMinMPLookupDict(lookupMap, { outputBinary: true });
      expect(binary).toBeInstanceOf(Uint8Array);

      const lookup = MinMPLookup.fromBinary(binary);
      expect(lookup.query("Shanghai")).toBe("China");
    });

    it("应能处理压缩数据 (异步)", async () => {
      const binary = await createMinMPLookupDict(lookupMap, {
        outputBinary: true,
        enableCompression: true,
      });
      expect(binary).toBeInstanceOf(Uint8Array);

      const lookup = await MinMPLookup.fromCompressed(binary);
      expect(lookup.query("Guangzhou")).toBe("China");
    });

    it("压缩后的体积应小于未压缩体积 (对于可压缩数据)", async () => {
      // Create a dataset with repetitive keys to ensure Gzip has something to compress
      // Since the binary format is already highly optimized for hashes, 
      // we rely on string compression for the keys part.
      const repetitiveMap: Record<string, string[]> = {};
      for (let i = 0; i < 50; i++) {
        const key = "RepetitiveLongKeyName_CommonPrefix_" + i;
        repetitiveMap[key] = ["Value" + i];
      }

      const rawBinary = createMinMPLookupDict(repetitiveMap, {
        outputBinary: true,
      });
      const compressedBinary = await createMinMPLookupDict(repetitiveMap, {
        outputBinary: true,
        enableCompression: true,
      });

      // console.log(`Raw: ${rawBinary.length}, Compressed: ${compressedBinary.length}`);
      expect(compressedBinary.length).toBeLessThan(rawBinary.length);
    });

    it("序列化一致性检查", () => {
      const dict = createMinMPLookupDict(lookupMap);
      const binary1 = serializeMinMPLookupDict(dict);

      const lookup = MinMPLookup.fromBinary(binary1);
      expect(lookup.query("Beijing")).toBe("China");
    });
  });

  describe("大数据集性能", () => {
    it("应能处理 10,000 条数据", () => {
      const largeMap: Record<string, string[]> = {};
      const keyCount = 100;
      const valPerKey = 100;

      for (let i = 0; i < keyCount; i++) {
        const key = `Key${i}`;
        const values: string[] = [];
        for (let j = 0; j < valPerKey; j++) {
          values.push(`Value-${i}-${j}`);
        }
        largeMap[key] = values;
      }

      const dict = createMinMPLookupDict(largeMap);
      const lookup = new MinMPLookup(dict);

      expect(lookup.query("Value-50-50")).toBe("Key50");
      expect(lookup.query("Value-0-0")).toBe("Key0");
      expect(lookup.query("Value-99-99")).toBe("Key99");
      expect(lookup.query("Value-X-Y")).toBe(null);
    });
  });

  describe("真实数据测试 (names-map.json)", () => {
    it("应能正确处理真实字体映射数据", async () => {
      const jsonPath = join(__dirname, "names-map.json");
      const jsonContent = readFileSync(jsonPath, "utf-8");
      const namesMap = JSON.parse(jsonContent) as Record<string, string[]>;

      // 1. 创建字典 (启用压缩)
      const binary = await createMinMPLookupDict(namesMap, {
        level: 5,
        outputBinary: true,
        enableCompression: true,
      });

      // 2. 加载字典
      const lookup = await MinMPLookup.fromCompressed(binary);

      // 3. 验证数据
      // 测试: pixel-mplus10 -> PixelMplus10-Bold
      expect(lookup.query("PixelMplus10-Bold")).toBe("pixel-mplus10");

      // 测试: rampart-one -> ランパート One (非 ASCII 字符)
      expect(lookup.query("ランパート One")).toBe("rampart-one");

      // 测试: designer-love-one -> 设计师爱心体1号字
      expect(lookup.query("设计师爱心体1号字")).toBe("designer-love-one");

      // 测试: 不存在的字体
      expect(lookup.query("NonExistentFont")).toBe(null);

      // 4. 统计信息输出
      console.log(`\n[Real Data Stats]`);
      console.log(
        `Original JSON Size: ${(jsonContent.length / 1024).toFixed(2)} KB`
      );
      console.log(
        `MinMPLookup Binary Size: ${(binary.length / 1024).toFixed(2)} KB`
      );
      console.log(
        `Compression Ratio: ${(
          (binary.length / jsonContent.length) *
          100
        ).toFixed(2)}%`
      );
    });
  });

  describe("配置选项", () => {
    it("onlySet 选项影响查询准确性", () => {
      // onlySet: false 关闭指纹，体积最小，但对于不在集合中的 Key 会产生误判
      const dictFalse = createMinMPLookupDict(lookupMap, { onlySet: false });
      const lookupFalse = new MinMPLookup(dictFalse);
      expect(lookupFalse.query("Beijing")).toBe("China");
      // 由于不再存储 Values 进行校验，onlySet: false 会导致 Unknown 被映射到某个存在的 Key
      expect(lookupFalse.query("Unknown")).not.toBe(null);

      // onlySet: "32" 强校验，几乎无误判
      const dict32 = createMinMPLookupDict(lookupMap, { onlySet: "32" });
      const lookup32 = new MinMPLookup(dict32);
      expect(lookup32.query("Beijing")).toBe("China");
      expect(lookup32.query("Unknown")).toBe(null);
    });
  });
});
