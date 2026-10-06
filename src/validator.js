/** 夜游联合运行中心领域事件校验：信封、口径与处置约定。 */

export const EVENT_TYPES = [
  "PERMIT_GRANTED",
  "PROGRAM_CLEARED",
  "SERVICE_CHANGED",
  "ROSTER_CHECKED_IN",
  "BOUNDARY_SET",
  "CAPACITY_OBSERVED",
  "CROWD_COUNTED",
  "PLAN_PUBLISHED",
  "ALERT_RAISED",
  "INCIDENT_REPORTED",
  "ITINERARY_INVALIDATED",
  "ZONE_RESTRICTED",
  "FLOW_THROTTLED",
  "SHUTTLE_ADDED",
  "ROUTE_SHORTENED",
  "PROGRAM_CANCELLED",
  "PERFORMANCE_SUSPENDED",
  "CAPACITY_RELEASED",
  "COMPENSATION_RECORDED",
  "DIRECTIVE_ISSUED",
  "RESPONSE_CLOSED"
];

export const AGGREGATE_TYPES = [
  "night_program",
  "capacity_zone",
  "transport_service",
  "participant_roster",
  "environment_boundary",
  "crowd_measurement",
  "evacuation_plan",
  "operational_alert",
  "site_incident",
  "visitor_itinerary",
  "joint_response",
  "compensation_case"
];

const COVERAGE_SCOPES = ["entrance_only", "zone_partial", "zone_full", "route_segment"];
const CROWD_DATA_KINDS = ["turnstile_actual", "sensor_estimate", "manual_count", "forecast"];
const ALERT_KINDS = ["weather_thunderstorm", "weather_gale", "fire_risk", "ecology_sensitive_species", "noise_breach", "other"];
const ROSTER_ROLES = ["merchant", "performer", "staff"];
const AUDIENCE_SEGMENTS = ["entered", "not_departed", "all"];
const SERVICE_KINDS = ["metro", "shuttle", "bus"];
const BOUNDARY_KINDS = ["lighting", "noise"];

/** 处置决策：必须给出实际依据，供事后复盘归因。 */
const DECISION_EVENTS = ["ZONE_RESTRICTED", "FLOW_THROTTLED", "SHUTTLE_ADDED", "ROUTE_SHORTENED", "PROGRAM_CANCELLED", "PERFORMANCE_SUSPENDED"];
/** 由各单位上报的事件：必须携带上报方与其编号，用于重复上报去重。 */
const REPORTED_EVENTS = ["INCIDENT_REPORTED", "ROSTER_CHECKED_IN", "CROWD_COUNTED", "ALERT_RAISED"];
/** 自然观察类活动遇告警时的优先动作：必须引用触发的告警。 */
const ALERT_DRIVEN_EVENTS = ["ROUTE_SHORTENED", "PROGRAM_CANCELLED"];

const REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function validateEvent(record) {
  const errors = REQUIRED.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`未知聚合类型：${record.aggregate_type}`);

  if (REPORTED_EVENTS.includes(record.event_type)) {
    if (!isNonEmptyString(record.reported_by)) errors.push("缺少字段：reported_by（上报单位）");
    if (!isNonEmptyString(record.report_key)) errors.push("缺少字段：report_key（上报编号）");
  }

  if (DECISION_EVENTS.includes(record.event_type)) {
    const basis = record.basis_event_ids;
    if (!Array.isArray(basis) || basis.length === 0 || !basis.every(isNonEmptyString)) {
      errors.push("决策事件必须在 basis_event_ids 中给出实际依据");
    }
  }

  if (record.visibility !== undefined && !["operations", "partner"].includes(record.visibility)) {
    errors.push(`未知可见范围：${record.visibility}`);
  }
  if (record.visibility === "partner" && !isNonEmptyString(record.partner_id)) {
    errors.push("visibility 为 partner 时必须给出 partner_id");
  }

  const payload = record.payload ?? {};
  switch (record.event_type) {
    case "PERMIT_GRANTED":
      if (!isNonEmptyString(payload.permit_id)) errors.push("活动许可必须给出 payload.permit_id");
      break;
    case "SERVICE_CHANGED":
      if (!SERVICE_KINDS.includes(payload.service_kind)) errors.push("交通班次必须给出 payload.service_kind（metro/shuttle/bus）");
      break;
    case "ROSTER_CHECKED_IN":
      if (!ROSTER_ROLES.includes(payload.role)) errors.push("报到必须给出 payload.role（merchant/performer/staff）");
      if (!Number.isInteger(payload.count) || payload.count < 0) errors.push("报到人数 payload.count 必须是非负整数");
      break;
    case "BOUNDARY_SET":
      if (!BOUNDARY_KINDS.includes(payload.boundary_kind)) errors.push("边界必须给出 payload.boundary_kind（lighting/noise）");
      break;
    case "CROWD_COUNTED":
      if (!COVERAGE_SCOPES.includes(payload.coverage_scope)) errors.push("客流数据必须标明覆盖范围 payload.coverage_scope");
      if (!CROWD_DATA_KINDS.includes(payload.data_kind)) errors.push("客流数据必须标明口径 payload.data_kind");
      if (payload.data_kind === "turnstile_actual" && !isNonEmptyString(payload.source_device)) {
        errors.push("闸机实数必须给出 payload.source_device");
      }
      if (payload.data_kind === "forecast") {
        if (!isNonEmptyString(payload.model_ref) || !isNonEmptyString(payload.valid_until)) {
          errors.push("预测值必须给出 payload.model_ref 与 payload.valid_until");
        }
        if ("source_device" in payload) errors.push("预测值不得携带闸机设备号，不能伪装成闸机实数");
      }
      break;
    case "PLAN_PUBLISHED":
      if (!isNonEmptyString(payload.plan_version)) errors.push("疏散预案必须给出 payload.plan_version");
      break;
    case "ALERT_RAISED":
      if (!ALERT_KINDS.includes(payload.alert_kind)) errors.push("告警必须给出 payload.alert_kind");
      break;
    case "ITINERARY_INVALIDATED":
      if (!isNonEmptyString(payload.cause_event_id)) errors.push("行程失效必须给出 payload.cause_event_id");
      break;
    case "ROUTE_SHORTENED":
    case "PROGRAM_CANCELLED":
      if (ALERT_DRIVEN_EVENTS.includes(record.event_type) && !isNonEmptyString(payload.trigger_alert_id)) {
        errors.push("缩线或取消必须引用触发的告警 payload.trigger_alert_id");
      }
      break;
    case "PERFORMANCE_SUSPENDED":
      if (!isNonEmptyString(payload.zone_id)) errors.push("临时停演必须给出 payload.zone_id");
      if (!Number.isInteger(payload.capacity_released) || payload.capacity_released < 0) {
        errors.push("临时停演必须给出释放容量 payload.capacity_released");
      }
      if ("revoked_experience_ids" in payload) errors.push("临时停演只释放对应区域容量，不得连带撤销已核销的其他体验");
      break;
    case "CAPACITY_RELEASED":
      if (!isNonEmptyString(payload.zone_id) || !isNonEmptyString(payload.released_by_event_id)) {
        errors.push("容量释放必须给出 payload.zone_id 与 payload.released_by_event_id");
      }
      break;
    case "COMPENSATION_RECORDED":
      if (!isNonEmptyString(payload.responsibility_party)) errors.push("补偿必须按责任方记录 payload.responsibility_party");
      if (!isNonEmptyString(payload.funding_source)) errors.push("补偿必须按资金来源记录 payload.funding_source");
      if (!isNonEmptyString(payload.cause_event_id)) errors.push("补偿必须关联成因事件 payload.cause_event_id");
      break;
    case "DIRECTIVE_ISSUED":
      if (!AUDIENCE_SEGMENTS.includes(payload.audience_segment)) {
        errors.push("对客指令必须区分人群 payload.audience_segment（entered/not_departed/all）");
      }
      if (!isNonEmptyString(payload.instruction)) errors.push("对客指令必须给出 payload.instruction");
      break;
    default:
      break;
  }
  return errors;
}

/** 重复上报去重：同一（上报单位, 上报编号）组合重复到达时只接收首条。 */
export function deduplicateReports(records) {
  const seen = new Set();
  const accepted = [];
  const duplicates = [];
  for (const record of records) {
    const key =
      isNonEmptyString(record.reported_by) && isNonEmptyString(record.report_key)
        ? `${record.reported_by}#${record.report_key}`
        : null;
    if (key && seen.has(key)) {
      duplicates.push(record);
      continue;
    }
    if (key) seen.add(key);
    accepted.push(record);
  }
  return { accepted, duplicates };
}
