// Mechanical input forms shared by published tool schemas and domain validators.
// These describe existing Lean wrapper/library contracts, not a research workflow.
export const MODULE_PATTERN = "^Mathlib(?:\\.[A-Za-z][A-Za-z0-9_]*)*$";
export const HELPER_PATTERN = "^[A-Z][A-Za-z0-9_]{0,47}$";
export const moduleInput = {
  type: "string",
  pattern: MODULE_PATTERN,
  maxLength: 180,
  description:
    "Additional pinned Mathlib module. Std/Init/Lean are built-in imports; omit them from this list.",
};
export const helperNameInput = {
  type: "string",
  pattern: HELPER_PATTERN,
  description:
    "Lean helper identifier: uppercase first, then ASCII letters, digits or underscore; no dots.",
};
