/**
 * @vitest-environment jsdom
 */
// C1 predicate pairs (#884): every deny case is paired with an allow case that
// differs on one axis only. Geometry comes from the global layout stub
// (helpers/layout-stub.ts): `data-rect="w,h,x,y"`, default 100×20 at (10, 10).
import { describe, it, expect, afterEach } from "vitest";
import {
  isFieldVisible,
  isNotSelfHidden,
  fillAdmission,
} from "../../content/field-query-lib";
import { setCheckVisibility } from "../helpers/layout-stub";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Renders `html` and returns the element with id "f". */
function field(html: string): HTMLElement {
  document.body.innerHTML = html;
  const el = document.getElementById("f");
  if (!el) throw new Error("fixture has no #f");
  return el;
}

const SELECT2_STYLE = "position:absolute; clip:rect(0px, 0px, 0px, 0px)";

describe("isFieldVisible — R1: display / content-visibility on the element or an ancestor", () => {
  it("denies a field whose ancestor is display:none", () => {
    expect(isFieldVisible(field(`<div style="display:none"><input id="f"></div>`))).toBe(false);
  });

  it("allows the same field under a display:block ancestor", () => {
    expect(isFieldVisible(field(`<div style="display:block"><input id="f"></div>`))).toBe(true);
  });

  it("denies a field in a shadow root whose host is display:none (inline style)", () => {
    document.body.innerHTML = `<div id="host" style="display:none"></div>`;
    const host = document.getElementById("host") as HTMLElement;
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).appendChild(input);
    expect(isFieldVisible(input)).toBe(false);
  });

  it("allows a field in a shadow root whose host is displayed", () => {
    document.body.innerHTML = `<div id="host" style="display:block"></div>`;
    const host = document.getElementById("host") as HTMLElement;
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).appendChild(input);
    expect(isFieldVisible(input)).toBe(true);
  });

  it("denies a field whose ancestor is content-visibility:hidden", () => {
    expect(
      isFieldVisible(field(`<div style="content-visibility:hidden"><input id="f"></div>`)),
    ).toBe(false);
  });

  it("allows a field whose ancestor is content-visibility:visible", () => {
    expect(
      isFieldVisible(field(`<div style="content-visibility:visible"><input id="f"></div>`)),
    ).toBe(true);
  });
});

describe("isFieldVisible — R2: the element's own computed visibility", () => {
  it("denies a field that inherits visibility:hidden from its parent", () => {
    expect(isFieldVisible(field(`<div style="visibility:hidden"><input id="f"></div>`))).toBe(false);
  });

  it("allows a visibility:visible child under a visibility:hidden parent", () => {
    expect(
      isFieldVisible(
        field(`<div style="visibility:hidden"><input id="f" style="visibility:visible"></div>`),
      ),
    ).toBe(true);
  });
});

describe("isFieldVisible — R3: opacity multiplied down the ancestor chain", () => {
  it("denies 0.2 × 0.2 (0.04)", () => {
    expect(
      isFieldVisible(field(`<div style="opacity:0.2"><input id="f" style="opacity:0.2"></div>`)),
    ).toBe(false);
  });

  it("allows 0.5 × 0.5 (0.25)", () => {
    expect(
      isFieldVisible(field(`<div style="opacity:0.5"><input id="f" style="opacity:0.5"></div>`)),
    ).toBe(true);
  });

  it("denies an opacity:0 password input (the former isElementVisuallySafe case)", () => {
    expect(isFieldVisible(field(`<input id="f" type="password" style="opacity:0">`))).toBe(false);
  });

  it("transparentOk allows an opacity:0 input", () => {
    expect(
      isFieldVisible(field(`<input id="f" style="opacity:0">`), { transparentOk: true }),
    ).toBe(true);
  });

  it("transparentOk does not lift the display rule", () => {
    expect(
      isFieldVisible(field(`<div style="display:none"><input id="f" style="opacity:0"></div>`), {
        transparentOk: true,
      }),
    ).toBe(false);
  });
});

describe("isFieldVisible — R4: the rect clipped per axis by its ancestors", () => {
  it("denies a 3×20 field", () => {
    expect(isFieldVisible(field(`<input id="f" data-rect="3,20,10,10">`))).toBe(false);
  });

  it("allows a 4×4 field", () => {
    expect(isFieldVisible(field(`<input id="f" data-rect="4,4,10,10">`))).toBe(true);
  });

  it("denies a 0×0 field", () => {
    expect(isFieldVisible(field(`<input id="f" data-rect="0,0,10,10">`))).toBe(false);
  });

  it("denies a field under a zero-width overflow-x:hidden ancestor", () => {
    expect(
      isFieldVisible(
        field(`<div style="overflow-x:hidden" data-rect="0,200,10,0"><input id="f"></div>`),
      ),
    ).toBe(false);
  });

  it("denies a field under a zero-height overflow-y:hidden ancestor", () => {
    expect(
      isFieldVisible(
        field(`<div style="overflow-y:hidden" data-rect="300,0,0,10"><input id="f"></div>`),
      ),
    ).toBe(false);
  });

  it("denies a field lying left of an overflow-x:hidden ancestor's box", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:hidden" data-rect="300,200,200,0"><input id="f" data-rect="100,20,50,10"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("denies a field lying above an overflow-y:hidden ancestor's box", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-y:hidden" data-rect="300,200,0,200"><input id="f" data-rect="100,20,10,50"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("allows the same field inside the overflow:hidden ancestor's box", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0"><input id="f" data-rect="100,20,50,50"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("allows a field under a zero-size ancestor whose overflow is visible on both axes", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:visible; overflow-y:visible" data-rect="0,0,0,0"><input id="f"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("denies a field under a zero-size paint-contained (contain:paint) ancestor", () => {
    expect(
      isFieldVisible(field(`<div style="contain:paint" data-rect="0,0,0,0"><input id="f"></div>`)),
    ).toBe(false);
  });

  it("skips a display:contents ancestor (its own box does not clip)", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="display:contents; overflow-x:hidden; overflow-y:hidden" data-rect="0,0,0,0"><input id="f"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("the same zero-size clipping ancestor as a block denies", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="display:block; overflow-x:hidden; overflow-y:hidden" data-rect="0,0,0,0"><input id="f"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("a position:fixed field escapes a zero-size clipping ancestor", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="0,0,0,0"><input id="f" style="position:fixed"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("a position:fixed wrapper stops the walk below an outer zero-size clip", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="0,0,0,0"><div style="position:fixed"><input id="f"></div></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("denies a field in an overflow-y:auto pane whose window is 2px tall", () => {
    expect(
      isFieldVisible(
        field(`<div style="overflow-y:auto" data-rect="300,2,0,0"><input id="f"></div>`),
      ),
    ).toBe(false);
  });

  it("denies a field in an overflow-y:auto pane of height 0", () => {
    expect(
      isFieldVisible(
        field(`<div style="overflow-y:auto" data-rect="300,0,0,0"><input id="f"></div>`),
      ),
    ).toBe(false);
  });

  it("allows a field below the fold of a normal overflow-y:auto pane", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-y:auto" data-rect="300,200,0,0"><input id="f" data-rect="100,20,10,5000"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("allows a field below the fold of an inner auto pane under an outer overflow:hidden wrapper", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0">` +
            `<div style="overflow-y:auto" data-rect="300,200,0,0"><input id="f" data-rect="100,20,10,5000"></div>` +
            `</div>`,
        ),
      ),
    ).toBe(true);
  });

  it("denies the same below-the-fold field under the overflow:hidden wrapper without the inner pane", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0">` +
            `<div data-rect="300,200,0,0"><input id="f" data-rect="100,20,10,5000"></div>` +
            `</div>`,
        ),
      ),
    ).toBe(false);
  });

  it("denies a field in an overflow-x:scroll pane whose window is 3px wide", () => {
    expect(
      isFieldVisible(
        field(`<div style="overflow-x:scroll" data-rect="3,200,0,0"><input id="f"></div>`),
      ),
    ).toBe(false);
  });

  it("allows a field right of the fold of a normal overflow-x:scroll pane", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:scroll" data-rect="300,200,0,0"><input id="f" data-rect="100,20,5000,10"></div>`,
        ),
      ),
    ).toBe(true);
  });
});

describe("isFieldVisible — R5: wholly before the document origin", () => {
  it("denies a field whose right edge is at 0", () => {
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,-100,10">`))).toBe(false);
  });

  it("allows a field whose right edge is at 1", () => {
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,-99,10">`))).toBe(true);
  });

  it("denies a field whose bottom edge is at 0", () => {
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,10,-20">`))).toBe(false);
  });

  it("allows a field whose bottom edge is at 1", () => {
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,10,-19">`))).toBe(true);
  });

  it("denies a position:fixed field placed beyond the viewport's right edge", () => {
    expect(
      isFieldVisible(
        field(`<input id="f" style="position:fixed" data-rect="100,20,${window.innerWidth},10">`),
      ),
    ).toBe(false);
  });

  it("denies a position:fixed field placed beyond the viewport's bottom edge", () => {
    expect(
      isFieldVisible(
        field(`<input id="f" style="position:fixed" data-rect="100,20,10,${window.innerHeight}">`),
      ),
    ).toBe(false);
  });

  it("allows a position:fixed field inside the viewport", () => {
    expect(
      isFieldVisible(
        field(
          `<input id="f" style="position:fixed" data-rect="100,20,${window.innerWidth - 1},${window.innerHeight - 1}">`,
        ),
      ),
    ).toBe(true);
  });

  it("a non-fixed field far right of the viewport stays allowed (it can be scrolled to)", () => {
    expect(
      isFieldVisible(field(`<input id="f" data-rect="100,20,${window.innerWidth + 500},10">`)),
    ).toBe(true);
  });
});

describe("isFieldVisible — R6: clip / clip-path that paints nothing", () => {
  it("denies an absolutely positioned field with clip: rect(0px, 0px, 0px, 0px)", () => {
    expect(
      isFieldVisible(field(`<input id="f" style="position:absolute; clip:rect(0px, 0px, 0px, 0px)">`)),
    ).toBe(false);
  });

  it("allows a static field with the same clip (clip applies to absolute/fixed only)", () => {
    expect(
      isFieldVisible(field(`<input id="f" style="position:static; clip:rect(0px, 0px, 0px, 0px)">`)),
    ).toBe(true);
  });

  it("denies a field whose ancestor is clipped (absolute + clip)", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="position:absolute; clip:rect(0px, 0px, 0px, 0px)"><input id="f"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("denies a field whose ancestor has clip-path: inset(100%)", () => {
    expect(
      isFieldVisible(field(`<div style="clip-path:inset(100%)"><input id="f"></div>`)),
    ).toBe(false);
  });

  it("denies a field whose ancestor has clip-path: inset(50%)", () => {
    expect(
      isFieldVisible(field(`<div style="clip-path:inset(50%)"><input id="f"></div>`)),
    ).toBe(false);
  });

  it("denies a field whose ancestor has clip-path: circle(0)", () => {
    expect(
      isFieldVisible(field(`<div style="clip-path:circle(0)"><input id="f"></div>`)),
    ).toBe(false);
  });

  it("denies a field whose ancestor has clip-path: inset(100% 0 0) (top inset covers it)", () => {
    expect(
      isFieldVisible(field(`<div style="clip-path:inset(100% 0px 0px)"><input id="f"></div>`)),
    ).toBe(false);
  });

  it("allows a field whose ancestor has clip-path: inset(50% 0 0) (bottom half painted)", () => {
    expect(
      isFieldVisible(field(`<div style="clip-path:inset(50% 0px 0px)"><input id="f"></div>`)),
    ).toBe(true);
  });

  it("allows a field whose ancestor has clip-path: inset(10%)", () => {
    expect(
      isFieldVisible(field(`<div style="clip-path:inset(10%)"><input id="f"></div>`)),
    ).toBe(true);
  });
});

describe("isFieldVisible — R7: checkVisibility can only deny", () => {
  it("denies an otherwise visible field when checkVisibility returns false", () => {
    setCheckVisibility(() => false);
    expect(isFieldVisible(field(`<input id="f">`))).toBe(false);
  });

  it("allows it when checkVisibility returns true", () => {
    setCheckVisibility(() => true);
    expect(isFieldVisible(field(`<input id="f">`))).toBe(true);
  });

  it("allows it when checkVisibility is undefined", () => {
    setCheckVisibility(undefined);
    expect(isFieldVisible(field(`<input id="f">`))).toBe(true);
  });

  it("checkVisibility returning true does not lift another rule", () => {
    setCheckVisibility(() => true);
    expect(isFieldVisible(field(`<input id="f" data-rect="0,0,10,10">`))).toBe(false);
  });

  it("denies a field in a closed <details> with checkVisibility undefined (the zero rect alone)", () => {
    setCheckVisibility(undefined);
    expect(
      isFieldVisible(field(`<details><summary>Pay</summary><input id="f"></details>`)),
    ).toBe(false);
  });

  it("allows the same field once the <details> is open", () => {
    setCheckVisibility(undefined);
    expect(
      isFieldVisible(field(`<details open><summary>Pay</summary><input id="f"></details>`)),
    ).toBe(true);
  });

  it("asks checkVisibility for opacityProperty unless transparentOk", () => {
    const seen: unknown[] = [];
    setCheckVisibility(function (opts) {
      seen.push(opts?.opacityProperty);
      return true;
    });
    const el = field(`<input id="f">`);
    isFieldVisible(el);
    isFieldVisible(el, { transparentOk: true });
    expect(seen).toEqual([true, false]);
  });
});

describe("isFieldVisible — geometryExempt", () => {
  const select2 = `<select id="f" style="${SELECT2_STYLE}" data-rect="1,1,0,0"><option>a</option></select>`;

  it("denies a Select2-style hidden select without the exemption", () => {
    expect(isFieldVisible(field(select2))).toBe(false);
  });

  it("allows the same select with geometryExempt", () => {
    expect(isFieldVisible(field(select2), { geometryExempt: true })).toBe(true);
  });

  it("geometryExempt does not lift a display:none ancestor", () => {
    expect(
      isFieldVisible(field(`<div style="display:none">${select2}</div>`), { geometryExempt: true }),
    ).toBe(false);
  });

  it("geometryExempt does not lift a closed <details> (checkVisibility denies)", () => {
    expect(
      isFieldVisible(field(`<details><summary>s</summary>${select2}</details>`), {
        geometryExempt: true,
      }),
    ).toBe(false);
  });

  it("geometryExempt does not lift the opacity rule", () => {
    expect(
      isFieldVisible(field(`<div style="opacity:0.01">${select2}</div>`), { geometryExempt: true }),
    ).toBe(false);
  });
});

describe("fillAdmission", () => {
  it("admits a Select2-style hidden select (roles are not known at admission)", () => {
    const el = field(
      `<select id="f" style="${SELECT2_STYLE}" data-rect="1,1,0,0"><option>a</option></select>`,
    ) as HTMLSelectElement;
    expect(fillAdmission()(el)).toBe(true);
  });

  it("does not admit an input with the same geometry", () => {
    const el = field(`<input id="f" style="${SELECT2_STYLE}" data-rect="1,1,0,0">`) as HTMLInputElement;
    expect(fillAdmission()(el)).toBe(false);
  });

  it("records the fields it rejects, and only those", () => {
    document.body.innerHTML = `<input id="shown"><div style="display:none"><input id="hid"></div>`;
    const hidden = new WeakSet<Element>();
    const admit = fillAdmission(hidden);
    const shown = document.getElementById("shown") as HTMLInputElement;
    const hid = document.getElementById("hid") as HTMLInputElement;
    admit(shown);
    admit(hid);
    expect([hidden.has(shown), hidden.has(hid)]).toEqual([false, true]);
  });

  it("a new admission sees a style change made after an earlier one", () => {
    document.body.innerHTML = `<div id="wrap" style="display:none"><input id="f"></div>`;
    const el = document.getElementById("f") as HTMLInputElement;
    expect(fillAdmission()(el)).toBe(false);
    (document.getElementById("wrap") as HTMLElement).style.display = "block";
    expect(fillAdmission()(el)).toBe(true);
  });
});

describe("isNotSelfHidden — the element's own style only", () => {
  it("denies its own display:none", () => {
    expect(isNotSelfHidden(field(`<input id="f" style="display:none">`))).toBe(false);
  });

  it("denies its own visibility:hidden", () => {
    expect(isNotSelfHidden(field(`<input id="f" style="visibility:hidden">`))).toBe(false);
  });

  it("denies its own opacity:0", () => {
    expect(isNotSelfHidden(field(`<input id="f" style="opacity:0">`))).toBe(false);
  });

  it("allows a field hidden only by a display:none ancestor", () => {
    expect(isNotSelfHidden(field(`<div style="display:none"><input id="f"></div>`))).toBe(true);
  });

  it("allows a zero-rect field", () => {
    expect(isNotSelfHidden(field(`<input id="f" data-rect="0,0,0,0">`))).toBe(true);
  });
});
