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
import { setCheckVisibility, setWindowScroll } from "../helpers/layout-stub";

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

  it("allows a field right of the fold of an inner scroll pane under an outer overflow:hidden wrapper", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="300,200,0,0">` +
            `<div style="overflow-x:scroll" data-rect="300,200,0,0"><input id="f" data-rect="100,20,5000,10"></div>` +
            `</div>`,
        ),
      ),
    ).toBe(true);
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

  it("denies a field in an overflow-x:auto pane of width 0", () => {
    expect(
      isFieldVisible(
        field(`<div style="overflow-x:auto" data-rect="0,200,0,0"><input id="f"></div>`),
      ),
    ).toBe(false);
  });
});

describe("isFieldVisible — R4: overflow:clip and paint containment clip strictly", () => {
  it.each([
    ["overflow-x:clip", "300,200,0,0", `data-rect="100,20,5000,10"`],
    ["overflow-y:clip", "300,200,0,0", `data-rect="100,20,10,5000"`],
    ["contain:strict", "0,0,0,0", ""],
    ["contain:content", "0,0,0,0", ""],
    ["content-visibility:auto", "0,0,0,0", ""],
  ])("denies a field clipped away by an ancestor with %s", (style, rect, fieldAttrs) => {
    expect(
      isFieldVisible(field(`<div style="${style}" data-rect="${rect}"><input id="f" ${fieldAttrs}></div>`)),
    ).toBe(false);
  });

  it.each([
    ["overflow-x:visible", "300,200,0,0", `data-rect="100,20,5000,10"`],
    ["overflow-y:visible", "300,200,0,0", `data-rect="100,20,10,5000"`],
    ["contain:size", "0,0,0,0", ""],
    ["contain:none", "0,0,0,0", ""],
    ["content-visibility:visible", "0,0,0,0", ""],
  ])("allows the same field under an ancestor with %s", (style, rect, fieldAttrs) => {
    expect(
      isFieldVisible(field(`<div style="${style}" data-rect="${rect}"><input id="f" ${fieldAttrs}></div>`)),
    ).toBe(true);
  });
});

// A field wholly before a scroll container's scroll origin can never be
// scrolled to: overflow runs right (LTR) or left (RTL) and down only.
describe("isFieldVisible — R4: the scroll origin of a scroll container", () => {
  it("denies a field placed at left:-9999px inside an overflow-x:auto pane", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:auto" data-rect="300,200,0,0"><input id="f" data-rect="100,20,-9999,10"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("denies a field whose right edge is at the pane's scroll origin", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:auto" data-rect="300,200,0,0"><input id="f" data-rect="100,20,-100,10"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("allows a field whose right edge is 1px past the pane's scroll origin", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:auto" data-rect="300,200,0,0"><input id="f" data-rect="100,20,-99,10"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("allows a scrolled carousel's first slide (content offset 0, scrollLeft 300)", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:auto" data-rect="300,200,10,0" data-scroll="300,0"><input id="f" data-rect="100,20,-290,10"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("denies a field wholly before a scrolled carousel's content origin", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:auto" data-rect="300,200,10,0" data-scroll="300,0"><input id="f" data-rect="100,20,-390,10"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("RTL: allows content left of the window (overflow runs left)", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:auto; direction:rtl" data-rect="300,200,0,0" data-scroll="-200,0"><input id="f" data-rect="100,20,-500,10"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("RTL: denies content wholly right of the scroll origin", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:auto; direction:rtl" data-rect="300,200,0,0" data-scroll="-200,0"><input id="f" data-rect="100,20,500,10"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("RTL: allows content whose left edge is 1px before the scroll origin", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-x:auto; direction:rtl" data-rect="300,200,0,0" data-scroll="-200,0"><input id="f" data-rect="100,20,499,10"></div>`,
        ),
      ),
    ).toBe(true);
  });

  // Pane top 100, scrollTop 50: the content origin is at y = 50.
  it("denies a field whose bottom edge is at a scrolled pane's content origin", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-y:auto" data-rect="300,200,0,100" data-scroll="0,50"><input id="f" data-rect="100,20,10,30"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("allows a field whose bottom edge is 1px past a scrolled pane's content origin", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="overflow-y:auto" data-rect="300,200,0,100" data-scroll="0,50"><input id="f" data-rect="100,20,10,31"></div>`,
        ),
      ),
    ).toBe(true);
  });
});

// Which ancestors clip a positioned box follows its containing-block chain.
describe("isFieldVisible — R4: the containing-block chain", () => {
  const CLIP = "overflow-x:hidden; overflow-y:hidden";

  it.each([
    ["transform", "transform:translateX(0px)"],
    ["contain:paint", "contain:paint"],
    ["filter", "filter:blur(0px)"],
    ["will-change:transform", "will-change:transform"],
  ])("denies a fixed field under a zero-size clip that %s makes its containing block", (_label, extra) => {
    expect(
      isFieldVisible(
        field(
          `<div style="${CLIP}; ${extra}" data-rect="0,0,0,0"><input id="f" style="position:fixed"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("allows the same fixed field under the same clip without a transform", () => {
    expect(
      isFieldVisible(
        field(`<div style="${CLIP}" data-rect="0,0,0,0"><input id="f" style="position:fixed"></div>`),
      ),
    ).toBe(true);
  });

  it("allows an absolute field under a static zero-size clip (not its containing block)", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="${CLIP}; position:static" data-rect="0,0,0,0"><input id="f" style="position:absolute"></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("denies an absolute field under a position:relative zero-size clip", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="${CLIP}; position:relative" data-rect="0,0,0,0"><input id="f" style="position:absolute"></div>`,
        ),
      ),
    ).toBe(false);
  });

  // Fail-safe: any containing-block trigger off its initial value keeps the
  // ancestor's clip, for an absolute and for a fixed field.
  it.each([
    ["translate", "translate:1px 0px"],
    ["rotate", "rotate:1deg"],
    ["scale", "scale:2"],
    ["transform-style", "transform-style:preserve-3d"],
    ["container-type", "container-type:inline-size"],
    ["content-visibility", "content-visibility:auto"],
    ["will-change (any value)", "will-change:opacity"],
  ])("denies an absolute field under a static zero-size clip that %s makes its containing block", (_label, extra) => {
    expect(
      isFieldVisible(
        field(
          `<div style="${CLIP}; position:static; ${extra}" data-rect="0,0,0,0"><input id="f" style="position:absolute"></div>`,
        ),
      ),
    ).toBe(false);
  });

  it.each([
    ["translate", "translate:1px 0px"],
    ["container-type", "container-type:inline-size"],
  ])("denies a fixed field under a zero-size clip that %s makes its containing block", (_label, extra) => {
    expect(
      isFieldVisible(
        field(`<div style="${CLIP}; ${extra}" data-rect="0,0,0,0"><input id="f" style="position:fixed"></div>`),
      ),
    ).toBe(false);
  });

  // An inline box is skipped for clipping, never for the containing-block
  // transition: a positioned span still ends an absolute field's escape.
  it("denies an absolute field whose containing block is an inline position:relative span under a static clip", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="${CLIP}" data-rect="0,0,0,0"><span style="position:relative"><input id="f" style="position:absolute"></span></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("allows an absolute field under a static span and a static zero-size clip", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="${CLIP}" data-rect="0,0,0,0"><span><input id="f" style="position:absolute"></span></div>`,
        ),
      ),
    ).toBe(true);
  });

  it("denies a fixed field whose containing block is an inline span with a filter under a clip", () => {
    expect(
      isFieldVisible(
        field(
          `<div style="${CLIP}" data-rect="0,0,0,0"><span style="filter:blur(0px)"><input id="f" style="position:fixed"></span></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("allows a fixed field under a plain inline span and a zero-size clip", () => {
    expect(
      isFieldVisible(
        field(`<div style="${CLIP}" data-rect="0,0,0,0"><span><input id="f" style="position:fixed"></span></div>`),
      ),
    ).toBe(true);
  });

  it("denies an in-flow field under the static zero-size clip", () => {
    expect(
      isFieldVisible(
        field(`<div style="${CLIP}; position:static" data-rect="0,0,0,0"><input id="f"></div>`),
      ),
    ).toBe(false);
  });
});

// The walk follows the flat tree: a slotted field is clipped by the shadow tree
// around its slot. jsdom ignores shadow stylesheets, so the wrapper is styled
// inline.
describe("isFieldVisible — R4: a slotted field", () => {
  function slotted(shadowHtml: string): HTMLElement {
    document.body.innerHTML = `<div id="host"><input id="f"></div>`;
    (document.getElementById("host") as HTMLElement).attachShadow({ mode: "open" }).innerHTML =
      shadowHtml;
    const el = document.getElementById("f") as HTMLElement;
    expect(el.assignedSlot).not.toBeNull();
    return el;
  }

  it("denies a field slotted into a zero-size clipping wrapper", () => {
    expect(
      isFieldVisible(
        slotted(
          `<div style="overflow-x:hidden; overflow-y:hidden" data-rect="0,0,0,0"><slot></slot></div>`,
        ),
      ),
    ).toBe(false);
  });

  it("allows the same field slotted with no wrapper around the slot", () => {
    expect(isFieldVisible(slotted(`<slot></slot>`))).toBe(true);
  });
});

// Overflow does not apply to an inline box, and Chrome reports its client size
// as 0, so an inline ancestor with a computed overflow clips nothing.
describe("isFieldVisible — R4: an inline ancestor", () => {
  it("allows a field inside an inline <label> with overflow-y:auto", () => {
    expect(
      isFieldVisible(
        field(`<label style="overflow-y:auto" data-rect="0,0,0,0">Card <input id="f"></label>`),
      ),
    ).toBe(true);
  });

  it("denies the same field when the <label> is display:block", () => {
    expect(
      isFieldVisible(
        field(
          `<label style="display:block; overflow-y:auto" data-rect="0,0,0,0">Card <input id="f"></label>`,
        ),
      ),
    ).toBe(false);
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

  it("denies a position:fixed field whose right edge is at 0", () => {
    expect(
      isFieldVisible(field(`<input id="f" style="position:fixed" data-rect="100,20,-100,10">`)),
    ).toBe(false);
  });

  it("allows a position:fixed field whose right edge is at 1", () => {
    expect(
      isFieldVisible(field(`<input id="f" style="position:fixed" data-rect="100,20,-99,10">`)),
    ).toBe(true);
  });

  it("denies a position:fixed field whose bottom edge is at 0", () => {
    expect(
      isFieldVisible(field(`<input id="f" style="position:fixed" data-rect="100,20,10,-20">`)),
    ).toBe(false);
  });

  it("allows a position:fixed field whose bottom edge is at 1", () => {
    expect(
      isFieldVisible(field(`<input id="f" style="position:fixed" data-rect="100,20,10,-19">`)),
    ).toBe(true);
  });

  it("a non-fixed field far right of the viewport stays allowed (it can be scrolled to)", () => {
    expect(
      isFieldVisible(field(`<input id="f" data-rect="100,20,${window.innerWidth + 500},10">`)),
    ).toBe(true);
  });
});

// The document origin is at -scrollX / -scrollY in viewport coordinates.
describe("isFieldVisible — R5: the page's scroll offset", () => {
  it("allows a field 500px above the viewport when the page is scrolled down 1000px", () => {
    setWindowScroll(0, 1000);
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,10,-500">`))).toBe(true);
  });

  it("denies the same field when the page is not scrolled", () => {
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,10,-500">`))).toBe(false);
  });

  it("denies a field whose bottom edge is at the scrolled document origin", () => {
    setWindowScroll(0, 1000);
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,10,-1020">`))).toBe(false);
  });

  it("allows a field whose bottom edge is 1px past the scrolled document origin", () => {
    setWindowScroll(0, 1000);
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,10,-1019">`))).toBe(true);
  });

  it("denies a field whose right edge is at the horizontally scrolled document origin", () => {
    setWindowScroll(1000, 0);
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,-1100,10">`))).toBe(false);
  });

  it("allows a field whose right edge is 1px past the horizontally scrolled document origin", () => {
    setWindowScroll(1000, 0);
    expect(isFieldVisible(field(`<input id="f" data-rect="100,20,-1099,10">`))).toBe(true);
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
