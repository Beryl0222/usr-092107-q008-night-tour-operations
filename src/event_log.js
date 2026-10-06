/**
 * 追加式事件日志与跨记录规则。
 *
 * 约定：
 * - 记录一经接收不可原地改写，只能追加；更正必须用 supersedes 提交后继记录。
 * - 各单位对同一客观事实的重复上报携带相同 idempotency_key：
 *   载荷指纹一致时折叠为 canonical（不重复计入投影）；不一致时拒收，要求走后继更正。
 * - 跨记录硬规则：补偿覆盖的核销票必须属于同一体验；停演释放分区不得超出场次登记分区；
 *   决策/缩线引用的读数与告警必须真实存在。
 */

import { fingerprint, validateEvent, NATURE_RISK_CATEGORIES } from "./validator.js";

export class EventLog {
  constructor() {
    /** @type {object[]} 规范化接收的记录（被标记为重复的上报也保留以备审计）。 */
    this.received = [];
    this._byId = new Map();
    /** idempotency_key -> canonical event_id */
    this._keyCanonical = new Map();
    /** 被折叠的重复上报 event_id 集合。 */
    this.duplicateIds = new Set();
    this._aggVersion = new Map(); // aggregate_id -> 最大 version
    this._redemptions = new Map(); // experience_id -> Set<redemption_id>
    this._sessions = new Map(); // session_id -> { experience_id, zone_ids }
    this._alerts = new Map(); // alert_id -> alert record payload
  }

  /**
   * 接收一条记录。
   * @returns {{status: 'accepted'|'duplicate', event: object, warnings: string[]}}
   * @throws {Error} 校验或跨记录规则不通过时抛出，errors 属性为中文信息数组。
   */
  append(record, { now = new Date().toISOString() } = {}) {
    const errors = validateEvent(record);
    if (errors.length > 0) {
      throw Object.assign(new Error(`事件校验未通过：${record.event_id ?? "<无 event_id>"}`), { errors });
    }
    const stored = { ...record, received_at: record.received_at ?? now };

    if (this._byId.has(stored.event_id)) {
      throw Object.assign(new Error("event_id 重复"), { errors: [`event_id 已存在：${stored.event_id}（记录不可重复提交，更正请用新 event_id 并带 supersedes）`] });
    }

    const idempotencyErrors = this._checkIdempotency(stored);
    if (idempotencyErrors.length > 0) throw Object.assign(new Error("重复上报冲突"), { errors: idempotencyErrors });

    // 载荷一致的重复上报：仅留存审计，不再做版本/引用校验，也不进入投影。
    if (this.duplicateIds.has(stored.event_id)) {
      this.received.push(stored);
      this._byId.set(stored.event_id, stored);
      return { status: "duplicate", event: stored, warnings: [] };
    }

    const crossErrors = [...this._checkVersion(stored), ...this._checkReferences(stored)];
    if (crossErrors.length > 0) throw Object.assign(new Error("跨记录规则未通过"), { errors: crossErrors });

    const warnings = [];
    this.received.push(stored);
    this._byId.set(stored.event_id, stored);
    if (stored.idempotency_key) this._keyCanonical.set(stored.idempotency_key, stored.event_id);
    this._updateIndexes(stored, warnings);
    return { status: "accepted", event: stored, warnings };
  }

  /** 规范化事件序列（折叠重复上报，按接收顺序）。 */
  events() {
    return this.received.filter((e) => !this.duplicateIds.has(e.event_id));
  }

  get(eventId) {
    return this._byId.get(eventId);
  }

  _checkIdempotency(stored) {
    const errors = [];
    if (!stored.idempotency_key) return errors;
    const canonicalId = this._keyCanonical.get(stored.idempotency_key);
    if (canonicalId === undefined) return errors;
    const canonical = this._byId.get(canonicalId);
    if (fingerprint(stored) === fingerprint(canonical)) {
      // 同一事实的重复上报：保留记录但折叠，不计入任何投影。
      this.duplicateIds.add(stored.event_id);
    } else if (!stored.supersedes) {
      errors.push(
        `idempotency_key=${stored.idempotency_key} 已被 ${canonicalId} 占用但载荷不一致：` +
          "不得就地改写，必须以新 event_id 提交 supersedes 指向原记录的后继记录",
      );
    }
    return errors;
  }

  _checkVersion(stored) {
    const errors = [];
    const prevMax = this._aggVersion.get(stored.aggregate_id) ?? 0;
    if (stored.version <= prevMax) {
      errors.push(`聚合 ${stored.aggregate_id} 版本必须严格递增：收到 v${stored.version}，已有最大 v${prevMax}`);
    }
    if (stored.supersedes) {
      const target = this._byId.get(stored.supersedes);
      if (!target) {
        errors.push(`supersedes 指向的原记录不存在：${stored.supersedes}`);
      } else {
        if (target.aggregate_id !== stored.aggregate_id) {
          errors.push("supersedes 只能更正同一聚合的记录");
        }
        if (stored.version <= target.version) {
          errors.push(`后继记录版本 v${stored.version} 必须大于原记录版本 v${target.version}`);
        }
      }
    }
    return errors;
  }

  _checkReferences(stored) {
    const errors = [];
    const p = stored.payload ?? {};

    if (stored.causation_id && !this._byId.has(stored.causation_id)) {
      errors.push(`causation_id 指向的记录不存在：${stored.causation_id}`);
    }
    const requireExisting = (ids, label) => {
      for (const id of ids ?? []) {
        if (!this._byId.has(id)) errors.push(`${label}引用的记录不存在：${id}`);
      }
    };

    switch (stored.event_type) {
      case "ROUTE_SHORTENED": {
        // 缩线只能由敏感物种、雷雨或消防风险触发，并须引用真实告警。
        for (const alertId of p.reason_alert_ids) {
          const alert = this._alerts.get(alertId);
          if (!alert) {
            errors.push(`缩线引用的告警不存在：${alertId}`);
          } else if (!NATURE_RISK_CATEGORIES.includes(alert.category)) {
            errors.push(`缩线引用的告警 ${alertId} 类别为 ${alert.category}，自然观察缩线/取消只接受敏感物种、雷雨或消防风险`);
          }
        }
        break;
      }
      case "SESSION_SUSPENDED":
      case "SESSION_CANCELLED": {
        // 停演/取消只释放本场次登记的分区。
        const session = this._sessions.get(p.session_id);
        if (!session) {
          errors.push(`场次尚未登记：${p.session_id}（先发 SESSION_SCHEDULED）`);
        } else {
          if (session.experience_id !== p.experience_id) {
            errors.push(`停演记录的体验 ${p.experience_id} 与场次登记的体验 ${session.experience_id} 不一致`);
          }
          for (const zoneId of p.released_zone_ids) {
            if (!session.zone_ids.includes(zoneId)) {
              errors.push(`释放分区 ${zoneId} 不在场次 ${p.session_id} 的登记分区内：临时停演只能释放对应区域容量`);
            }
          }
        }
        break;
      }
      case "COMPENSATION_OPENED":
      case "COMPENSATION_SETTLED": {
        // 补偿只能覆盖本体验已核销的票，不能连带其他体验。
        const redeemed = this._redemptions.get(p.experience_id);
        if (!redeemed || redeemed.size === 0) {
          errors.push(`体验 ${p.experience_id} 尚无已核销票记录，不能立案补偿`);
        }
        for (const id of p.covered_redemption_ids ?? []) {
          if (!redeemed?.has(id)) {
            errors.push(`核销票 ${id} 不属于体验 ${p.experience_id}：补偿不得覆盖其他体验（停演不连带撤销已核销的其他体验）`);
          }
        }
        break;
      }
      case "DECISION_MADE":
      case "DECISION_REVISED":
        requireExisting(p.based_on, "决策依据");
        break;
      case "ZONE_RESTRICTED":
        requireExisting(p.reason_event_ids, "限流依据");
        break;
      case "INCIDENT_REPORTED":
        requireExisting(p.evidence_ids, "事件证据");
        break;
      case "DIRECTIVE_ISSUED":
        requireExisting(p.based_on, "指令依据");
        break;
      case "SHUTTLE_SERVICE_ADDED":
        requireExisting(p.reason_event_ids, "增开接驳依据");
        break;
      default:
        break;
    }
    return errors;
  }

  _updateIndexes(stored, warnings) {
    this._aggVersion.set(stored.aggregate_id, Math.max(this._aggVersion.get(stored.aggregate_id) ?? 0, stored.version));
    const p = stored.payload ?? {};
    switch (stored.event_type) {
      case "SESSION_SCHEDULED":
        this._sessions.set(p.session_id, { experience_id: p.experience_id, zone_ids: [...p.zone_ids] });
        break;
      case "TICKETS_REDEEMED": {
        const set = this._redemptions.get(p.experience_id) ?? new Set();
        for (const id of p.redemption_ids) {
          if (set.has(id)) warnings.push(`核销票重复上报：${id}`);
          set.add(id);
        }
        this._redemptions.set(p.experience_id, set);
        break;
      }
      case "ALERT_RAISED":
      case "ALERT_UPDATED":
        this._alerts.set(p.alert_id, { ...(this._alerts.get(p.alert_id) ?? {}), ...p });
        break;
      case "ALERT_CLEARED":
        this._alerts.delete(p.alert_id);
        break;
      default:
        break;
    }
  }
}

/** 从数组批量装载（如启动时重放事件库），第一条失败即抛出。 */
export function replay(records) {
  const log = new EventLog();
  for (const record of records) log.append(record);
  return log;
}
