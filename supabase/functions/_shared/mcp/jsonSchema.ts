// ============================================================
// KANBO — MCP: the small piece of JSON Schema the tools use.
//
// Tool arguments are checked with it (a bad argument is an isError result in
// plain words), and tests check every structured result against its tool's
// outputSchema with it, so a schema can't drift from what a tool really sends.
//
// Pure module.
// ============================================================

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  format?: string;
  default?: unknown;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

const matches = (want: string, have: string) => want === have || (want === "number" && have === "integer");

const describeType = (t: string | string[]) => (Array.isArray(t) ? t.filter((x) => x !== "null").join(" or ") : t);

/** Each problem as a short sentence naming the field; [] when the value fits. */
export function schemaErrors(schema: JsonSchema, value: unknown, path = ""): string[] {
  const at = path || "This value";
  const out: string[] = [];
  const have = typeOf(value);
  if (schema.type !== undefined) {
    const wants = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wants.some((w) => matches(w, have))) return [`${at} must be ${describeType(schema.type)}.`];
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) out.push(`${at} must be one of ${schema.enum.join(", ")}.`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at} can't be empty.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at} can be at most ${schema.maxLength} characters.`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at} must be at most ${schema.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at} can have at most ${schema.maxItems} items.`);
    if (schema.items) value.forEach((v, i) => out.push(...schemaErrors(schema.items!, v, `${path}[${i}]`)));
  }
  if (have === "object") {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (o[r] === undefined) out.push(`${path ? `${path}.` : ""}${r} is required.`);
    for (const [k, v] of Object.entries(o)) {
      const name = path ? `${path}.${k}` : k;
      const sub = schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, k) ? schema.properties[k] : undefined;
      if (sub) out.push(...schemaErrors(sub, v, name));
      else if (schema.additionalProperties === false) out.push(`${name} isn't a field of this tool.`);
    }
  }
  return out;
}
