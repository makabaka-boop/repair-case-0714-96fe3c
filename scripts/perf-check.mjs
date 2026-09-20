/**
 * 独立性能验收：用 esbuild 即时转译核心算法后在原生 Node 中运行，
 * 反映浏览器/构建产物的真实性能（vitest 的 BigInt 解释执行会慢约 50 倍，
 * 不能作为四秒指标的判据）。
 *
 * 用法：node scripts/perf-check.mjs
 * 退出码 0 表示最大规模在 4000ms 内完成且方案合法。
 */
import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/core/paginate.ts', import.meta.url));
const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
});
const code = result.outputFiles[0].text;
const tmp = new URL('../node_modules/.cache-paginate.mjs', import.meta.url);
writeFileSync(tmp, code);
const { paginate } = await import(tmp.pathname);

// xorshift32 随机文档（与 src/core/sample.ts 同一发生器，逻辑内联以免再转译 TS）
function randomDoc(n, pageHeight, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s = s >>> 0;
    return s / 0xffffffff;
  };
  const blocks = Array.from({ length: n }, (_, i) => ({
    id: `b${i + 1}`, height: 1 + Math.floor(rand() * pageHeight), edge: 0,
  }));
  let chainSum = 0;
  for (let i = 0; i < n - 1; i++) {
    const r = rand();
    if (r < 0.12) { blocks[i].edge = 1; chainSum = 0; }
    else if (r < 0.3 && chainSum + blocks[i].height + blocks[i + 1].height <= pageHeight) {
      blocks[i].edge = 2; chainSum += blocks[i].height;
    } else { chainSum = 0; }
  }
  return { pageHeight, blocks };
}

function validate(model, out) {
  if (!out.ok) throw new Error('expected feasible: ' + JSON.stringify(out.error));
  const { pages, cost } = out.result;
  let prev = 0, recomputed = 0;
  for (const p of pages) {
    if (p.start !== prev) throw new Error('pages not contiguous');
    prev = p.end;
    let used = 0;
    for (let k = p.start; k < p.end; k++) used += model.blocks[k].height;
    if (used !== p.used || used > model.pageHeight) throw new Error('capacity violation');
    for (let k = p.start; k < p.end - 1; k++) {
      if (model.blocks[k].edge === 1) throw new Error('break inside page');
    }
    recomputed += (model.pageHeight - used) ** 2;
  }
  if (prev !== model.blocks.length) throw new Error('pages do not cover all blocks');
  if (recomputed !== cost) throw new Error('cost mismatch');
}

const cases = [
  ['随机可行 200000 / H=1000', () => randomDoc(200_000, 1000, 0x9e3779b9)],
  ['随机可行 200000 / H=1000 (seed2)', () => randomDoc(200_000, 1000, 0xdeadbeef)],
  ['每页一块 200000 / H=1', () => ({
    pageHeight: 1,
    blocks: Array.from({ length: 200_000 }, (_, i) => ({ id: i, height: 1, edge: 0 })),
  })],
];

let maxElapsed = 0;
for (const [name, make] of cases) {
  const model = make();
  const t0 = performance.now();
  const out = paginate(model);
  const elapsed = performance.now() - t0;
  validate(model, out);
  maxElapsed = Math.max(maxElapsed, elapsed);
  console.log(`- ${name}: ${elapsed.toFixed(1)} ms, ${out.result.pages.length} 页, 代价 ${out.result.cost}`);
}

rmSync(tmp, { force: true });

if (maxElapsed > 4000) {
  console.error(`性能验收失败：最大耗时 ${maxElapsed.toFixed(1)} ms 超过 4000 ms`);
  process.exit(1);
}
console.log(`性能验收通过：最大耗时 ${maxElapsed.toFixed(1)} ms ≤ 4000 ms`);
