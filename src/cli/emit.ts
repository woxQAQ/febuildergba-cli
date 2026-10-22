/**
 * Every command's payload, in one envelope.
 *
 * `data` is what the command computed; `meta` says what it was computed from
 * and whether the input supported it. The envelope is uniform so a consumer
 * never has to ask "is this a bare array or an object" before indexing it -
 * that shape check is what silently produced `undefined` from `payload[0]`
 * when a command switched its payload kind.
 *
 * `meta.diagnostics` is where warnings live. They used to go to stderr only,
 * which made them invisible to anything that redirected stderr and
 * indistinguishable from the driver's own noise; a warning about the input's
 * quality belongs in the artifact that the warning is about.
 */
export interface Envelope<D> {
  data: D;
  meta: CommandMeta;
}

export interface CommandMeta {
  /** The command word that produced `data`. */
  command: string;
  /** Input path as typed: the ROM for `extract`/`text`, the db for the rest. */
  path: string;
  /** The extract's game version, when the command reads a db. */
  game?: string;
  /**
   * Snapshot extraction warnings plus checks triggered by this analysis.
   * Reading stored warnings does not load the event layer. Empty is not a
   * completeness certificate: unimplemented checks cannot produce warnings.
   */
  diagnostics: readonly string[];
  /**
   * The parameters the numbers were measured under, for the commands whose
   * output moves with them (`expcurve`). Absent elsewhere rather than empty, so
   * a caller can tell "not applicable" from "defaults".
   */
  parameters?: Readonly<Record<string, unknown>>;
}

/**
 * Print one command's payload as pretty-printed JSON on stdout.
 *
 * Commands return their **data**, not an envelope: `run` is where the
 * diagnostics are known and where the payload is attached to them, so no
 * command has to remember to wrap its own result correctly.
 *
 * There is no `--compact`: these payloads are meant to be read or redirected,
 * and the sizes here are not large enough to justify a second format.
 */
export function emit<D>(data: D, meta: CommandMeta): void {
  const envelope: Envelope<D> = { data, meta };
  console.log(JSON.stringify(envelope, null, 2));
}
