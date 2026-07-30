/**
 * The `metadata.claimRefusal` diagnosis and the type that makes it
 * unforgeable-by-construction.
 *
 * Round-5 S2 moved the diagnosis out of `metadata.claim` because a `refused: `
 * prefix inside an attacker-supplied string is a forgeable trust signal, and
 * both READMEs told the operator to key their remedy on it. What round 5 did
 * NOT do is stop a future caller from writing an arbitrary string into the new
 * key: `emitAuthLoginFailure`'s `claimRefusal?: string | null` accepted any
 * string, and the guarantee lived in a comment (round-6 SEC-R6-3).
 *
 * The brand moves that guarantee into the type system. `ClaimRefusalDiagnosis`
 * cannot be produced anywhere except `claimRefusal()` below — a plain string
 * literal does not satisfy it — so "this field was written by us, never by a
 * party to the authentication" is checked by `tsc` rather than asserted in
 * prose. `claimRefusal()` is the only cast, and it owns the `refused: ` prefix
 * so the wording cannot drift between producers either.
 */

declare const claimRefusalBrand: unique symbol;

/**
 * A machine-generated, printable-ASCII statement of WHICH RULE an asserted
 * claim broke. Never a rendering of the value — see D-35.
 */
export type ClaimRefusalDiagnosis = string & {
  readonly [claimRefusalBrand]: true;
};

/**
 * The sole producer. `rule` names the violated rule, not the value: an operator
 * reading this row needs to know what to change at the IdP, and the value is
 * unregistrable by definition, so reproducing it buys nothing and costs the
 * encoding hazards round-4 S1 measured.
 */
export function claimRefusal(rule: string): ClaimRefusalDiagnosis {
  return `refused: ${rule}` as ClaimRefusalDiagnosis;
}
