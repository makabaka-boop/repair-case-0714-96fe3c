import { BREAK, CONFLICT, NONE, SAME, type DocModel, type Edge, type PaginateOutcome } from './types';
import { findConflicts } from './model';

/**
 * 精确分页：在满足全部边界标记的前提下，最小化 Σ(每页剩余高度)²。
 *
 * 令 S[i] 为前 i 块高度之和（S[0]=0），页面 (j,i)（半开，块 [j,i)）代价为
 * (H - S[i] + S[j])²，动态规划：
 *
 *   dp[i] = min over 合法 j: dp[j] + (H - S[i] + S[j])²
 *
 * 展开（查询点 x = S[i]，并加上与 j 无关的 (H-x)²）：
 *   dp[i] = (H-x)² + min_j ( m_j·x + b_j )
 *     m_j = -2S[j]                    （随 j 严格递减，因块高 ≥1）
 *     b_j = dp[j] + 2H·S[j] + S[j]²
 *
 * 可行窗口 j ≥ L_i（容量 + 最后一个强制分页，L_i 单调不减）。
 * 斜率单调递减、查询点严格递增，用凸包队列做到均摊 O(n)。
 *
 * 插入新直线时，中线 b（前驱 a、新线 c）只有在同时满足两个条件时才可删除：
 *   1. 全局冗余：x(a,b) ≥ x(b,c)，即 b 不在全局下包络上；
 *   2. 窗口安全：c 接管 b 的横坐标 x(b,c) ≤ a 的失效横坐标。
 * 条件 2 是滑动窗口下的关键正确性点：朴素做法只查条件 1，但 a 因容量或
 * 强制分页从队首过期后，被删的 b 可能在可行窗口内重新成为最优
 * （反例：H=5、高度 [2,3,1]，只查条件 1 会把最优代价 10 错算成 16）。
 * 查询和过期淘汰都从队首单向推进。
 *
 * 交叉点比较全部使用 BigInt：S[j]² 可达 4e18，浮点比较会出错。
 *
 * 边界语义：
 * - 页 (j,i) 内部边界 k ∈ [j, i-1) 不得为 BREAK；
 * - 页首前边界 edge(j-1)、页尾边界 edge(i-1) 若存在则不得为 SAME；
 * - CONFLICT 立即拒绝。
 */
export function paginate(model: DocModel): PaginateOutcome {
  const H = model.pageHeight;
  const blocks = model.blocks;
  const n = blocks.length;

  const conflicts = findConflicts(model);
  if (conflicts.length > 0) {
    return { ok: false, error: { kind: 'conflict', conflicts } };
  }

  // 被「同页」链串起来的连续块若总高超过页容量，则无解。
  const overflow = findSameOverflow(model);
  if (overflow) {
    return {
      ok: false,
      error: { kind: 'unsat', reason: overflow.reason, start: overflow.start, end: overflow.end },
    };
  }

  // 前缀和：最大 200000 × 10000 = 2e9，Number 安全整数范围内。
  const S = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) S[i + 1] = S[i] + blocks[i].height;

  const edgeAt = (i: number): Edge => (i < n - 1 ? blocks[i].edge : NONE);
  /** 起点 j 可作页首：j=0 恒可；j>0 要求前边界 edge(j-1) 不是 SAME。 */
  const canStart = (j: number): boolean => j === 0 || edgeAt(j - 1) !== SAME;
  /** 终点 i 可作页尾：i=n 恒可；i<n 要求尾边界 edge(i-1) 不是 SAME。 */
  const canEnd = (i: number): boolean => i === n || edgeAt(i - 1) !== SAME;

  // 每条线 j 的失效横坐标：查询点 x 超过它后，j 必然已离开可行窗口。
  // - 容量：x > H + S[j] 时 j < capPtr；
  // - 强制分页：首个 e ≥ j 的 BREAK 边界令 L ≥ e+1 > j，自 x = S[e+2] 起生效。
  // nextBreak[j] = 首个 ≥ j 的 BREAK 边界下标（n 表示不存在），后缀扫描 O(n)。
  const nextBreak = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    nextBreak[i] = edgeAt(i) === BREAK ? i : nextBreak[i + 1];
  }
  const expireX = new Float64Array(n + 1);
  for (let j = 0; j <= n; j++) {
    const byBreak = nextBreak[j] <= n - 2 ? S[nextBreak[j] + 2] : Number.POSITIVE_INFINITY;
    expireX[j] = Math.min(H + S[j], byBreak);
  }

  const dp = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const parent = new Int32Array(n + 1).fill(-1);

  // 凸包队列，存直线下标 j。
  const hull = new Int32Array(n + 2);
  let head = 0;
  let tail = 0;

  // b_j 与 -m_j = 2S[j]（恒正、严格递增）。b 最大约 4e18，在 int64 内。
  const bArr = new BigInt64Array(n + 1);
  const neg2m = new Float64Array(n + 1);

  /**
   * b 相对 a、c 是否全局冗余：x(a,b) ≥ x(b,c)
   * 等价于 (b_c-b_a)(nm_b-nm_a) ≤ (b_b-b_a)(nm_c-nm_a)，nm=-m。
   */
  const redundant = (a: number, b: number, c: number): boolean => {
    const lhs = (bArr[c] - bArr[a]) * BigInt(Math.round(neg2m[b] - neg2m[a]));
    const rhs = (bArr[b] - bArr[a]) * BigInt(Math.round(neg2m[c] - neg2m[a]));
    return lhs <= rhs;
  };

  /** 队首查询：在 x 处 b(第二线) 不差于 a(第一线)。 */
  const frontWorse = (a: number, b: number, x: number): boolean => {
    return bArr[b] - bArr[a] <= BigInt(Math.round(x)) * BigInt(Math.round(neg2m[b] - neg2m[a]));
  };

  /**
   * 窗口安全：c 接管 b 的横坐标 x(b,c) 不超过 a 的失效横坐标。
   * 成立时 a 过期之日 c 已不劣于 b，b 不可能在可行窗口内重新最优；
   * 不成立则必须保留 b。x(b,c) = (b_c−b_b)/(nm_c−nm_b) ≤ X 交叉相乘为
   * b_c − b_b ≤ X·(nm_c − nm_b)，BigInt 精确比较。
   */
  const takeoverBeforeExpiry = (a: number, b: number, c: number): boolean => {
    const x = expireX[a];
    if (!Number.isFinite(x)) return true;
    return bArr[c] - bArr[b] <= BigInt(Math.round(x)) * BigInt(Math.round(neg2m[c] - neg2m[b]));
  };

  const pushLine = (j: number) => {
    bArr[j] = BigInt(Math.round(dp[j])) + 2n * BigInt(H) * BigInt(Math.round(S[j])) + BigInt(Math.round(S[j])) ** 2n;
    neg2m[j] = 2 * S[j];
    // 全局冗余且窗口安全的中线才允许删除（见文件头注释）。
    while (
      tail - head >= 2 &&
      redundant(hull[tail - 2], hull[tail - 1], j) &&
      takeoverBeforeExpiry(hull[tail - 2], hull[tail - 1], j)
    ) {
      tail--;
    }
    hull[tail++] = j;
  };

  dp[0] = 0;
  pushLine(0);

  let capPtr = 0; // 最小满足 S[i]-S[capPtr] ≤ H 的下标
  let lastBreakPlus = 0; // 最后一个 BREAK（edge(k-1)）要求 j ≥ k+1

  for (let i = 1; i <= n; i++) {
    if (i > 1 && edgeAt(i - 2) === BREAK) {
      lastBreakPlus = i - 1;
    }
    while (S[i] - S[capPtr] > H) capPtr++;
    const L = Math.max(capPtr, lastBreakPlus);

    // 队首过期（容量/分页下界，可能一次跨越多条）或已被后线接管。
    while (
      tail - head >= 1 &&
      (hull[head] < L || (tail - head >= 2 && frontWorse(hull[head], hull[head + 1], S[i])))
    ) {
      head++;
    }

    if (canEnd(i) && tail > head) {
      const j = hull[head];
      const rem = H - (S[i] - S[j]);
      dp[i] = dp[j] + rem * rem;
      parent[i] = j;
    }

    if (i < n && canStart(i) && Number.isFinite(dp[i])) {
      pushLine(i);
    }
  }

  if (!Number.isFinite(dp[n]) || parent[n] < 0) {
    return {
      ok: false,
      error: { kind: 'unsat', reason: '不存在满足全部边界约束的分页方案', start: 0, end: n },
    };
  }

  const pages = [];
  let cur = n;
  while (cur > 0) {
    const j = parent[cur];
    const used = S[cur] - S[j];
    pages.push({ start: j, end: cur, used, remaining: H - used });
    cur = j;
  }
  pages.reverse();

  return { ok: true, result: { pages, cost: Math.round(dp[n]) } };
}

/** 扫描同页链：连续被 SAME 连接的块若总高 > H，返回无解区间（半开，块下标）。 */
function findSameOverflow(model: DocModel): { reason: string; start: number; end: number } | null {
  const { blocks, pageHeight: H } = model;
  const n = blocks.length;
  let i = 0;
  while (i < n) {
    let sum = blocks[i].height;
    let j = i;
    while (j < n - 1 && blocks[j].edge === SAME) {
      j++;
      sum += blocks[j].height;
    }
    if (sum > H) {
      return {
        reason: `第 ${i + 1}–${j + 1} 块被「同页」标记强制连续，但总高度 ${sum} 超过页容量 ${H}`,
        start: i,
        end: j + 1,
      };
    }
    i = j + 1;
  }
  return null;
}

export { NONE, BREAK, SAME, CONFLICT };
