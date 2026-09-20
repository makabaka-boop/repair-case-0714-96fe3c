import { NONE, type DocModel, type Edge } from './types';

/** 内置示例：印前安全操作卡，含警示同页组与强制分页。 */
export const SAMPLE_JSON = `{
  "pageHeight": 300,
  "blocks": [
    { "id": "title", "height": 60 },
    { "id": "warn-hot", "height": 90, "sameAfter": true },
    { "id": "warn-hot-detail", "height": 80 },
    { "id": "step-1", "height": 120 },
    { "id": "step-2", "height": 150, "breakAfter": true },
    { "id": "warn-chem", "height": 70, "sameAfter": true },
    { "id": "warn-chem-detail", "height": 110 },
    { "id": "step-3", "height": 200 },
    { "id": "step-4", "height": 95 }
  ]
}`;

/** 构造一份随机文档（无冲突、可行），便于手工压测。 */
export function randomDoc(n: number, pageHeight: number, seed: number): DocModel {
  let s = seed >>> 0;
  const rand = () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s = s >>> 0;
    return s / 0xffffffff;
  };

  const blocks = Array.from({ length: n }, (_, i) => {
    const height = 1 + Math.floor(rand() * pageHeight);
    return { id: `b${i + 1}`, height, edge: NONE as Edge };
  });

  // 保证可行：BREAK 随意；SAME 只在「当前同页链累计高度 + 下一块」不超容量时打。
  let chainSum = 0;
  for (let i = 0; i < n - 1; i++) {
    const r = rand();
    if (r < 0.12) {
      blocks[i].edge = 1;
      chainSum = 0;
    } else if (r < 0.3 && chainSum + blocks[i].height + blocks[i + 1].height <= pageHeight) {
      blocks[i].edge = 2;
      chainSum += blocks[i].height;
    } else {
      chainSum = 0;
    }
  }
  return { pageHeight, blocks };
}
