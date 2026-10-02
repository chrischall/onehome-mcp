import * as mcpUtils from '@chrischall/mcp-utils';
import { makeViewHelpers, REALTY_VIEWS } from '@chrischall/realty-core';

/**
 * The rungs this server honours (`@chrischall/mcp-utils`' `view` vocabulary;
 * `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * **What compact does here, and what it deliberately does NOT do.**
 *
 * The read tools in this server hand back OneHome's payload close to
 * verbatim, and the repo holds no verified record of what those payloads
 * contain — no captured fixture, no documented field list. So nothing here can
 * honestly say which of OneHome's fields matter and which are noise.
 *
 * Compact therefore does the one projection that needs no such knowledge: it
 * strips image and avatar URLs. That is SUBTRACTIVE, so it cannot lose a field
 * nobody knew about — the failure an invented field list would risk, where a
 * record comes back with holes in it and reads like a verified answer.
 *
 * When a real payload can be captured, a field projection belongs here beside
 * this one and will save considerably more. Until then this is the honest
 * ceiling, and this docblock says so rather than implying a shape was checked.
 */
export const OH_VIEWS = REALTY_VIEWS;

/**
 * The `view` parameter, for the tools that take one.
 *
 * NOT every read tool — this is a deliberate PARTIAL rollout. Four tools
 * declare it (`onehome_get_by_address`, `onehome_compare_properties`,
 * `onehome_graphql`, `onehome_get_user`); the other fifteen call
 * `minifiedResult` directly and advertise no rung at all. `CLAUDE.md` carries
 * the list and the reasoning, including why `onehome_get_property_photos` must
 * never take one — its PRODUCT is the image URLs, so stripping empties the
 * response rather than shrinking it.
 *
 * This docblock used to claim "every read tool", which was never true and
 * contradicted the file that had it right. A comment asserting broader
 * coverage than exists is worse than none: it is exactly what someone checks
 * INSTEAD of counting.
 */
//
// `viewResponse` answers in the requested rung. Only ever called from a READ
// tool. A write's response is a receipt — an id, a status — with nothing to
// strip and everything to keep. Both come from realty-core's shared
// `makeViewHelpers` (fleet-audit#1175); the note is `compactNote('OneHome')`.
export const { viewArg, viewResponse } = makeViewHelpers(mcpUtils, {
  portal: 'OneHome',
});
