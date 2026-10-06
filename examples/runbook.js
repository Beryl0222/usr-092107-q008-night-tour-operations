/**
 * 周末样例运行手册：重放 data/weekend_timeline.json，打印
 * 21:06 值班运行视图（限流/接驳判断）、两个合作方视图与一次拥堵的复盘血缘。
 *
 * 运行：node examples/runbook.js
 */
import { readFile } from "node:fs/promises";

import { replay } from "../src/event_log.js";
import { operationsView, partnerView, incidentLineage } from "../src/views.js";

const records = JSON.parse(await readFile(new URL("../data/weekend_timeline.json", import.meta.url), "utf8"));
const log = replay(records);

const view = operationsView(log, { asOf: "2026-10-10T21:06:00+08:00" });

console.log("== 21:06 值班运行视图（系统建议，均带依据事件） ==");
for (const rec of view.recommendations) {
  console.log(`- [${rec.type}] ${rec.zone_id ?? rec.session_id ?? rec.service_id}：${rec.reason}（依据 ${rec.based_on.join("、")}）`);
}

console.log("\n== 各分区客流（闸机实数 / 估算 / 预测分列） ==");
for (const z of view.zones) {
  const bits = [];
  if (z.gate_actual) bits.push(`闸机实数 ${z.gate_actual.value}（${z.gate_actual.gate_count} 台闸机）`);
  if (z.estimates?.length) bits.push(`估算 ${z.estimates.map((e) => `${e.value}(${e.reading_kind})`).join("，")}`);
  if (z.forecasts?.length) bits.push(`预测 ${z.forecasts.map((f) => `${f.value}@${f.forecast_for.slice(11, 16)}`).join("，")}`);
  if (bits.length) console.log(`- ${z.name}：${bits.join("；")}`);
}

console.log("\n== 合作方视图：bus-co 只看到接驳资源与一条点名指令 ==");
const bus = partnerView(log, "bus-co");
console.log(JSON.stringify({ resources: bus.resources, action_required: bus.action_required.map((d) => d.directive_id) }, null, 2));

console.log("\n== 复盘：地铁口拥堵 inc-congest-metro 的决定链 ==");
const lineage = incidentLineage(log, "inc-congest-metro");
for (const n of lineage.nodes) {
  console.log(`${n.at.slice(11, 16)} [${n.category.padEnd(9)}] ${n.event_id} ${n.summary}`);
}
