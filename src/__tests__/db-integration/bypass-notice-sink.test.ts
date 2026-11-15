import { describe, it, expect, afterEach } from "vitest";
import { BYPASS_REPORT_KIND } from "@/lib/db/pool-factory";
import {
  bypassNoticeBuffer,
  bypassRefusalBuffer,
  failOnReports,
  recordBypassNotice,
} from "./bypass-notice-sink";

afterEach(() => {
  bypassNoticeBuffer().length = 0;
  bypassRefusalBuffer().length = 0;
});

describe("recordBypassNotice", () => {
  it("routes a warning to the warning buffer, without its kind", () => {
    recordBypassNotice({ kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" });
    expect(bypassNoticeBuffer()).toEqual([{ table: "sessions", purpose: "auth_flow" }]);
    expect(bypassRefusalBuffer()).toEqual([]);
  });

  it("routes a refusal to the refusal buffer, without its kind", () => {
    recordBypassNotice({ kind: BYPASS_REPORT_KIND.REFUSAL, table: "users", purpose: "system_maintenance" });
    expect(bypassRefusalBuffer()).toEqual([{ table: "users", purpose: "system_maintenance" }]);
    expect(bypassNoticeBuffer()).toEqual([]);
  });
});

describe("failOnReports", () => {
  it("throws, naming expectBypassNotices, when a warning was not taken", () => {
    recordBypassNotice({ kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" });
    expect(() => failOnReports("in this test")).toThrow(/sessions \(purpose auth_flow\).*expectBypassNotices/s);
  });

  it("throws, naming both refusal helpers, when a refusal was not taken", () => {
    recordBypassNotice({ kind: BYPASS_REPORT_KIND.REFUSAL, table: "users", purpose: "auth_flow" });
    expect(() => failOnReports("in this test")).toThrow(
      /users \(purpose auth_flow\).*expectBypassRefusal.*expectSwallowedBypassRefusal/s,
    );
  });

  it("does not throw when both buffers are empty", () => {
    expect(() => failOnReports("in this test")).not.toThrow();
  });

  it("empties both buffers", () => {
    recordBypassNotice({ kind: BYPASS_REPORT_KIND.WARNING, table: "sessions", purpose: "auth_flow" });
    recordBypassNotice({ kind: BYPASS_REPORT_KIND.REFUSAL, table: "users", purpose: "auth_flow" });
    expect(() => failOnReports("in this test")).toThrow();
    expect(bypassNoticeBuffer()).toEqual([]);
    expect(bypassRefusalBuffer()).toEqual([]);
  });
});
