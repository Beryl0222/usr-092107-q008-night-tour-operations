import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EVENT_TYPES,
  AGGREGATE_TYPES,
  EVENT_AGGREGATE,
  CROWD_READING_KINDS,
  ALERT_CATEGORIES,
  FUNDING_SOURCES,
  validateEvent,
} from "../src/validator.js";
import { replay } from "../src/event_log.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

test("校验器事件类型与 JSON Schema 枚举保持一致", () => {
  assert.deepEqual([...EVENT_TYPES].sort(), [...schema.properties.event_type.enum].sort());
  assert.deepEqual([...AGGREGATE_TYPES].sort(), [...schema.properties.aggregate_type.enum].sort());
});

test("每个事件类型都登记了唯一归属聚合", () => {
  for (const type of EVENT_TYPES) assert.ok(AGGREGATE_TYPES.includes(EVENT_AGGREGATE[type]), `${type} 缺少聚合归属`);
  // 聚合归属表中的聚合必须合法
  for (const agg of Object.values(EVENT_AGGREGATE)) assert.ok(AGGREGATE_TYPES.includes(agg));
});

test("Schema 内客流读数与补偿定义与校验器枚举一致", () => {
  assert.deepEqual(
    [...CROWD_READING_KINDS].sort(),
    [...schema.$defs.crowd_reading.properties.reading_kind.enum].sort(),
  );
  assert.deepEqual(
    [...FUNDING_SOURCES].sort(),
    [...schema.$defs.compensation.properties.funding_source.enum].sort(),
  );
  assert.ok(ALERT_CATEGORIES.includes("weather_thunder"));
  assert.ok(ALERT_CATEGORIES.includes("wildlife_sensitive_species"));
  assert.ok(ALERT_CATEGORIES.includes("fire_risk"));
});

test("信封封闭：业务字段必须放 payload，顶层未知字段被拒收", () => {
  assert.equal(schema.additionalProperties, false);
  const errors = validateEvent({
    event_id: "x1",
    event_type: "PROGRAM_CLEARED",
    aggregate_type: "night_program",
    aggregate_id: "p1",
    occurred_at: "2026-10-10T18:00:00+08:00",
    version: 1,
    summary: "测试",
    source_system: "duty-room",
    crowd_value: 999,
  });
  assert.ok(errors.some((e) => e.includes("信封不允许顶层字段")), errors.join("；"));
});

test("完整周末时间线每条记录都通过信封校验，且可整体重放", async () => {
  const records = JSON.parse(await readFile(new URL("../data/weekend_timeline.json", import.meta.url), "utf8"));
  for (const record of records) {
    const errors = validateEvent(record);
    assert.deepEqual(errors, [], `${record.event_id} 校验失败：${errors.join("；")}`);
  }
  const log = replay(records);
  assert.equal(log.events().length, records.length - 1); // 恰好一条跨单位重复上报
});
