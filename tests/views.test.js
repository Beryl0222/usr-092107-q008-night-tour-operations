import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { replay } from "../src/event_log.js";
import { operationsView, partnerView, incidentLineage } from "../src/views.js";

const TIMELINE_PATH = new URL("../data/weekend_timeline.json", import.meta.url);

async function loadTimeline() {
  const records = JSON.parse(await readFile(TIMELINE_PATH, "utf8"));
  return { records, log: replay(records) };
}

test("周末时间线整体可重放：74 份上报，其中 1 份跨单位重复被折叠", async () => {
  const { records, log } = await loadTimeline();
  assert.equal(records.length, 74);
  assert.equal(log.received.length, 74);
  assert.equal(log.events().length, 73);
  assert.ok(log.duplicateIds.has("e30"));
});

test("运行视图：闸机实数合计、估算与预测分列，预测不冒充实数", async () => {
  const { log } = await loadTimeline();
  const view = operationsView(log);

  const museum = view.zones.find((z) => z.zone_id === "z-museum-hall");
  // 两闸机各有覆盖说明，合计 830+410=1240
  assert.equal(museum.gate_actual.value, 1240);
  assert.equal(museum.gate_actual.gate_count, 2);
  assert.ok(museum.gate_actual.coverage.some((c) => c.gate_id === "gm-east"));
  assert.equal(museum.load_ratio, 1.03);

  const market = view.zones.find((z) => z.zone_id === "z-night-market");
  // 原估算被后继记录更正为 3050；预测 6100 单列
  assert.deepEqual(market.estimates.map((e) => e.value), [3050]);
  assert.equal(market.forecasts.length, 1);
  assert.equal(market.forecasts[0].value, 6100);
  assert.equal(market.forecasts[0].forecast_for, "2026-10-10T21:30:00+08:00");
  assert.equal(market.gate_actual, undefined); // 夜市无闸机，不生成"实数"
});

test("运行视图：自然观察场次在雷雨/敏感物种下被标记优先缩线或取消", async () => {
  const { log } = await loadTimeline();
  // 20:26 雷雨 watch + 原麝告警已发，缩线决定（20:30）尚未下达：视图应提示缩线/取消
  const viewAt2026 = operationsView(log, { asOf: "2026-10-10T20:26:00+08:00" });
  const rec = viewAt2026.recommendations.find((r) => r.type === "shorten_or_cancel_nature_session");
  assert.ok(rec, "20:26 应建议对观星场缩线或取消");
  assert.equal(rec.session_id, "ses-star-1010");
  assert.ok(rec.based_on.includes("e29"));

  // 取消后不再重复建议
  const viewAt2100 = operationsView(log, { asOf: "2026-10-10T21:00:00+08:00" });
  assert.equal(viewAt2100.recommendations.some((r) => r.type === "shorten_or_cancel_nature_session"), false);
});

test("运行视图：限流建议只采信闸机实数；夜市预测被更正后未被限流", async () => {
  const { log } = await loadTimeline();
  const view = operationsView(log, { asOf: "2026-10-10T21:06:00+08:00" });
  // 地铁口闸机实数 2100 ≥ 2000，且此时尚未限流 → 建议限流
  assert.ok(view.recommendations.some((r) => r.type === "restrict_entry" && r.zone_id === "z-metro-exit"));
  // 夜市只有更正后的估算 3050（<5000）与预测 6100，不得因预测触发限流
  assert.equal(view.recommendations.some((r) => r.zone_id === "z-night-market"), false);
});

test("运行视图：实际发车超运力触发增开接驳建议", async () => {
  const { log } = await loadTimeline();
  const view = operationsView(log, { asOf: "2026-10-10T21:33:00+08:00" });
  const rec = view.recommendations.find((r) => r.type === "add_shuttle" && r.service_id === "svc-metro-2");
  assert.ok(rec, "21:30 次班 1850/1800 超员应建议增开接驳");
});

test("运行视图：最终态两场补偿按责任与资金来源分别立案", async () => {
  const { log } = await loadTimeline();
  const view = operationsView(log);
  const byCase = Object.fromEntries(view.compensations.map((c) => [c.case_id, c]));
  assert.equal(byCase["cmp-star-insurance"].funding_source, "insurance");
  assert.equal(byCase["cmp-star-insurance"].responsibility.party, "force_majeure");
  assert.equal(byCase["cmp-star-insurance"].amount, 360);
  assert.equal(byCase["cmp-heritage-org"].funding_source, "organizer");
  assert.equal(byCase["cmp-heritage-org"].responsibility.party, "heritage-troupe");
  assert.equal(byCase["cmp-heritage-org"].amount, 320);
  // 两案覆盖的核销票互不串案
  assert.deepEqual(byCase["cmp-star-insurance"].covered_redemption_ids, ["rd-star-001", "rd-star-002", "rd-star-003"]);
  assert.deepEqual(byCase["cmp-heritage-org"].covered_redemption_ids, ["rd-her-001", "rd-her-002", "rd-her-003", "rd-her-004"]);
});

test("合作方视图：林站只看到观星资源与点名本方的处置指令", async () => {
  const { log } = await loadTimeline();
  const forest = partnerView(log, "forest-station");
  assert.deepEqual(forest.resources.sessions.map((s) => s.experience_id), ["exp-stargazing"]);
  assert.equal(forest.resources.transit.length, 0);
  // 点名 forest-station 的指令：缩线分群指令、取消疏散指令
  assert.ok(forest.action_required.length >= 2);
  // 林站看到的是去重后的唯一告警事实（其转报 e30 被折叠，不重复出现）
  assert.ok(forest.reports_on_file.some((r) => r.event_id === "e34"));
  assert.equal(forest.reports_on_file.some((r) => r.event_id === "e30"), false);
});

test("合作方视图：客运公司只看到接驳资源与增车指令，看不到博物馆核销与补偿", async () => {
  const { log } = await loadTimeline();
  const bus = partnerView(log, "bus-co");
  assert.deepEqual(bus.resources.transit.map((t) => t.service_id), ["svc-shuttle-forest"]);
  assert.equal(bus.resources.sessions.length, 0);
  assert.equal(bus.resources.compensations.length, 0);
  assert.equal(bus.action_required.length, 1);
  assert.deepEqual(bus.action_required[0].audience.map((a) => a.segment), ["onsite"]);
});

test("合作方视图：无关合作方看不到任何记录", async () => {
  const { log } = await loadTimeline();
  const stranger = partnerView(log, "unrelated-vendor");
  assert.equal(stranger.reports_on_file.length, 0);
  assert.equal(stranger.action_required.length, 0);
});

test("复盘血缘：地铁口拥堵可还原为 读数→事件→决定→措施/接驳 的完整链路", async () => {
  const { log } = await loadTimeline();
  const lineage = incidentLineage(log, "inc-congest-metro");
  const ids = lineage.nodes.map((n) => n.event_id);
  // 证据
  assert.ok(ids.includes("e42"), "闸机实数 2100");
  assert.ok(ids.includes("e24"), "末班提前");
  assert.ok(ids.includes("e55"), "次班超员");
  // 事件与决定
  assert.ok(ids.includes("e45"));
  assert.ok(ids.includes("e47"));
  assert.ok(ids.includes("e58"));
  // 后果
  assert.ok(ids.includes("e59"), "增开接驳");
  assert.ok(ids.includes("e60"), "接驳指令");
  // 决定节点可直接读到依据
  const dec58 = lineage.nodes.find((n) => n.event_id === "e58");
  assert.deepEqual(dec58.payload_highlights.based_on, ["e24", "e55", "e45"]);
});

test("复盘血缘：噪声投诉可追到边界实测记录", async () => {
  const { log } = await loadTimeline();
  const lineage = incidentLineage(log, "inc-noise-complaint");
  assert.deepEqual(lineage.nodes.map((n) => n.event_id), ["e36", "e57"]);
});

test("asOf 视图：更正当晚（20:08）看到的是当时的原始估算值", async () => {
  const { log } = await loadTimeline();
  const viewAt2009 = operationsView(log, { asOf: "2026-10-10T20:09:00+08:00" });
  const market = viewAt2009.zones.find((z) => z.zone_id === "z-night-market");
  assert.deepEqual(market.estimates.map((e) => e.value), [4200]);
});
