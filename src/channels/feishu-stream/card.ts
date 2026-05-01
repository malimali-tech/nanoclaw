/**
 * Card JSON shape for streaming output.
 *
 * First-cut: a single top-level markdown element with a stable `element_id`
 * that `cardElement.content` targets across updates. Reasoning/tool-call
 * rendering will land in the next milestone — for now those events are
 * dropped at the handle level rather than risking unverified element
 * targeting (CardKit's element-level update API only addresses top-level
 * elements reliably; nested element_ids inside collapsible_panels behave
 * differently across SDK versions).
 */

export const STREAMING_ELEMENT_ID = 'stream_text';

interface CardConfig {
  streaming_mode: boolean;
}

export interface StreamingCardJson extends Record<string, unknown> {
  schema: '2.0';
  config: CardConfig;
  body: {
    elements: Array<{
      tag: 'markdown';
      element_id: string;
      content: string;
      text_align?: string;
      text_size?: string;
    }>;
  };
}

/** Initial card sent when a stream opens. */
export function buildInitialCard(): StreamingCardJson {
  return {
    schema: '2.0',
    config: { streaming_mode: true },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: STREAMING_ELEMENT_ID,
          content: '',
          text_align: 'left',
          text_size: 'normal_v2',
        },
      ],
    },
  };
}

/** Final card snapshot used by `updateCardKitCard` after streaming finishes. */
export function buildFinalCard(content: string): StreamingCardJson {
  return {
    schema: '2.0',
    config: { streaming_mode: false },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: STREAMING_ELEMENT_ID,
          content,
          text_align: 'left',
          text_size: 'normal_v2',
        },
      ],
    },
  };
}
