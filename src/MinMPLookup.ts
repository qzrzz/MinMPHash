

export type ILookupMap = Record<string, string[]>;

export interface IMinMPLookupDict {}

/**
 * 创建 MinMPLookup 字典
 * 把一个普通的查找表 Record<string, string[]> 转换为 IMinMPLookupDict，减小体积并且完成快速查询
 */
export function createMinMPLookupDict(data: Uint8Array): IMinMPLookupDict {
  return {};
}

export class MinMPLookup {
  static async fromCompressed(data: Uint8Array): Promise<MinMPLookup> {}
  constructor(private dict: IMinMPLookupDict) {}
}
