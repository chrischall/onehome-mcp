// Tool-result formatting. Re-exported from @chrischall/mcp-utils so the whole
// fleet shares one JSON wrapper; the local module path is kept so every
// `tools/*.ts` import stays put.
//
// The wrapper is MINIFIED, not pretty-printed — `JSON.stringify(data)`, no
// indent argument. Indentation carries no information and nothing downstream
// reads it: measured at roughly a fifth of a large response. Whitespace INSIDE
// a value is untouched, because `JSON.stringify` drops only the indent and the
// runs after `:` and `,`, so a listing's multi-paragraph `description` comes
// back byte-identical.
//
// A READ tool answers through `viewResponse` (`src/view.ts`) instead, which
// projects for the requested rung and then calls this.
export { minifiedResult } from '@chrischall/mcp-utils';
