import allNames from "./names.json"
import { createMinMPHashDict } from "../src/index"

function formatBytes(b: number) {
    if (b < 1024) return b + " B"
    if (b < 1024 * 1024) return (b / 1024).toFixed(2) + " KB"
    return (b / (1024 * 1024)).toFixed(2) + " MB"
}

function bytesOfFingerprints(fp: any): number {
    if (!fp) return 0
    if (fp instanceof Uint8Array || fp instanceof Uint16Array || fp instanceof Uint32Array) return fp.byteLength
    if (Array.isArray(fp)) return fp.length * 4
    return 0
}

async function main() {
    const tests: { label: string; opt?: boolean | string }[] = [
        { label: "none", opt: undefined },
        { label: "false", opt: false },
        { label: "true (-> 8-bit)", opt: true },
        { label: "4-bit", opt: "4" },
        { label: "8-bit", opt: "8" },
        { label: "16-bit", opt: "16" },
    ]

    const results: any[] = []

    for (const t of tests) {
        const start = Date.now()
        const dict = createMinMPHashDict(allNames as string[], { onlySet: t.opt as any, level: 5 })
        const took = Date.now() - start

        // 使用 JSON 序列化后的体积进行比较
        // 注意：Uint8Array 等在 JSON 中会被转为数组，这会显著增加体积，但这是用户要求的“标准”
        const jsonStr = JSON.stringify(dict)
        const jsonBytes = Buffer.byteLength(jsonStr, "utf8")

        const seedStreamBytes = dict.seedStream ? dict.seedStream.byteLength : 0
        const bucketSizesBytes = dict.bucketSizes ? dict.bucketSizes.byteLength : 0
        const fpBytes = bytesOfFingerprints((dict as any).fingerprints)

        results.push({
            label: t.label,
            n: dict.n,
            m: dict.m,
            seedStreamBytes,
            bucketSizesBytes,
            fpBytes,
            total: jsonBytes, // 统一使用 JSON 体积
            took,
        })
    }

    const baseline = results.find((r) => r.label === "none")?.total ?? results[0].total

    // 构建表格行
    const rows = results.map((r) => {
        const delta = r.total - baseline
        const bitsPerKey = (r.total * 8) / r.n
        const overheadPct = baseline > 0 ? (delta / baseline) * 100 : 0

        return {
            "模式 (onlySet)": r.label,
            总大小: formatBytes(r.total),
            "每元素占用 (bits)": bitsPerKey.toFixed(2),
            额外开销: `${delta >= 0 ? "+" : ""}${formatBytes(delta)}`,
            增长率: `${overheadPct.toFixed(1)}%`,
            种子流: formatBytes(r.seedStreamBytes),
            桶大小表: formatBytes(r.bucketSizesBytes),
            指纹数据: formatBytes(r.fpBytes),
            构建耗时: `${r.took}ms`,
        }
    })

    console.log("\n📊 MinMPHash 字典体积对比报告")
    console.log("============================================================")
    console.log(`数据集大小 (n): ${results[0].n}`)
    console.log(`分桶数量 (m): ${results[0].m}`)
    console.log("------------------------------------------------------------")
    console.table(rows)

    console.log("\n💡 结论说明:")
    console.log("- 'none': 基础最小完美哈希，不包含任何原始数据或指纹，仅用于将已知 Key 映射到 [0, n-1]。")
    console.log("- '4/8/16-bit': 开启 onlySet 后增加的指纹大小。位数越高，误判率越低，但体积越大。")
    console.log("- '每元素占用 (bits)': 衡量哈希效率的关键指标。通常基础 MPHF 在 2-4 bits/key 左右。")
    console.log("============================================================\n")

    // 简略总结表
    const summaryRows = results.map((r) => {
        const delta = r.total - baseline
        const overheadPct = baseline > 0 ? (delta / baseline) * 100 : 0
        return {
            "onlySet 模式": r.label,
            体积: formatBytes(r.total),
            体积变化: `${delta >= 0 ? "+" : ""}${formatBytes(delta)}`,
            百分比: `${overheadPct.toFixed(1)}%`,
        }
    })

    console.log("📝 简略总结表")
    console.table(summaryRows)

    // 输出用于注释的 Markdown 表格
    console.log("\n📝 用于注释的 Markdown 表格 (可直接复制到 JSDoc):")
    console.log("/**")
    console.log(" * | onlySet 模式 | 体积 | 体积变化 | 百分比 |")
    console.log(" * | :--- | :--- | :--- | :--- |")
    summaryRows.forEach(row => {
        console.log(` * | ${row["onlySet 模式"].padEnd(15)} | ${row.体积.padEnd(10)} | ${row.体积变化.padEnd(10)} | ${row.百分比.padEnd(8)} |`)
    })
    console.log(" */")
}

main().catch((err) => {
    console.error(err)
    process.exit(2)
})
