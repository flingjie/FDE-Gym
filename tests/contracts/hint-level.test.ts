import { describe, expect, it } from "vitest";

import { parseHintLevel } from "../../src/cli/hint-level";
import { localize } from "../../src/cli/render";

describe("parseHintLevel", () => {
  it("treats a missing flag as auto-escalate", () => {
    expect(parseHintLevel(undefined)).toEqual({ ok: true, level: undefined });
  });

  it("accepts 1, 2, and 3", () => {
    expect(parseHintLevel("1")).toEqual({ ok: true, level: 1 });
    expect(parseHintLevel("2")).toEqual({ ok: true, level: 2 });
    expect(parseHintLevel("3")).toEqual({ ok: true, level: 3 });
  });

  it("rejects 4, foo, empty string, and non-strings", () => {
    expect(parseHintLevel("4")).toEqual({ ok: false });
    expect(parseHintLevel("foo")).toEqual({ ok: false });
    expect(parseHintLevel("")).toEqual({ ok: false });
    expect(parseHintLevel(true)).toEqual({ ok: false });
  });
});

describe("HINT_INVALID_LEVEL copy", () => {
  it("localizes differently in zh-CN and en-US", () => {
    expect(localize("HINT_INVALID_LEVEL", "zh-CN").message).toBe("提示级别必须是 1、2 或 3。");
    expect(localize("HINT_INVALID_LEVEL", "en-US").message).toBe("Hint level must be 1, 2, or 3.");
    expect(localize("HINT_INVALID_LEVEL", "zh-CN").message).not.toBe(
      localize("HINT_INVALID_LEVEL", "en-US").message,
    );
  });
});
