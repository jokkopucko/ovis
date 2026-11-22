import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LegendList } from "@legendapp/list/react";

declare global {
  interface Window {
    paddingQa: { header: (height: number) => void; add: (height: number) => void; resize: (by: number) => void };
  }
}

function Fixture() {
  const [heights, setHeights] = useState<number[]>(() => Array.from({ length: 40 }, (_, index) => 60.37 + (index % 7) * 13.13));
  const [header, setHeader] = useState(20);
  window.paddingQa = {
    header: setHeader,
    add: (height) => setHeights((list) => [...list, height]),
    resize: (by) => setHeights((list) => list.map((value, index) => index === list.length - 1 ? Math.max(30, value + by) : value)),
  };
  return <LegendList
    style={{ height: 600, overflow: "auto" }}
    className="padding-qa-scroller"
    contentContainerClassName="padding-qa-content"
    data={heights.map((height, index) => ({ height, key: `row-${index}` }))}
    keyExtractor={(row) => row.key}
    renderItem={({ item }) => <div style={{ height: item.height }}>{item.key}</div>}
    estimatedItemSize={80}
    recycleItems={false}
    initialScrollAtEnd
    maintainVisibleContentPosition
    ListHeaderComponent={<div style={{ height: header }}>header</div>}
    ListFooterComponent={<div className="padding-qa-footer" style={{ height: 20 }}>footer</div>}
  />;
}

const root = document.getElementById("root");
if (!root) throw new Error("Padding fixture root missing");
createRoot(root).render(<Fixture />);
