const ESC = 0x1b;
const encoder = new TextEncoder();

/** A refused query: the index just past its terminator in the bytes fed, and the reply. */
export interface Refusal {
  end: number;
  reply: Uint8Array;
}

/** Ghostty with image storage disabled consumes graphics APCs silently. Refuse a complete Kitty query on that same stream. */
export class GraphicsQueries {
  private state: "ground" | "escape" | "osc" | "string" | "apc" = "ground";
  private stringEscape = false;
  private header = "";
  private payload = false;

  reset(): void {
    this.state = "ground";
    this.stringEscape = false;
  }

  /**
   * The complete queries in `bytes` that are refused, in order, each with where its terminator ends, so that the caller can
   * answer it after the bytes before that point and before the bytes after it.
   */
  feed(bytes: Uint8Array): Refusal[] {
    const refusals: Refusal[] = [];
    for (let at = 0; at < bytes.length; at++) {
      const byte = bytes[at]!;
      if (this.state === "ground") {
        const start = bytes.indexOf(ESC, at);
        if (start < 0) return refusals;
        at = start;
        this.state = "escape";
        continue;
      }
      if (byte === 0x18 || byte === 0x1a) { this.reset(); continue; }
      if (this.stringEscape) {
        this.stringEscape = false;
        if (byte === 0x5c) {
          const reply = this.state === "apc" ? this.refusal() : null;
          if (reply) refusals.push({ end: at + 1, reply });
          this.state = "ground";
          continue;
        }
        this.state = "escape";
      }
      if (this.state === "escape") {
        if (byte === 0x5f) {
          this.state = "apc";
          this.header = "";
          this.payload = false;
        } else if (byte === 0x5d) this.state = "osc";
        else if (byte === 0x50 || byte === 0x58 || byte === 0x5e) this.state = "string";
        else if (byte !== ESC) this.state = "ground";
      } else if (byte === ESC) this.stringEscape = true;
      else if (byte === 0x07 && this.state === "osc") this.state = "ground";
      else if (this.state === "apc" && !this.payload) {
        if (byte === 0x3b) this.payload = true;
        else if (this.header.length < 1024) this.header += String.fromCharCode(byte);
        else this.state = "string";
      }
    }
    return refusals;
  }

  private refusal(): Uint8Array | null {
    if (!this.header.startsWith("G")) return null;
    const fields = new Map(this.header.slice(1).split(",").map((field) => {
      const at = field.indexOf("=");
      return [field.slice(0, at), field.slice(at + 1)] as const;
    }));
    if (fields.get("a") !== "q" || fields.get("q") === "2") return null;
    const id = fields.get("i"), number = fields.get("I");
    const identity = id !== undefined ? `i=${id}` : number !== undefined ? `I=${number}` : "";
    if (!/^[iI]=[1-9]\d{0,9}$/.test(identity)) return null;
    return encoder.encode(`\x1b_G${identity};ENOTSUP:graphics are not supported\x1b\\`);
  }
}
