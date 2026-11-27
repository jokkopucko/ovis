/**
 * "Not me" on an admission notice (device table T51, T60, T65): this device signs one block of the named
 * key with its own key, and each PC answers for itself. The account's order only says whether to offer it;
 * each PC judges by its own admission order, so a PC is shown done only on its own receipt for a block sent.
 */
import { newRecordId, signSafetyRecord, type BlockRecord } from "../../../shared/account-records.ts";
import { blockOutcome, parseBlockReceipt, type DeviceNotice, type PcBlockOutcome } from "../../../shared/account-devices-api.ts";

export interface OwnKey { readonly public_spki: string; readonly private_key: CryptoKey; readonly no: number }

/** T51: use the same eligibility check when offering and when signing a block. */
export function canBlockAdmission(notice: DeviceNotice, own: OwnKey): notice is DeviceNotice & {
  readonly key: string;
  readonly no: number;
  readonly account: string;
} {
  return notice.kind === "admit" && notice.open && notice.key !== null && notice.no !== null &&
    notice.account !== null && notice.key !== own.public_spki && own.no < notice.no;
}

/**
 * `accountNo`: the target's number in the account's order, which the account service holds `target_no` to; a notice's
 * `no` is its PC's own admission number, which the PCs judge by and the service does not know. It only fills that
 * claim: whether to sign stays canBlockAdmission's, and a lookup that fails or names nothing never holds the block back.
 */
export async function notMeBlocks(notice: DeviceNotice, own: OwnKey, options: { now?: () => number; accountNo?: (key: string) => Promise<number | null> } = {}): Promise<BlockRecord[]> {
  if (!canBlockAdmission(notice, own)) return [];
  const accountNo = await options.accountNo?.(notice.key).catch((error: unknown) => {
    console.warn("Ovis: the account service did not number the device to block", error instanceof Error ? error.name : error);
    return null;
  });
  return [await signSafetyRecord({
    v: 1, kind: "block", account: notice.account, target: notice.key, target_no: accountNo ?? notice.no, signer: own.public_spki, signer_no: own.no,
    signed_at: new Date((options.now ?? Date.now)()).toISOString(), nonce: newRecordId(),
  }, own.private_key)];
}

export interface FleetBlock {
  readonly ids: readonly string[];
  readonly outcomes: ReadonlyMap<string, PcBlockOutcome>;
  /** Present only while account delivery is unconfirmed; retries the original signed records, not the PCs. */
  readonly retryService?: () => Promise<boolean>;
}

/** `answer` is what PC `serverId` said over its own channel; anything else, or a receipt for a block not sent, changes nothing. */
export function withBlockReceipt(fleet: FleetBlock, serverId: string, answer: unknown): FleetBlock {
  if (!fleet.outcomes.has(serverId)) return fleet;
  const receipt = matchingReceipt(fleet.ids, answer);
  if (receipt === undefined) return fleet;
  return { ...fleet, outcomes: new Map(fleet.outcomes).set(serverId, blockOutcome(serverId, receipt)) };
}

function matchingReceipt(ids: readonly string[], answer: unknown) {
  try {
    const receipt = parseBlockReceipt(answer);
    return ids.includes(receipt.id) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

/** One PC's transport for blocks (its notice-answer or POST /api/account/records): the receipts that PC itself sent back. */
export type BlockSend = (records: readonly BlockRecord[]) => Promise<readonly unknown[]>;

/**
 * Sends the blocks to every PC of the account and to the account service at once (device table T60), each PC again
 * with the same records while it cannot be reached (retry by id), and keeps only what each PC answered for itself.
 */
export async function sendBlocks(blocks: readonly BlockRecord[], options: {
  /** by server_id: a channel authenticated to that PC itself (the page's own socket, or its relay channel); only these receipts count */
  pcs: ReadonlyMap<string, BlockSend>;
  /** by server_id: a route through another PC's proxy, which delivers the blocks but whose answer is that other PC's word (relay-hub ruling on T60) */
  relayed?: ReadonlyMap<string, BlockSend>;
  service: (blocks: readonly BlockRecord[]) => Promise<void>;
  tries?: number;
}): Promise<FleetBlock> {
  const tries = options.tries ?? 3;
  const relayed = options.relayed ?? new Map<string, BlockSend>();
  let fleet: FleetBlock = { ids: blocks.map((block) => block.id), outcomes: new Map([...options.pcs.keys(), ...relayed.keys()].map((serverId) => [serverId, { server_id: serverId, state: "waiting" as const }])) };
  const toPc = async (serverId: string, send: BlockSend, counted: boolean): Promise<void> => {
    let replied = false;
    for (let attempt = 0; attempt < tries; attempt++) {
      let receipts: readonly unknown[];
      try { receipts = await send(blocks); } catch { continue; }
      replied = true;
      let matched = false;
      for (const answer of receipts) {
        if (matchingReceipt(fleet.ids, answer) === undefined) continue;
        matched = true;
        if (counted) fleet = withBlockReceipt(fleet, serverId, answer);
      }
      if (matched) return;
    }
    if (!replied && tries > 0 && (counted || !options.pcs.has(serverId))) {
      fleet = { ...fleet, outcomes: new Map(fleet.outcomes).set(serverId, { server_id: serverId, state: "unreachable" }) };
    }
  };
  let posting: Promise<boolean> | undefined;
  const postToService = () => posting ??= options.service(blocks).then(() => true, (error: unknown) => {
    console.warn("Ovis: the account service did not confirm the block", error instanceof Error ? error.name : error);
    return false;
  }).finally(() => {
    posting = undefined;
  });
  const service = postToService();
  const deliver = [...relayed].map(([serverId, send]) => toPc(serverId, send, false));
  await Promise.all([...[...options.pcs].map(([serverId, send]) => toPc(serverId, send, true)), ...deliver, service]);
  return await service ? fleet : { ...fleet, retryService: postToService };
}
