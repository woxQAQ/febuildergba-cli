/**
 * An extract is a rebuildable artifact. Bump this revision whenever decoding
 * or materialized derivation rules change, even if the SQL columns do not.
 * We reject older artifacts instead of migrating their inferred conclusions.
 */
export const EXTRACT_REVISION = "2";
