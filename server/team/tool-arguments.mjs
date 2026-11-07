import { toolError } from "./tool-errors.mjs";
const keywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "description",
  "title",
  "default",
  "x-reference",
]);
export function assertSupportedSchema(schema, at = "schema") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw Error(`${at}: invalid schema`);
  for (const k of Object.keys(schema))
    if (!keywords.has(k)) throw Error(`${at}: unsupported schema keyword ${k}`);
  if (
    schema.type !== undefined &&
    ![
      "object",
      "array",
      "string",
      "boolean",
      "integer",
      "number",
      "null",
    ].includes(schema.type)
  )
    throw Error(`${at}: unsupported schema type`);
  if (schema.pattern !== undefined) new RegExp(schema.pattern);
  for (const [k, s] of Object.entries(schema.properties || {}))
    assertSupportedSchema(s, `${at}.${k}`);
  if (schema.items) assertSupportedSchema(schema.items, `${at}.items`);
  for (const key of ["oneOf", "anyOf", "allOf"])
    for (const s of schema[key] || []) assertSupportedSchema(s, `${at}.${key}`);
  if (schema.not) assertSupportedSchema(schema.not, `${at}.not`);
  if (typeof schema.additionalProperties === "object")
    assertSupportedSchema(
      schema.additionalProperties,
      `${at}.additionalProperties`,
    );
}
export function argumentErrors(schema, value, at = "arguments") {
  const errors = [],
    add = (message) => errors.push({ field: at, message });
  if (schema.enum && !schema.enum.includes(value))
    add(`expected one of ${schema.enum.join(", ")}`);
  if (Object.hasOwn(schema, "const") && value !== schema.const)
    add(`expected ${JSON.stringify(schema.const)}`);
  for (const key of ["oneOf", "anyOf"])
    if (schema[key]) {
      const matches = schema[key].filter(
        (s) => argumentErrors(s, value, at).length === 0,
      ).length;
      if (key === "oneOf" ? matches !== 1 : matches === 0)
        add(
          `${key}: choose ${key === "oneOf" ? "exactly one" : "a supported"} input mode`,
        );
    }
  for (const s of schema.allOf || [])
    errors.push(...argumentErrors(s, value, at));
  if (schema.not && !argumentErrors(schema.not, value, at).length)
    add("conflicting input mode");
  if (
    schema.type === "object" ||
    (!schema.type &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (schema.required ||
        schema.properties ||
        schema.additionalProperties !== undefined))
  ) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      add("expected object");
      return errors;
    }
    for (const k of schema.required || [])
      if (!Object.hasOwn(value, k))
        errors.push({ field: `${at}.${k}`, message: `missing ${k}` });
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k])
        errors.push(...argumentErrors(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false)
        errors.push({ field: `${at}.${k}`, message: `unrecognized ${k}` });
      else if (typeof schema.additionalProperties === "object")
        errors.push(
          ...argumentErrors(schema.additionalProperties, v, `${at}.${k}`),
        );
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      add("expected array");
      return errors;
    }
    value.forEach((v, i) =>
      errors.push(...argumentErrors(schema.items || {}, v, `${at}[${i}]`)),
    );
    if (schema.minItems !== undefined && value.length < schema.minItems)
      add("too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      add("too many items");
  } else if (
    schema.type &&
    !(schema.type === "string"
      ? typeof value === "string"
      : schema.type === "boolean"
        ? typeof value === "boolean"
        : schema.type === "integer"
          ? Number.isSafeInteger(value)
          : schema.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : schema.type === "null"
              ? value === null
              : false)
  )
    add(`expected ${schema.type}`);
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength)
      add("text too short");
    if (schema.maxLength !== undefined && length > schema.maxLength)
      add("text too long");
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      add("invalid format");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      add("below minimum");
    if (schema.maximum !== undefined && value > schema.maximum)
      add("above maximum");
  }
  return errors;
}
export function validateToolArguments(schema, value, at = "arguments") {
  assertSupportedSchema(schema);
  const errors = argumentErrors(schema, value, at);
  if (errors.length)
    throw toolError(
      "tool_arguments_invalid",
      errors.map((x) => `${x.field}: ${x.message}`).join("; "),
      { fieldErrors: errors, dispatchState: "not_dispatched" },
    );
}
