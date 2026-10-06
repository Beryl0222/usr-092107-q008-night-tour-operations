import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATE_TYPES, EVENT_TYPES, deduplicateReports, validateEvent } from "../src/validator.js";

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

function baseEvent(overrides = {}) {
  return {
    event_id: "evt-test-001",
    event_type: "INCIDENT_REPORTED",
    aggregate_type: "site_incident",
    aggregate_id: "inc-test",
    occurred_at: "2026-10-10T20:00:00+08:00",
    version: 1,
    summary: "测试事件",
    reported_by: "测试单位",
    report_key: "T-1",
    ...overrides
  };
}

test("样例符合领域约定", async () => {
  const sample = await readJson(new URL("../data/sample.json", import.meta.url));
  assert.deepEqual(validateEvent(sample), []);
});

test("全部示例事件符合领域约定", async () => {
  const dir = new URL("../data/examples/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  assert.ok(files.length >= 10, "示例数量不足");
  for (const file of files) {
    const record = await readJson(new URL(file, dir));
    assert.deepEqual(validateEvent(record), [], file);
  }
});

test("校验器与契约的事件、聚合枚举一致", async () => {
  const schema = await readJson(new URL("../contracts/domain.schema.json", import.meta.url));
  assert.deepEqual([...schema.properties.event_type.enum].sort(), [...EVENT_TYPES].sort());
  assert.deepEqual([...schema.properties.aggregate_type.enum].sort(), [...AGGREGATE_TYPES].sort());
});

test("各单位重复上报按上报方与编号去重", async () => {
  const first = await readJson(new URL("../data/examples/incident-stall-fire.json", import.meta.url));
  const resent = await readJson(new URL("../data/examples/incident-stall-fire-duplicate.json", import.meta.url));
  const { accepted, duplicates } = deduplicateReports([first, resent]);
  assert.equal(accepted.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].event_id, resent.event_id);
});

test("客流数据必须标明覆盖范围", () => {
  const record = baseEvent({
    event_type: "CROWD_COUNTED",
    aggregate_type: "crowd_measurement",
    payload: { data_kind: "manual_count", count: 300 }
  });
  assert.ok(validateEvent(record).some((error) => error.includes("coverage_scope")));
});

test("预测值不能伪装成闸机实数", () => {
  const forecastWithDevice = baseEvent({
    event_type: "CROWD_COUNTED",
    aggregate_type: "crowd_measurement",
    payload: {
      coverage_scope: "zone_full",
      data_kind: "forecast",
      model_ref: "crowd-model-v4",
      valid_until: "2026-10-10T21:30:00+08:00",
      source_device: "gate-01"
    }
  });
  assert.ok(validateEvent(forecastWithDevice).some((error) => error.includes("伪装")));

  const actualWithoutDevice = baseEvent({
    event_type: "CROWD_COUNTED",
    aggregate_type: "crowd_measurement",
    payload: { coverage_scope: "entrance_only", data_kind: "turnstile_actual", count: 100 }
  });
  assert.ok(validateEvent(actualWithoutDevice).some((error) => error.includes("source_device")));
});

test("临时停演只释放对应区域容量，不得连带撤销已核销体验", () => {
  const record = baseEvent({
    event_type: "PERFORMANCE_SUSPENDED",
    aggregate_type: "joint_response",
    basis_event_ids: ["evt-cause"],
    payload: { zone_id: "night-market-stage", capacity_released: 800, revoked_experience_ids: ["exp-1"] }
  });
  assert.ok(validateEvent(record).some((error) => error.includes("不得连带撤销")));
});

test("补偿按责任与资金来源分别记录", () => {
  const record = baseEvent({
    event_type: "COMPENSATION_RECORDED",
    aggregate_type: "compensation_case",
    payload: { responsibility_party: "演出承办方" }
  });
  const errors = validateEvent(record);
  assert.ok(errors.some((error) => error.includes("funding_source")));
  assert.ok(errors.some((error) => error.includes("cause_event_id")));
});

test("对客指令必须区分已入场与尚未出发人群", () => {
  const record = baseEvent({
    event_type: "DIRECTIVE_ISSUED",
    aggregate_type: "joint_response",
    payload: { audience_segment: "everyone", instruction: "请撤离" }
  });
  assert.ok(validateEvent(record).some((error) => error.includes("audience_segment")));
});

test("自然观察活动缩线或取消必须引用触发的告警", () => {
  const record = baseEvent({
    event_type: "ROUTE_SHORTENED",
    aggregate_type: "joint_response",
    basis_event_ids: ["evt-alert"],
    payload: {}
  });
  assert.ok(validateEvent(record).some((error) => error.includes("trigger_alert_id")));
});

test("决策事件必须给出实际依据", () => {
  const record = baseEvent({ event_type: "FLOW_THROTTLED", aggregate_type: "joint_response" });
  assert.ok(validateEvent(record).some((error) => error.includes("basis_event_ids")));
});

test("单位上报必须携带上报方与编号", () => {
  const record = baseEvent();
  delete record.report_key;
  assert.ok(validateEvent(record).some((error) => error.includes("report_key")));
});

test("合作方可见记录必须指明合作方", () => {
  const record = baseEvent({ visibility: "partner" });
  assert.ok(validateEvent(record).some((error) => error.includes("partner_id")));
});
