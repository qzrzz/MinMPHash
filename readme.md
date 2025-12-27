# MinMPHash | Mini Minimal Perfect Hash

一个简单的最小完美哈希（Minimal Perfect Hash）库，
用在 JavaScript/TypeScript 平台上

它可以用一个 hash 函数把一组字符串（长度 n）映射到 `[0, n-1]` 的整数范围内，且不会有冲突


## 什么是最小完美哈希？

如果你知道 hash 函数，那你肯地能理解 hash 函数可以把数据映射到一个范围内，也就是生成固定长度的“指纹”
但是大多数 hash 函数都会有冲突（不同的输入映射到相同的输出），这会导致需要额外的处理来解决冲突
而最小完美哈希函数则是一个特殊的 hash 函数，它能确保没有冲突，并且输出范围正好等于输入数据的数量
也就是说，如果你有 n 个不同的字符串，最小完美哈希函数会把它们映射到 `[0, n-1]` 的整数范围内，每个字符串都有一个唯一的整数索引

```
    text set               Hash              Hash Table (Sparse)
  +----------+        +------------+        +-------------------+
  |  Apple   | ---->  |    h(x)    | ---->  | 0: [ Apple ]      |
  |  Banana  |        +------------+        | 1:                | <--- Gap
  |  Cherry  |                              | 2: [ Banana ]     |
  +----------+                              | 3:                | <--- Gap
                                            |       ...         | <--- Gap
                                            | 9: [ Cherry ]     |
                                            +-------------------+
                                              (Waste of Space)


    text set      🤩 Minimal Perfect Hash      Hash Table (Compact)
  +----------+        +--------------+        +-------------------+
  |  Apple   | ---->  |   mmph(x)    | ---->  | 0: [ Apple ]      |
  |  Banana  |        +--------------+        | 1: [ Banana ]     |
  |  Cherry  |                                | 2: [ Cherry ]     |
  +----------+                                +-------------------+
                                             ( 100% Space Utilization )


```

## 什么时候使用最小完美哈希？

你看到了最小完美哈希可以把一组字符串映射到一个紧凑的整数范围内，没有冲突，这就像是
一个映射表（Map），但是一个普通的映射表（Map）需要存储完整的键（Key），而使用最小完美哈希相当于
不需要存储完整的键值，只需要存储键（Key）的 hash 值，就可以等价地实现键值映射，这样可以节省存储空间

举一个例子，有一组字体名称列表，要从根据字体名映射到字体的系列名
一般的方法是通过一个映射表来完成这一切：

```js
let FontMap = {
    "Source Sans ": "Source Sans",
    "Source Sans Black": "Source Sans",
    "Source Sans Bold": "Source Sans",
    "思源黑体 CN ExtraLight": "Source Sans",
    "思源黑体 TW Light": "Source Sans",
    // ... 6000+
}

let query = "思源黑体 TW Light"
let found = FontMap[query] // 'Source Sans'
```

这样的映射表需要存储所有的键（字体名称），字体名称映射表会非常大，
但使用最小完美哈希，我们可以只存储字体名称的 hash 值，而不是完整的名称：

```js
let FontMapWithHash = {
    "Source Sans": ["Bx", "Cy", "Dz", "E1" /* ... */],
    Heiti: ["1f", "x2" /* ... */],
    "JetBrains Mono": ["9a", "Ab" /* ... */],
    // ...
}

let dict = await fetch("hash-dict.bin").arrayBuffer() // 预先加载的二进制映射表数据
let minHash = new MinMPHash(dict) // 创建最小完美哈希实例

let query = "思源黑体 TW Light"
let query_hash = minHash.hash(query, dict) // 查询词的最小完美哈希值

let found = Object.entries(FontMapWithHash).find(([family, hashes]) => hashes.includes(query_hash))[0] // 'Source Sans'
```

> 在 Web 平台，只要数据没有 > 1MB，大部分情况下你不需要考虑映射表体积
> 因为可以使用 Gzip 或者 Brotli 压缩压缩网络请求数据，实际上映射表的
> 实际传输体积会比原始体积小很多，所以只有你的映射表非常大，或者对
> 体积非常敏感，才需要考虑使用最小完美哈希


## 如何使用 MinMPHash 库？

 