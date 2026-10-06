/**
 * 夜游联合运行中心领域事件目录。
 *
 * 记录一经接收，event_id / occurred_at / version 不得原地改写；
 * 更正或补充只能提交 supersedes 指向原记录的后继记录（version 更大）。
 * 各单位重复上报同一客观事实时复用 idempotency_key。
 */

export type Visibility = "joint_center" | `partner:${string}`;

/** 事件信封，所有跨单位记录共用。 */
export interface DomainEvent<TPayload = unknown> {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  /** 事实实际发生时间，接收后不可改写。 */
  occurred_at: string;
  /** 联合运行中心接收时间。 */
  received_at?: string;
  version: number;
  summary: string;
  /** 报送单位或系统标识，如 metro-ops、duty-room、gate-g1。 */
  source_system: string;
  /** 同一客观事实的自然键；跨单位重复上报复用此键。 */
  idempotency_key?: string;
  /** 处置链路关联标识，复盘按此串联。 */
  correlation_id?: string;
  /** 触发本记录的上游记录 event_id。 */
  causation_id?: string;
  /** 本记录更正/替代的原记录 event_id（同一聚合）。 */
  supersedes?: string;
  visibility?: Visibility;
  payload?: TPayload;
}

export type EventType =
  // 活动许可与体验场次
  | "PROGRAM_CLEARED"
  | "EXPERIENCE_REGISTERED"
  | "SESSION_SCHEDULED"
  | "TICKETS_REDEEMED"
  | "ROUTE_SHORTENED"
  | "SESSION_SUSPENDED"
  | "SESSION_CANCELLED"
  | "SESSION_RESUMED"
  // 商户与演职人员
  | "VENDOR_CHECKED_IN"
  | "PERFORMER_CHECKED_IN"
  | "PARTICIPANT_CHECKED_OUT"
  // 分区容量与限流
  | "ZONE_REGISTERED"
  | "CAPACITY_OBSERVED"
  | "CROWD_COUNT_REPORTED"
  | "ZONE_RESTRICTED"
  | "ZONE_REOPENED"
  // 交通接驳
  | "TRANSIT_SCHEDULED"
  | "TRANSIT_DEPARTURE_REPORTED"
  | "TRANSIT_LAST_SERVICE_CHANGED"
  | "SHUTTLE_SERVICE_ADDED"
  // 气象、生态、照明与噪声边界
  | "ALERT_RAISED"
  | "ALERT_UPDATED"
  | "ALERT_CLEARED"
  | "BOUNDARY_RULE_PUBLISHED"
  | "BOUNDARY_MEASURED"
  // 疏散
  | "EVACUATION_PLAN_PUBLISHED"
  | "EVACUATION_ACTIVATED"
  | "EVACUATION_STOOD_DOWN"
  // 现场事件
  | "INCIDENT_REPORTED"
  | "INCIDENT_ACKNOWLEDGED"
  | "INCIDENT_RESOLVED"
  // 决策与分群指令
  | "DECISION_MADE"
  | "DECISION_REVISED"
  | "DIRECTIVE_ISSUED"
  | "DIRECTIVE_WITHDRAWN"
  // 联合处置与补偿
  | "RESPONSE_OPENED"
  | "RESPONSE_CLOSED"
  | "COMPENSATION_OPENED"
  | "COMPENSATION_SETTLED";

export type AggregateType =
  | "night_program"
  | "experience"
  | "participant"
  | "capacity_zone"
  | "transit_service"
  | "operational_alert"
  | "site_boundary"
  | "evacuation_plan"
  | "field_incident"
  | "operational_decision"
  | "audience_directive"
  | "joint_response"
  | "compensation_case";

/**
 * 客流读数性质：
 * - gate_actual 闸机实数（必须带 gate_id，是唯一可作为“实数”展示的读数）
 * - camera_estimate 摄像头估算
 * - manual_count 人工计数
 * - forecast 预测值（必须带 forecast_for），禁止在视图中与闸机实数混排为实数
 */
export type CrowdReadingKind = "gate_actual" | "camera_estimate" | "manual_count" | "forecast";

export interface CrowdCoverage {
  scope: "zone_entrance" | "zone_full" | "route_segment" | "transit_boarding";
  /** 覆盖范围中文说明，例如“博物馆东入口闸机，不含西侧无障碍通道”。 */
  description: string;
  window_start?: string;
  window_end?: string;
}

export interface CrowdReading {
  zone_id: string;
  reading_kind: CrowdReadingKind;
  coverage: CrowdCoverage;
  value: number;
  gate_id?: string;
  captured_at?: string;
  /** reading_kind=forecast 时必填：预测指向的未来时刻。 */
  forecast_for?: string;
  confidence?: number;
}

/** 告警类别：weather_thunder 雷雨、weather_wind 大风、wildlife 敏感物种、fire 消防、noise 噪声越界等。 */
export type AlertCategory =
  | "weather_thunder"
  | "weather_wind"
  | "weather_other"
  | "wildlife_sensitive_species"
  | "fire_risk"
  | "noise"
  | "lighting"
  | "crowd"
  | "other";

export type AlertSeverity = "advisory" | "watch" | "warning";

/**
 * 自然观察活动（山野观星等）的处置优先级：
 * 出现敏感物种、雷雨或消防风险时，优先缩线（ROUTE_SHORTENED）或取消（SESSION_CANCELLED），
 * 不得仅以限流/排队掩盖风险。
 */
export type NatureRiskCategory = "weather_thunder" | "wildlife_sensitive_species" | "fire_risk";

/** 指令面向人群：已入场与尚未出发收到不同指令。 */
export type AudienceSegment = "onsite" | "not_departed";

export type DirectiveAction =
  | "hold_departure" // 尚未出发：暂缓出发/改约
  | "shorten_route" // 已入场：按缩线路径返回
  | "evacuate" // 已入场：按疏散预案撤离
  | "shelter" // 已入场：就近避险
  | "divert" // 分流至其他体验/接驳
  | "stop_entry"; // 停止检票入场

/** 补偿资金来源，与责任方分别记录。 */
export type FundingSource =
  | "insurance"
  | "organizer"
  | "venue_operator"
  | "government_fiscal"
  | "partner";

export interface CompensationPayload {
  experience_id: string;
  responsibility: {
    party: string;
    basis: string;
    /** 多方分担时的比例，单方责任为 1。 */
    share?: number;
  };
  funding_source: FundingSource;
  amount?: number;
  /** 仅限本体验已核销票，临时停演不得把其他体验的核销纳入同一补偿案。 */
  covered_redemption_ids?: string[];
}

/** 值班视图中的分区状态（由事件投影得出）。 */
export interface ZoneStatus {
  zone_id: string;
  name: string;
  capacity?: number;
  actual_onsite?: number;
  actual_coverage?: CrowdCoverage;
  latest_estimates?: Array<Pick<CrowdReading, "reading_kind" | "value" | "coverage" | "confidence">>;
  forecasts?: Array<{ forecast_for: string; value: number; confidence?: number }>;
  restricted?: boolean;
  active_alerts?: Array<{ alert_id: string; category: AlertCategory; severity: AlertSeverity }>;
}
