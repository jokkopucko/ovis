export interface ReadEvidence { order_epoch: string; read_seq: number }
export interface MoveReceipt { order_epoch: string; moved_seq: number }

export class OrderSequence {
  private seq = 0;
  constructor(readonly epoch: string) {}
  read(): ReadEvidence { return { order_epoch: this.epoch, read_seq: this.seq }; }
  moved(): MoveReceipt { return { order_epoch: this.epoch, moved_seq: ++this.seq }; }
}
