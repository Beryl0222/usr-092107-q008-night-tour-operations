# 夜游联合运行中心

本仓库记录该项目已确认的领域对象、事件名称和基础校验方式，便于不同系统交换一致的数据。

县城把博物馆夜场、山野观星、非遗演出和夜市安排在同一周末后，地铁末班、临时摊位、林区雷雨大风预警、噪声时段与野生动物保护中任何一项变化，都可能让跨场景行程失效。这里的约定支撑文旅联席值班室的联合运行：值班人员在一张运行视图中判断哪里需要限流或增开接驳，合作方只看到自身资源与处置要求，事后复盘能说明一次拥堵、投诉或生态干扰由哪些实际决定造成。

## 资料范围

- `contracts/domain.schema.json`：领域事件信封、聚合类型、事件名称与各事件的 payload 约定。
- `data/sample.json`：一条用于本地联调的中文样例。
- `data/examples/`：覆盖主要约定的示例事件，取自同一个周末的连贯场景。
- `src/`：事件信封与约定的最小校验代码，含重复上报去重。
- `tests/`：验证样例与示例符合约定，并覆盖关键反面情况。

## 接入的业务面

活动许可、场地容量、交通班次、商户与演职人员报到、照明噪声边界、气象与生态告警、客流计数、疏散预案、现场事件，分别对应聚合 `night_program`、`capacity_zone`、`transport_service`、`participant_roster`、`environment_boundary`、`operational_alert`、`crowd_measurement`、`evacuation_plan`、`site_incident`；跨场景行程、联合处置与补偿分录对应 `visitor_itinerary`、`joint_response`、`compensation_case`。

## 关键约定

- **记录不可改写**：标识、发生时间与版本一经接收不得原地改写；更正使用新的后继记录。个人、机构及商业敏感信息仅向履行职责所需的调用方开放。
- **重复上报去重**：单位上报类事件（`INCIDENT_REPORTED`、`ROSTER_CHECKED_IN`、`CROWD_COUNTED`、`ALERT_RAISED`）必须携带 `reported_by` 与 `report_key`，同一组合重复到达只接收首条（见 `deduplicateReports`）；`report_key` 在上报单位内不得复用。不同单位上报同一现场事件时用 `payload.correlation_key` 关联，不算重复。
- **客流口径**：客流数据必须标明 `coverage_scope`（覆盖范围）与 `data_kind`（口径）。闸机实数必须给出 `source_device`；预测值必须给出 `model_ref` 与 `valid_until`，且不得携带闸机设备号——预测不能伪装成闸机实数。
- **停演范围**：临时停演（`PERFORMANCE_SUSPENDED`）只释放 `zone_id` 对应区域的容量（由 `CAPACITY_RELEASED` 记录），不得携带 `revoked_experience_ids`，不能连带撤销已核销的其他体验。
- **补偿分录**：补偿按 `responsibility_party`（责任）与 `funding_source`（资金来源）分别记录，并关联 `cause_event_id`。
- **指令分群**：对客指令（`DIRECTIVE_ISSUED`）必须区分 `audience_segment`：`entered`（已入场）与 `not_departed`（尚未出发）收到不同指令。
- **自然观察优先动作**：自然观察类活动遇敏感物种、雷雨或消防风险告警时，优先缩线（`ROUTE_SHORTENED`）或取消（`PROGRAM_CANCELLED`），并必须引用触发的告警 `trigger_alert_id`。
- **决策依据**：限流、增开接驳、区域管控、缩线、取消、停演等决策事件必须在 `basis_event_ids` 中给出实际依据，事后复盘据此归因。
- **可见范围**：`visibility` 缺省视为 `operations`（仅值班室运行视图）；`partner` 级记录必须给出 `partner_id`，合作方只看到自身资源与处置要求。

## 本地检查

```bash
node --test
```
