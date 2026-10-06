/** 测试用最小事件构造器，默认值可被覆盖。 */
let seq = 0;

export function baseEvent(overrides = {}) {
  seq += 1;
  return {
    event_id: `t-${seq}`,
    event_type: "PROGRAM_CLEARED",
    aggregate_type: "night_program",
    aggregate_id: "prog-test",
    occurred_at: "2026-10-10T18:00:00+08:00",
    version: 1,
    summary: "测试记录",
    source_system: "duty-room",
    ...overrides,
    payload: overrides.payload ?? {},
  };
}

export function appendExpectingErrors(log, record) {
  try {
    log.append(record);
    return [];
  } catch (err) {
    return err.errors ?? [err.message];
  }
}
