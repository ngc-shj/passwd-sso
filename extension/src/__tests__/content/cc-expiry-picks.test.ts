// @vitest-environment jsdom
// Expiry role picks in detectCreditCardFields (#883): the format comes from the
// month/year fields nearest the card number, not from the page's first expiry
// match, and no role is taken from a non-card date field. Each row's comment
// names the review finding it pins; the mutation table in
// docs/archive/review/extension-detection-followups-plan.md maps rules to rows.
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { detectCreditCardFields } from "../../content/cc-field-detection-lib";

type Want = { month?: string | null; year?: string | null; combined?: string | null };

const o = (v: string) => `<option>${v}</option>`;

const CASES: [string, string, Want][] = [
  ["EN split labels", `<form><label>Card number <input name="card_number"></label><label>Expiry month <input name="exp_month"></label><label>Expiry year <input name="exp_year"></label><label>CVV <input name="cvv"></label></form>`, { month: "exp_month", year: "exp_year", combined: null }],
  ["underscore split", `<form><input name="card_number"><input name="expiry_mm"><input name="expiry_yy"><input name="cvv"></form>`, { month: "expiry_mm", year: "expiry_yy", combined: null }],
  ["Expiry date [MM]/[YY]", `<form><input name="card_number"><label>Expiry date <input name="m" placeholder="MM"></label> / <input name="y" placeholder="YY"><input name="cvv"></form>`, { month: "m", year: "y", combined: null }],
  ["JA split inputs", `<form><label>カード番号<input name="cn"></label><label>有効期限（月）<input name="em"></label><label>有効期限（年）<input name="ey"></label><label>セキュリティコード<input name="cvc"></label></form>`, { month: "em", year: "ey", combined: null }],
  ["JA 月/年 selects form", `<form><label>カード番号<input name="cn"></label>有効期限 <label>月<select name="sm">${o("1")}</select></label><label>年<select name="sy">${o("2030")}</select></label></form>`, { month: "sm", year: "sy", combined: null }],
  ["JA 月/年 selects divs", `<div><div><label>カード番号<input name="cn"></label></div><div>有効期限 <label>月<select name="sm">${o("1")}</select></label><label>年<select name="sy">${o("2030")}</select></label></div><label>セキュリティコード<input name="cvc"></label></div>`, { month: "sm", year: "sy", combined: null }],
  ["cc_month/cc_year", `<form><input name="cc_number"><input name="cc_month"><input name="cc_year"></form>`, { month: "cc_month", year: "cc_year", combined: null }],
  ["split then later Expiration date", `<form><input name="card_number"><label>Expiry month <input name="em"></label><label>Expiry year <input name="ey"></label><label>Expiration date <input name="ed"></label></form>`, { month: "em", year: "ey", combined: null }],
  ["expiry MM/YY", `<form><input name="card_number"><input name="expiry" placeholder="MM/YY"></form>`, { combined: "expiry", month: null, year: null }],
  ["expire MM/YY", `<form><input name="card_number"><input name="expire" placeholder="MM/YY"></form>`, { combined: "expire", month: null, year: null }],
  ["Expiry month/year single", `<form><input name="card_number"><label>Expiry month/year <input name="e"></label></form>`, { combined: "e", month: null, year: null }],
  ["Expiration date", `<form><input name="card_number"><label>Expiration date <input name="e"></label></form>`, { combined: "e", month: null, year: null }],
  ["JA 有効期限（月/年）", `<form><label>カード番号<input name="cn"></label><label>有効期限（月/年）<input name="e"></label></form>`, { combined: "e", month: null, year: null }],
  ["JA 2025年 placeholder", `<form><input name="card_number"><label>Expiry date (MM/YY) <input name="e" placeholder="2025年"></label></form>`, { combined: "e", month: null, year: null }],
  ["cc-exp MM / YY no autocomplete", `<form><input name="card_number"><input name="cc-exp" placeholder="MM / YY"></form>`, { combined: "cc-exp", month: null, year: null }],
  ["exp_mmyy -> nothing", `<form><input name="card_number"><input name="exp_mmyy"></form>`, { combined: null, month: null, year: null }],
  ["expMonth / expYr", `<form><input name="card_number"><input name="expMonth"><input name="expYr"></form>`, { month: "expMonth", year: null, combined: null }],
  ["exp_month select + expiry_yr input", `<form><input name="card_number"><label>Expiry month <select name="exp_month">${o("1")}</select></label><input name="expiry_yr"></form>`, { month: "exp_month", year: "expiry_yr", combined: null }],
  ["passport before cc_month form (separate form)", `<form><label>Passport expiry <input name="pp"></label></form><form><input name="cc_number"><input name="cc_month"><input name="cc_year"></form>`, { month: "cc_month", year: "cc_year", combined: null }],
  ["passport same flat form + cc_month", `<form><label>Passport expiry <input name="pp"></label><input name="cc_number"><input name="cc_month"><input name="cc_year"></form>`, { month: "cc_month", year: "cc_year", combined: null }],
  ["birth month before cc form (separate)", `<form><label>Birth month <input name="bm"></label></form><form><input name="cc_number"><input name="cc_month"><input name="cc_year"></form>`, { month: "cc_month", year: "cc_year", combined: null }],
  ["生年月日 before JA split (separate form)", `<form><label>生年月日<input name="dob"></label></form><form><label>カード番号<input name="cn"></label><label>有効期限（月）<input name="em"></label><label>有効期限（年）<input name="ey"></label></form>`, { month: "em", year: "ey", combined: null }],
  ["生年月日 same flat form JA split", `<form><label>生年月日<input name="dob"></label><label>カード番号<input name="cn"></label><label>有効期限（月）<input name="em"></label><label>有効期限（年）<input name="ey"></label></form>`, { month: "em", year: "ey", combined: null }],
  ["DOB selects EN + Expiry date same form", `<form><label>Birth month <select name="dob_month">${o("1")}</select></label><label>Birth year <select name="dob_year">${o("1990")}</select></label><input name="card_number"><label>Expiry date <input name="expiry"></label></form>`, { combined: "expiry", month: null, year: null }],
  ["JA DOB 月/年 selects + card_exp mm/yy same form", `<form><fieldset>生年月日 <label>年<select name="by">${o("1990")}</select></label><label>月<select name="bm">${o("1")}</select></label></fieldset><fieldset><label>カード番号<input name="cn"></label><label>有効期限 <input name="card_exp" placeholder="mm/yy"></label></fieldset></form>`, { combined: "card_exp", month: null, year: null }],
  ["JA DOB flat + card_exp mm/yy", `<form>生年月日 <label>年<select name="by">${o("1990")}</select></label><label>月<select name="bm">${o("1")}</select></label><label>カード番号<input name="cn"></label><label>有効期限 <input name="card_exp" placeholder="mm/yy"></label></form>`, { combined: "card_exp", month: null, year: null }],
  ["delivery date before expiry selects", `<form><label>Delivery date <input name="delivery_date" placeholder="YYYY/MM/DD"></label><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label><label>Expiry year <select name="ey">${o("2030")}</select></label></form>`, { month: "em", year: "ey", combined: null }],
  ["formless card, birth_month in another form in wrapper", `<div><form><label>月<select name="bm">${o("1")}</select></label><label>年<select name="by">${o("1990")}</select></label></form><div><input name="card_number"><label>CVC <input name="cvc"></label></div></div>`, { month: null, year: null, combined: null }],
  ["formless lone card + Month/Year selects + earlier birth_month", `<div><label>Birth month <select name="birth_month">${o("1")}</select></label></div><div><input name="card_number"><label>Month <select name="m">${o("1")}</select></label><label>Year <select name="y">${o("2030")}</select></label></div>`, { month: null, year: null, combined: null }],
  ["A flat DOB year select + [MM]/[YY]", `<form><label>Birth year <select name="birth_year">${o("1990")}</select></label><input name="card_number"><label>Expiry date <input name="m" placeholder="MM"></label> / <input name="y" placeholder="YY"><input name="cvv"></form>`, { month: "m", year: "y", combined: null }],
  ["A2 flat DOB yyyy input", `<form><label>Date of birth <input name="dob_yyyy" placeholder="YYYY"></label><input name="card_number"><label>Expiry month <input name="em"></label><input name="ey" placeholder="YY"><input name="cvv"></form>`, { month: "em", year: "ey", combined: null }],
  ["A2 select variant", `<form><label>Date of birth <select name="dob_yyyy">${o("1990")}</select></label><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label><select name="ey" aria-label="YY">${o("30")}</select><input name="cvv"></form>`, { month: "em", year: "ey", combined: null }],
  ["C year in next row", `<form><div class="row"><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label></div><div class="row"><label>Expiry year <select name="ey">${o("2030")}</select></label><input name="cvv"></div></form>`, { month: "em", year: "ey", combined: null }],
  ["P coupon expiry before combined", `<form><label>Coupon expiry date <input name="coupon_exp"></label><input name="card_number"><label>Expiry date <input name="expiry"></label></form>`, { combined: "expiry", month: null, year: null }],
  ["Q AC month + YY partner, DOB year earlier", `<form><label>Birth year <input name="byear"></label><input name="card_number"><input name="mm" autocomplete="cc-exp-month"><input name="yy" placeholder="YY"></form>`, { month: "mm", year: "yy", combined: null }],
  ["R combined in card row", `<form><div><input name="card_number"><label>Expiry <input name="exp" placeholder="MM/YY"></label></div><div><label>CVC<input name="cvc"></label></div></form>`, { combined: "exp", month: null, year: null }],
  ["P1 formless 誕生月 outside card form", `<div><label>誕生月<select name="bmonth">${o("1")}</select></label></div><form><input name="card_number"><label>Month <select name="m">${o("1")}</select></label><label>Year <select name="y">${o("2030")}</select></label></form>`, { month: null, year: null, combined: null }],
  ["P2 formless passport outside card form", `<div><label>Passport expiry <input name="pp"></label></div><form><input name="card_number"><label>Month <select name="m">${o("1")}</select></label><label>Year <select name="y">${o("2030")}</select></label></form>`, { month: null, year: null, combined: null }],
  ["P3 Birth year + Expiry month + unlabelled year", `<form><label>Birth year <select name="birth_year">${o("1990")}</select></label><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label><select name="x2">${o("2030")}</select></form>`, { month: "em", year: null, combined: null }],
  ["P4 Birth month + unlabelled + Expiry year", `<form><label>Birth month <select name="birth_month">${o("1")}</select></label><input name="card_number"><select name="x1">${o("1")}</select><label>Expiry year <select name="ey">${o("2030")}</select></label></form>`, { month: null, year: "ey", combined: null }],
  ["P5 formless SPA passport (known gap, as today)", `<div id="app"><section><label>Passport expiry <input name="pp"></label></section><section><input name="card_number"><label>CVC <input name="cvc"></label></section></div>`, { combined: "pp" }],
  ["P6 DOB + Expiry month only", `<form><label>DOB <select name="dob_y">${o("1990")}</select></label><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label></form>`, { month: "em", year: null, combined: null }],
  ["R4-T1 JA DOB fieldset vs card fieldset, context-free 月/年", `<form><fieldset>生年月日 <label>月<select name="bm">${o("1")}</select></label><label>年<select name="by">${o("1990")}</select></label></fieldset><fieldset><label>カード番号<input name="cn"></label>有効期限 <label>月<select name="sm">${o("1")}</select></label><label>年<select name="sy">${o("2030")}</select></label></fieldset></form>`, { month: "sm", year: "sy", combined: null }],
  ["R4-T2 both-parts field beside the month anchor is not the year", `<form><input name="card_number"><div><label>Expiry month <select name="em">${o("1")}</select></label><input name="dd" placeholder="YYYY/MM/DD"></div><input name="y2" placeholder="YY"></form>`, { month: "em", year: null, combined: null }],
  ["F-S16 AC month outside form; Birth year first in card form", `<select name="acm" autocomplete="cc-exp-month">${o("1")}</select><form><label>Birth year <select name="birth_year">${o("1990")}</select></label><input name="card_number"></form>`, { month: "acm", year: null }],
  ["F-S16b AC month outside form; bare [YY] first in card form", `<select name="acm" autocomplete="cc-exp-month">${o("1")}</select><form><input name="yy" placeholder="YY"><input name="card_number"></form>`, { month: "acm", year: null }],
  ["F-S17 Q4c Passport expiry (MM) select", `<form><input name="card_number"><label>Month <select name="m">${o("1")}</select></label><label>Year <select name="y">${o("2030")}</select></label><label>Passport expiry (MM) <select name="pm">${o("1")}</select></label></form>`, { month: null, year: null, combined: null }],
  ["F-S17 Q3 Birth year beside Expiry month", `<form><input name="card_number"><select name="uy">${o("2030")}</select><label>Expiry month <select name="em">${o("1")}</select></label><label>Birth year <select name="birth_year">${o("1990")}</select></label></form>`, { month: "em", year: null }],
  ["R5-F1 JA year-first", `<form><label>カード番号<input name="cn"></label><label>有効期限 年<select name="y">${o("2030")}</select></label><label>月<select name="m">${o("1")}</select></label></form>`, { month: "m", year: "y", combined: null }],
  ["R5-F2 passport pair after combined card expiry", `<form><input name="card_number"><label>Expiry date <input name="expiry" placeholder="MM/YY"></label><label>CVV <input name="cvv"></label><label>Passport expiry month <select name="pm">${o("1")}</select></label><label>Passport expiry year <select name="py">${o("2030")}</select></label></form>`, { combined: "expiry", month: null, year: null }],
  ["R5-F2 fieldsets", `<form><fieldset><input name="card_number"><label>Expiry date <input name="expiry" placeholder="MM/YY"></label></fieldset><fieldset><label>Passport expiry month <select name="pm">${o("1")}</select></label><label>Passport expiry year <select name="py">${o("2030")}</select></label></fieldset></form>`, { combined: "expiry", month: null, year: null }],
  ["R5-F3 expiry outside a form wrapping only the card number (SC3)", `<form id="f"><input name="card_number"></form><label>Expiry month <select name="em">${o("1")}</select></label><label>Expiry year <select name="ey">${o("2030")}</select></label>`, { month: null, year: null }],
  ["R5-T1 mixed select/input order", `<form><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label><input name="y2" placeholder="YY"><input name="other" placeholder="YY"></form>`, { month: "em", year: "y2" }],
  ["R5-T1b zz before select", `<form><input name="card_number"><input name="zz" placeholder="YY"><label>Expiry month <select name="em">${o("1")}</select></label><input name="y2" placeholder="YY"></form>`, { month: "em", year: "y2" }],
  ["R5-T2 tier-3 both-parts exclusion", `<form><label>カード番号<input name="cn"></label><label>生年月日<input name="dob"></label><label>月<select name="sm">${o("1")}</select></label><label>年<select name="sy">${o("2030")}</select></label></form>`, { month: "sm", year: "sy" }],
  ["R5-T3 depth key", `<form><fieldset>有効期限 <label>月<select name="sm">${o("1")}</select></label><label>年<select name="sy">${o("2030")}</select></label><label>カード番号<input name="cn"></label></fieldset><fieldset>生年月日 <label>月<select name="bm">${o("1")}</select></label><label>年<select name="by">${o("1990")}</select></label></fieldset></form>`, { month: "sm", year: "sy" }],
  ["R5-T4 combined must be an input", `<form><input name="card_number"><label>Expiry date <select name="ed">${o("1")}</select></label></form>`, { month: null, year: null, combined: null }],
  ["R5-T5 usual side preferred", `<form><input name="card_number"><input name="yb" placeholder="YY"><label>Expiry month <input name="em"></label><input name="ya" placeholder="YY"></form>`, { month: "em", year: "ya" }],
  ["R5-T6 nearest earlier candidate", `<form><label>Expiry month <input name="far"></label><input name="x"><label>Expiry month <input name="near"></label><input name="card_number"></form>`, { month: "near" }],
  ["F-S18 Q7 Arrival month beside Expiry year", `<form><input name="card_number"><select name="um">${o("1")}</select><label>Expiry year <select name="ey">${o("2030")}</select></label><label>Arrival month <select name="arr_m">${o("1")}</select></label></form>`, { month: null, year: "ey" }],
  ["F-S18 Q8 Graduation year before Expiry month", `<form><input name="card_number"><label>Graduation year <select name="grad_y">${o("2010")}</select></label><label>Expiry month <select name="em">${o("1")}</select></label><select name="uy">${o("2030")}</select></form>`, { month: "em", year: null }],
  ["F-S18 Q9 Check-in year after Expiry month", `<form><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label><label>Check-in year <select name="ci_y">${o("2026")}</select></label></form>`, { month: "em", year: null }],
  ["F-S18 Q12 Start month before Expiry year", `<form><input name="card_number"><label>Start month <select name="sm">${o("1")}</select></label><label>Expiry year <select name="ey">${o("2030")}</select></label><select name="um">${o("1")}</select></form>`, { month: null, year: "ey" }],
  ["R6-F1 Expiry month/year (required)", `<form><input name="card_number"><label>Expiry month/year (required) <input name="exp" placeholder="MM/YY"></label></form>`, { combined: "exp", month: null, year: null }],
  ["R6-F1 bracket name combined", `<form><input name="card_number"><label>Expiry month/year <input name="checkout[card_expiry]" placeholder="MM/YY"></label></form>`, { combined: "checkout[card_expiry]", month: null, year: null }],
  ["R6-F1 billing prefix combined", `<form><input name="card_number"><label>Expiry Month / Year <input name="billing_card_exp" placeholder="MM / YY"></label></form>`, { combined: "billing_card_exp", month: null, year: null }],
  ["R6-F1 Please enter expire MM/YY", `<form><input name="card_number"><label>Please enter expire MM/YY <input name="e"></label></form>`, { combined: "e", month: null, year: null }],
  ["R6-F2 bracket-namespaced split", `<form><input name="card_number"><input name="order[payment][expiry_mm]"><input name="order[payment][expiry_yy]"></form>`, { month: "order[payment][expiry_mm]", year: "order[payment][expiry_yy]", combined: null }],
  ["R6-F2 Expiry date (required) [MM][YY]", `<form><input name="card_number"><label>Expiry date (required) <input name="m" placeholder="MM"></label><input name="y" placeholder="YY"></form>`, { month: "m", year: "y", combined: null }],
  // Code review round 1.
  ["CR1 label[for] (MM/YY) over exp_month/exp_year selects", `<form><input name="card_number"><label for="em">Expiration date (MM/YY)</label><select id="em" name="exp_month">${o("1")}</select> / <select name="exp_year">${o("2030")}</select></form>`, { month: "exp_month", year: "exp_year", combined: null }],
  ["CR1 label[for] (MM / YYYY) over exp_month/exp_year inputs", `<form><input name="card_number"><label for="em">Expiry (MM / YYYY)</label><input id="em" name="exp_month"> <input name="exp_year"></form>`, { month: "exp_month", year: "exp_year", combined: null }],
  ["CR1 Valid thru (month/year) over ccmonth/ccyear selects", `<form><input name="card_number"><label for="cm">Valid thru (month/year)</label><select id="cm" name="ccmonth">${o("1")}</select><select name="ccyear">${o("2030")}</select></form>`, { month: "ccmonth", year: "ccyear", combined: null }],
  ["CR1 wrapping label with Month/Year option text", `<form><input name="card_number"><label>Expiration date <select name="exp_month"><option>Month</option>${o("01")}</select><select name="exp_year"><option>Year</option>${o("2030")}</select></label></form>`, { month: "exp_month", year: "exp_year", combined: null }],
  ["CR1 autocomplete month + exp_year in one wrapping label", `<form><input name="card_number"><label>Expiry <select name="m" autocomplete="cc-exp-month">${o("1")}</select><select name="exp_year">${o("2030")}</select></label></form>`, { month: "m", year: "exp_year", combined: null }],
  ["CR1 JA wrapping label 月/年 selects", `<form><label>カード番号<input name="cn"></label><label>有効期限 <select name="card_exp_month">${o("1")}</select>月 / <select name="card_exp_year">${o("2030")}</select>年</label></form>`, { month: "card_exp_month", year: "card_exp_year", combined: null }],
  ["CR1 form-less card: Year across another form is not the partner", `<div><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label></div><form><input name="newsletter"></form><section><fieldset><legend>Date of birth</legend><label>Year <input name="year"></label></fieldset></section>`, { month: "em", year: null }],
  ["CR1 same form: Year behind skipped controls is not the partner", `<form><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label><input type="checkbox" name="c"><input type="hidden" name="h"><textarea name="t"></textarea><label>Year <select name="year">${o("1990")}</select></label></form>`, { month: "em", year: null }],
  // Code review round 2.
  ["CR2 fromAutocomplete suppresses a nearer combined candidate", `<form><input name="card_number"><input name="expiry" placeholder="MM/YY"><select name="acm" autocomplete="cc-exp-month">${o("1")}</select><label>Expiry year <select name="ey">${o("2030")}</select></label></form>`, { month: "acm", year: "ey", combined: null }],
  ["CR2 CJK check keeps a passport label out of vocabulary", `<form><input name="card_number"><label>Month <select name="m">${o("1")}</select></label><label>Year <select name="y">${o("2030")}</select></label><label>パスポート有効期限 (MM) <select name="pm">${o("1")}</select></label></form>`, { month: null, year: null, combined: null }],
  ["CR2 month-only mentions excludes a combined claim", `<form><input name="card_number"><label>Passport expiry (MM) <input name="pm"></label></form>`, { month: null, year: null, combined: null }],
  // Code review round 2: a label naming another subject keeps its veto.
  ["CR3 passport pair labelled (MM/YY), no card expiry", `<form><input name="card_number"><label>Passport expiry (MM/YY) <input name="passport_exp_month"></label><label>Passport expiry (MM/YY) <input name="passport_exp_year"></label></form>`, { month: null, year: null }],
  ["CR3 id=card_month under Date of birth (MM/YYYY)", `<form><input name="card_number"><label>Date of birth (MM/YYYY) <input name="dob" id="card_month"></label></form>`, { month: null }],
  ["CR3 生年月日 selects with own birth_year/birth_month names", `<form><input name="card_number"><label>生年月日 <select name="birth_year">${o("1990")}</select>年<select name="birth_month">${o("1")}</select>月</label></form>`, { month: null, year: null }],
  ["CR3 有効期限（月） beside 生年月日（年） birth_year", `<form><label>カード番号<input name="cn"></label><label>有効期限（月）<select name="em">${o("1")}</select></label><label>生年月日（年）<select name="birth_year">${o("1990")}</select></label></form>`, { month: "em", year: null }],
  ["CR3 Expiry date (MM/YY) on exp_month input stays combined", `<form><input name="card_number"><label>Expiry date (MM/YY) <input name="exp_month"></label><label>CVV <input name="cvv"></label></form>`, { combined: "exp_month", month: null, year: null }],
  ["CR3 id cc-exp-month name expiry under Expiration (MM/YY) stays combined", `<form><input name="card_number"><label>Expiration (MM/YY) <input id="cc-exp-month" name="expiry"></label></form>`, { combined: "expiry", month: null, year: null }],
  // Each own attribute ownSinglePart reads, pinned on its own.
  ["CR3 own placeholder MM/YY under a (MM/YY) label", `<form><input name="card_number"><label for="em">Expiration date (MM/YY)</label><input id="em" name="a1" placeholder="MM"> <input name="a2" placeholder="YY"></form>`, { month: "a1", year: "a2", combined: null }],
  ["CR3 own id exp_month under a (MM/YY) label", `<form><input name="card_number"><label for="exp_month">Expiration date (MM/YY)</label><select id="exp_month" name="a1">${o("1")}</select> <select name="exp_year">${o("2030")}</select></form>`, { month: "a1", year: "exp_year", combined: null }],
  ["CR3 own aria-label Month under a (MM/YY) label", `<form><input name="card_number"><label for="x1">Expiration date (MM/YY)</label><select id="x1" name="a1" aria-label="Month">${o("1")}</select> <select name="exp_year">${o("2030")}</select></form>`, { month: "a1", year: "exp_year", combined: null }],
  ["CR3 a textarea between month and Year breaks adjacency", `<form><input name="card_number"><label>Expiry month <select name="em">${o("1")}</select></label><textarea name="t"></textarea><label>Year <select name="year">${o("2030")}</select></label></form>`, { month: "em", year: null }],
];

const name = (el: Element | null) => (el ? el.getAttribute("name") : null);

describe("detectCreditCardFields expiry picks", () => {
  // jsdom has no CSS.escape, so getHintString would skip <label for> text that
  // real browsers include; give it one for the label[for] rows.
  const hadCss = typeof CSS !== "undefined";
  beforeAll(() => {
    if (!hadCss) {
      (globalThis as { CSS?: { escape(v: string): string } }).CSS = {
        escape: (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
      };
    }
  });
  afterAll(() => {
    if (!hadCss) delete (globalThis as { CSS?: unknown }).CSS;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  for (const [title, html, want] of CASES) {
    it(title, () => {
      document.body.innerHTML = html;
      const fields = detectCreditCardFields(document);
      expect(fields).not.toBeNull();
      const got = {
        month: name(fields!.expiryMonth),
        year: name(fields!.expiryYear),
        combined: name(fields!.expiryCombined),
      };
      for (const key of Object.keys(want) as (keyof Want)[]) {
        expect(got[key], key).toBe(want[key]);
      }
    });
  }
});
