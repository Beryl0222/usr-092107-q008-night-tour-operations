/**
 * 夜游联合运行中心事件校验。
 *
 * validateEvent 只做与状态无关的信封与载荷校验；
 * 涉及跨记录的规则（后继版本、补偿只能覆盖本体验核销票等）在 src/event_log.js 中校验。
 */

const REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
  "source_system",
];

export const EVENT_TYPES = [
  "PROGRAM_CLEARED",
  "EXPERIENCE_REGISTERED",
  "SESSION_SCHEDULED",
  "TICKETS_REDEEMED",
  "ROUTE_SHORTENED",
  "SESSION_SUSPENDED",
  "SESSION_CANCELLED",
  "SESSION_RESUMED",
  "VENDOR_CHECKED_IN",
  "PERFORMER_CHECKED_IN",
  "PARTICIPANT_CHECKED_OUT",
  "ZONE_REGISTERED",
  "CAPACITY_OBSERVED",
  "CROWD_COUNT_REPORTED",
  "ZONE_RESTRICTED",
  "ZONE_REOPENED",
  "TRANSIT_SCHEDULED",
  "TRANSIT_DEPARTURE_REPORTED",
  "TRANSIT_LAST_SERVICE_CHANGED",
  "SHUTTLE_SERVICE_ADDED",
  "ALERT_RAISED",
  "ALERT_UPDATED",
  "ALERT_CLEARED",
  "BOUNDARY_RULE_PUBLISHED",
  "BOUNDARY_MEASURED",
  "EVACUATION_PLAN_PUBLISHED",
  "EVACUATION_ACTIVATED",
  "EVACUATION_STOOD_DOWN",
  "INCIDENT_REPORTED",
  "INCIDENT_ACKNOWLEDGED",
  "INCIDENT_RESOLVED",
  "DECISION_MADE",
  "DECISION_REVISED",
  "DIRECTIVE_ISSUED",
  "DIRECTIVE_WITHDRAWN",
  "RESPONSE_OPENED",
  "RESPONSE_CLOSED",
  "COMPENSATION_OPENED",
  "COMPENSATION_SETTLED",
];

export const AGGREGATE_TYPES = [
  "night_program",
  "experience",
  "participant",
  "capacity_zone",
  "transit_service",
  "operational_alert",
  "site_boundary",
  "evacuation_plan",
  "field_incident",
  "operational_decision",
  "audience_directive",
  "joint_response",
  "compensation_case",
];

/** 事件类型只允许出现在对应的聚合上。 */
export const EVENT_AGGREGATE = {
  PROGRAM_CLEARED: "night_program",
  EXPERIENCE_REGISTERED: "experience",
  SESSION_SCHEDULED: "experience",
  TICKETS_REDEEMED: "experience",
  ROUTE_SHORTENED: "experience",
  SESSION_SUSPENDED: "experience",
  SESSION_CANCELLED: "experience",
  SESSION_RESUMED: "experience",
  VENDOR_CHECKED_IN: "participant",
  PERFORMER_CHECKED_IN: "participant",
  PARTICIPANT_CHECKED_OUT: "participant",
  ZONE_REGISTERED: "capacity_zone",
  CAPACITY_OBSERVED: "capacity_zone",
  CROWD_COUNT_REPORTED: "capacity_zone",
  ZONE_RESTRICTED: "capacity_zone",
  ZONE_REOPENED: "capacity_zone",
  TRANSIT_SCHEDULED: "transit_service",
  TRANSIT_DEPARTURE_REPORTED: "transit_service",
  TRANSIT_LAST_SERVICE_CHANGED: "transit_service",
  SHUTTLE_SERVICE_ADDED: "transit_service",
  ALERT_RAISED: "operational_alert",
  ALERT_UPDATED: "operational_alert",
  ALERT_CLEARED: "operational_alert",
  BOUNDARY_RULE_PUBLISHED: "site_boundary",
  BOUNDARY_MEASURED: "site_boundary",
  EVACUATION_PLAN_PUBLISHED: "evacuation_plan",
  EVACUATION_ACTIVATED: "evacuation_plan",
  EVACUATION_STOOD_DOWN: "evacuation_plan",
  INCIDENT_REPORTED: "field_incident",
  INCIDENT_ACKNOWLEDGED: "field_incident",
  INCIDENT_RESOLVED: "field_incident",
  DECISION_MADE: "operational_decision",
  DECISION_REVISED: "operational_decision",
  DIRECTIVE_ISSUED: "audience_directive",
  DIRECTIVE_WITHDRAWN: "audience_directive",
  RESPONSE_OPENED: "joint_response",
  RESPONSE_CLOSED: "joint_response",
  COMPENSATION_OPENED: "compensation_case",
  COMPENSATION_SETTLED: "compensation_case",
};

export const CROWD_READING_KINDS = ["gate_actual", "camera_estimate", "manual_count", "forecast"];
export const ALERT_CATEGORIES = [
  "weather_thunder",
  "weather_wind",
  "weather_other",
  "wildlife_sensitive_species",
  "fire_risk",
  "noise",
  "lighting",
  "crowd",
  "other",
];
export const FUNDING_SOURCES = ["insurance", "organizer", "venue_operator", "government_fiscal", "partner"];

/** 触发自然观察活动优先缩线/取消的风险类别。 */
export const NATURE_RISK_CATEGORIES = ["weather_thunder", "wildlife_sensitive_species", "fire_risk"];

const SEGMENT_ACTIONS = {
  onsite: ["shorten_route", "evacuate", "shelter", "divert", "stop_entry"],
  not_departed: ["hold_departure", "divert", "stop_entry"],
};

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 信封允许的全部顶层字段；业务数据必须放 payload。 */
const ALLOWED_TOP_LEVEL = new Set([
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "received_at",
  "version",
  "summary",
  "source_system",
  "idempotency_key",
  "correlation_id",
  "causation_id",
  "supersedes",
  "visibility",
  "payload",
]);

function isDateTime(value) {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

function requireFields(obj, fields, prefix = "") {
  const errors = [];
  for (const name of fields) {
    if (obj == null || typeof obj !== "object" || !(name in obj) || obj[name] === null) {
      errors.push(`缺少字段：${prefix}${name}`);
    }
  }
  return errors;
}

function validateCrowdReading(reading, path) {
  const errors = requireFields(reading, ["zone_id", "reading_kind", "coverage", "value"], `${path}.`);
  if (errors.length > 0) return errors;
  if (!CROWD_READING_KINDS.includes(reading.reading_kind)) {
    errors.push(`${path}.reading_kind 非法：${reading.reading_kind}`);
  }
  if (!Number.isInteger(reading.value) || reading.value < 0) {
    errors.push(`${path}.value 必须是非负整数（预测值也以人数整数给出，并在 reading_kind=forecast 标明）`);
  }
  errors.push(...requireFields(reading.coverage, ["scope", "description"], `${path}.coverage.`));
  const scopes = ["zone_entrance", "zone_full", "route_segment", "transit_boarding"];
  if (reading.coverage && !scopes.includes(reading.coverage.scope)) {
    errors.push(`${path}.coverage.scope 非法：${reading.coverage.scope}`);
  }
  if (reading.coverage?.window_start && !isDateTime(reading.coverage.window_start)) {
    errors.push(`${path}.coverage.window_start 必须是 date-time`);
  }
  if (reading.coverage?.window_end && !isDateTime(reading.coverage.window_end)) {
    errors.push(`${path}.coverage.window_end 必须是 date-time`);
  }
  // 真值标注硬约束：闸机实数必须能指到具体闸机；预测必须指向未来时刻。
  if (reading.reading_kind === "gate_actual" && !reading.gate_id) {
    errors.push(`${path}.reading_kind=gate_actual（闸机实数）必须提供 gate_id`);
  }
  if (reading.reading_kind === "forecast") {
    if (!reading.forecast_for || !isDateTime(reading.forecast_for)) {
      errors.push(`${path}.reading_kind=forecast（预测值）必须提供 forecast_for，预测不得伪装成闸机实数`);
    }
  } else if (reading.forecast_for) {
    errors.push(`${path}.reading_kind=${reading.reading_kind} 为实测/估算读数，不得携带 forecast_for`);
  }
  if (reading.confidence !== undefined && (typeof reading.confidence !== "number" || reading.confidence < 0 || reading.confidence > 1)) {
    errors.push(`${path}.confidence 必须在 0 到 1 之间`);
  }
  return errors;
}

function validateAudience(audience, path) {
  const errors = [];
  if (!Array.isArray(audience) || audience.length === 0) {
    return [`${path} 必须是非空数组：已入场与尚未出发人群需要分别收到指令`];
  }
  const seenSegments = new Set();
  for (const [i, item] of audience.entries()) {
    const itemPath = `${path}[${i}]`;
    errors.push(...requireFields(item, ["segment", "action", "message"], `${itemPath}.`));
    if (!SEGMENT_ACTIONS.onsite.includes(item.action) && !SEGMENT_ACTIONS.not_departed.includes(item.action)) {
      errors.push(`${itemPath}.action 非法：${item.action}`);
      continue;
    }
    if (item.segment !== "onsite" && item.segment !== "not_departed") {
      errors.push(`${itemPath}.segment 只能是 onsite 或 not_departed`);
      continue;
    }
    if (!SEGMENT_ACTIONS[item.segment].includes(item.action)) {
      errors.push(`${itemPath}.action=${item.action} 不适用于人群 ${item.segment}`);
    }
    if (typeof item.message !== "string" || item.message.trim().length === 0) {
      errors.push(`${itemPath}.message 必须写明该人群要执行的具体指令`);
    }
    if (seenSegments.has(item.segment)) {
      errors.push(`${itemPath}.segment=${item.segment} 重复：同一人群的多条要求应合并为一条指令`);
    }
    seenSegments.add(item.segment);
  }
  return errors;
}

/** 与已有日志状态无关的校验，返回中文错误信息数组（空数组表示通过）。 */
export function validateEvent(record) {
  const errors = requireFields(record, REQUIRED);
  if (errors.length > 0) return errors;

  if (!EVENT_TYPES.includes(record.event_type)) errors.push(`event_type 未登记：${record.event_type}`);
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`aggregate_type 未登记：${record.aggregate_type}`);
  if (EVENT_TYPES.includes(record.event_type) && EVENT_AGGREGATE[record.event_type] !== record.aggregate_type) {
    errors.push(
      `event_type=${record.event_type} 只能挂在 aggregate_type=${EVENT_AGGREGATE[record.event_type]} 下，收到的是 ${record.aggregate_type}`,
    );
  }
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) errors.push(`信封不允许顶层字段：${key}（业务数据请放入 payload）`);
  }
  if (!isDateTime(record.occurred_at)) errors.push("occurred_at 必须是 date-time");
  if (record.received_at !== undefined && !isDateTime(record.received_at)) errors.push("received_at 必须是 date-time");
  if (typeof record.source_system !== "string" || record.source_system.trim() === "") {
    errors.push("source_system 必须标明报送单位或系统");
  }
  if (record.visibility !== undefined) {
    if (record.visibility !== "joint_center" && !/^partner:[A-Za-z0-9_.-]+$/.test(record.visibility)) {
      errors.push("visibility 只能是 joint_center 或 partner:<单位标识>");
    }
  }

  const p = record.payload ?? {};
  if (record.payload !== undefined && (typeof p !== "object" || Array.isArray(p))) {
    errors.push("payload 必须是对象");
    return errors;
  }

  switch (record.event_type) {
    case "EXPERIENCE_REGISTERED":
      errors.push(...requireFields(p, ["experience_id", "name", "nature_observation"], "payload."));
      if (typeof p.nature_observation !== "boolean") errors.push("payload.nature_observation 必须是布尔值");
      break;
    case "SESSION_SCHEDULED":
      errors.push(...requireFields(p, ["session_id", "experience_id", "zone_ids", "starts_at", "ends_at"], "payload."));
      if (!Array.isArray(p.zone_ids) || p.zone_ids.length === 0) errors.push("payload.zone_ids 必须是非空数组");
      if (p.starts_at && !isDateTime(p.starts_at)) errors.push("payload.starts_at 必须是 date-time");
      if (p.ends_at && !isDateTime(p.ends_at)) errors.push("payload.ends_at 必须是 date-time");
      break;
    case "TICKETS_REDEEMED":
      errors.push(...requireFields(p, ["experience_id", "redemption_ids"], "payload."));
      if (!Array.isArray(p.redemption_ids) || p.redemption_ids.length === 0) {
        errors.push("payload.redemption_ids 必须是非空数组");
      }
      break;
    case "ROUTE_SHORTENED":
      errors.push(...requireFields(p, ["session_id", "experience_id", "dropped_waypoints", "reason_alert_ids"], "payload."));
      if (!Array.isArray(p.dropped_waypoints) || p.dropped_waypoints.length === 0) {
        errors.push("payload.dropped_waypoints 必须是非空数组（缩线撤下的观星点）");
      }
      if (!Array.isArray(p.reason_alert_ids) || p.reason_alert_ids.length === 0) {
        errors.push("payload.reason_alert_ids 必须是非空数组：缩线必须引用触发它的敏感物种/雷雨/消防告警");
      }
      break;
    case "SESSION_SUSPENDED":
    case "SESSION_CANCELLED":
      errors.push(...requireFields(p, ["session_id", "experience_id", "released_zone_ids", "reason"], "payload."));
      if (!Array.isArray(p.released_zone_ids) || p.released_zone_ids.length === 0) {
        errors.push("payload.released_zone_ids 必须是非空数组：停演/取消只释放这些分区，其他体验不受影响");
      }
      break;
    case "SESSION_RESUMED":
      errors.push(...requireFields(p, ["session_id", "experience_id"], "payload."));
      break;
    case "ZONE_REGISTERED":
      errors.push(...requireFields(p, ["zone_id", "name"], "payload."));
      if (p.capacity !== undefined && (!Number.isInteger(p.capacity) || p.capacity < 0)) {
        errors.push("payload.capacity 必须是非负整数");
      }
      break;
    case "CAPACITY_OBSERVED":
      errors.push(...requireFields(p, ["zone_id", "capacity_limit"], "payload."));
      if (!Number.isInteger(p.capacity_limit) || p.capacity_limit < 0) {
        errors.push("payload.capacity_limit 必须是非负整数");
      }
      break;
    case "CROWD_COUNT_REPORTED":
      errors.push(...validateCrowdReading(p, "payload"));
      break;
    case "ZONE_RESTRICTED":
      errors.push(...requireFields(p, ["zone_id", "restriction", "reason"], "payload."));
      if (p.restriction && !["stop_entry", "one_way_flow", "hold_and_release"].includes(p.restriction)) {
        errors.push("payload.restriction 只能是 stop_entry / one_way_flow / hold_and_release");
      }
      if (p.reason_event_ids !== undefined && !Array.isArray(p.reason_event_ids)) {
        errors.push("payload.reason_event_ids 必须是数组：限流措施应引用触发它的读数/事件");
      }
      break;
    case "TRANSIT_SCHEDULED":
      errors.push(...requireFields(p, ["service_id", "mode", "departures"], "payload."));
      if (Array.isArray(p.departures)) {
        for (const [i, d] of p.departures.entries()) {
          if (!isDateTime(d?.departs_at)) errors.push(`payload.departures[${i}].departs_at 必须是 date-time`);
        }
      }
      break;
    case "TRANSIT_LAST_SERVICE_CHANGED":
      errors.push(...requireFields(p, ["service_id", "last_departs_at", "reason"], "payload."));
      if (p.last_departs_at && !isDateTime(p.last_departs_at)) errors.push("payload.last_departs_at 必须是 date-time");
      break;
    case "TRANSIT_DEPARTURE_REPORTED":
      errors.push(...requireFields(p, ["service_id", "departs_at", "boarding_count"], "payload."));
      if (p.departs_at && !isDateTime(p.departs_at)) errors.push("payload.departs_at 必须是 date-time");
      break;
    case "SHUTTLE_SERVICE_ADDED":
      errors.push(...requireFields(p, ["service_id", "reason_event_ids", "departures"], "payload."));
      if (!Array.isArray(p.reason_event_ids) || p.reason_event_ids.length === 0) {
        errors.push("payload.reason_event_ids 必须是非空数组：增开接驳要引用触发它的拥堵/末班变化记录");
      }
      if (Array.isArray(p.departures)) {
        for (const [i, d] of p.departures.entries()) {
          if (!isDateTime(d?.departs_at)) errors.push(`payload.departures[${i}].departs_at 必须是 date-time`);
        }
      }
      break;
    case "ALERT_RAISED":
    case "ALERT_UPDATED":
      errors.push(...requireFields(p, ["alert_id", "category", "severity", "zone_ids"], "payload."));
      if (!ALERT_CATEGORIES.includes(p.category)) errors.push(`payload.category 未登记：${p.category}`);
      if (p.severity && !["advisory", "watch", "warning"].includes(p.severity)) {
        errors.push("payload.severity 只能是 advisory / watch / warning");
      }
      if (p.zone_ids !== undefined && (!Array.isArray(p.zone_ids) || p.zone_ids.length === 0)) {
        errors.push("payload.zone_ids 必须是非空数组：告警必须标明影响分区");
      }
      break;
    case "BOUNDARY_RULE_PUBLISHED":
      errors.push(...requireFields(p, ["zone_ids", "noise"], "payload."));
      if (p.noise) {
        errors.push(
          ...requireFields(p.noise, ["limit_db", "quiet_hours"], "payload.noise."),
        );
        if (Array.isArray(p.noise.quiet_hours)) {
          for (const [i, q] of p.noise.quiet_hours.entries()) {
            errors.push(...requireFields(q, ["start", "end"], `payload.noise.quiet_hours[${i}].`));
          }
        }
      }
      break;
    case "BOUNDARY_MEASURED":
      errors.push(...requireFields(p, ["zone_id", "measured_db"], "payload."));
      if (typeof p.measured_db !== "number") errors.push("payload.measured_db 必须是数值");
      break;
    case "EVACUATION_PLAN_PUBLISHED":
      errors.push(...requireFields(p, ["plan_id", "zone_ids", "routes"], "payload."));
      if (!Array.isArray(p.routes) || p.routes.length === 0) errors.push("payload.routes 必须是非空数组");
      break;
    case "EVACUATION_ACTIVATED":
      errors.push(...requireFields(p, ["plan_id", "zone_ids", "reason"], "payload."));
      if (!Array.isArray(p.zone_ids) || p.zone_ids.length === 0) errors.push("payload.zone_ids 必须是非空数组");
      break;
    case "INCIDENT_REPORTED":
      errors.push(...requireFields(p, ["incident_id", "category", "zone_id", "description"], "payload."));
      if (p.evidence_ids !== undefined && !Array.isArray(p.evidence_ids)) {
        errors.push("payload.evidence_ids 必须是数组：现场事件可引用支撑它的读数或告警记录");
      }
      break;
    case "DECISION_MADE":
    case "DECISION_REVISED":
      errors.push(...requireFields(p, ["decision_type", "rationale", "based_on"], "payload."));
      if (!Array.isArray(p.based_on) || p.based_on.length === 0) {
        errors.push("payload.based_on 必须是非空数组：每条决定都要能追溯到实际读数/告警/事件");
      }
      break;
    case "DIRECTIVE_ISSUED":
      if (p.based_on !== undefined && !Array.isArray(p.based_on)) errors.push("payload.based_on 必须是数组");
      errors.push(...validateAudience(p.audience, "payload.audience"));
      break;
    case "COMPENSATION_OPENED":
    case "COMPENSATION_SETTLED":
      errors.push(...requireFields(p, ["case_id", "experience_id", "responsibility", "funding_source"], "payload."));
      if (p.responsibility) {
        errors.push(...requireFields(p.responsibility, ["party", "basis"], "payload.responsibility."));
        if (
          p.responsibility.share !== undefined &&
          (typeof p.responsibility.share !== "number" || p.responsibility.share < 0 || p.responsibility.share > 1)
        ) {
          errors.push("payload.responsibility.share 必须在 0 到 1 之间");
        }
      }
      if (p.funding_source && !FUNDING_SOURCES.includes(p.funding_source)) {
        errors.push(`payload.funding_source 未登记：${p.funding_source}`);
      }
      if (p.covered_redemption_ids !== undefined && !Array.isArray(p.covered_redemption_ids)) {
        errors.push("payload.covered_redemption_ids 必须是数组");
      }
      if (record.event_type === "COMPENSATION_SETTLED") {
        errors.push(...requireFields(p, ["amount"], "payload."));
      }
      break;
    default:
      break;
  }

  return errors;
}

/** 计算用于跨单位重复上报识别的载荷指纹（不含报送单位、接收时间等信封字段）。 */
export function fingerprint(record) {
  const core = {
    event_type: record.event_type,
    aggregate_type: record.aggregate_type,
    aggregate_id: record.aggregate_id,
    occurred_at: record.occurred_at,
    version: record.version,
    payload: record.payload ?? null,
  };
  return stableStringify(core);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
