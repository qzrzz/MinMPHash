 

import { createMinMPHashDict, MinMPHash } from "../src/index";
import fullData from "./names.json";

describe("MinMPHash 全量数据测试", () => {
  it("应该为 names.json 中的所有名称创建完美哈希", () => {
    // 确保键是唯一的字符串
    const keys = Array.from(new Set(fullData as string[]));

    console.log(`正在测试 ${keys.length} 个唯一键...`);

    // 创建字典
    const dict = createMinMPHashDict(keys, { level: 5 });

    // 初始化运行时
    const mph = new MinMPHash(dict);

    const seen = new Set<number>();

    // 验证每个键
    for (const key of keys) {
      const hash = mph.hash(key);

      // 检查范围 [0, n-1]
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(keys.length);

      // 检查唯一性
      if (seen.has(hash)) {
        throw new Error(`检测到碰撞: key="${key}", hash=${hash}`);
      }
      seen.add(hash);
    }

    // 再次检查我们是否拥有正好 n 个唯一的哈希值
    expect(seen.size).toBe(keys.length);

    console.log(`成功哈希了 ${keys.length} 个键，无碰撞。`);
    console.log(
      `字典大小统计: n=${dict.n}, m=${dict.m}, seedStream=${dict.seedStream.length} bytes, bucketSizes=${dict.bucketSizes.length} bytes`
    );
  });
});
