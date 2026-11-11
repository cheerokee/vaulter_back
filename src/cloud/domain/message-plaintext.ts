import { validate, version } from 'uuid';
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_TITLE_MAX_CHARS,
  utf8Bytes,
} from './responder.js';

// O texto em claro de uma mensagem de assunto, na convenção v1 (docs/crypto/conversations.md, "Texto em claro das
// mensagens"): UTF-8 de um objeto JSON com `text` e campos opcionais; quem lê ignora campos que não conhece e aceita
// também texto puro (UTF-8 que não é esse JSON = a mensagem inteira é o texto). Legível: nunca vai a log.

/** A document the cloud proposes and asks before recording (spec active-cloud §4.3, confidentiality alert). */
export type DocumentProposal = {
  proposalId: string;
  title: string;
  /** Markdown. */
  content: string;
  /** The model judged the content confidential (the question then shows the space audience). */
  confidential: boolean;
};

/** A person's answer to a proposal through the app's buttons (free text works too: the model judges it). */
export type DocumentDecision = {
  proposalId: string;
  decision: 'record' | 'decline';
};

export type MessageContent = {
  text: string;
  documentProposal?: DocumentProposal;
  documentDecision?: DocumentDecision;
  documentRecorded?: { fileId: string; title: string };
  /** A fixed notice of the cloud (no model involved), e.g. `ai-budget-exceeded`. */
  notice?: 'ai-budget-exceeded';
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isV7 = (v: unknown): v is string =>
  typeof v === 'string' && validate(v) && version(v) === 7;

function proposalOf(v: unknown): DocumentProposal | undefined {
  if (!isRecord(v) || !isV7(v.proposalId)) return undefined;
  if (
    typeof v.title !== 'string' ||
    v.title.length < 1 ||
    v.title.length > DOCUMENT_TITLE_MAX_CHARS ||
    typeof v.content !== 'string' ||
    v.content.length < 1 ||
    utf8Bytes(v.content) > DOCUMENT_MAX_BYTES
  ) {
    return undefined;
  }
  return {
    proposalId: v.proposalId,
    title: v.title,
    content: v.content,
    confidential: v.confidential === true,
  };
}

function decisionOf(v: unknown): DocumentDecision | undefined {
  if (!isRecord(v) || !isV7(v.proposalId)) return undefined;
  if (v.decision !== 'record' && v.decision !== 'decline') return undefined;
  return { proposalId: v.proposalId, decision: v.decision };
}

/** Never throws: anything that is not the v1 JSON is plain text (invalid UTF-8 is replaced, not refused). */
export function decodeMessage(plaintext: Uint8Array): MessageContent {
  const raw = new TextDecoder('utf-8').decode(plaintext);
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { text: raw };
  }
  if (!isRecord(doc) || typeof doc.text !== 'string') return { text: raw };
  const out: MessageContent = { text: doc.text };
  const proposal = proposalOf(doc.documentProposal);
  if (proposal) out.documentProposal = proposal;
  const decision = decisionOf(doc.documentDecision);
  if (decision) out.documentDecision = decision;
  return out;
}

export function encodeMessage(content: MessageContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(content));
}
