import { describe, expect, it } from "bun:test";
import { CRAMPED_QUERY, layoutTopology, loneTabHidden, paneContextPress, soloPane, splitPath, splitRatioAt } from "./paneCanvas.ts";
import type { PaneLayoutSnapshot } from "../../shared/protocol.ts";

const layout: PaneLayoutSnapshot = {
  tab_id: "w1:t1", workspace_id: "w1", zoomed: false, focused_pane_id: "w1:p1",
  area: { x: 25, y: 1, width: 120, height: 40 },
  panes: [{pane_id:"w1:p1",focused:true,rect:{x:25,y:1,width:60,height:40}}],
  splits: [{id:"split_0_root",direction:"right",ratio:0.5,rect:{x:25,y:1,width:120,height:40}}],
};
describe("native pane canvas", () => {
  it("keeps Mac Control-click as a menu target without stealing pane focus", () => {
    expect(paneContextPress({button:0,ctrlKey:true}, true)).toBe(true);
    expect(paneContextPress({button:0,ctrlKey:true}, false)).toBe(false);
    expect(paneContextPress({button:2,ctrlKey:false}, false)).toBe(true);
    expect(paneContextPress({button:0,ctrlKey:false}, true)).toBe(false);
  });
  it("decodes nested paths without treating the preorder index as a path", () => {
    expect(splitPath("split_12_010")).toEqual([false,true,false]);
    expect(splitPath("split_0_root")).toEqual([]);
    expect(splitPath("split_0_unknown")).toBeNull();
  });
  it("measures a nested divider against its own area and clamps native limits", () => {
    const split={...layout.splits[0]!,rect:{x:85,y:1,width:60,height:40}};
    const box={left:320,top:70,width:1000,height:800};
    expect(splitRatioAt(split,layout,box,1070,400)).toBe(0.5);
    expect(splitRatioAt(split,layout,box,0,400)).toBe(0.1);
    expect(splitRatioAt(split,layout,box,3000,400)).toBe(0.9);
    expect(splitRatioAt({...split,direction:"down"},layout,box,1070,270)).toBe(0.25);
  });
  it("cancels for topology/zoom changes but keeps the drag across ratio updates", () => {
    const resized=structuredClone(layout); resized.splits[0]!.ratio=0.6;
    expect(layoutTopology(resized)).toBe(layoutTopology(layout));
    resized.panes.push({...resized.panes[0]!,pane_id:"w1:p2"});
    expect(layoutTopology(resized)).not.toBe(layoutTopology(layout));
    expect(layoutTopology({...layout,zoomed:true})).not.toBe(layoutTopology(layout));
  });
});

describe("the pane a tab shows alone", () => {
  const panes = ["w1:p1", "w1:p2"];
  it("draws every pane on a wide screen, and one where a split has no room", () => {
    expect(soloPane(layout, panes, "w1:p2", false)).toBeNull();
    expect(soloPane(layout, panes, "w1:p2", true)).toBe("w1:p2");
    expect(soloPane(layout, ["w1:p1"], "w1:p1", true)).toBeNull();
  });
  it("falls back to herdr's focused pane, then the first, while the selection is not in the tab", () => {
    expect(soloPane(layout, panes, "w9:p1", true)).toBe("w1:p1");
    expect(soloPane(layout, panes, null, true)).toBe("w1:p1");
    expect(soloPane({ ...layout, focused_pane_id: "w9:p9" }, ["w1:p2", "w1:p1"], null, true)).toBe("w1:p2");
  });
  it("shows herdr's zoomed pane whatever the screen and the selection", () => {
    const zoomed = { ...layout, zoomed: true, focused_pane_id: "w1:p2" };
    expect(soloPane(zoomed, panes, "w1:p1", false)).toBe("w1:p2");
    expect(soloPane(zoomed, panes, "w1:p1", true)).toBe("w1:p2");
  });
});

describe("the compact-height tab strip", () => {
  it("leaves out only a lone tab through the 700px phone-height ceiling", () => {
    expect(CRAMPED_QUERY).toBe("(max-width: 768px) and (max-height: 700px)");
    expect(loneTabHidden(true, 1)).toBe(true);
    expect(loneTabHidden(true, 2)).toBe(false);
    expect(loneTabHidden(false, 1)).toBe(false);
  });
});
