import { createMinMPHashDict, MinMPHash } from "../src/index"
import names from "./names.json"

describe("MinMPHash onlySet 模式大规模验证", () => {
    const dataSet = names as string[]
    const n = dataSet.length

    it(`验证 ${n} 条数据的完整性 (onlySet: "16")`, () => {
        console.log(`数据集大小: ${n}`)
        const dict = createMinMPHashDict(dataSet, { onlySet: "16" })
        const hasher = new MinMPHash(dict)

        // 1. 验证所有原始数据都能找到
        for (let i = 0; i < dataSet.length; i++) {
            const res = hasher.hash(dataSet[i])
            if (res === -1) {
                throw new Error(`数据丢失: ${dataSet[i]} at index ${i}`)
            }
        }
        console.log("✅ 所有原始数据验证通过")
    })

    it("测试不同指纹位数的误判率与体积", () => {
        const testCases = [
            { mode: "none", label: "无校验" },
            { mode: "2", label: "2-bit 指纹" },
            { mode: "4", label: "4-bit 指纹" },
            { mode: "8", label: "8-bit 指纹" },
            { mode: "16", label: "16-bit 指纹" },
            { mode: "32", label: "32-bit 指纹" },
        ] as const

        const negativeSamples = Array.from({ length: 10000 }, (_, i) => `non-existent-name-${i}-${Math.random()}`)

        console.log("\n| 模式 | 字典体积 (KB) | 误判数 (10000次) | 误判率 |")
        console.log("| :--- | :--- | :--- | :--- |")

        for (const { mode, label } of testCases) {
            const dict = createMinMPHashDict(dataSet, { onlySet: mode as any })
            const hasher = new MinMPHash(dict)

            // 计算体积 (近似)
            let size = 0
            size += dict.seedStream.length
            size += dict.bucketSizes.length
            if (dict.fingerprints) {
                size +=
                    (dict.fingerprints as any).byteLength ||
                    dict.fingerprints.length * (mode === "16" ? 2 : mode === "32" ? 4 : 1)
            }
            const sizeKB = (size / 1024).toFixed(2)

            // 测试误判率
            let falsePositives = 0
            if (mode !== "none") {
                for (const sample of negativeSamples) {
                    if (hasher.hash(sample) !== -1) {
                        falsePositives++
                    }
                }
            } else {
                falsePositives = 10000 // none 模式下所有输入都会返回一个索引
            }

            const fpRate = ((falsePositives / 10000) * 100).toFixed(4) + "%"
            console.log(`| ${label} | ${sizeKB} KB | ${falsePositives} | ${fpRate} |`)

            // 验证基本正确性
            expect(hasher.hash(dataSet[0])).not.toBe(-1)
        }
    })

    it("验证 4-bit 模式下的边界情况", () => {
        // 4-bit 模式下，两个索引共享一个 byte，需要确保高低位存取正确
        const dict = createMinMPHashDict(dataSet, { onlySet: "4" })
        const hasher = new MinMPHash(dict)

        for (let i = 0; i < Math.min(dataSet.length, 100); i++) {
            expect(hasher.hash(dataSet[i])).not.toBe(-1)
        }
    })
})
