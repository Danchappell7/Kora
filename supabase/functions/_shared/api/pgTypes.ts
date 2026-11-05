// ============================================================
// KANBO — the postgres.js type table for every edge function that uses db.ts.
//
// Pure, so the PGlite suite runs the real driver with exactly these settings.
//
//   date  keep date-only columns as "YYYY-MM-DD" strings (serialise.ts takes
//         strings or Dates either way).
//   json  postgres.js stringifies every json and jsonb parameter, whatever it is.
//         Every $n::jsonb in this codebase is already JSON text (JSON.stringify
//         at the call site, because unsafe() can't bind a JS array), so the
//         driver's own serializer turned ["a"] into the JSON *string* "[\"a\"]"
//         and jsonb_array_elements_text raised "cannot extract elements from a
//         scalar". Text now goes as it is; anything else is stringified once.
//
// Never pass a bare string meaning a JSON string here: it isn't valid JSON.
// ============================================================
export const PG_TYPES = {
  date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
  json: {
    to: 114,
    from: [114, 3802],
    serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)),
    parse: (x: string) => JSON.parse(x) as unknown,
  },
};
