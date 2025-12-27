/// <reference types="bun-types/test-globals" />

import { createMinMPHashDict, MinMPHash } from '../src/index'

describe('MinMPHash 最小完美哈希', () => {
    it('基础功能：应该能正确哈希数据集中的所有元素', () => {
        const dataSet = ['apple', 'banana', 'cherry', 'date', 'elderberry']
        const dict = createMinMPHashDict(dataSet)
        const hasher = new MinMPHash(dict)

        const results = new Set<number>()
        for (const item of dataSet) {
            const hash = hasher.hash(item)
            // 哈希值应该在 [0, n-1] 范围内
            expect(hash).toBeGreaterThanOrEqual(0)
            expect(hash).toBeLessThan(dataSet.length)
            results.add(hash)
        }

        // 完美哈希：不应该有冲突，结果集大小应等于原数据集大小
        expect(results.size).toBe(dataSet.length)
    })

    it('空数据集：应该能处理空数据集', () => {
        const dict = createMinMPHashDict([])
        const hasher = new MinMPHash(dict)
        expect(hasher.hash('anything')).toBe(-1)
    })

    it('验证模式 (onlySet)：应该能识别不在集合中的数据', () => {
        const dataSet = ['one', 'two', 'three']
        // 使用 16-bit 指纹以获得极低的误判率
        const dict = createMinMPHashDict(dataSet, { onlySet: '16' })
        const hasher = new MinMPHash(dict)

        // 集合内的元素应该返回正确的索引
        for (const item of dataSet) {
            expect(hasher.hash(item)).not.toBe(-1)
        }

        // 集合外的元素大概率返回 -1
        expect(hasher.hash('four')).toBe(-1)
        expect(hasher.hash('five')).toBe(-1)
    })

    it('不同位数的指纹校验', () => {
        const dataSet = ['a', 'b', 'c', 'd', 'e', 'f']
        
        const modes = ['4', '8', '16', '32'] as const
        for (const mode of modes) {
            const dict = createMinMPHashDict(dataSet, { onlySet: mode })
            const hasher = new MinMPHash(dict)
            
            for (const item of dataSet) {
                expect(hasher.hash(item)).not.toBe(-1)
            }
        }
    })

    it('序列化与反序列化：模拟 JSON 传输后的恢复', () => {
        const dataSet = ['hello', 'world', 'foo', 'bar']
        const dict = createMinMPHashDict(dataSet, { onlySet: '8' })
        
        // 模拟 JSON 序列化和反序列化
        // 注意：TypedArray 在 JSON.stringify 时会变成对象 {"0":x, "1":y ...}
        // 在实际使用中，通常需要手动转换为数组或在恢复时处理
        const jsonStr = JSON.stringify(dict, (key, value) => {
            if (value instanceof Uint8Array || value instanceof Uint16Array || value instanceof Uint32Array) {
                return Array.from(value)
            }
            return value
        })
        const recoveredDict = JSON.parse(jsonStr)
        
        const hasher = new MinMPHash(recoveredDict)
        
        for (const item of dataSet) {
            const hash = hasher.hash(item)
            expect(hash).toBeGreaterThanOrEqual(0)
            expect(hash).toBeLessThan(dataSet.length)
        }
        
        // 验证模式依然有效
        expect(hasher.hash('not-in-set')).toBe(-1)
    })

    it('不同优化级别 (level)：应该都能正常工作', () => {
        const dataSet = ['x', 'y', 'z', 'w']
        const levels = [1, 5, 10]
        
        for (const level of levels) {
            const dict = createMinMPHashDict(dataSet, { level })
            const hasher = new MinMPHash(dict)
            
            const results = new Set<number>()
            for (const item of dataSet) {
                results.add(hasher.hash(item))
            }
            expect(results.size).toBe(dataSet.length)
        }
    })

    it('大规模数据集测试', () => {
        const size = 1000
        const dataSet = Array.from({ length: size }, (_, i) => `item-${i}`)
        const dict = createMinMPHashDict(dataSet, { level: 5 })
        const hasher = new MinMPHash(dict)

        const results = new Set<number>()
        for (const item of dataSet) {
            const h = hasher.hash(item)
            expect(h).toBeGreaterThanOrEqual(0)
            expect(h).toBeLessThan(size)
            results.add(h)
        }
        expect(results.size).toBe(size)
    })
})
