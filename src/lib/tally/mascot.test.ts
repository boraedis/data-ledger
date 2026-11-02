import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MASCOT_MOODS, MASCOT_VIEWBOX, mascotShapes, mascotSvg, mascotViewBox } from "@/lib/tally/mascot";

describe("Tally's moods", () => {
  it("draws happy by default, which is what the icons are drawn from", () => {
    expect(mascotShapes("full")).toEqual(mascotShapes("full", "happy"));
    // The tab icon is the mark; if a mood change ever leaked into it, this catches it.
    expect(`${mascotSvg("mark")}\n`).toBe(readFileSync("src/app/icon.svg", "utf8"));
  });

  it("gives every mood its own face, with only finite numbers in it", () => {
    const happy = JSON.stringify(mascotShapes("full", "happy"));
    for (const mood of MASCOT_MOODS) {
      const shapes = mascotShapes("full", mood);
      if (mood !== "happy") expect(JSON.stringify(shapes)).not.toBe(happy);
      for (const s of shapes) for (const v of Object.values(s.attrs)) if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("blinks only the moods that have open eyes", () => {
    const eyes = (mood: (typeof MASCOT_MOODS)[number]) => mascotShapes("full", mood).filter((s) => s.part === "eye").length;
    expect(eyes("happy")).toBe(4);
    expect(eyes("wow")).toBe(4);
    expect(eyes("cool")).toBe(0);
    expect(eyes("sleepy")).toBe(0);
  });

  it("keeps the small mark mood-free", () => {
    expect(mascotShapes("mark", "worried")).toEqual(mascotShapes("mark"));
    expect(mascotViewBox("mark", "party")).toEqual(MASCOT_VIEWBOX.mark);
  });

  it("makes room for a hat above and an arm beside, and nothing else", () => {
    const base = MASCOT_VIEWBOX.full;
    expect(mascotViewBox("full", "happy")).toEqual(base);
    expect(mascotViewBox("full", "party")).toMatchObject({ x: base.x, width: base.width, y: -12, height: 108 });
    expect(mascotViewBox("full", "waving")).toMatchObject({ y: base.y, height: base.height, width: 78 });
  });
});
