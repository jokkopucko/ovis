import type { AgentInfo, AgentTarget, PaneProcessInfo, PaneProcessInfoParams, PaneSendKeysParams, PaneSendTextParams } from "../../shared/herdr-api.generated.ts";

/**
 * Hand-written on purpose: herdr's schema maps a method to its params (`request.oneOf`), but its
 * answers are one `ResponseResult.oneOf` told apart by a `type` tag (`pane_process_info`,
 * `agent_info`, `ok`) with no link back to the method, so a generated method -> result table
 * would be a hand-kept table anyway.
 */
export interface HerdrMethods {
  /** `pane_id`, never `target`: given `target`, herdr silently answers for the focused pane. */
  "pane.process_info": { params: PaneProcessInfoParams & { pane_id: string }; result: { type?: "pane_process_info"; process_info?: PaneProcessInfo } };
  "agent.get": { params: AgentTarget; result: { type?: "agent_info"; agent: AgentInfo } };
  "pane.send_text": { params: PaneSendTextParams; result: { type?: "ok" } };
  "pane.send_keys": { params: PaneSendKeysParams; result: { type?: "ok" } };
}

export type HerdrMethod = keyof HerdrMethods;

/**
 * One typed method, never a union of them: given `"pane.process_info" | "agent.get"`, the params
 * would be the union of both methods' params, and `{ target }` would pass for pane.process_info.
 */
export type SingleHerdrMethod<M extends HerdrMethod> = IsUnion<M> extends true ? never : M;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * A method `HerdrMethods` does not type yet. A typed method given here is `never`, so a call
 * like `herdrRpc("pane.process_info", { target })` fails to compile instead of falling back.
 * That holds only while `M` is inferred from the literal: with an explicit result type
 * (`herdrRpc<T>("pane.process_info", …)`) or a method typed as plain `string`, `M` is `string`
 * and the fallback takes any params (see the herdrRpc overloads in client.ts).
 */
export type UntypedHerdrMethod<M extends string> = M extends HerdrMethod ? never : M;
