import { createMinMPHFilterDict, MinMPHFilter } from "../src/MinMPHFilter";
import { expect, test, describe } from "bun:test";

describe("MinMPHFilter (最小完美哈希过滤器)", () => {
  
  test("基础功能测试", () => {
    const dataSet = ["apple", "banana", "cherry", "date", "elderberry"];
    // 使用默认 bitKey="8"
    const dict = createMinMPHFilterDict(dataSet, { bitKey: "8" });
    const filter = new MinMPHFilter(dict);

    // 验证集合中的所有元素都能被找到
    for (const item of dataSet) {
      expect(filter.has(item)).toBe(true);
    }

    // 验证不在集合中的元素（大概率返回 false）
    // 注意：GCS 是概率性数据结构，存在误判率，所以我们只检查误判数量是否在合理范围内
    const nonExisting = ["fig", "grape", "honeydew", "kiwi", "lemon"];
    let fpCount = 0;
    for (const item of nonExisting) {
      if (filter.has(item)) fpCount++;
    }
    // 5个元素误判率极低，应该全部为 false，但为了测试稳定性，我们允许极少数误判
    expect(fpCount).toBeLessThan(nonExisting.length);
  });

  test("特殊字符支持 (Unicode/Emoji/中文)", () => {
    const dataSet = ["你好", "世界", "👋", "🌍", "测试-test-123", "空格  测试"];
    const dict = createMinMPHFilterDict(dataSet);
    const filter = new MinMPHFilter(dict);

    for (const item of dataSet) {
      expect(filter.has(item)).toBe(true);
    }
    expect(filter.has("不存在")).toBe(false);
    expect(filter.has("🚀")).toBe(false);
  });

  test("二进制序列化与反序列化", () => {
    const dataSet = ["apple", "banana", "cherry"];
    // 输出二进制格式
    const bin = createMinMPHFilterDict(dataSet, { outputBinary: true, bitKey: "8" });
    expect(bin).toBeInstanceOf(Uint8Array);
    
    // 从二进制数据恢复过滤器
    const filter = new MinMPHFilter(bin);

    for (const item of dataSet) {
      expect(filter.has(item)).toBe(true);
    }
    expect(filter.has("fig")).toBe(false);
  });

  test("Gzip 压缩支持", async () => {
    const dataSet = ["apple", "banana", "cherry"];
    // 启用压缩
    const bin = await createMinMPHFilterDict(dataSet, { 
      outputBinary: true, 
      enableCompression: true, 
      bitKey: "8" 
    });
    expect(bin).toBeInstanceOf(Uint8Array);

    // 从压缩数据恢复
    const filter = await MinMPHFilter.fromCompressed(bin);

    for (const item of dataSet) {
      expect(filter.has(item)).toBe(true);
    }
    expect(filter.has("fig")).toBe(false);
  });

  test("大数据集与 Checkpoints (检查点机制)", () => {
    // 创建足够多的数据以触发多个 Checkpoints (默认间隔 128)
    const count = 2000;
    const dataSet: string[] = [];
    for (let i = 0; i < count; i++) {
      dataSet.push(`key-${i}-${Math.random()}`);
    }

    const dict = createMinMPHFilterDict(dataSet, { bitKey: "8" });
    const filter = new MinMPHFilter(dict);

    // 验证所有 Key 都在集合中
    for (const key of dataSet) {
      expect(filter.has(key)).toBe(true);
    }

    // 验证误判率 (FPR)
    // bitKey=8 时，理论误判率约为 0.39%
    let falsePositives = 0;
    const testCount = 5000;
    for (let i = 0; i < testCount; i++) {
      if (filter.has(`not-in-set-${i}`)) {
        falsePositives++;
      }
    }
    
    const fpr = (falsePositives / testCount) * 100;
    console.log(`[FPR Test] bitKey=8, Items=${count}, Queries=${testCount}, FP=${falsePositives}, FPR=${fpr.toFixed(3)}%`);
    
    // 期望 FPR < 1% (理论值 ~0.39%)
    expect(fpr).toBeLessThan(1.0);
  });

  test("不同 bitKey 参数测试", () => {
    const dataSet = ["a", "b", "c", "d", "e"];
    
    // 测试几个典型的 bitKey
    // bitKey 越大，误判率越低，体积越大
    const keys = ["6", "10", "16"] as const;
    
    for (const k of keys) {
      const dict = createMinMPHFilterDict(dataSet, { bitKey: k });
      const filter = new MinMPHFilter(dict);
      
      for (const item of dataSet) {
        expect(filter.has(item)).toBe(true);
      }
      expect(filter.has("z")).toBe(false);
    }
  });

  test("边界情况：空数据集", () => {
    const dataSet: string[] = [];
    const dict = createMinMPHFilterDict(dataSet, { bitKey: "8" });
    const filter = new MinMPHFilter(dict);

    expect(filter.has("anything")).toBe(false);
  });

  test("边界情况：单元素集合", () => {
    const dataSet = ["only-one"];
    const dict = createMinMPHFilterDict(dataSet);
    const filter = new MinMPHFilter(dict);

    expect(filter.has("only-one")).toBe(true);
    expect(filter.has("other")).toBe(false);
  });

  test("边界情况：重复元素", () => {
    // 输入包含重复元素，过滤器应该能正常工作（视为去重后）
    const dataSet = ["apple", "apple", "banana"];
    const dict = createMinMPHFilterDict(dataSet);
    const filter = new MinMPHFilter(dict);

    expect(filter.has("apple")).toBe(true);
    expect(filter.has("banana")).toBe(true);
    expect(filter.has("cherry")).toBe(false);
  });
  
  test("64位哈希模拟 (大量数据稳定性)", () => {
    // 验证内部 64 位哈希逻辑在处理一定量数据时不会崩溃
    const dataSet: string[] = [];
    for(let i=0; i<100; i++) {
        dataSet.push(`test-item-${i}`);
    }
    
    const dict = createMinMPHFilterDict(dataSet, { bitKey: "8" });
    const filter = new MinMPHFilter(dict);
    
    for(const item of dataSet) {
        expect(filter.has(item)).toBe(true);
    }
  });

  test("错误处理：无效的二进制数据", () => {
    // 传入随机垃圾数据
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    // 构造函数可能会抛出错误，或者创建一个行为异常的过滤器
    // 这里我们主要确保它不会导致进程崩溃（Crash）
    try {
        const filter = new MinMPHFilter(garbage);
        // 如果没有抛出错误，调用 has 也不应崩溃
        filter.has("test");
    } catch (e) {
        // 抛出错误也是可以接受的
        expect(e).toBeDefined();
    }
  });
});
