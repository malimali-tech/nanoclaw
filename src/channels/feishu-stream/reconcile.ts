/**
 * Boot-time recovery for Feishu CardKit cards orphaned by a hard restart.
 *
 * If nanoclaw is killed mid-stream (SIGKILL, OOM, machine reboot), the
 * `finalize()` step never runs and the card stays in `streaming_mode=true`
 * forever — loading icon spinning, can't be forwarded, can't fire action
 * callbacks. Worse, the user sees a half-written reply that never
 * resolves.
 *
 * On every nanoclaw boot we read the `feishu_in_flight_cards` table
 * (rows live from card.create until finalize), and for each row run a
 * minimal "force-terminal" sequence:
 *
 *   1. Append a "[interrupted — restarted]" line into the streaming
 *      element so the user sees something happened, not just a freeze.
 *   2. Flip `streaming_mode` to false so the card returns to normal
 *      interaction state.
 *   3. Drop the row.
 *
 * Best-effort — any failure is logged and the row is still dropped, since
 * a stuck card is worse than a leaked DB row.
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import { clearInFlightCard, getInFlightCards } from '../../db.js';
import { logger } from '../../logger.js';
import { STREAMING_ELEMENT_ID } from './builder.js';
import {
  setCardStreamingMode,
  streamCardContent,
} from './cardkit.js';

const log = (m: string) => logger.info(`[feishu-stream:reconcile] ${m}`);

const INTERRUPT_NOTICE =
  '\n\n_[此对话因 nanoclaw 重启被中断，请重新提问继续。]_';

/**
 * Reconcile every in-flight card recorded in SQLite. Should be called
 * once per process boot, ideally right after the Feishu channel reaches
 * `connected` so the SDK client is available.
 *
 * The `client` slice matches what FeishuStreamHandle uses (im + cardkit),
 * so callers can pass `(channel as FeishuChannel).deps.client` or the
 * minimal mock equivalent.
 */
export async function reconcileInFlightCards(
  client: Pick<Lark.Client, 'im' | 'cardkit'>,
): Promise<{ scanned: number; recovered: number; failed: number }> {
  const rows = getInFlightCards();
  if (rows.length === 0) {
    return { scanned: 0, recovered: 0, failed: 0 };
  }
  log(`reconciling ${rows.length} in-flight card(s) from previous run`);
  let recovered = 0;
  let failed = 0;
  for (const row of rows) {
    // Each card gets its own try block so one failure doesn't block the
    // rest. Sequence allocation: continue from whatever the previous
    // process had reached, and increment beyond that.
    let nextSeq = row.sequence + 1;
    try {
      // Step 1: append an interrupt notice. We can't read what was last
      // pushed (CardKit doesn't expose a get-content API for streaming
      // elements), so we use the SDK to push only the notice and accept
      // that CardKit will diff it against the prior content. If that's
      // empty (rare — we'd only have a row if at least one streamCardContent
      // attempt happened), it just shows the notice on its own.
      await streamCardContent(client, {
        cardId: row.cardId,
        elementId: STREAMING_ELEMENT_ID,
        content: INTERRUPT_NOTICE,
        sequence: nextSeq++,
      });
      // Step 2: flip streaming_mode off so the card stops loading.
      await setCardStreamingMode(client, {
        cardId: row.cardId,
        streamingMode: false,
        sequence: nextSeq++,
      });
      log(`recovered cardId=${row.cardId} chatId=${row.chatId}`);
      recovered++;
    } catch (err) {
      failed++;
      log(
        `recover cardId=${row.cardId} FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Don't rethrow — keep going through the queue.
    } finally {
      // Drop the row whether or not the recovery succeeded. Leaving it
      // would cause the same failed card to be reattempted every restart,
      // which is just noise — at this point the card on the Feishu side
      // is permanently stuck and a forced toggle isn't going to fix it.
      try {
        clearInFlightCard(row.cardId);
      } catch {
        /* tolerate: db error here is harmless, the recover was best-effort */
      }
    }
  }
  log(
    `reconcile done: scanned=${rows.length} recovered=${recovered} failed=${failed}`,
  );
  return { scanned: rows.length, recovered, failed };
}
