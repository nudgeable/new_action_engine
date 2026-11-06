import { describe, expect, it } from "vitest";
import {
  chartWeekCount,
  elapsedWeekCount,
  formatWeekRangeLabel,
  sharedWeekAnchor,
  weekAnchorFromIstDate,
  weekAnchorFromTimestamp,
  weekNumberFor,
  weekRangeIst,
} from "@/lib/cohort-week";

describe("weekAnchorFromTimestamp", () => {
  it("uses IST midnight of the delivery's IST calendar day", () => {
    // Surge's first delivery: Mon 24 Aug 2026 11:35 IST.
    const anchor = weekAnchorFromTimestamp("2026-08-24T06:05:07.560Z");
    expect(anchor.toISOString()).toBe("2026-08-23T18:30:00.000Z");
    expect(weekAnchorFromIstDate("2026-08-24").toISOString()).toBe(anchor.toISOString());
  });

  it("treats date-only strings as IST calendar dates, not UTC midnight", () => {
    expect(weekAnchorFromTimestamp("2026-08-20").toISOString()).toBe("2026-08-19T18:30:00.000Z");
  });
});

describe("weekNumberFor from first delivery", () => {
  const anchor = weekAnchorFromTimestamp("2026-08-24T06:05:07.560Z");

  it("keeps the workshop week and mid-week days in week 1", () => {
    expect(weekNumberFor(new Date("2026-08-24T06:05:07.560Z"), anchor)).toBe(1);
    expect(weekNumberFor(new Date("2026-08-27T05:47:00.000Z"), anchor)).toBe(1);
    expect(weekNumberFor(new Date("2026-08-30T18:29:59.000Z"), anchor)).toBe(1);
  });

  it("opens week 2 at IST midnight of the 8th calendar day", () => {
    expect(weekNumberFor(new Date("2026-08-30T18:30:00.000Z"), anchor)).toBe(2);
    expect(weekNumberFor(new Date("2026-08-31T06:00:00.000Z"), anchor)).toBe(2);
  });

  it("clamps dates before the first delivery to week 1", () => {
    expect(weekNumberFor(new Date("2026-08-20T00:00:00.000Z"), anchor)).toBe(1);
  });
});

describe("elapsedWeekCount", () => {
  const surgeAnchor = weekAnchorFromTimestamp("2026-08-24T06:05:07.560Z");

  it("stays at week 1 through the 7th IST calendar day", () => {
    expect(elapsedWeekCount([surgeAnchor], new Date("2026-08-30T18:29:59.000Z"))).toBe(1);
  });

  it("opens week 2 at IST midnight of the 8th calendar day", () => {
    expect(elapsedWeekCount([surgeAnchor], new Date("2026-08-31T04:23:00.000Z"))).toBe(2);
  });
});

describe("chartWeekCount", () => {
  const anchor = weekAnchorFromIstDate("2026-08-24");
  const anchors = new Map([["batch", anchor]]);
  const weekEleven = new Date("2026-11-05T06:00:00.000Z");
  const weekThree = new Date("2026-09-08T06:00:00.000Z");

  it("stops a finished batch at its programme length", () => {
    expect(chartWeekCount(anchors, new Map([["batch", 6]]), [], weekEleven)).toBe(6);
  });

  it("keeps real activity after the programme ended", () => {
    expect(chartWeekCount(anchors, new Map([["batch", 6]]), [1, 6, 7], weekEleven)).toBe(7);
  });

  it("keeps counting elapsed weeks when the batch has no programme length", () => {
    expect(chartWeekCount(anchors, new Map([["batch", null]]), [7], weekEleven)).toBe(11);
  });

  it("shows only elapsed weeks for a running batch", () => {
    expect(chartWeekCount(anchors, new Map([["batch", 6]]), [], weekThree)).toBe(3);
  });

  it("ignores data scheduled for weeks that have not started", () => {
    expect(chartWeekCount(anchors, new Map([["batch", 6]]), [5], weekThree)).toBe(3);
  });

  it("uses the longest batch when several are combined", () => {
    const both = new Map([
      ["finished", anchor],
      ["running", weekAnchorFromIstDate("2026-10-08")],
    ]);
    const limits = new Map([
      ["finished", 6],
      ["running", 6],
    ]);
    expect(chartWeekCount(both, limits, [], weekEleven)).toBe(6);
  });
});

describe("weekRangeIst from first delivery", () => {
  const anchor = weekAnchorFromTimestamp("2026-08-24T06:05:07.560Z");

  it("covers the delivery day through the 7th IST calendar day", () => {
    expect(weekRangeIst(1, anchor)).toEqual({ startIst: "2026-08-24", endIst: "2026-08-30" });
  });

  it("opens week 2 on the 8th IST calendar day", () => {
    expect(weekRangeIst(2, anchor)).toEqual({ startIst: "2026-08-31", endIst: "2026-09-06" });
  });
});

describe("formatWeekRangeLabel", () => {
  it("collapses a same-month range", () => {
    expect(formatWeekRangeLabel("2026-08-24", "2026-08-30")).toBe("24–30 Aug");
  });

  it("keeps both months when the week crosses a month boundary", () => {
    expect(formatWeekRangeLabel("2026-08-31", "2026-09-06")).toBe("31 Aug – 6 Sep");
  });
});

describe("sharedWeekAnchor", () => {
  it("returns the origin when every batch starts on the same IST day", () => {
    const a = weekAnchorFromIstDate("2026-08-24");
    const b = weekAnchorFromTimestamp("2026-08-24T06:05:07.560Z");
    expect(sharedWeekAnchor([a, b])?.toISOString()).toBe(a.toISOString());
  });

  it("returns null when batches start on different delivery days", () => {
    expect(
      sharedWeekAnchor([weekAnchorFromIstDate("2026-08-24"), weekAnchorFromIstDate("2026-09-01")])
    ).toBeNull();
  });
});
