export const ENTRY_TYPES = Object.freeze({
  claim: "命题",
  definition: "定义与符号",
  proof_step: "原证明步骤",
  condition: "条件与边界",
  citation: "外部引用",
});
export const ENTRY_STATES = Object.freeze({
  proved: "形式化已证明",
  refuted: "否定已证明",
  unknown: "核验未完成",
  pending: "未核验",
  stale: "证据已过期",
  conflict: "证据冲突",
  excluded: "已列为范围外",
});
