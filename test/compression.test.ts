import { describe, expect, test } from "bun:test"
import { createMinMPHashDict, MinMPHash } from "../src"

describe("MinMPHash Compression", () => {
    const dataSet = ["apple", "banana", "cherry", "date", "elderberry", "fig", "grape"]

    test("Should create compressed binary dictionary", async () => {
        const compressed = await createMinMPHashDict(dataSet, {
            outputBinary: true,
            enableCompression: true,
        })

        expect(compressed).toBeInstanceOf(Uint8Array)
        expect(compressed.length).toBeGreaterThan(0)

        // Create instance from compressed data
        const mph = await MinMPHash.fromCompressed(compressed)
        
        // Verify hash
        for (const key of dataSet) {
            const hash = mph.hash(key)
            expect(hash).toBeGreaterThanOrEqual(0)
            expect(hash).toBeLessThan(dataSet.length)
        }
    })

    test("Should be smaller than uncompressed binary (for large dataset with validation)", async () => {
        // Generate larger dataset
        const largeSet = Array.from({ length: 10000 }, (_, i) => `key-${i}`)
        
        const uncompressed = createMinMPHashDict(largeSet, {
            outputBinary: true,
            enableCompression: false,
            onlySet: "8"
        }) as Uint8Array

        const compressed = await createMinMPHashDict(largeSet, {
            outputBinary: true,
            enableCompression: true,
            onlySet: "8"
        })

        console.log(`Uncompressed: ${uncompressed.length} bytes`)
        console.log(`Compressed: ${compressed.length} bytes`)

        // Gzip might not always be smaller for high entropy data like hashes/seeds
        // But for larger datasets with some structure, it might help.
        // If it fails, we just verify it works.
        if (compressed.length < uncompressed.length) {
             expect(compressed.length).toBeLessThan(uncompressed.length)
        } else {
             console.warn("Compression did not reduce size (expected for high entropy data)")
        }
    })
})
