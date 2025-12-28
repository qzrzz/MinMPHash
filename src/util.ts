import { IMinMPHashDict, IValidationMode } from "./MinMPHash"

export function writeVarInt(val: number, buffer: number[] | Uint8Array, offset?: number): number {
  let bytes = 0;
  while (val >= 0x80) {
    const b = (val & 0x7f) | 0x80;
    if (Array.isArray(buffer)) {
      buffer.push(b);
    } else if (offset !== undefined) {
      buffer[offset + bytes] = b;
    }
    val >>>= 7;
    bytes++;
  }
  if (Array.isArray(buffer)) {
    buffer.push(val);
  } else if (offset !== undefined) {
    buffer[offset + bytes] = val;
  }
  return bytes + 1;
}

export function readVarInt(buffer: Uint8Array, offset: number): { value: number; bytes: number } {
  let val = 0;
  let shift = 0;
  let bytes = 0;
  while (true) {
    const b = buffer[offset + bytes];
    val |= (b & 0x7f) << shift;
    bytes++;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: val, bytes };
}
 
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



const MODE_TO_INT: Record<IValidationMode, number> = { none: 0, "4": 1, "8": 2, "16": 3, "32": 4, "2": 5 }
const INT_TO_MODE: IValidationMode[] = ["none", "4", "8", "16", "32", "2"]

export function dictToCBOR(dict: IMinMPHashDict): Uint8Array {
    const buffer: number[] = []

    // 结构：Array(9) [n, m, seed0, bucketSizes, seedStream, mode, fingerprints, seedZeroBitmap, hashSeed]
    CBOR.encodeArrayHead(9, buffer)

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
            if (mode === "2" || mode === "4" || mode === "8") typed = new Uint8Array(dict.fingerprints)
            else if (mode === "16") typed = new Uint16Array(dict.fingerprints)
            else typed = new Uint32Array(dict.fingerprints)
            fpBytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)
        }
        CBOR.encodeBytes(fpBytes, buffer)
    } else {
        CBOR.encodeNull(buffer)
    }

    if (dict.seedZeroBitmap) {
        CBOR.encodeBytes(dict.seedZeroBitmap, buffer)
    } else {
        CBOR.encodeNull(buffer)
    }

    CBOR.encodeInt(dict.hashSeed || 0, buffer)

    return new Uint8Array(buffer)
}

export function dictFromCBOR(bin: Uint8Array): IMinMPHashDict {
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    const offsetRef = { current: 0 }

    // 读取 Array
    const arr = CBOR.decode(view, offsetRef)

    if (!Array.isArray(arr) || arr.length < 7) throw new Error("Invalid CBOR format")

    const [n, m, seed0, bucketSizes, seedStream, modeInt, fpRaw, seedZeroBitmap, hashSeed] = arr

    const validationMode = INT_TO_MODE[modeInt] || "none"
    let fingerprints: Uint8Array | Uint16Array | Uint32Array | undefined

    if (fpRaw && validationMode !== "none") {
        if (validationMode === "2" || validationMode === "4" || validationMode === "8") {
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
        hashSeed: hashSeed || 0,
        bucketSizes,
        seedStream,
        validationMode,
        fingerprints,
        seedZeroBitmap: seedZeroBitmap || undefined,
    }
}

export async function compressIBinary(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as any]).stream().pipeThrough(new CompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function decompressIBinary(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as any]).stream().pipeThrough(new DecompressionStream("gzip"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

export class BitWriter {
  private buffer: number[] = [];
  private currentByte = 0;
  private bitCount = 0;

  write(value: number, bits: number) {
    for (let i = 0; i < bits; i++) {
      const bit = (value >> i) & 1;
      this.currentByte |= bit << this.bitCount;
      this.bitCount++;
      if (this.bitCount === 8) {
        this.buffer.push(this.currentByte);
        this.currentByte = 0;
        this.bitCount = 0;
      }
    }
  }

  flush() {
    if (this.bitCount > 0) {
      this.buffer.push(this.currentByte);
      this.currentByte = 0;
      this.bitCount = 0;
    }
  }

  getData(): Uint8Array {
    this.flush();
    return new Uint8Array(this.buffer);
  }
}

export class BitReader {
  private buffer: Uint8Array;
  private byteOffset = 0;
  private bitOffset = 0;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
  }

  read(bits: number): number {
    let value = 0;
    for (let i = 0; i < bits; i++) {
      if (this.byteOffset >= this.buffer.length) {
        // Should not happen if data is correct
        return 0; 
      }
      const bit = (this.buffer[this.byteOffset] >> this.bitOffset) & 1;
      value |= bit << i;
      this.bitOffset++;
      if (this.bitOffset === 8) {
        this.byteOffset++;
        this.bitOffset = 0;
      }
    }
    return value;
  }
}

export function readBitsAt(buffer: Uint8Array, bitOffset: number, bitLength: number): number {
  let value = 0;
  let currentBit = bitOffset;
  
  for (let i = 0; i < bitLength; i++) {
    const byteIdx = currentBit >>> 3; // Math.floor(currentBit / 8)
    const bitIdx = currentBit & 7;    // currentBit % 8
    
    if (byteIdx >= buffer.length) return 0; // Out of bounds
    
    const bit = (buffer[byteIdx] >> bitIdx) & 1;
    value |= bit << i;
    currentBit++;
  }
  
  return value;
}
