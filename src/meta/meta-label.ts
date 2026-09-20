/**
 * Naming a token's meta, and keeping those names comparable to each other.
 *
 * The whole feature rests on one fragile property: that two tokens riding the same wave get the
 * *same string*. A model asked "what theme is this" will happily answer "dog", "Dogs", "doge meta"
 * and "canine" for four tokens that are obviously one thing, and every aggregate built on top then
 * splinters across synonyms and reports four cold metas instead of one hot one. Normalisation and a
 * shared vocabulary are therefore not tidiness, they are the measurement.
 *
 * The second property is that a label never expires. A token's name does not change, so a mint is
 * labelled once and the answer is kept forever -- unlike the narrative verdict, which carries a
 * 24-hour TTL and is re-bought for the same mints after every restart.
 */

export type MetaConfidence = 'high' | 'medium' | 'low';

/** No opinion. Never a theme, and deliberately scored as zero rather than as a weak match. */
export const UNLABELED = 'unlabeled';

/** Longer than this is a sentence, not a label -- the model describing rather than classifying. */
export const MAX_LABEL_LENGTH = 24;

export interface MetaLabelRecord {
    tokenMint: string;
    label: string;
    confidence: MetaConfidence;
    /** `llm` when the model classified it, `unlabeled` when it answered but had nothing usable. */
    source: 'llm' | 'unlabeled';
    labeledAt: number;
}

export interface MetaLabelRequest {
    tokenMint: string;
    tokenName: string;
    symbol?: string;
}

const CONFIDENCES = new Set<string>(['high', 'medium', 'low']);

/**
 * Folds a raw model answer into a canonical label.
 *
 * Case, punctuation and the word "meta" itself are all noise the model adds inconsistently -- it
 * returns "Dog", "dog meme" and "DOG meta" for the same concept within one batch. Anything left
 * empty, overlong or non-alphabetic is not a label at all and becomes UNLABELED, which is inert.
 */
export function normalizeMetaLabel(raw: unknown): string {
    const text = String(raw ?? '')
        .toLowerCase()
        .trim();
    if (!text) return UNLABELED;

    const cleaned = text
        // Keep hyphens: "pump-fun" and "ai-agent" are single concepts, not two words.
        .replace(/[^a-z0-9\s-]/g, ' ')
        // The model appends these to roughly half its answers and omits them on the rest, which
        // would split one concept into two labels.
        .replace(/\b(meta|meme|coin|token|theme|narrative)\b/g, ' ')
        .replace(/[\s-]+/g, ' ')
        .trim();

    if (!cleaned) return UNLABELED;
    if (cleaned.length > MAX_LABEL_LENGTH) return UNLABELED;
    // A label has to contain a letter. "2024" or "420" classify nothing.
    if (!/[a-z]/.test(cleaned)) return UNLABELED;

    return cleaned.replace(/ /g, '-');
}

export function normalizeMetaConfidence(raw: unknown): MetaConfidence {
    const text = String(raw ?? '').toLowerCase().trim();
    return CONFIDENCES.has(text) ? (text as MetaConfidence) : 'low';
}

/**
 * Maps a label onto an existing vocabulary entry when one of its aliases matches.
 *
 * Runs after normalisation, and exists because normalisation can only fix spelling, not synonymy:
 * "canine" and "dog" survive normalisation as two distinct labels and only a vocabulary can know
 * they are one.
 */
export function resolveAlias(label: string, aliases: ReadonlyMap<string, string>): string {
    if (label === UNLABELED) return UNLABELED;
    return aliases.get(label) ?? label;
}

/**
 * Turns one batch response into per-mint records.
 *
 * Batching is what makes full-LLM labelling affordable, and it is also what makes the response
 * untrustworthy: a model handed forty items will occasionally return thirty-nine, duplicate one, or
 * invent a mint that was never asked about. Every answer is therefore matched back against the
 * request set, extras are dropped, and anything missing falls through to UNLABELED rather than
 * silently shifting labels onto the wrong tokens by position.
 */
export function normalizeLabelBatch(
    parsed: unknown,
    requested: ReadonlyArray<MetaLabelRequest>,
    aliases: ReadonlyMap<string, string> = new Map(),
    now: number = Date.now(),
): MetaLabelRecord[] {
    const wanted = new Set(requested.map((item) => item.tokenMint));
    const answers = extractAnswers(parsed);
    const byMint = new Map<string, MetaLabelRecord>();

    for (const answer of answers) {
        const tokenMint = resolveAnswerMint(answer, requested);
        if (!tokenMint || !wanted.has(tokenMint) || byMint.has(tokenMint)) continue;

        const label = resolveAlias(normalizeMetaLabel(answer?.label), aliases);
        byMint.set(tokenMint, {
            tokenMint,
            label,
            confidence: label === UNLABELED ? 'low' : normalizeMetaConfidence(answer?.confidence),
            source: label === UNLABELED ? 'unlabeled' : 'llm',
            labeledAt: now,
        });
    }

    // A mint the model skipped must still get a record, otherwise it re-enters the buffer on the
    // next pass and is paid for again on every one of the ~700 re-analyses it receives.
    for (const item of requested) {
        if (byMint.has(item.tokenMint)) continue;
        byMint.set(item.tokenMint, {
            tokenMint: item.tokenMint,
            label: UNLABELED,
            confidence: 'low',
            source: 'unlabeled',
            labeledAt: now,
        });
    }

    return [...byMint.values()];
}

/**
 * Which token an answer is about.
 *
 * Two forms are accepted, in priority order. An explicit `tokenMint` is unambiguous and wins. An
 * index is the cheap form the prompt asks for: a mint address is 44 characters the model would
 * otherwise have to retype for every token, and measuring a live run showed that retyping was the
 * single largest component of the response -- which matters because output tokens bill at several
 * times the input rate.
 *
 * An index is not the same as trusting the order. The model states which item it is answering, and
 * an index outside the batch is discarded rather than silently attached to a neighbour. Array
 * position is never used as a fallback, because that is exactly the failure this guards against:
 * a reordered response would put one token's label on another token, wrongly and undetectably.
 */
function resolveAnswerMint(
    answer: Record<string, unknown> | undefined,
    requested: ReadonlyArray<MetaLabelRequest>,
): string | undefined {
    const explicit = String(answer?.tokenMint ?? '').trim();
    if (explicit) return explicit;

    const raw = answer?.i ?? answer?.index;
    const index = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isInteger(index) || index < 0 || index >= requested.length) return undefined;
    return requested[index].tokenMint;
}

/** Accepts the two shapes models actually return: a bare array, or one wrapped in a key. */
function extractAnswers(parsed: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    if (parsed && typeof parsed === 'object') {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
            if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
        }
    }
    return [];
}

/**
 * Whether this mint is worth an API call.
 *
 * A stored record -- including an UNLABELED one -- is final. Only a genuinely absent record is
 * refreshed, because a transient API failure is never persisted in the first place (the caller
 * drops it), so "present" always means "the model answered".
 */
export function shouldRefreshLabel(record: MetaLabelRecord | undefined): boolean {
    return !record;
}

/**
 * Picks the new labels a batch introduced, so they can join the vocabulary.
 *
 * Capped at one per batch by the prompt; enforced here too, because a prompt instruction is a
 * request and this is the thing that actually keeps the vocabulary from exploding.
 */
export function extractNewLabels(
    records: ReadonlyArray<MetaLabelRecord>,
    known: ReadonlySet<string>,
    limit = 1,
): string[] {
    const fresh: string[] = [];
    for (const record of records) {
        if (record.label === UNLABELED) continue;
        if (known.has(record.label) || fresh.includes(record.label)) continue;
        fresh.push(record.label);
        if (fresh.length >= limit) break;
    }
    return fresh;
}
