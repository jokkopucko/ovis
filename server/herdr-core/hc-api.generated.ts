/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Source: herdr-core (hc) OpenRPC schema, hc 0.1.14, Apache-2.0.
 * Regenerate with: bun run generate:types
 * Verify freshness with: bun run generate:types --check
 */

export interface AttachResult {
  channel: number;
  terminal: Terminal;
}

export interface CoreInfo {
  id: string;
  name: string;
}

export interface Display {
  bg?: string | null;
  cell?: [number, number] | null;
  cursor?: string | null;
  fg?: string | null;
}

export interface DocGetParams {
  name: string;
  on?: string | null;
}

export interface DocGetResult {
  value: unknown;
  version: number;
}

export interface EventsSubscribeParams {
  children_of?: string | null;
  labels?: Record<string, string>;
  terminal?: string | null;
}

export interface FirstMessage {
  reason?: string | null;
  sent: boolean;
  started?: boolean | null;
  turn?: number | null;
}

export interface Foreground {
  argv: string[];
  cwd: string;
  name: string;
  pid: number;
}

export interface HelloParams {
  calls_you?: string | null;
  core?: CoreInfo | null;
  framed?: boolean;
  generation?: number | null;
}

export interface HelloResult {
  core: CoreInfo;
  features: string[];
  framed: boolean;
  generation: number;
  methods: string[];
  version: string;
}

export interface HolderInfo {
  current: boolean;
  instance: string;
  pid: number;
  terminals: number;
}

export type IdleOrWorking = "idle" | "working" | (string & {});

export interface KeysResult {
  status?: string | null;
  turn: number;
}

export interface ListResult {
  hidden_finished: number;
  machines: MachineView[];
  terminals: Terminal[];
}

export interface MachineView {
  host: string;
  id: string;
  name: string;
  session?: string | null;
  since_ms?: number | null;
  state: string;
  target: string;
  temporary?: boolean;
  version: string;
  via?: boolean;
  why?: string | null;
}

export interface ReadResult {
  complete: boolean;
  how: string;
  text: string;
  why?: string | null;
}

export interface RemoveResult {
  removed: string;
}

export interface RunResult {
  address: string;
  argv: string[];
  cols: number;
  created_ms: number;
  cwd: string;
  die_with_parent?: boolean;
  exit_code?: number | null;
  finished_ms?: number | null;
  first_message?: FirstMessage | null;
  foreground?: Foreground | null;
  identity?: string;
  keep?: boolean;
  labels: Record<string, string>;
  name?: string | null;
  notify?: boolean;
  output?: string | null;
  parent?: string | null;
  paste_gap_ms?: number | null;
  pid?: number | null;
  reason?: string | null;
  records?: Record<string, Status>;
  reported?: boolean;
  rm?: boolean;
  rows: number;
  screen: string;
  signal?: number | null;
  state: string;
  status?: Status | null;
  status_ms?: number | null;
  stop?: string | null;
  submit?: string | null;
  template?: string | null;
  title?: string;
  turn?: number;
  wait?: WaitResult | null;
}

export interface SendResult {
  started?: boolean | null;
  status?: string | null;
  turn: number;
  wait?: WaitResult | null;
}

export type ServerStatusParams = Record<string, never>;

export interface Status {
  app?: string;
  kind?: string | null;
  msg?: string;
  progress?: number | null;
  state: string;
  title?: string;
}

export interface StatusResult {
  core: CoreInfo;
  finished: number;
  holder?: HolderInfo | null;
  holders: HolderInfo[];
  installed_by?: string | null;
  live: number;
  pid: number;
  uptime_ms: number;
  version: string;
}

export interface SubscribeResult {
  channel?: number | null;
  seq: number;
  terminals: Terminal[];
}

export interface Terminal {
  address: string;
  argv: string[];
  cols: number;
  created_ms: number;
  cwd: string;
  die_with_parent?: boolean;
  exit_code?: number | null;
  finished_ms?: number | null;
  foreground?: Foreground | null;
  identity?: string;
  keep?: boolean;
  labels: Record<string, string>;
  name?: string | null;
  notify?: boolean;
  parent?: string | null;
  paste_gap_ms?: number | null;
  pid?: number | null;
  reason?: string | null;
  records?: Record<string, Status>;
  reported?: boolean;
  rm?: boolean;
  rows: number;
  screen: string;
  signal?: number | null;
  state: string;
  status?: Status | null;
  status_ms?: number | null;
  stop?: string | null;
  submit?: string | null;
  template?: string | null;
  title?: string;
  turn?: number;
}

export interface TerminalAttachParams {
  caller?: string | null;
  cols: number;
  display?: Display;
  history?: number;
  observe?: boolean;
  resumed?: boolean;
  rows: number;
  terminal: string;
}

export interface TerminalGetParams {
  caller?: string | null;
  terminal: string;
}

export interface TerminalKeysParams {
  caller?: string | null;
  keys: string[];
  terminal: string;
}

export interface TerminalKillParams {
  caller?: string | null;
  terminal: string;
}

export interface TerminalLabelParams {
  labels: Record<string, string>;
  terminal: string;
}

export interface TerminalListParams {
  all?: boolean;
  labels?: Record<string, string>;
}

export interface TerminalReadParams {
  caller?: string | null;
  lines?: number;
  terminal: string;
}

export interface TerminalRmParams {
  caller?: string | null;
  terminal: string;
}

export interface TerminalRunParams {
  argv?: string[];
  caller?: string | null;
  cwd?: string | null;
  die_with_parent?: boolean;
  env?: Record<string, string>;
  keep?: boolean;
  labels?: Record<string, string>;
  line?: string | null;
  name?: string | null;
  no_notify?: boolean;
  no_parent?: boolean;
  on?: string | null;
  outlive_parent?: boolean;
  parent?: string | null;
  rm?: boolean;
  timeout?: number | null;
  wait?: boolean;
}

export interface TerminalSendParams {
  caller?: string | null;
  force?: boolean;
  if?: IdleOrWorking | null;
  terminal: string;
  text: string;
  timeout?: number | null;
  wait?: boolean;
}

export interface WaitResult {
  children: WaitResult[];
  ended: boolean;
  exit_code?: number | null;
  from?: string | null;
  reason: string;
  signal?: number | null;
  status?: string | null;
  terminal: string;
  turn: number;
}

/** Every hc method Ovis calls, with its params and its result. */
export interface HcMethods {
  "doc.get": { params: DocGetParams; result: DocGetResult };
  "events.subscribe": { params: EventsSubscribeParams; result: SubscribeResult };
  "hello": { params: HelloParams; result: HelloResult };
  "server.status": { params: ServerStatusParams; result: StatusResult };
  "terminal.attach": { params: TerminalAttachParams; result: AttachResult };
  "terminal.get": { params: TerminalGetParams; result: Terminal };
  "terminal.keys": { params: TerminalKeysParams; result: KeysResult };
  "terminal.kill": { params: TerminalKillParams; result: Terminal };
  "terminal.label": { params: TerminalLabelParams; result: Terminal };
  "terminal.list": { params: TerminalListParams; result: ListResult };
  "terminal.read": { params: TerminalReadParams; result: ReadResult };
  "terminal.rm": { params: TerminalRmParams; result: RemoveResult };
  "terminal.run": { params: TerminalRunParams; result: RunResult };
  "terminal.send": { params: TerminalSendParams; result: SendResult };
}

export type HcMethod = keyof HcMethods;
