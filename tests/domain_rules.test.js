import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EventLog, replay } from "../src/event_log.js";
import { operationsView, partnerView, incidentLineage } from "../src/views.js";
import { baseEvent, appendExpectingErrors } from "./helpers.js";

/** 构造一套最小可用登记：自然观察体验 + 两个分区 + 场次 + 核销票。 */
function seedNatureNight(log, { overrides = {} } = {}) {
  log.append(baseEvent({
    event_type: "EXPERIENCE_REGISTERED",
    aggregate_type: "experience",
    aggregate_id: "exp-star",
    payload: { experience_id: "exp-star", name: "观星", nature_observation: true, operator_id: "forest-station" },
    ...overrides.experience,
  }));
  log.append(baseEvent({
    event_type: "ZONE_REGISTERED",
    aggregate_type: "capacity_zone",
    aggregate_id: "z-base",
    version: 1,
    payload: { zone_id: "z-base", name: "集结区", capacity: 100 },
  }));
  log.append(baseEvent({
    event_type: "ZONE_REGISTERED",
    aggregate_type: "capacity_zone",
    aggregate_id: "z-ridge",
    version: 1,
    payload: { zone_id: "z-ridge", name: "山脊点", capacity: 40 },
  }));
  log.append(baseEvent({
    event_type: "SESSION_SCHEDULED",
    aggregate_type: "experience",
    aggregate_id: "exp-star",
    version: 2,
    payload: {
      session_id: "ses-1",
      experience_id: "exp-star",
      zone_ids: ["z-base", "z-ridge"],
      starts_at: "2026-10-10T19:30:00+08:00",
      ends_at: "2026-10-10T22:00:00+08:00",
    },
  }));
  log.append(baseEvent({
    event_type: "TICKETS_REDEEMED",
    aggregate_type: "experience",
    aggregate_id: "exp-star",
    version: 3,
    payload: { experience_id: "exp-star", redemption_ids: ["r1", "r2"] },
  }));
}

function raiseAlert(log, { id = "alert-1", category = "weather_thunder", zones = ["z-ridge"], severity = "warning", key } = {}) {
  log.append(baseEvent({
    event_id: `evt-alert-${id}`,
    event_type: "ALERT_RAISED",
    aggregate_type: "operational_alert",
    aggregate_id: id,
    idempotency_key: key,
    payload: { alert_id: id, category, severity, zone_ids: zones, message: "测试告警" },
  }));
}

function crowdRecord(overrides = {}) {
  return baseEvent({
    event_type: "CROWD_COUNT_REPORTED",
    aggregate_type: "capacity_zone",
    aggregate_id: "z-base",
    version: 10,
    payload: {
      zone_id: "z-base",
      reading_kind: "gate_actual",
      gate_id: "g1",
      value: 10,
      captured_at: "2026-10-10T20:00:00+08:00",
      coverage: { scope: "zone_entrance", description: "入口闸机" },
    },
    ...overrides,
  });
}

test("客流真值：闸机实数必须带 gate_id", () => {
  const log = new EventLog();
  const errors = appendExpectingErrors(log, crowdRecord({ payload: {
    zone_id: "z-base",
    reading_kind: "gate_actual",
    value: 10,
    coverage: { scope: "zone_entrance", description: "入口" },
  } }));
  assert.ok(errors.some((e) => e.includes("gate_id")), errors.join("；"));
});

test("客流真值：预测必须带 forecast_for，且预测不得伪装成闸机实数", () => {
  const log = new EventLog();
  // forecast 缺 forecast_for → 拒收
  assert.ok(appendExpectingErrors(log, crowdRecord({ payload: {
    zone_id: "z-base",
    reading_kind: "forecast",
    value: 999,
    coverage: { scope: "zone_full", description: "模型预测" },
  } })).some((e) => e.includes("forecast_for")));
  // 非预测读数携带 forecast_for → 拒收，防止预测污染实数
  assert.ok(appendExpectingErrors(log, crowdRecord({ payload: {
    zone_id: "z-base",
    reading_kind: "gate_actual",
    gate_id: "g1",
    value: 10,
    forecast_for: "2026-10-10T22:00:00+08:00",
    coverage: { scope: "zone_entrance", description: "入口" },
  } })).some((e) => e.includes("不得携带 forecast_for")));
  // 合规预测可接收
  assert.deepEqual(appendExpectingErrors(log, crowdRecord({
    event_id: "fc-ok",
    payload: {
      zone_id: "z-base",
      reading_kind: "forecast",
      value: 999,
      forecast_for: "2026-10-10T22:00:00+08:00",
      confidence: 0.8,
      coverage: { scope: "zone_full", description: "模型预测，全分区" },
    },
  })), []);
});

test("客流读数必须标明覆盖范围", () => {
  const log = new EventLog();
  const errors = appendExpectingErrors(log, crowdRecord({ payload: {
    zone_id: "z-base",
    reading_kind: "gate_actual",
    gate_id: "g1",
    value: 10,
  } }));
  assert.ok(errors.some((e) => e.includes("coverage")), errors.join("；"));
});

test("重复上报：同幂等键同载荷折叠为一份，不重复进入投影", () => {
  const log = new EventLog();
  raiseAlert(log, { key: "fact:alert-1" });
  log.append(baseEvent({
    event_id: "dup-1",
    event_type: "ALERT_RAISED",
    aggregate_type: "operational_alert",
    aggregate_id: "alert-1",
    source_system: "forest-station",
    idempotency_key: "fact:alert-1",
    payload: { alert_id: "alert-1", category: "weather_thunder", severity: "warning", zone_ids: ["z-ridge"], message: "测试告警" },
  }));
  assert.equal(log.received.length, 2);
  assert.equal(log.events().length, 1);
  assert.ok(log.duplicateIds.has("dup-1"));
});

test("重复上报：同幂等键但载荷不一致且未走后继记录 → 拒收", () => {
  const log = new EventLog();
  raiseAlert(log, { key: "fact:alert-1", severity: "watch" });
  const errors = appendExpectingErrors(log, baseEvent({
    event_id: "conflict-1",
    event_type: "ALERT_RAISED",
    aggregate_type: "operational_alert",
    aggregate_id: "alert-1",
    idempotency_key: "fact:alert-1",
    payload: { alert_id: "alert-1", category: "weather_thunder", severity: "warning", zone_ids: ["z-ridge"], message: "测试告警" },
  }));
  assert.ok(errors.some((e) => e.includes("supersedes")), errors.join("；"));
});

test("更正：后继记录必须同聚合且版本更大，投影只取新值", () => {
  const log = new EventLog();
  log.append(crowdRecord({ event_id: "c1", version: 10, payload: {
    zone_id: "z-base", reading_kind: "camera_estimate", value: 500, confidence: 0.6,
    coverage: { scope: "zone_full", description: "初版估算" },
  } }));
  // 指向不存在记录
  assert.ok(appendExpectingErrors(log, crowdRecord({ event_id: "c2", version: 11, supersedes: "nope", payload: {
    zone_id: "z-base", reading_kind: "camera_estimate", value: 400,
    coverage: { scope: "zone_full", description: "更正估算" },
  } })).some((e) => e.includes("不存在")));
  // 版本未增大
  assert.ok(appendExpectingErrors(log, crowdRecord({ event_id: "c2", version: 10, supersedes: "c1", payload: {
    zone_id: "z-base", reading_kind: "camera_estimate", value: 400,
    coverage: { scope: "zone_full", description: "更正估算" },
  } })).some((e) => e.includes("版本")));
  // 合规更正
  assert.deepEqual(appendExpectingErrors(log, crowdRecord({ event_id: "c2", version: 11, supersedes: "c1", payload: {
    zone_id: "z-base", reading_kind: "camera_estimate", value: 400,
    coverage: { scope: "zone_full", description: "更正估算" },
  } })), []);
  const zone = operationsView(log).zones.find((z) => z.zone_id === "z-base");
  assert.deepEqual(zone.estimates.map((e) => e.value), [400]);
});

test("自然观察：缩线只能由敏感物种、雷雨或消防告警触发", () => {
  const log = new EventLog();
  seedNatureNight(log);
  // 噪声告警不构成缩线理由
  raiseAlert(log, { id: "alert-noise", category: "noise", zones: ["z-ridge"], severity: "advisory" });
  const errors = appendExpectingErrors(log, baseEvent({
    event_type: "ROUTE_SHORTENED",
    aggregate_type: "experience",
    aggregate_id: "exp-star",
    version: 4,
    payload: { session_id: "ses-1", experience_id: "exp-star", dropped_waypoints: ["wp-ridge"], reason_alert_ids: ["alert-noise"] },
  }));
  assert.ok(errors.some((e) => e.includes("只接受敏感物种、雷雨或消防风险")), errors.join("；"));
  // 引用不存在的告警也不行
  assert.ok(appendExpectingErrors(log, baseEvent({
    event_type: "ROUTE_SHORTENED",
    aggregate_type: "experience",
    aggregate_id: "exp-star",
    version: 4,
    payload: { session_id: "ses-1", experience_id: "exp-star", dropped_waypoints: ["wp-ridge"], reason_alert_ids: ["ghost"] },
  })).some((e) => e.includes("不存在")));

  raiseAlert(log, { id: "alert-thunder", category: "weather_thunder", zones: ["z-ridge"], severity: "warning" });
  assert.deepEqual(appendExpectingErrors(log, baseEvent({
    event_type: "ROUTE_SHORTENED",
    aggregate_type: "experience",
    aggregate_id: "exp-star",
    version: 4,
    payload: { session_id: "ses-1", experience_id: "exp-star", dropped_waypoints: ["wp-ridge"], reason_alert_ids: ["alert-thunder"] },
  })), []);
});

test("临时停演只释放本场次登记分区，不能波及其他体验分区", () => {
  const log = new EventLog();
  seedNatureNight(log);
  const errors = appendExpectingErrors(log, baseEvent({
    event_type: "SESSION_SUSPENDED",
    aggregate_type: "experience",
    aggregate_id: "exp-star",
    version: 4,
    payload: { session_id: "ses-1", experience_id: "exp-star", released_zone_ids: ["z-ridge", "z-other"], reason: "测试" },
  }));
  assert.ok(errors.some((e) => e.includes("只能释放对应区域")), errors.join("；"));
});

test("场次状态机：先缩线再取消，投影如实反映", () => {
  const log = new EventLog();
  seedNatureNight(log);
  raiseAlert(log, { id: "a1", category: "wildlife_sensitive_species", zones: ["z-ridge"] });
  raiseAlert(log, { id: "a2", category: "weather_thunder", zones: ["z-base", "z-ridge"], severity: "warning" });
  log.append(baseEvent({
    event_type: "ROUTE_SHORTENED", aggregate_type: "experience", aggregate_id: "exp-star", version: 4,
    payload: { session_id: "ses-1", experience_id: "exp-star", dropped_waypoints: ["wp-ridge"], reason_alert_ids: ["a1"] },
  }));
  log.append(baseEvent({
    event_type: "SESSION_CANCELLED", aggregate_type: "experience", aggregate_id: "exp-star", version: 5,
    payload: { session_id: "ses-1", experience_id: "exp-star", released_zone_ids: ["z-base", "z-ridge"], reason: "雷雨升级" },
  }));
  const session = operationsView(log).sessions.find((s) => s.session_id === "ses-1");
  assert.equal(session.status, "cancelled");
  assert.deepEqual(session.lifecycle.map((x) => x.type), ["scheduled", "shortened", "cancelled"]);
});

test("分群指令：已入场与尚未出发分别校验可用动作", () => {
  const log = new EventLog();
  seedNatureNight(log);
  // 给未出发人群发 evacuate 不适用
  const errors = appendExpectingErrors(log, baseEvent({
    event_type: "DIRECTIVE_ISSUED",
    aggregate_type: "audience_directive",
    aggregate_id: "dir-1",
    payload: {
      audience: [
        { segment: "not_departed", action: "evacuate", message: "立即撤离" },
      ],
    },
  }));
  assert.ok(errors.some((e) => e.includes("不适用于人群")), errors.join("；"));
  // 合规分群指令
  assert.deepEqual(appendExpectingErrors(log, baseEvent({
    event_id: "dir-ok",
    event_type: "DIRECTIVE_ISSUED",
    aggregate_type: "audience_directive",
    aggregate_id: "dir-2",
    payload: {
      audience: [
        { segment: "onsite", action: "shorten_route", message: "山上队伍撤回集结区" },
        { segment: "not_departed", action: "hold_departure", message: "未出发者暂缓" },
      ],
    },
  })), []);
});

test("指令依据必须真实存在", () => {
  const log = new EventLog();
  const errors = appendExpectingErrors(log, baseEvent({
    event_type: "DIRECTIVE_ISSUED",
    aggregate_type: "audience_directive",
    aggregate_id: "dir-x",
    payload: {
      based_on: ["ghost"],
      audience: [{ segment: "onsite", action: "shelter", message: "就近避险" }],
    },
  }));
  assert.ok(errors.some((e) => e.includes("不存在")));
});

test("补偿：只能覆盖本体验已核销票；资金来源与责任分别记录", () => {
  const log = new EventLog();
  seedNatureNight(log);
  // 另一体验与核销票
  log.append(baseEvent({
    event_type: "EXPERIENCE_REGISTERED", aggregate_type: "experience", aggregate_id: "exp-her",
    event_id: "exp-her-reg", version: 1,
    payload: { experience_id: "exp-her", name: "夜戏", nature_observation: false, operator_id: "troupe" },
  }));
  log.append(baseEvent({
    event_type: "TICKETS_REDEEMED", aggregate_type: "experience", aggregate_id: "exp-her",
    event_id: "her-rd", version: 2,
    payload: { experience_id: "exp-her", redemption_ids: ["h1"] },
  }));
  // 把别的体验的票塞进观星补偿案 → 拒收（停演不连带其他体验）
  const errors = appendExpectingErrors(log, baseEvent({
    event_type: "COMPENSATION_OPENED",
    aggregate_type: "compensation_case",
    aggregate_id: "cmp-1",
    payload: {
      case_id: "cmp-1",
      experience_id: "exp-star",
      responsibility: { party: "force_majeure", basis: "雷雨", share: 1 },
      funding_source: "insurance",
      covered_redemption_ids: ["r1", "h1"],
    },
  }));
  assert.ok(errors.some((e) => e.includes("不属于体验")), errors.join("；"));
  // 未登记的资金来源 → 拒收
  assert.ok(appendExpectingErrors(log, baseEvent({
    event_type: "COMPENSATION_OPENED",
    aggregate_type: "compensation_case",
    aggregate_id: "cmp-2",
    payload: {
      case_id: "cmp-2", experience_id: "exp-star",
      responsibility: { party: "organizer", basis: "设备故障" },
      funding_source: "crowdfunding",
    },
  })).some((e) => e.includes("funding_source")));
  // 合规两案：保险与主办方分账
  for (const [id, source, party, eventId] of [
    ["cmp-a", "insurance", "force_majeure", "cmp-a-open"],
    ["cmp-b", "organizer", "troupe", "cmp-b-open"],
  ]) {
    assert.deepEqual(appendExpectingErrors(log, baseEvent({
      event_id: eventId,
      event_type: "COMPENSATION_OPENED",
      aggregate_type: "compensation_case",
      aggregate_id: id,
      payload: {
        case_id: id, experience_id: "exp-star",
        responsibility: { party, basis: "测试", share: 1 },
        funding_source: source,
        covered_redemption_ids: ["r1"],
      },
    })), []);
  }
});

test("决策必须挂实际依据，凭空决定进不了日志", () => {
  const log = new EventLog();
  const errors = appendExpectingErrors(log, baseEvent({
    event_type: "DECISION_MADE",
    aggregate_type: "operational_decision",
    aggregate_id: "dec-1",
    payload: { decision_type: "stop_entry", rationale: "感觉人多", based_on: ["nope"] },
  }));
  assert.ok(errors.some((e) => e.includes("不存在")));
  assert.ok(appendExpectingErrors(log, baseEvent({
    event_type: "DECISION_MADE",
    aggregate_type: "operational_decision",
    aggregate_id: "dec-2",
    payload: { decision_type: "stop_entry", rationale: "无依据" },
  })).some((e) => e.includes("based_on")));
});

test("版本必须按聚合严格递增", () => {
  const log = new EventLog();
  log.append(baseEvent({ event_id: "v1", version: 1 }));
  assert.ok(appendExpectingErrors(log, baseEvent({ event_id: "v2", version: 1 })).some((e) => e.includes("严格递增")));
});

test("增开接驳必须引用触发它的末班变化或实际超载记录", () => {
  const log = new EventLog();
  const errors = appendExpectingErrors(log, baseEvent({
    event_type: "SHUTTLE_SERVICE_ADDED",
    aggregate_type: "transit_service",
    aggregate_id: "svc-1",
    payload: { service_id: "svc-1", reason_event_ids: ["ghost"], departures: [{ departs_at: "2026-10-10T22:20:00+08:00", capacity: 45 }] },
  }));
  assert.ok(errors.some((e) => e.includes("不存在")));
});
