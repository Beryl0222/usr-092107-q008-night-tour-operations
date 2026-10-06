/** 夜游联合运行中心使用的领域事件信封与 payload 约定。 */

export type EventType =
  | "PERMIT_GRANTED"
  | "PROGRAM_CLEARED"
  | "SERVICE_CHANGED"
  | "ROSTER_CHECKED_IN"
  | "BOUNDARY_SET"
  | "CAPACITY_OBSERVED"
  | "CROWD_COUNTED"
  | "PLAN_PUBLISHED"
  | "ALERT_RAISED"
  | "INCIDENT_REPORTED"
  | "ITINERARY_INVALIDATED"
  | "ZONE_RESTRICTED"
  | "FLOW_THROTTLED"
  | "SHUTTLE_ADDED"
  | "ROUTE_SHORTENED"
  | "PROGRAM_CANCELLED"
  | "PERFORMANCE_SUSPENDED"
  | "CAPACITY_RELEASED"
  | "COMPENSATION_RECORDED"
  | "DIRECTIVE_ISSUED"
  | "RESPONSE_CLOSED";

export type AggregateType =
  | "night_program"
  | "capacity_zone"
  | "transport_service"
  | "participant_roster"
  | "environment_boundary"
  | "crowd_measurement"
  | "evacuation_plan"
  | "operational_alert"
  | "site_incident"
  | "visitor_itinerary"
  | "joint_response"
  | "compensation_case";

/** 客流数据覆盖范围，不同来源不得混用。 */
export type CoverageScope = "entrance_only" | "zone_partial" | "zone_full" | "route_segment";
/** 客流数据口径：闸机实数 / 设备估算 / 人工点数 / 模型预测。 */
export type CrowdDataKind = "turnstile_actual" | "sensor_estimate" | "manual_count" | "forecast";
/** 对客指令的人群分段：已入场 / 尚未出发 / 全部。 */
export type AudienceSegment = "entered" | "not_departed" | "all";

export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 上报单位标识；单位上报类事件必填，与 report_key 组合用于重复上报去重。 */
  reported_by?: string;
  /** 上报方侧唯一编号，同一上报单位内不得复用。 */
  report_key?: string;
  /** 可见范围：operations 仅值班室运行视图；partner 可投给 partner_id 指定的合作方。 */
  visibility?: "operations" | "partner";
  /** visibility 为 partner 时必填。 */
  partner_id?: string;
  /** 决策类事件必填：处置所依据的实际事件，供事后复盘归因。 */
  basis_event_ids?: string[];
  payload?: Record<string, unknown>;
}

/** CROWD_COUNTED 的 payload：闸机实数必须携带 source_device；预测值不得携带。 */
export interface CrowdCountPayload {
  coverage_scope: CoverageScope;
  data_kind: CrowdDataKind;
  count: number;
  source_device?: string;
  model_ref?: string;
  valid_until?: string;
}

/** PERFORMANCE_SUSPENDED 的 payload：只释放对应区域容量，不得出现 revoked_experience_ids。 */
export interface PerformanceSuspendedPayload {
  zone_id: string;
  capacity_released: number;
  program_id?: string;
}

/** COMPENSATION_RECORDED 的 payload：责任与资金来源分别记录。 */
export interface CompensationPayload {
  responsibility_party: string;
  funding_source: string;
  cause_event_id: string;
}

/** DIRECTIVE_ISSUED 的 payload：已入场与尚未出发人群使用不同指令。 */
export interface DirectivePayload {
  audience_segment: AudienceSegment;
  instruction: string;
}
