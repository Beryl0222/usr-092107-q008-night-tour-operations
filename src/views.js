/**
 * 只读投影：值班运行视图、合作方视图、事后复盘血缘。
 * 所有结论都引用支撑它的事件 event_id，便于复盘说明"由哪些实际决定造成"。
 */

import { NATURE_RISK_CATEGORIES } from "./validator.js";

function canonicalEvents(log) {
  return log.events();
}

/** 被后继记录替代的原记录集合（投影取值时视为过期）。 */
function staleIds(events) {
  const ids = new Set();
  for (const e of events) if (e.supersedes) ids.add(e.supersedes);
  return ids;
}

function latestBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    const prev = map.get(key);
    if (!prev || item.occurred_at >= prev.occurred_at) map.set(key, item);
  }
  return map;
}

function activeAlerts(events) {
  const byId = new Map();
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.event_type === "ALERT_RAISED" || e.event_type === "ALERT_UPDATED") {
      byId.set(p.alert_id, { ...(byId.get(p.alert_id) ?? {}), event_id: e.event_id, ...p, status: "active" });
    } else if (e.event_type === "ALERT_CLEARED") {
      const existing = byId.get(p.alert_id);
      if (existing) existing.status = "cleared";
    }
  }
  return [...byId.values()];
}

function projectZones(events, alerts) {
  const zones = new Map();
  const ensure = (zoneId) => {
    if (!zones.has(zoneId)) zones.set(zoneId, { zone_id: zoneId, name: zoneId });
    return zones.get(zoneId);
  };

  for (const e of events) {
    const p = e.payload ?? {};
    if (e.event_type === "ZONE_REGISTERED") {
      const z = ensure(p.zone_id);
      z.name = p.name;
      if (p.capacity !== undefined) z.capacity = p.capacity;
    } else if (e.event_type === "CAPACITY_OBSERVED") {
      ensure(p.zone_id).capacity_limit = p.capacity_limit;
    } else if (e.event_type === "ZONE_RESTRICTED") {
      const z = ensure(p.zone_id);
      z.restricted = true;
      z.restriction = p.restriction;
      z.restriction_event_id = e.event_id;
    } else if (e.event_type === "ZONE_REOPENED") {
      const z = ensure(p.zone_id);
      z.restricted = false;
      z.restriction = undefined;
      z.restriction_event_id = undefined;
    } else if (e.event_type === "CROWD_COUNT_REPORTED") {
      ensure(p.zone_id);
    }
  }

  const crowd = events
    .filter((e) => e.event_type === "CROWD_COUNT_REPORTED")
    .map((e) => ({ ...e.payload, event_id: e.event_id, at: e.occurred_at, occurred_at: e.occurred_at }));
  for (const z of zones.values()) {
    const inZone = crowd.filter((c) => c.zone_id === z.zone_id);
    const gates = latestBy(
      inZone.filter((c) => c.reading_kind === "gate_actual"),
      (c) => c.gate_id,
    );
    const gateReadings = [...gates.values()];
    if (gateReadings.length > 0) {
      // 闸机实数：逐闸机展示并合计，coverage 说明各闸机覆盖了哪些入口。
      z.gate_actual = {
        value: gateReadings.reduce((sum, c) => sum + c.value, 0),
        gate_count: gateReadings.length,
        coverage: gateReadings.map((c) => ({ gate_id: c.gate_id, description: c.coverage.description })),
        captured_at: gateReadings.map((c) => c.captured_at).sort().at(-1),
        based_on: gateReadings.map((c) => c.event_id),
      };
    }
    z.estimates = inZone
      .filter((c) => c.reading_kind === "camera_estimate" || c.reading_kind === "manual_count")
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((c) => ({
        reading_kind: c.reading_kind,
        value: c.value,
        confidence: c.confidence,
        coverage: c.coverage,
        based_on: c.event_id,
      }));
    // 预测单列，绝不与闸机实数混排。
    z.forecasts = inZone
      .filter((c) => c.reading_kind === "forecast")
      .map((c) => ({
        forecast_for: c.forecast_for,
        value: c.value,
        confidence: c.confidence,
        coverage: c.coverage.description,
        based_on: c.event_id,
      }));
    const limit = z.capacity_limit ?? z.capacity;
    if (z.gate_actual && limit !== undefined) {
      z.load_ratio = Number((z.gate_actual.value / Math.max(limit, 1)).toFixed(2));
    }
    z.active_alerts = alerts.filter((a) => a.status === "active" && a.zone_ids.includes(z.zone_id)).map((a) => ({
      alert_id: a.alert_id,
      category: a.category,
      severity: a.severity,
      based_on: a.event_id,
    }));
  }
  return [...zones.values()];
}

function projectSessions(events) {
  const sessions = new Map();
  const experienceNature = new Map();
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.event_type === "EXPERIENCE_REGISTERED") {
      experienceNature.set(p.experience_id, p.nature_observation === true);
    }
    if (e.event_type === "SESSION_SCHEDULED") {
      sessions.set(p.session_id, {
        session_id: p.session_id,
        experience_id: p.experience_id,
        zone_ids: [...p.zone_ids],
        starts_at: p.starts_at,
        ends_at: p.ends_at,
        status: "scheduled",
        lifecycle: [{ type: "scheduled", event_id: e.event_id, at: e.occurred_at }],
      });
    }
    const s = p.session_id ? sessions.get(p.session_id) : undefined;
    if (!s) continue;
    if (e.event_type === "ROUTE_SHORTENED") {
      s.status = "shortened";
      s.dropped_waypoints = p.dropped_waypoints;
      s.lifecycle.push({ type: "shortened", event_id: e.event_id, at: e.occurred_at, reason_alert_ids: p.reason_alert_ids });
    } else if (e.event_type === "SESSION_SUSPENDED") {
      s.status = "suspended";
      s.released_zone_ids = p.released_zone_ids;
      s.lifecycle.push({ type: "suspended", event_id: e.event_id, at: e.occurred_at });
    } else if (e.event_type === "SESSION_CANCELLED") {
      s.status = "cancelled";
      s.released_zone_ids = p.released_zone_ids;
      s.lifecycle.push({ type: "cancelled", event_id: e.event_id, at: e.occurred_at });
    } else if (e.event_type === "SESSION_RESUMED") {
      s.status = "active";
      s.lifecycle.push({ type: "resumed", event_id: e.event_id, at: e.occurred_at });
    }
  }
  for (const s of sessions.values()) s.nature_observation = experienceNature.get(s.experience_id) === true;
  return [...sessions.values()];
}

function projectTransit(events) {
  const services = new Map();
  const ensure = (id) => {
    if (!services.has(id)) services.set(id, { service_id: id, departures: [], reported_departures: [], shuttle_additions: [] });
    return services.get(id);
  };
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.event_type === "TRANSIT_SCHEDULED") {
      const s = ensure(p.service_id);
      s.mode = p.mode ?? s.mode;
      if (p.operator_id) s.operator_id = p.operator_id;
      s.departures.push(...(p.departures ?? []));
    } else if (e.event_type === "TRANSIT_DEPARTURE_REPORTED") {
      ensure(p.service_id).reported_departures.push({ ...p, based_on: e.event_id });
    } else if (e.event_type === "TRANSIT_LAST_SERVICE_CHANGED") {
      const s = ensure(p.service_id);
      s.last_departs_at = p.last_departs_at;
      s.last_service_reason = p.reason;
      s.last_service_event_id = e.event_id;
    } else if (e.event_type === "SHUTTLE_SERVICE_ADDED") {
      const s = ensure(p.service_id);
      s.shuttle_additions.push({ ...p, based_on: e.event_id });
      s.departures.push(...(p.departures ?? []).map((d) => ({ ...d, shuttle: true })));
    }
  }
  return [...services.values()];
}

function projectIncidents(events) {
  const byId = new Map();
  for (const e of events) {
    const p = e.payload ?? {};
    if (!p.incident_id) continue;
    const status = { reported: "open", acknowledged: "acknowledged", resolved: "resolved" }[
      e.event_type.replace("INCIDENT_", "").toLowerCase()
    ];
    byId.set(p.incident_id, {
      incident_id: p.incident_id,
      category: p.category,
      zone_id: p.zone_id,
      description: p.description,
      status,
      event_id: e.event_id,
      correlation_id: e.correlation_id,
    });
  }
  return [...byId.values()];
}

function projectDecisions(events) {
  return events
    .filter((e) => e.event_type === "DECISION_MADE" || e.event_type === "DECISION_REVISED")
    .map((e) => ({
      decision_id: e.aggregate_id,
      type: e.payload.decision_type,
      rationale: e.payload.rationale,
      based_on: e.payload.based_on,
      revised: e.event_type === "DECISION_REVISED",
      event_id: e.event_id,
      at: e.occurred_at,
    }));
}

function projectDirectives(events) {
  const byAggregate = new Map();
  for (const e of events) {
    if (e.event_type !== "DIRECTIVE_ISSUED" && e.event_type !== "DIRECTIVE_WITHDRAWN") continue;
    const cur = byAggregate.get(e.aggregate_id) ?? { directive_id: e.aggregate_id, status: "issued" };
    if (e.event_type === "DIRECTIVE_ISSUED") {
      Object.assign(cur, {
        audience: e.payload.audience,
        based_on: e.payload.based_on ?? [],
        requires_action_from: e.payload.requires_action_from ?? [],
        event_id: e.event_id,
        at: e.occurred_at,
        correlation_id: e.correlation_id,
        status: "issued",
      });
    } else {
      cur.status = "withdrawn";
      cur.withdrawn_event_id = e.event_id;
    }
    byAggregate.set(e.aggregate_id, cur);
  }
  return [...byAggregate.values()];
}

function projectCompensations(events) {
  const byId = new Map();
  for (const e of events) {
    const p = e.payload ?? {};
    if (!p.case_id) continue;
    const cur = byId.get(p.case_id) ?? { case_id: p.case_id };
    Object.assign(cur, {
      experience_id: p.experience_id,
      responsibility: p.responsibility,
      funding_source: p.funding_source,
      amount: p.amount ?? cur.amount,
      covered_redemption_ids: p.covered_redemption_ids ?? cur.covered_redemption_ids,
      status: e.event_type === "COMPENSATION_SETTLED" ? "settled" : "opened",
      event_id: e.event_id,
    });
    byId.set(p.case_id, cur);
  }
  return [...byId.values()];
}

/**
 * 值班一张运行视图：分区实况（闸机实数/估算/预测分列）、告警、场次、交通、
 * 事件、决策、指令与补偿；recommendations 中每条建议都给出依据事件。
 *
 * @param {object} log 事件日志
 * @param {{asOf?: string}} [opts] asOf 只投影该时刻之前（含）的记录，用于还原值班现场当时所见
 */
export function operationsView(log, { asOf } = {}) {
  const all = canonicalEvents(log);
  const within = asOf ? all.filter((e) => e.occurred_at <= asOf) : all;
  // asOf 还原：后继记录尚未到达时，原记录在当时仍是有效数据。
  const fresh = within.filter((e) => !staleIds(within).has(e.event_id));
  fresh.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const alerts = activeAlerts(fresh);
  const zones = projectZones(fresh, alerts);
  const sessions = projectSessions(fresh);
  const transit = projectTransit(fresh);
  const incidents = projectIncidents(fresh);
  const decisions = projectDecisions(fresh);
  const directives = projectDirectives(fresh);
  const compensations = projectCompensations(fresh);

  const recommendations = [];
  // 限流：闸机实数达到容量上限（只采信 gate_actual，不采信预测/估算做强制依据）。
  for (const z of zones) {
    const limit = z.capacity_limit ?? z.capacity;
    if (z.gate_actual && limit !== undefined && z.gate_actual.value >= limit && !z.restricted) {
      recommendations.push({
        type: "restrict_entry",
        zone_id: z.zone_id,
        reason: `闸机实数 ${z.gate_actual.value} 已达容量上限 ${limit}`,
        based_on: z.gate_actual.based_on,
      });
    }
  }
  // 增开接驳：实际发车的上车人数达到计划运力。
  for (const s of transit) {
    for (const dep of s.reported_departures) {
      const planned = s.departures.find((d) => d.departs_at === dep.departs_at);
      const capacity = planned?.capacity ?? s.capacity;
      if (capacity !== undefined && dep.boarding_count >= capacity) {
        recommendations.push({
          type: "add_shuttle",
          service_id: s.service_id,
          reason: `${dep.departs_at} 实际上车 ${dep.boarding_count} 人，达到计划运力 ${capacity}`,
          based_on: [dep.based_on],
        });
      }
    }
  }
  // 自然观察优先处置：敏感物种、雷雨或消防告警覆盖观星/山野场次且尚未缩线或取消。
  const natureRisk = alerts.filter((a) => a.status === "active" && NATURE_RISK_CATEGORIES.includes(a.category));
  for (const session of sessions) {
    if (!session.nature_observation || ["shortened", "cancelled"].includes(session.status)) continue;
    const hit = natureRisk.find((a) => a.zone_ids.some((zid) => session.zone_ids.includes(zid)));
    if (hit) {
      recommendations.push({
        type: "shorten_or_cancel_nature_session",
        session_id: session.session_id,
        experience_id: session.experience_id,
        reason: `自然观察场次处于${hit.category} 告警（${hit.severity}）影响分区，优先缩线或取消，不得仅以限流应对`,
        based_on: [hit.event_id],
      });
    }
  }

  return {
    generated_from: fresh.length,
    zones,
    active_alerts: alerts.filter((a) => a.status === "active"),
    sessions,
    transit,
    incidents,
    decisions,
    directives: directives.filter((d) => d.status === "issued"),
    compensations,
    recommendations,
  };
}

/**
 * 合作方视图：只返回其自有资源与点名要求其处置的指令。
 * 自有 = 本方报送、登记为 operator_id、补偿责任方，或 visibility 明确点名 partner:<id>。
 */
export function partnerView(log, partnerId) {
  const events = canonicalEvents(log);
  const ownedExperience = new Set();
  const ownedService = new Set();
  for (const e of events) {
    if (e.event_type === "EXPERIENCE_REGISTERED" && e.payload?.operator_id === partnerId) {
      ownedExperience.add(e.payload.experience_id);
    }
    if (e.event_type === "TRANSIT_SCHEDULED" && e.payload?.operator_id === partnerId) {
      ownedService.add(e.payload.service_id);
    }
  }
  // 本方自己报送的交通服务也算自有资源。
  for (const e of events) {
    if (e.source_system === partnerId && e.payload?.service_id) ownedService.add(e.payload.service_id);
  }

  const ownsExperience = (experienceId) => ownedExperience.has(experienceId);
  const visible = events.filter((e) => {
    const p = e.payload ?? {};
    if (e.source_system === partnerId) return true;
    if (e.visibility === `partner:${partnerId}`) return true;
    if (p.operator_id === partnerId) return true;
    if (p.responsibility?.party === partnerId) return true;
    if (Array.isArray(p.requires_action_from) && p.requires_action_from.includes(partnerId)) return true;
    if (p.experience_id && ownsExperience(p.experience_id)) return true;
    if (p.service_id && ownedService.has(p.service_id)) return true;
    return false;
  });

  const view = operationsView({ events: () => visible });
  return {
    partner_id: partnerId,
    resources: {
      sessions: view.sessions.filter((s) => ownsExperience(s.experience_id)),
      transit: view.transit.filter((s) => ownedService.has(s.service_id)),
      compensations: view.compensations,
    },
    // 处置要求只返回点名本方的指令；其他单位的内部记录不出现在此视图。
    action_required: view.directives
      .filter((d) => d.requires_action_from.includes(partnerId))
      .map((d) => ({
        directive_id: d.directive_id,
        audience: d.audience,
        based_on: d.based_on,
        event_id: d.event_id,
      })),
    reports_on_file: visible.map((e) => ({ event_id: e.event_id, event_type: e.event_type, aggregate_id: e.aggregate_id, summary: e.summary })),
  };
}

/**
 * 事后复盘血缘：从一次事件（event_id 或 correlation_id）出发，
 * 沿 causation / based_on / 各类依据引用展开，说明事件、证据、决定、指令与后果。
 */
export function incidentLineage(log, seedIdOrCorrelation) {
  const events = canonicalEvents(log);
  const byId = new Map(events.map((e) => [e.event_id, e]));

  // alert_id -> 告警相关 event_id 列表（缩线依据是业务告警号而非事件号）。
  const alertEvents = new Map();
  for (const e of events) {
    const alertId = e.payload?.alert_id;
    if (alertId) {
      if (!alertEvents.has(alertId)) alertEvents.set(alertId, []);
      alertEvents.get(alertId).push(e.event_id);
    }
  }

  const seeds = events.filter(
    (e) =>
      e.event_id === seedIdOrCorrelation ||
      e.correlation_id === seedIdOrCorrelation ||
      e.aggregate_id === seedIdOrCorrelation ||
      e.payload?.incident_id === seedIdOrCorrelation ||
      e.payload?.alert_id === seedIdOrCorrelation,
  );
  if (seeds.length === 0) {
    throw new Error(`找不到复盘起点：${seedIdOrCorrelation}`);
  }

  const edges = [];
  const addEdge = (from, to, relation) => {
    if (from && to && byId.has(to) && from !== to) edges.push({ from, to, relation });
  };

  // 建立全部依据边。
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.causation_id) addEdge(e.event_id, e.causation_id, "caused_by");
    if (e.event_type === "DECISION_MADE" || e.event_type === "DECISION_REVISED") {
      for (const id of p.based_on ?? []) addEdge(e.event_id, id, "decided_from");
    }
    if (e.event_type === "DIRECTIVE_ISSUED") {
      for (const id of p.based_on ?? []) addEdge(e.event_id, id, "issued_from");
    }
    if (e.event_type === "ZONE_RESTRICTED") {
      for (const id of p.reason_event_ids ?? []) addEdge(e.event_id, id, "restricted_for");
    }
    if (e.event_type === "INCIDENT_REPORTED") {
      for (const id of p.evidence_ids ?? []) addEdge(e.event_id, id, "evidenced_by");
    }
    if (e.event_type === "SHUTTLE_SERVICE_ADDED") {
      for (const id of p.reason_event_ids ?? []) addEdge(e.event_id, id, "triggered_by");
    }
    if (e.event_type === "ROUTE_SHORTENED") {
      for (const alertId of p.reason_alert_ids ?? []) {
        for (const id of alertEvents.get(alertId) ?? []) addEdge(e.event_id, id, "risk_alert");
      }
    }
    if (e.event_type === "COMPENSATION_OPENED" || e.event_type === "COMPENSATION_SETTLED") {
      if (e.causation_id) addEdge(e.event_id, e.causation_id, "compensates");
    }
  }

  // 从种子沿边双向闭包：向上找证据与决定，向下找指令与后果。
  const reachable = new Set(seeds.map((e) => e.event_id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const { from, to } of edges) {
      if (reachable.has(from) && !reachable.has(to)) {
        reachable.add(to);
        changed = true;
      }
      if (reachable.has(to) && !reachable.has(from)) {
        reachable.add(from);
        changed = true;
      }
    }
  }

  const classify = (e) => {
    if (e.event_type.startsWith("INCIDENT_")) return "incident";
    if (e.event_type === "DECISION_MADE" || e.event_type === "DECISION_REVISED") return "decision";
    if (e.event_type === "DIRECTIVE_ISSUED" || e.event_type === "DIRECTIVE_WITHDRAWN") return "directive";
    if (["CROWD_COUNT_REPORTED", "ALERT_RAISED", "ALERT_UPDATED", "BOUNDARY_MEASURED", "TRANSIT_DEPARTURE_REPORTED", "CAPACITY_OBSERVED", "TRANSIT_LAST_SERVICE_CHANGED"].includes(e.event_type)) {
      return "evidence";
    }
    return "consequence";
  };

  const nodes = [...reachable]
    .map((id) => byId.get(id))
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
    .map((e) => ({
      event_id: e.event_id,
      event_type: e.event_type,
      category: classify(e),
      summary: e.summary,
      at: e.occurred_at,
      source_system: e.source_system,
      payload_highlights: highlight(e),
    }));

  return {
    seed: seedIdOrCorrelation,
    nodes,
    edges: edges.filter((edge) => reachable.has(edge.from) && reachable.has(edge.to)),
  };
}

function highlight(e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case "DECISION_MADE":
    case "DECISION_REVISED":
      return { decision_type: p.decision_type, rationale: p.rationale, based_on: p.based_on };
    case "CROWD_COUNT_REPORTED":
      return { reading_kind: p.reading_kind, value: p.value, coverage: p.coverage?.description, forecast_for: p.forecast_for };
    case "ALERT_RAISED":
    case "ALERT_UPDATED":
      return { alert_id: p.alert_id, category: p.category, severity: p.severity, zone_ids: p.zone_ids };
    default:
      return { ...p };
  }
}
