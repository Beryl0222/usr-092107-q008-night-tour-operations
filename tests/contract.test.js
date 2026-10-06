import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { baseEvent } from "./helpers.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("缺少必填字段时逐个报中文错误", () => {
  const errors = validateEvent({ event_id: "x" });
  assert.ok(errors.some((e) => e.includes("event_type")));
  assert.ok(errors.some((e) => e.includes("source_system")));
});

test("事件类型必须挂在对应聚合上", () => {
  const errors = validateEvent(
    baseEvent({ event_type: "ALERT_RAISED", aggregate_type: "capacity_zone", payload: {} }),
  );
  assert.ok(errors.some((e) => e.includes("只能挂在")));
  assert.deepEqual(
    validateEvent(
      baseEvent({
        event_type: "ALERT_RAISED",
        aggregate_type: "operational_alert",
        aggregate_id: "a1",
        payload: { alert_id: "a1", category: "weather_wind", severity: "watch", zone_ids: ["z1"] },
      }),
    ),
    [],
  );
});

test("version 必须是正整数", () => {
  assert.ok(validateEvent(baseEvent({ version: 0 })).some((e) => e.includes("version")));
  assert.ok(validateEvent(baseEvent({ version: 1.5 })).some((e) => e.includes("version")));
});

test("时间字段必须是带时区的 date-time", () => {
  assert.ok(validateEvent(baseEvent({ occurred_at: "2026-10-10 18:00" })).length > 0);
});

test("visibility 只能是联合中心或 partner 点名", () => {
  assert.deepEqual(validateEvent(baseEvent({ visibility: "joint_center" })), []);
  assert.deepEqual(validateEvent(baseEvent({ visibility: "partner:metro-ops" })), []);
  assert.ok(validateEvent(baseEvent({ visibility: "public" })).some((e) => e.includes("visibility")));
});
