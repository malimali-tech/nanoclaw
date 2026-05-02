/**
 * Boot-time recovery for CardKit cards orphaned by a hard restart: append an
 * "[interrupted]" notice into the streaming element, flip streaming_mode off,
 * and drop the row. Best-effort — a leaked DB row is preferable to a card
 * stuck in streaming forever.
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import {
  clearAllInFlightCards,
  getInFlightCards,
  type InFlightCard,
} from '../../db.js';
import { errMsg, logger } from '../../logger.js';
import { STREAMING_ELEMENT_ID } from './builder.js';
import { setCardStreamingMode, streamCardContent } from './cardkit.js';

const log = (m: string) => logger.info(`[feishu-stream:reconcile] ${m}`);

const INTERRUPT_NOTICE =
  '\n\n_[此对话因 nanoclaw 重启被中断，请重新提问继续。]_';

export async function reconcileInFlightCards(
  client: Pick<Lark.Client, 'im' | 'cardkit'>,
): Promise<{ scanned: number; recovered: number; failed: number }> {
  const rows = getInFlightCards();
  if (rows.length === 0) {
    return { scanned: 0, recovered: 0, failed: 0 };
  }
  log(`reconciling ${rows.length} in-flight card(s) from previous run`);

  const results = await Promise.all(rows.map((row) => recoverOne(client, row)));

  const recovered = results.filter((ok) => ok).length;
  const failed = results.length - recovered;

  try {
    clearAllInFlightCards();
  } catch (err) {
    log(
      `clearAllInFlightCards failed (rows will retry next boot): ${errMsg(err)}`,
    );
  }

  log(
    `reconcile done: scanned=${rows.length} recovered=${recovered} failed=${failed}`,
  );
  return { scanned: rows.length, recovered, failed };
}

async function recoverOne(
  client: Pick<Lark.Client, 'im' | 'cardkit'>,
  row: InFlightCard,
): Promise<boolean> {
  let nextSeq = row.sequence + 1;
  try {
    await streamCardContent(client, {
      cardId: row.cardId,
      elementId: STREAMING_ELEMENT_ID,
      content: INTERRUPT_NOTICE,
      sequence: nextSeq++,
    });
    await setCardStreamingMode(client, {
      cardId: row.cardId,
      streamingMode: false,
      sequence: nextSeq++,
    });
    log(`recovered cardId=${row.cardId} chatId=${row.chatId}`);
    return true;
  } catch (err) {
    log(`recover cardId=${row.cardId} FAILED: ${errMsg(err)}`);
    return false;
  }
}
