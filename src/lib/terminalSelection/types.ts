import type { ScreenRows } from "../terminalScreen.ts";

export type Point = [x: number, y: number];
type Position = { readonly x: number; readonly y: number };
type Range = { readonly start: Position; readonly end: Position };
export type SelectionPosition = Range;
export type DrawnSelection = { readonly start: Point; readonly end: Point; readonly column: boolean };

/** The visible grid and its buffer, with history rows numbered from zero. */
export interface LinkHost {
  readonly screen: HTMLElement;
  cols(): number;
  rows(): number;
  cell(): { readonly width: number; readonly height: number };
  screenRows(): ScreenRows & { readonly alternate: boolean };
}

export interface SelectionHost extends LinkHost {
  readonly element: HTMLElement;
  readonly isMac: boolean;
  readonly macOptionClickForcesSelection: boolean;
  scrollLines(amount: number): void;
  mouseReporting(): boolean;
  wordSeparator(): string;
  onUserInput(listener: () => void): () => void;
  /** Supply Linkifier.focusedLink to make a double-click select the whole link. */
  focusedLink?(): ILink | undefined;
}

export interface Selection {
  hasSelection(): boolean;
  getSelection(): string;
  getSelectionPosition(): SelectionPosition | undefined;
  select(column: number, row: number, length: number): void;
  selectAll(): void;
  selectLines(start: number, end: number): void;
  clearSelection(): void;
  drawnSelection(): DrawnSelection | null;
  onSelectionChange(listener: () => void): () => void;
  onRedraw(listener: () => void): () => void;
  onLinuxMouseSelection(listener: (text: string) => void): () => void;
  /** Call after view/buffer changes. Pass the actual number of rows dropped from the front. */
  refresh(trimmedRows?: number): void;
  enable(): void;
  disable(): void;
  dispose(): void;
}

/** Compatible with xterm's providers: range endpoints are 1-based and both inclusive. */
export interface ILink {
  readonly range: Range;
  readonly text: string;
  decorations?: ILinkDecorations;
  activate(event: MouseEvent, text: string): void;
  hover?(event: MouseEvent, text: string): void;
  leave?(event: MouseEvent, text: string): void;
  dispose?(): void;
}

export interface ILinkDecorations {
  pointerCursor: boolean;
  underline: boolean;
}

export interface ILinkProvider {
  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
}

/** Clipped to visible rows, zero-based, start inclusive/end exclusive, just like selection drawing. */
export type LinkUnderline = { readonly start: Point; readonly end: Point };

export interface Linkifier {
  registerLinkProvider(provider: ILinkProvider): { dispose(): void };
  focusedLink(): ILink | undefined;
  /** Paint this range in the renderer (null erases it); the pointer class is handled here. */
  onUnderlineChange(listener: (underline: LinkUnderline | null) => void): () => void;
  /** Invalidate provider results after changes to visible content, scroll or resize. */
  refresh(): void;
  dispose(): void;
}
