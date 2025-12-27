import { IMinMPHashDict, ValidationMode } from "."

 
const CBOR = {
    // 写入无符号整数
    encodeInt(val: number, buffer: number[]): void {
        const major = 0x00 // Major type 0: unsigned integer
        if (val < 24) {
            buffer.push(major | val)
        } else if (val <= 0xff) {
            buffer.push(major | 24, val)
        } else if (val <= 0xffff) {
            buffer.push(major | 25, val >> 8, val & 0xff)
        } else {
            // JS bitwise operators are 32-bit
            buffer.push(major | 26, (val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff)
        }
    },

    // 写入 Byte String (Uint8Array)
    encodeBytes(bytes: Uint8Array, buffer: number[]): void {
        const major = 0x40 // Major type 2: byte string
        const len = bytes.byteLength
        // 写入长度头
        if (len < 24) {
            buffer.push(major | len)
        } else if (len <= 0xff) {
            buffer.push(major | 24, len)
        } else if (len <= 0xffff) {
            buffer.push(major | 25, len >> 8, len & 0xff)
        } else {
            buffer.push(major | 26, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff)
        }
        // 写入数据
        for (let i = 0; i < len; i++) buffer.push(bytes[i])
    },

    // 写入 Null
    encodeNull(buffer: number[]): void {
        buffer.push(0xf6)
    },

    // 写入 Array 头
    encodeArrayHead(len: number, buffer: number[]): void {
        const major = 0x80 // Major type 4: array
        if (len < 24) buffer.push(major | len)
        // 本场景 array 长度很小，不需要处理大长度
    },

    // --- 解码器 ---
    decode(view: DataView, offsetRef: { current: number }): any {
        const byte = view.getUint8(offsetRef.current++)
        const major = byte & 0xe0
        const additional = byte & 0x1f

        // 1. 读取长度/数值
        let val = 0
        if (additional < 24) {
            val = additional
        } else if (additional === 24) {
            val = view.getUint8(offsetRef.current)
            offsetRef.current += 1
        } else if (additional === 25) {
            val = view.getUint16(offsetRef.current, false)
            offsetRef.current += 2 // CBOR is Big-Endian
        } else if (additional === 26) {
            val = view.getUint32(offsetRef.current, false)
            offsetRef.current += 4
        } else {
            throw new Error("Unsupported CBOR size")
        }

        // 2. 根据类型处理
        if (major === 0x00) {
            // Unsigned Int
            return val
        } else if (major === 0x40) {
            // Byte String
            const len = val
            // 复制一份数据
            const buf = new Uint8Array(
                view.buffer.slice(view.byteOffset + offsetRef.current, view.byteOffset + offsetRef.current + len)
            )
            offsetRef.current += len
            return buf
        } else if (major === 0x80) {
            // Array
            const len = val
            const arr = []
            for (let i = 0; i < len; i++) {
                arr.push(CBOR.decode(view, offsetRef))
            }
            return arr
        } else if (byte === 0xf6) {
            // Null
            return null
        }

        throw new Error(`Unknown CBOR type: ${byte.toString(16)}`)
    },
}



const MODE_TO_INT: Record<ValidationMode, number> = { none: 0, "4": 1, "8": 2, "16": 3, "32": 4 }
const INT_TO_MODE: ValidationMode[] = ["none", "4", "8", "16", "32"]

export function dictToCBOR(dict: IMinMPHashDict): Uint8Array {
    const buffer: number[] = []

    // 结构：Array(7) [n, m, seed0, bucketSizes, seedStream, mode, fingerprints]
    CBOR.encodeArrayHead(7, buffer)

    CBOR.encodeInt(dict.n, buffer)
    CBOR.encodeInt(dict.m, buffer)
    CBOR.encodeInt(dict.seed0, buffer)
    CBOR.encodeBytes(dict.bucketSizes, buffer)
    CBOR.encodeBytes(dict.seedStream, buffer)
    CBOR.encodeInt(MODE_TO_INT[dict.validationMode], buffer)

    if (dict.fingerprints && dict.validationMode !== "none") {
        let fpBytes: Uint8Array
        if (dict.fingerprints instanceof Uint8Array) {
            fpBytes = dict.fingerprints
        } else if (dict.fingerprints instanceof Uint16Array || dict.fingerprints instanceof Uint32Array) {
            fpBytes = new Uint8Array(dict.fingerprints.buffer, dict.fingerprints.byteOffset, dict.fingerprints.byteLength)
        } else {
            // number[] - fallback
            const mode = dict.validationMode
            let typed: Uint8Array | Uint16Array | Uint32Array
            if (mode === "4" || mode === "8") typed = new Uint8Array(dict.fingerprints)
            else if (mode === "16") typed = new Uint16Array(dict.fingerprints)
            else typed = new Uint32Array(dict.fingerprints)
            fpBytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)
        }
        CBOR.encodeBytes(fpBytes, buffer)
    } else {
        CBOR.encodeNull(buffer)
    }

    return new Uint8Array(buffer)
}

export function dictFromCBOR(bin: Uint8Array): IMinMPHashDict {
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    const offsetRef = { current: 0 }

    // 读取 Array
    const arr = CBOR.decode(view, offsetRef)

    if (!Array.isArray(arr) || arr.length < 7) throw new Error("Invalid CBOR format")

    const [n, m, seed0, bucketSizes, seedStream, modeInt, fpRaw] = arr

    const validationMode = INT_TO_MODE[modeInt] || "none"
    let fingerprints: Uint8Array | Uint16Array | Uint32Array | undefined

    if (fpRaw && validationMode !== "none") {
        if (validationMode === "4" || validationMode === "8") {
            fingerprints = fpRaw
        } else if (validationMode === "16") {
            fingerprints = new Uint16Array(fpRaw.buffer, fpRaw.byteOffset, fpRaw.byteLength / 2)
        } else if (validationMode === "32") {
            fingerprints = new Uint32Array(fpRaw.buffer, fpRaw.byteOffset, fpRaw.byteLength / 4)
        }
    }

    return {
        n,
        m,
        seed0,
        bucketSizes,
        seedStream,
        validationMode,
        fingerprints,
    }
}
