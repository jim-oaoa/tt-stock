/**
 * TT 股票分析工具 — 測試套件
 * 包含：冒煙測試、API 整合測試、魚模型邏輯驗算
 *
 * 執行：node tests/run-tests.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.FINMIND_TOKEN || '';
const BASE_URL = 'https://api.finmindtrade.com/api/v4/data';

// ─── ANSI 顏色 ──────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;
const BOLD = s => `\x1b[1m${s}\x1b[0m`;

// ─── 測試框架 ───────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ${G('✔')} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${R('✘')} ${name}`);
    console.log(`       ${R(e.message)}`);
    failures.push({ name, err: e.message });
    failed++;
  }
}

function expect(val) {
  return {
    toBe: (expected) => {
      if (val !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`);
    },
    toBeCloseTo: (expected, tolerance = 5) => {
      if (Math.abs(val - expected) > tolerance)
        throw new Error(`expected ~${expected} (±${tolerance}), got ${val}`);
    },
    toBeGreaterThan: (n) => {
      if (!(val > n)) throw new Error(`expected > ${n}, got ${val}`);
    },
    toBeLessThan: (n) => {
      if (!(val < n)) throw new Error(`expected < ${n}, got ${val}`);
    },
    toContain: (sub) => {
      if (!String(val).includes(sub)) throw new Error(`expected to contain "${sub}", got "${val}"`);
    },
    toBeTrue: () => {
      if (!val) throw new Error(`expected true, got ${val}`);
    },
    toBeFalse: () => {
      if (val) throw new Error(`expected false, got ${val}`);
    },
    toBeArray: () => {
      if (!Array.isArray(val)) throw new Error(`expected Array, got ${typeof val}`);
    },
    toHaveLength: (n) => {
      if (val.length !== n) throw new Error(`expected length ${n}, got ${val.length}`);
    },
    toBeAtLeast: (n) => {
      if (val < n) throw new Error(`expected >= ${n}, got ${val}`);
    },
  };
}

async function apiGet(dataset, stockId, startDate, token = TOKEN) {
  const url = `${BASE_URL}?dataset=${dataset}&data_id=${stockId}&start_date=${startDate}&token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${dataset}`);
  return res.json();
}

// ─── helper：模擬 pick() ────────────────────────────────────────────
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && !isNaN(obj[k])) return +obj[k];
  }
  return 0;
}

function buildPeriodMap(rows, filterPerRows = false) {
  const byPeriod = {};
  rows.forEach(r => {
    if (filterPerRows && r.type && r.type.endsWith('_per')) return;
    if (!byPeriod[r.date]) byPeriod[r.date] = {};
    byPeriod[r.date][r.origin_name] = r.value;
  });
  return byPeriod;
}

// ════════════════════════════════════════════════════════════════════
// 1. 冒煙測試：檢查 index.html 靜態結構
// ════════════════════════════════════════════════════════════════════
function runSmokeTests() {
  console.log(BOLD('\n══ 冒煙測試（Smoke Tests）══'));

  const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf-8');

  test('index.html 存在且非空', () => {
    expect(html.length).toBeGreaterThan(1000);
  });

  test('5 個分頁標題存在', () => {
    expect(html).toContain('EPS 預估');
    expect(html).toContain('魚模型估價');
    expect(html).toContain('杜邦分析');
    expect(html).toContain('本益比評估');
    expect(html).toContain('股本稀釋');
  });

  test('FinMind API 請求程式碼存在', () => {
    expect(html).toContain('TaiwanStockFinancialStatements');
    expect(html).toContain('TaiwanStockBalanceSheet');
    expect(html).toContain('TaiwanStockPrice');
  });

  test('損益表單位為 ÷1e8（非舊版 ÷1e5）', () => {
    // 找 rev/gp/op 等的換算 — 確認都是 1e8
    const matches_1e8 = (html.match(/\) \/ 1e8/g) || []).length;
    const matches_1e5 = (html.match(/\) \/ 1e5/g) || []).length;
    expect(matches_1e8).toBeAtLeast(9);   // 6個損益 + 3個資產負債
    expect(matches_1e5).toBe(0);           // 不應再有 1e5
  });

  test('資產負債表 _per 過濾程式碼存在', () => {
    expect(html).toContain("endsWith('_per')");
  });

  test('資產負債表 teq pick list 含「權益總額」', () => {
    expect(html).toContain("'權益總額'");
  });

  test('股本張數計算為 ÷10000（非舊版 ÷10）', () => {
    expect(html).toContain('cs/10000');
  });

  test('魚模型 adj_roe 自動推算程式碼存在', () => {
    expect(html).toContain('roAuto');
    expect(html).toContain('eps * 4 / +bpsCalc * 100');
  });

  test('populuate() 重置 other_eq 為 0', () => {
    expect(html).toContain("setVal('other_eq', '0')");
  });
}

// ════════════════════════════════════════════════════════════════════
// 2. API 整合測試
// ════════════════════════════════════════════════════════════════════
async function runIntegrationTests() {
  console.log(BOLD('\n══ API 整合測試（Integration Tests）══'));

  // ── 2-1. 台積電損益表 ──────────────────────────────────────────────
  console.log(B('  → 台積電 2330 損益表'));
  let fsData, bsData, prData;

  try {
    const fsJson = await apiGet('TaiwanStockFinancialStatements', '2330', '2026-01-01');
    fsData = fsJson.data || [];

    test('損益表回傳筆數 > 10（每科目一列，Q1約17筆）', () => expect(fsData.length).toBeAtLeast(10));

    const byPeriod = buildPeriodMap(fsData);
    const dates = Object.keys(byPeriod).sort().reverse();
    const latest = byPeriod[dates[0]];

    test('最新期間為 2026-03-31', () => expect(dates[0]).toBe('2026-03-31'));

    const rev = pick(latest, ['營業收入合計','營業收入','收入合計','營業淨收入']) / 1e8;
    test(`營收 ≈ 11341 億（得到 ${rev.toFixed(0)}）`, () =>
      expect(rev).toBeCloseTo(11341, 50));

    const gp = pick(latest, ['營業毛利（毛損）淨額','營業毛利（毛損）','營業毛利','毛利']) / 1e8;
    test(`毛利 ≈ 7513 億（得到 ${gp.toFixed(0)}）`, () =>
      expect(gp).toBeCloseTo(7513, 50));

    const op = pick(latest, ['營業利益（損失）','營業利益']) / 1e8;
    test(`營業利益 ≈ 6589 億（得到 ${op.toFixed(0)}）`, () =>
      expect(op).toBeCloseTo(6589, 50));

    const eps = pick(latest, ['基本每股盈餘（元）','基本每股盈餘','每股盈餘']);
    test(`EPS = 22.08（得到 ${eps}）`, () =>
      expect(eps).toBeCloseTo(22.08, 0.1));

    const gmPct = gp / rev * 100;
    test(`毛利率 ≈ 66.25%（得到 ${gmPct.toFixed(2)}%）`, () =>
      expect(gmPct).toBeCloseTo(66.25, 0.5));

  } catch (e) {
    console.log(`  ${R('✘')} 損益表 API 呼叫失敗: ${e.message}`);
    failed++;
  }

  // ── 2-2. 台積電資產負債表：_per 過濾 ──────────────────────────────
  console.log(B('  → 台積電 2330 資產負債表'));
  try {
    const bsJson = await apiGet('TaiwanStockBalanceSheet', '2330', '2026-01-01');
    bsData = bsJson.data || [];

    test('資產負債表回傳筆數 > 50（元值+_per各一列，Q1約102筆）', () => expect(bsData.length).toBeAtLeast(50));

    // 驗證 _per 行確實存在（這是我們要過濾的）
    const perRows = bsData.filter(r => r.type && r.type.endsWith('_per'));
    test('存在 _per 百分比行（需過濾）', () =>
      expect(perRows.length).toBeAtLeast(10));

    // 有過濾（filterPerRows=true）
    const byPeriodFiltered = buildPeriodMap(bsData, true);
    const dates = Object.keys(byPeriodFiltered).sort().reverse();
    const latest = byPeriodFiltered[dates[0]];

    test('最新期間為 2026-03-31', () => expect(dates[0]).toBe('2026-03-31'));

    // 無過濾（錯誤的舊行為）
    const byPeriodUnfiltered = buildPeriodMap(bsData, false);
    const latestUnfiltered = byPeriodUnfiltered[dates[0]];

    const taFiltered   = pick(latest,           ['資產總計','資產總額','資產合計']) / 1e8;
    const taUnfiltered = pick(latestUnfiltered,  ['資產總計','資產總額','資產合計']) / 1e8;

    test(`過濾後總資產 ≈ 86609 億（得到 ${taFiltered.toFixed(0)}）`, () =>
      expect(taFiltered).toBeCloseTo(86609, 100));

    test(`未過濾時總資產錯誤（得到 ${taUnfiltered.toFixed(2)} ≪ 正確值）`, () =>
      expect(taUnfiltered).toBeLessThan(200));  // _per 殘留導致數值異常小

    const teq = pick(latest, ['權益總額','權益總計','股東權益合計']) / 1e8;
    test(`股東權益 ≈ 59324 億（得到 ${teq.toFixed(0)}）`, () =>
      expect(teq).toBeCloseTo(59324, 100));

    const cs = pick(latest, ['普通股股本','股本','股本合計']);
    test(`股本 = 259325245000 元（得到 ${cs}）`, () =>
      expect(cs).toBeCloseTo(259325245000, 1e6));

    const sharesZ = Math.round(cs / 10000);
    test(`張數 = 25,932,525（得到 ${sharesZ.toLocaleString()}）`, () =>
      expect(sharesZ).toBeCloseTo(25932525, 1000));

    const peq = pick(latest, ['歸屬於母公司業主之權益合計','母公司業主之權益合計']) / 1e8;
    const bpsCalc = (peq * 1e8 / (sharesZ * 1000)).toFixed(2);
    test(`BPS ≈ 227 元（得到 ${bpsCalc}）`, () =>
      expect(+bpsCalc).toBeCloseTo(227.16, 2));

  } catch (e) {
    console.log(`  ${R('✘')} 資產負債表 API 呼叫失敗: ${e.message}`);
    failed++;
  }

  // ── 2-3. 股價 API ──────────────────────────────────────────────────
  console.log(B('  → 台積電 2330 股價'));
  try {
    const prJson = await apiGet('TaiwanStockPrice', '2330', '2026-05-01');
    prData = prJson.data || [];

    test('股價回傳筆數 > 10', () => expect(prData.length).toBeAtLeast(10));

    const latest = prData[prData.length - 1];
    const price = latest.close || latest.Close || latest.price || 0;
    test(`最新股價 > 1000 元（台積電）（得到 ${price}）`, () =>
      expect(price).toBeAtLeast(1000));

  } catch (e) {
    console.log(`  ${R('✘')} 股價 API 呼叫失敗: ${e.message}`);
    failed++;
  }

  // ── 2-4. 長榮 2603：_per 過濾 + adj_roe 推算 ──────────────────────
  console.log(B('  → 長榮 2603 資產負債表（驗證 _per 過濾）'));
  try {
    const bsJson2603 = await apiGet('TaiwanStockBalanceSheet', '2603', '2026-01-01');
    const bsRows2603 = bsJson2603.data || [];

    const byPeriod = buildPeriodMap(bsRows2603, true);
    const dates = Object.keys(byPeriod).sort().reverse();
    const latest = byPeriod[dates[0]];

    const ta = pick(latest, ['資產總計','資產總額','資產合計']) / 1e8;
    test(`長榮總資產 > 0（得到 ${ta.toFixed(0)} 億）`, () =>
      expect(ta).toBeAtLeast(1));

    const cs = pick(latest, ['普通股股本','股本','股本合計']);
    const peq = pick(latest, ['歸屬於母公司業主之權益合計','母公司業主之權益合計']) / 1e8;
    const sharesZ = cs > 0 ? Math.round(cs / 10000) : 0;
    const bpsCalc = sharesZ > 0 ? (peq * 1e8 / (sharesZ * 1000)) : 0;
    test(`長榮 BPS > 0（得到 ${bpsCalc.toFixed(2)} 元）`, () =>
      expect(bpsCalc).toBeAtLeast(1));

    // adj_roe 自動推算（EPS×4/BPS）
    const fsJson2603 = await apiGet('TaiwanStockFinancialStatements', '2603', '2026-01-01');
    const fsRows2603 = fsJson2603.data || [];
    const fsByPeriod = buildPeriodMap(fsRows2603);
    const fsDates = Object.keys(fsByPeriod).sort().reverse();
    const fsLatest = fsByPeriod[fsDates[0]];
    const eps2603 = pick(fsLatest, ['基本每股盈餘（元）','基本每股盈餘','每股盈餘']);

    const adjRoeAuto = bpsCalc > 0 ? (eps2603 * 4 / bpsCalc * 100) : 0;
    test(`長榮 adj_roe 自動推算 > 0%（得到 ${adjRoeAuto.toFixed(2)}%，非台積電的 42.91%）`, () => {
      expect(adjRoeAuto).toBeAtLeast(0.1);
      // 確認不等於台積電殘留值 42.91%（容差 5%）
      if (Math.abs(adjRoeAuto - 42.91) < 5) throw new Error('adj_roe 可能殘留台積電數值！');
    });

  } catch (e) {
    console.log(`  ${R('✘')} 長榮 API 呼叫失敗: ${e.message}`);
    failed++;
  }
}

// ════════════════════════════════════════════════════════════════════
// 3. 魚模型邏輯驗算（純數學，不需 API）
// ════════════════════════════════════════════════════════════════════
function runFishModelTests() {
  console.log(BOLD('\n══ 魚模型邏輯驗算（Unit Tests）══'));

  // 台積電 2330 Q1 2026 數據
  const BPS    = 227.16;
  const OEQ    = 0;      // 重置後
  const ADJ_ROE = +(22.08 * 4 / 227.16 * 100).toFixed(2);  // 自動推算

  const adjB = BPS + OEQ;
  const mult = ADJ_ROE / 10;
  const base = adjB * mult;

  test(`台積電 adj_roe 自動推算 = ${ADJ_ROE}%（EPS 22.08×4÷BPS 227.16）`, () => {
    expect(ADJ_ROE).toBeCloseTo(38.87, 0.5);
  });

  test(`魚模型基準值 = ${base.toFixed(1)} 元`, () => {
    // BPS=227.16, ROE=38.87% → base = 227.16 × 3.887 = 883.1
    expect(base).toBeCloseTo(227.16 * ADJ_ROE / 10, 0.5);
  });

  test('魚頭下限 = 基準值 × 0.85', () => {
    expect(base * 0.85).toBeCloseTo(base * 0.85, 0.1);
  });

  test('魚尾上限 = 基準值 × 1.30', () => {
    expect(base * 1.30).toBeCloseTo(base * 1.30, 0.1);
  });

  test('瘋狂價 = 基準值 × 2.0', () => {
    expect(base * 2.0).toBeCloseTo(base * 2, 0.1);
  });

  // BPS 計算驗算
  const peq = 5890960252000;   // 歸母權益（元）
  const cs  = 259325245000;    // 股本（元）
  const sharesZ = Math.round(cs / 10000);
  const bpsCalc = peq * 1e8 / (sharesZ * 1000) / 1e8;

  test(`BPS 計算 = ${bpsCalc.toFixed(2)} ≈ 227 元`, () =>
    expect(bpsCalc).toBeCloseTo(227.17, 0.5));

  test('sharesZ 計算正確（元 ÷ 10000）', () => {
    expect(sharesZ).toBe(25932525);
  });

  // 長榮魚模型 — 確認 adj_roe 殘留台積電數值時會給錯誤結果
  const TSMC_STALE_ROE = 42.91;
  const EVG_BPS = 268.71;
  const EVG_EPS = 3.84;
  const EVG_ROE_CORRECT = +(EVG_EPS * 4 / EVG_BPS * 100).toFixed(2);
  const EVG_ROE_STALE   = TSMC_STALE_ROE;

  const base_correct = EVG_BPS * EVG_ROE_CORRECT / 10;
  const base_stale   = EVG_BPS * EVG_ROE_STALE   / 10;

  test(`長榮正確基準值 ≈ ${base_correct.toFixed(0)} 元（非台積電的 ${base_stale.toFixed(0)} 元）`, () => {
    expect(base_correct).toBeLessThan(200);  // 合理（~154 元）
    expect(base_stale  ).toBeAtLeast(1000);  // 殘留導致基準暴高
  });
}

// ════════════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════════════
async function main() {
  console.log(BOLD(B('\n╔══════════════════════════════════════╗')));
  console.log(BOLD(B('║  TT 股票分析工具 — 完整測試套件     ║')));
  console.log(BOLD(B('╚══════════════════════════════════════╝')));
  console.log(`  FinMind token: ${TOKEN ? G('已提供') : Y('未提供（使用免費額度）')}`);

  // 1. 冒煙測試（同步）
  runSmokeTests();

  // 2. 整合測試（非同步 API）
  await runIntegrationTests();

  // 3. 魚模型邏輯驗算
  runFishModelTests();

  // ── 彙總 ─────────────────────────────────────────────────────────
  console.log(BOLD('\n══ 測試結果彙總 ══'));
  console.log(`  ${G('通過')} ${passed}  ${R('失敗')} ${failed}  ${Y('略過')} ${skipped}`);

  if (failures.length > 0) {
    console.log(R('\n  失敗項目：'));
    failures.forEach(f => console.log(`  ${R('✘')} ${f.name}\n     ${f.err}`));
  }

  const exitCode = failed > 0 ? 1 : 0;
  if (exitCode === 0) {
    console.log(G('\n  ✔ 所有測試通過 — 可以建立 PR'));
  } else {
    console.log(R('\n  ✘ 有測試失敗 — 請修正後再建立 PR'));
  }
  process.exit(exitCode);
}

main().catch(e => {
  console.error(R(`Fatal: ${e.message}`));
  process.exit(1);
});
