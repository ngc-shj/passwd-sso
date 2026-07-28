/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import {
  describeSelect,
  logNoSelectMatch,
  SELECT_DIAG_LABEL_MAX,
} from "../../content/select-diag-lib";

// Real elements, never object-literal casts: an HTMLSelectElement with no `name`
// attribute reflects "", while a literal that omits `name` yields undefined — so
// `name || id` and `name ?? id` behave identically against a fake and differently
// against the real thing.
function sel(html: string): HTMLSelectElement {
  document.body.innerHTML = html;
  const el = document.body.querySelector("select");
  if (!el) throw new Error("fixture produced no <select>");
  return el;
}

describe("describeSelect", () => {
  it("returns the name attribute when present", () => {
    expect(describeSelect(sel('<select name="pref"></select>'))).toBe("pref");
  });

  it("falls back to the id when there is no name", () => {
    expect(describeSelect(sel('<select id="country"></select>'))).toBe("country");
  });

  it("returns (unnamed) when the element has neither name nor id", () => {
    expect(describeSelect(sel("<select></select>"))).toBe("(unnamed)");
  });

  it("falls through a whitespace-only name to the id", () => {
    expect(describeSelect(sel('<select name=" " id="shipping"></select>'))).toBe(
      "shipping",
    );
  });

  // The I1 red-proof. Every property the invariant forbids carries the payload
  // value here, so any implementation whose fallback chain reaches value, option
  // text, dataset, getAttribute, aria-label or outerHTML returns it.
  it("never reads a property that can hold the user's value", () => {
    const el = sel(
      '<select data-selected="Nowhereland" aria-label="Nowhereland" title="Nowhereland">' +
        '<option value="Nowhereland" selected>Nowhereland</option>' +
        "</select>",
    );
    const label = describeSelect(el);
    expect(label).toBe("(unnamed)");
    expect(label).not.toContain("Nowhereland");
  });

  it("returns a name of exactly the cap unchanged, with no ellipsis", () => {
    const name = "a".repeat(SELECT_DIAG_LABEL_MAX);
    expect(describeSelect(sel(`<select name="${name}"></select>`))).toBe(name);
  });

  it("truncates one past the cap and marks it with an ellipsis", () => {
    const name = "a".repeat(SELECT_DIAG_LABEL_MAX + 1);
    const label = describeSelect(sel(`<select name="${name}"></select>`));
    expect(label).toHaveLength(SELECT_DIAG_LABEL_MAX + 1);
    expect(label.endsWith("…")).toBe(true);
  });

  // Positive allowlist, not a "contains no control characters" denylist — a denylist
  // drifts out of sync with the sanitiser and passes for characters nobody thought
  // to enumerate.
  it("replaces newline, ANSI escape and bidi override characters", () => {
    const el = sel("<select></select>");
    el.setAttribute("name", "a\nb[2K‮c");
    expect(describeSelect(el)).toMatch(/^[\p{L}\p{N}_\-.:[\]?…]*$/u);
  });

  it("keeps non-ASCII letters, which a JP-first product's ids carry", () => {
    expect(describeSelect(sel('<select name="pref_東京都"></select>'))).toBe(
      "pref_東京都",
    );
  });

  // String.prototype.slice cuts UTF-16 units, so it can halve an astral character
  // and emit a lone surrogate — invalid UTF-8 for the log ingests this sanitisation
  // protects.
  //
  // Two traps this test has to avoid, both of which made an earlier version of it
  // incapable of failing:
  //   - the fixture must put the cut at an ODD unit offset. A name of nothing but
  //     2-unit characters puts slice(0, 64) on an even boundary, which never splits
  //     a pair. The leading "a" is what makes the offset odd.
  //   - the assertion must be on well-formedness. `JSON.parse(JSON.stringify(s)) === s`
  //     holds for EVERY string including lone surrogates (well-formed JSON.stringify,
  //     ES2019), so a round-trip assertion is a tautology.
  it("truncates on code points, never emitting a lone surrogate", () => {
    const el = sel("<select></select>");
    el.setAttribute("name", "a" + "\u{10400}".repeat(SELECT_DIAG_LABEL_MAX + 5));
    const label = describeSelect(el);
    expect(label.isWellFormed()).toBe(true);
  });
});

describe("logNoSelectMatch", () => {
  it("emits one single-argument message carrying the label and nothing else", () => {
    const el = sel('<select name="pref"></select>');
    const calls: unknown[][] = [];
    const original = console.debug;
    console.debug = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      logNoSelectMatch(el);
    } finally {
      console.debug = original;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0][0]).toBe("[passwd-sso] No exact match for select: pref");
  });
});
