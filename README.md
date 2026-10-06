# 夜游联合运行中心

县城把博物馆夜场、山野观星、非遗演出与夜市排在同一周末后，任何一项条件变化（地铁末班、临时摊位、林区雷雨大风、噪声时段、野生动物保护）都可能让跨场景行程失效。本仓库记录**夜游联合运行中心**已确认的领域对象、事件目录、处置约定与最小校验/投影代码，供文旅联席值班室与各合作方系统交换一致数据。

## 资料范围

| 路径 | 内容 |
| --- | --- |
| `contracts/domain.schema.json` | 事件信封、38 种事件类型、13 类聚合、客流读数与补偿结构 |
| `src/domain.ts` | 同构的 TypeScript 类型与中文注释（领域语言） |
| `src/validator.js` | 信封与载荷校验（与状态无关的规则） |
| `src/event_log.js` | 追加式事件日志：去重、后继记录、跨记录规则 |
| `src/views.js` | 值班运行视图、合作方视图、事后复盘血缘 |
| `data/weekend_timeline.json` | 一个完整周末夜晚的 74 条联调样例（含重复上报、更正、全链路处置） |
| `data/sample.json` | 单条最小样例 |
| `examples/runbook.js` | 重放样例并打印运行视图、合作方视图与复盘链 |
| `tests/` | 38 项约定测试 |

## 本地检查

```bash
node --test          # 全部约定测试
node examples/runbook.js
```

## 事件约定（各单位共同遵守）

### 信封

```jsonc
{
  "event_id": "e29",                    // 唯一标识，接收后不可改写
  "event_type": "ALERT_RAISED",
  "aggregate_type": "operational_alert",
  "aggregate_id": "alert-thunder-1010",
  "occurred_at": "2026-10-10T20:15:00+08:00", // 事实发生时间，不可改写
  "received_at": "2026-10-10T20:15:02+08:00",
  "version": 1,                         // 同一聚合严格递增
  "summary": "……",
  "source_system": "weather-bureau",    // 报送单位/系统
  "idempotency_key": "fact:alert:alert-thunder-1010:raised",
  "correlation_id": "corr-night-1010",  // 处置链路，复盘按此串联
  "causation_id": "e33",                // 直接上游记录
  "supersedes": "e27",                  // 本记录更正的原记录（同聚合、更大版本）
  "visibility": "joint_center",         // 或 partner:heritage-troupe
  "payload": { /* 业务字段 */ }
}
```

- **不可变与更正**：记录一经接收，`event_id`/`occurred_at`/`version` 不得原地改写；更正只能提交带 `supersedes` 的后继记录（同一聚合、版本更大）。投影自动取后继值，`asOf` 视图可还原更正当晚所见的旧值。
- **重复上报**：不同单位上报同一客观事实时复用 `idempotency_key`（建议 `事实:对象:时间`）。载荷指纹一致的上报折叠为一份（保留审计但不进投影，样例 e29/e30）；键相同但内容不一致且未走后继更正的，**拒收**。
- **决策留痕**：`DECISION_MADE` 必须带 `based_on`（实际读数/告警/事件的 event_id）；指令、限流、缩线、增开接驳、补偿均须引用真实存在的依据记录，凭空决定进不了日志。
- **可见性**：`joint_center` 为值班内部；`partner:<id>` 仅点名单位可见。个人、机构及商业敏感信息只向履行职责所需的调用方开放。

### 事件目录（按业务域）

- **许可与体验**：`PROGRAM_CLEARED`、`EXPERIENCE_REGISTERED`、`SESSION_SCHEDULED/RESUMED/SUSPENDED/CANCELLED`、`ROUTE_SHORTENED`、`TICKETS_REDEEMED`
- **报到**：`VENDOR_CHECKED_IN`、`PERFORMER_CHECKED_IN`、`PARTICIPANT_CHECKED_OUT`
- **容量与限流**：`ZONE_REGISTERED`、`CAPACITY_OBSERVED`、`CROWD_COUNT_REPORTED`、`ZONE_RESTRICTED/REOPENED`
- **交通**：`TRANSIT_SCHEDULED`、`TRANSIT_DEPARTURE_REPORTED`、`TRANSIT_LAST_SERVICE_CHANGED`、`SHUTTLE_SERVICE_ADDED`
- **气象/生态/边界**：`ALERT_RAISED/UPDATED/CLEARED`、`BOUNDARY_RULE_PUBLISHED/MEASURED`
- **疏散与事件**：`EVACUATION_PLAN_PUBLISHED/ACTIVATED/STOOD_DOWN`、`INCIDENT_REPORTED/ACKNOWLEDGED/RESOLVED`
- **决定与指令**：`DECISION_MADE/REVISED`、`DIRECTIVE_ISSUED/WITHDRAWN`
- **处置与补偿**：`RESPONSE_OPENED/CLOSED`、`COMPENSATION_OPENED/SETTLED`

事件只能挂在归属聚合上（如 `ALERT_RAISED` 只能属于 `operational_alert`），完整归属表见 `src/validator.js`。

## 关键业务约定

### 1. 客流数据必须标明真值与覆盖范围

每条 `CROWD_COUNT_REPORTED` 必须带：

- `reading_kind`：`gate_actual`（闸机实数，**必须带 `gate_id`，是唯一可作"实数"展示的读数）/ `camera_estimate` / `manual_count` / `forecast`；
- `coverage`：覆盖范围（`scope` + 中文 `description`），例如"东闸机，不含西侧无障碍通道"；
- `forecast` 必须带 `forecast_for` 指向未来时刻；非预测读数禁止携带 `forecast_for`。

运行视图把三类读数**分列**：`gate_actual`（逐闸机展示覆盖说明再合计）、`estimates`、`forecasts`。**限流建议只采信闸机实数**——样例中夜市模型预测 6100 人超容量，但摄像头估算经后继记录更正为 3050 人，系统未对夜市限流；博物馆两闸机合计 1240 ≥ 1200、地铁口 2100 ≥ 2000 才触发限流建议。

### 2. 自然观察：敏感物种、雷雨、消防风险优先缩线或取消

`nature_observation=true` 的体验（山野观星）受 `weather_thunder`、`wildlife_sensitive_species`、`fire_risk` 告警影响时，运行视图优先建议 `ROUTE_SHORTENED` 或 `SESSION_CANCELLED`，不允许只靠限流/排队掩盖风险。`ROUTE_SHORTENED` 必须引用上述类别的真实告警（引用噪声等其他类别会被拒收）。样例：20:15 雷雨 watch + 20:25 原麝告警 → 20:30 先缩线撤下山脊点 → 20:50 预警升 warning → 20:53 取消并启动疏散。

### 3. 已入场与尚未出发收到不同指令

`DIRECTIVE_ISSUED` 的 `audience` 按 `segment` 分群且各有适用动作：

- `onsite`：`shorten_route` / `evacuate` / `shelter` / `divert` / `stop_entry`；
- `not_departed`：`hold_departure` / `divert` / `stop_entry`。

例如取消观星时，山上队伍收到"沿 r-ridge-down、r-star-bus 撤离至停车场"，未出发团队收到"暂缓前往、等待退改"。每条指令可在 `requires_action_from` 点名执行单位（如 `bus-co`、`forest-station`）。

### 4. 临时停演只释放对应区域，不连带其他体验

`SESSION_SUSPENDED/CANCELLED` 的 `released_zone_ids` 必须是该场次 `SESSION_SCHEDULED` 登记分区的子集；其他体验照常运行，其已核销票仍然有效。样例中非遗产第二场因功放故障停演，只释放 `z-heritage-stage`，博物馆、观星、夜市均不受影响，且演出修复后可 `SESSION_RESUMED`（不撤销已立补偿案）。

### 5. 补偿按责任与资金来源分别记录

每个补偿案（`COMPENSATION_OPENED/SETTLED`）必须写明：

- `responsibility.party` + `basis`（责任方与认定依据，多方分担用 `share`）；
- `funding_source`：`insurance` / `organizer` / `venue_operator` / `government_fiscal` / `partner`；
- `covered_redemption_ids`：**只能是本体验已核销的票**，把别的体验的票纳入会被拒收。

样例两案分账：观星取消属不可抗力走**保险**赔付 360 元（3 张票）；非遗停演是演出团设备责任，由**主办方**赔付 320 元（4 张票）。

### 6. 照明、噪声与生态边界

`BOUNDARY_RULE_PUBLISHED` 公布分区噪声上限与静默时段（林区侧 22:00–06:00、55 分贝）及照明限制；`BOUNDARY_MEASURED` 记录实测。样例中实测 61 分贝超限后，民宿投诉事件以该实测为 `evidence_ids`，复盘可直接追到越界记录。

## 三张运行视图（`src/views.js`）

- **`operationsView(log, { asOf })`**：值班一张图。分区实况（实数/估算/预测分列、负载率、限流态、活跃告警）、场次生命周期、交通末班与实际发车、现场事件、决定、生效指令、补偿案，以及 `recommendations`（`restrict_entry` / `add_shuttle` / `shorten_or_cancel_nature_session`）——每条建议都附 `based_on` 事件号。`asOf` 可还原任意时刻值班员当时所见（含"更正尚未到达"的状态）。
- **`partnerView(log, partnerId)`**：合作方只看到**自身资源**（本方登记/运营的体验、交通服务、点名本方的补偿）与**点名本方的处置要求**；看不到其他单位的内部记录。无关合作方视图为空。
- **`incidentLineage(log, seed)`**：事后复盘。从 event_id、correlation_id、incident_id 或 alert_id 出发，沿 `causation_id`、`based_on`、`reason_event_ids`、`reason_alert_ids`、`evidence_ids` 双向闭包，输出按时间排序的"证据 → 事件 → 决定 → 指令/措施"节点与边。一次拥堵、投诉或生态干扰由哪些实际读数与决定造成，可逐条说明。

## 边界与后续

本仓库只定义约定、校验与只读投影，不包含具体接入网关、权限鉴权与通知通道实现；接入新单位时先在 Schema 与校验器登记事件/聚合，再补对应投影与测试。
