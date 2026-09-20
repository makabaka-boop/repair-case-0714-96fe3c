# 精确分页排版台（Imposition Bench）

面向印前安全操作卡场景的**纯前端**排版台：导入一批带高度的内容块与页容量，
人工逐项标记「强制分页 / 与后项同页」边界后，计算**严格满足所有边界**且
**最小化 Σ 每页剩余高度²** 的精确分页方案。

- TypeScript + React 18 负责交互，Vite 构建
- 无后端、无任何网络调用；导入、计算、下载全部在浏览器本机完成
- Vitest：小规模**穷举**（约 14 万组输入与朴素 O(n²) DP 对拍）+ 20 万块**大夹具**验收
- 200,000 块规模实测约 **90–200 ms**（要求 ≤ 4 s），算法为均摊 O(n)

## 快速开始

```bash
npm install
npm run dev        # 本地开发
npm test           # Vitest：穷举 + 大夹具
npm run perf       # 原生 Node 四秒性能自检（esbuild 即时转译核心算法）
npm run verify     # 测试 + 类型检查 + 生产构建 + 性能自检
npm run build      # 仅生产构建（产物在 dist/）
```

### Docker / Docker Compose

```bash
# 静态站点；宿主端口由 WEB_PORT 覆盖（默认 8080）
WEB_PORT=9000 docker compose up --build web
# 打开 http://localhost:9000

# 一次性验收服务：跑完穷举/大夹具/类型/构建/性能自检即退出
docker compose build verify
docker compose run --rm verify
```

`verify` 服务的退出码即验收结论（0 = 全部通过）。

## 数据约定（导入 JSON）

顶层为一个普通 JSON 对象，UTF-8 编码：

```json
{
  "pageHeight": 300,
  "blocks": [
    { "id": "title",         "height": 60 },
    { "id": "warn-hot",      "height": 90, "sameAfter": true },
    { "id": "warn-hot-body", "height": 80 },
    { "id": "step-2",        "height": 150, "breakAfter": true },
    { "id": "warn-chem",     "height": 70, "sameAfter": true },
    { "id": "warn-chem-body","height": 110 }
  ]
}
```

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `pageHeight` | 整数 | 1 ≤ pageHeight ≤ 10000 |
| `blocks` | 数组 | 1 ≤ 长度 ≤ 200000，顺序即排版顺序 |
| `blocks[].id` | 字符串或数字 | 在数组内**唯一**（数字 `1` 与字符串 `"1"` 视为不同 id） |
| `blocks[].height` | 整数 | 1 ≤ height ≤ pageHeight |
| `blocks[].breakAfter` | 布尔，可省略 | 该块与后一块之间**强制分页** |
| `blocks[].sameAfter` | 布尔，可省略 | 该块与后一块**必须同页** |

边界语义（边界 i = 第 i 块与第 i+1 块之间）：

- 无标记：算法自由决定是否在此分页；
- `breakAfter: true`：边界两侧**不得**同页；
- `sameAfter: true`：边界两侧**必须**同页（用于防止警示标题与正文被人工拆页）；
- 两者同置即为**冲突**。最后一块上的两个标记无意义，导入时忽略。
- 导入文件中出现的任何其他字段（包括本工具导出的 `pagination` 等）一律忽略，
  因此导出文件可以直接重新导入。

非法导入（结构、类型、范围、唯一性、标记类型等不满足约定）会被拒绝并提示原因，
**当前文档与已采纳版本保持不变**。

## 交互与计算规则

- 每个块后边界可在下拉框中逐项切换为：无标记 / 强制分页 / 与后项同页 / 两者同置。
- 冲突（两者同置）出现时：顶部与列表立即标红、可点击定位，并**禁止计算**。
- 点击「运行精确分页」后四秒内显示：**页数、代价 Σ(剩余高度)²、覆盖范围**（及每页
  块号/id 区间、已用/剩余高度）。
- 边界被修改后，旧结果标记为「已过期」，需重新计算才能采纳/下载。
- 只有一次**成功且为最新**的计算结果可以「采纳」；采纳后可随时下载**与画面一致**
  的 JSON（边界标记 + 分页结果 + 代价）。
- 无解（例如同页链总高超过页容量）或计算异常只显示原因与涉及块区间；修正边界后
  可立即重新计算并得到最优分页。

### 导出 JSON 结构

```json
{
  "pageHeight": 300,
  "blocks": [
    { "id": "title", "height": 60 },
    { "id": "warn-hot", "height": 90, "sameAfter": true }
  ],
  "pagination": {
    "pageCount": 2,
    "cost": 9800,
    "pages": [
      {
        "page": 1,
        "startBlock": 1, "endBlock": 3,
        "startId": "title", "endId": "warn-hot-body",
        "used": 230, "remaining": 70
      }
    ]
  },
  "adoptedAt": "2026-09-20T12:00:00.000Z"
}
```

`startBlock`/`endBlock` 为 1 起块号、半开区间（endBlock 是本页最后一块）。

## 优化模型与算法

令前缀高度和 `S[i]` 为前 i 块之和，页面 `(j,i)`（半开区间）代价
`(H − S[i] + S[j])²`，动态规划：

```
dp[i] = min over 合法 j: dp[j] + (H − S[i] + S[j])²
```

展开后每个 j 是一条直线（斜率 `−2·S[j]` 随 j 严格递减，查询点 `S[i]` 严格递增），
用**凸包单调队列**把转移降到均摊 O(n)、空间 O(n)。

实现要点（见 `src/core/paginate.ts` 注释）：

- 边界约束转化为页面**起点/终点可行性**：页内不得跨越强制分页；页首前边界、
  页尾边界不得是「同页」。「同页链总高 > 页容量」在线性预检中直接判无解。
- **滑动窗口下的凸包删除是本实现的关键正确性点**：朴素做法会删除相对前后线
  全局冗余的中线，但当前线因容量/强制分页从队首过期后，被删的中线可能在
  可行集内重新最优。只有当「后线接管点 ≤ 前驱线的失效横坐标」时才允许删除
  （穷举对拍捕获到了这个反例：H=5、高度 [2,3,1]）。
- 交叉点比较全部使用 **BigInt**（`S[j]²` 可达 4×10¹⁸，Double 比较会出错），
  而代价数值本身仍在 Number 安全整数范围内（≤ 2×10¹³）。
- 多个方案达到同一最小代价均为合格，回溯得到其中一个确定方案。

## 目录结构

```
src/
  core/
    types.ts          # 数据类型与边界常量
    model.ts          # 导入严格校验/规范化、冲突定位
    paginate.ts       # O(n) 凸包优化精确分页
    export.ts         # 与画面一致的导出 JSON
    sample.ts         # 内置示例与随机大夹具
    paginate.test.ts  # 穷举对拍 + 朴素 DP + 大夹具验收
  components/
    VirtualList.tsx   # 定高虚拟列表（20 万行流畅渲染）
  App.tsx             # 交互界面
scripts/
  perf-check.mjs      # 原生 Node 四秒性能自检
Dockerfile            # deps / verify / build / web 多阶段
docker-compose.yml    # web（WEB_PORT 覆盖）+ 一次性 verify 服务
```

## 验收覆盖

- **小规模穷举**：n = 1..6、页容量 5/6/9、全部高度序列（单块高度 {1,2,3,5}）
  与全部边界赋值（n≤4 时含冲突的 4^(n−1) 全组合），逐例与朴素 O(n²) DP
  比较代价，并校验分页连续性、容量、全部边界约束与回算代价一致。
- **中等交叉验证**：5000 块随机可行文档，与朴素 DP 代价相等。
- **大夹具**：200,000 块两组随机种子、200,000 块每页一块（20 万页、代价 0）、
  200,000 块同页链无解；原生运行 ≤ 4 s（实测约 0.1–0.2 s）。
