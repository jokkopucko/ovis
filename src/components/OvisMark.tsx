import type { ComponentProps } from "react";

export function OvisMark({ className, ...rest }: ComponentProps<"img">) {
  return <img src="/icons/icon-192.png?v=sheep1" alt="" {...rest} className={`ovis-mark${className ? ` ${className}` : ""}`} />;
}
