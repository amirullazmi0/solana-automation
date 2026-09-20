import {
    MAX_LABEL_LENGTH,
    UNLABELED,
    extractNewLabels,
    normalizeLabelBatch,
    normalizeMetaLabel,
    shouldRefreshLabel,
} from './meta-label';

describe('normalizeMetaLabel', () => {
    it('folds the spellings one model returns for a single concept', () => {
        // The whole aggregate depends on these collapsing: left alone they become three separate
        // labels, and one hot meta is reported as three cold ones.
        expect(normalizeMetaLabel('Dog')).toBe('dog');
        expect(normalizeMetaLabel('DOG meta')).toBe('dog');
        expect(normalizeMetaLabel('  dog  meme ')).toBe('dog');
        expect(normalizeMetaLabel('Dog Coin')).toBe('dog');
    });

    it('keeps hyphenated concepts as one label', () => {
        expect(normalizeMetaLabel('ai agent')).toBe('ai-agent');
        expect(normalizeMetaLabel('AI-Agent')).toBe('ai-agent');
    });

    it('answers UNLABELED rather than inventing a theme', () => {
        expect(normalizeMetaLabel('')).toBe(UNLABELED);
        expect(normalizeMetaLabel(null)).toBe(UNLABELED);
        expect(normalizeMetaLabel(undefined)).toBe(UNLABELED);
        expect(normalizeMetaLabel('   ')).toBe(UNLABELED);
        // A bare number classifies nothing.
        expect(normalizeMetaLabel('2024')).toBe(UNLABELED);
        // Stripping the filler words can empty a label entirely.
        expect(normalizeMetaLabel('meme coin token')).toBe(UNLABELED);
    });

    it('rejects a description masquerading as a label', () => {
        const sentence = 'a dog wearing a hat and sunglasses on the moon';
        expect(sentence.length).toBeGreaterThan(MAX_LABEL_LENGTH);
        expect(normalizeMetaLabel(sentence)).toBe(UNLABELED);
    });
});

describe('normalizeLabelBatch', () => {
    const requested = [
        { tokenMint: 'MINT_A', tokenName: 'Doge Rocket' },
        { tokenMint: 'MINT_B', tokenName: 'Trump 2028' },
        { tokenMint: 'MINT_C', tokenName: 'xk3j2' },
    ];

    it('matches answers back by mint instead of by position', () => {
        // A model handed a batch will reorder it. Trusting the order would put the politics label
        // on the dog token, which is silently wrong in a way nothing downstream could detect.
        const parsed = {
            labels: [
                { tokenMint: 'MINT_B', label: 'politics', confidence: 'high' },
                { tokenMint: 'MINT_A', label: 'dog', confidence: 'medium' },
                { tokenMint: 'MINT_C', label: 'unlabeled', confidence: 'low' },
            ],
        };

        const records = normalizeLabelBatch(parsed, requested);
        const byMint = new Map(records.map((r) => [r.tokenMint, r]));
        expect(byMint.get('MINT_A')?.label).toBe('dog');
        expect(byMint.get('MINT_B')?.label).toBe('politics');
        expect(byMint.get('MINT_C')?.label).toBe(UNLABELED);
    });

    it('gives every requested mint a record even when the model skips some', () => {
        // Without this the skipped mint re-enters the buffer and is paid for on every one of the
        // hundreds of re-analyses it receives.
        const records = normalizeLabelBatch({ labels: [{ tokenMint: 'MINT_A', label: 'dog' }] }, requested);

        expect(records).toHaveLength(3);
        const byMint = new Map(records.map((r) => [r.tokenMint, r]));
        expect(byMint.get('MINT_B')?.label).toBe(UNLABELED);
        expect(byMint.get('MINT_B')?.source).toBe('unlabeled');
    });

    it('drops answers for mints that were never asked about', () => {
        const records = normalizeLabelBatch(
            { labels: [{ tokenMint: 'GHOST_MINT', label: 'dog' }] },
            requested,
        );
        expect(records.map((r) => r.tokenMint).sort()).toEqual(['MINT_A', 'MINT_B', 'MINT_C']);
    });

    it('keeps the first answer when a mint is duplicated', () => {
        const records = normalizeLabelBatch(
            {
                labels: [
                    { tokenMint: 'MINT_A', label: 'dog' },
                    { tokenMint: 'MINT_A', label: 'cat' },
                ],
            },
            requested,
        );
        expect(records.find((r) => r.tokenMint === 'MINT_A')?.label).toBe('dog');
    });

    it('resolves an indexed answer, which is the cheap form the prompt asks for', () => {
        // Output tokens bill several times the input rate, and a 44-character mint retyped per
        // token was measured as the largest part of the response.
        const records = normalizeLabelBatch(
            {
                labels: [
                    { i: 1, label: 'politics', confidence: 'high' },
                    { i: 0, label: 'dog', confidence: 'medium' },
                ],
            },
            requested,
        );
        const byMint = new Map(records.map((r) => [r.tokenMint, r]));
        expect(byMint.get('MINT_A')?.label).toBe('dog');
        expect(byMint.get('MINT_B')?.label).toBe('politics');
    });

    it('discards an out-of-range index instead of attaching it to a neighbour', () => {
        const records = normalizeLabelBatch(
            { labels: [{ i: 99, label: 'dog' }, { i: -1, label: 'cat' }] },
            requested,
        );
        expect(records.every((r) => r.label === UNLABELED)).toBe(true);
    });

    it('never falls back to array position when an answer identifies nothing', () => {
        // The failure this guards against: a reordered response silently putting one token's
        // label onto another token.
        const records = normalizeLabelBatch({ labels: [{ label: 'dog' }] }, requested);
        expect(records.every((r) => r.label === UNLABELED)).toBe(true);
    });

    it('prefers an explicit mint over an index when both are present', () => {
        const records = normalizeLabelBatch(
            { labels: [{ i: 0, tokenMint: 'MINT_C', label: 'politics' }] },
            requested,
        );
        expect(records.find((r) => r.tokenMint === 'MINT_C')?.label).toBe('politics');
        expect(records.find((r) => r.tokenMint === 'MINT_A')?.label).toBe(UNLABELED);
    });

    it('accepts a bare array as well as a wrapped one', () => {
        const records = normalizeLabelBatch([{ tokenMint: 'MINT_A', label: 'dog' }], requested);
        expect(records.find((r) => r.tokenMint === 'MINT_A')?.label).toBe('dog');
    });

    it('applies vocabulary aliases so synonyms do not split a meta', () => {
        const aliases = new Map([['canine', 'dog']]);
        const records = normalizeLabelBatch(
            { labels: [{ tokenMint: 'MINT_A', label: 'Canine' }] },
            requested,
            aliases,
        );
        expect(records.find((r) => r.tokenMint === 'MINT_A')?.label).toBe('dog');
    });

    it('never reports high confidence on an unlabeled answer', () => {
        const records = normalizeLabelBatch(
            { labels: [{ tokenMint: 'MINT_A', label: '', confidence: 'high' }] },
            requested,
        );
        const record = records.find((r) => r.tokenMint === 'MINT_A');
        expect(record?.label).toBe(UNLABELED);
        expect(record?.confidence).toBe('low');
    });

    it('survives a malformed response without throwing', () => {
        for (const garbage of [null, undefined, 42, 'nope', {}]) {
            const records = normalizeLabelBatch(garbage, requested);
            expect(records).toHaveLength(3);
            expect(records.every((r) => r.label === UNLABELED)).toBe(true);
        }
    });
});

describe('shouldRefreshLabel', () => {
    it('asks only when nothing is stored', () => {
        expect(shouldRefreshLabel(undefined)).toBe(true);
    });

    it('never re-asks for a stored answer, including an unlabeled one', () => {
        // A name does not change, so a stored verdict is final. Re-asking would re-buy the same
        // answer forever for tokens the scanner keeps re-encountering.
        expect(
            shouldRefreshLabel({
                tokenMint: 'MINT_A',
                label: UNLABELED,
                confidence: 'low',
                source: 'unlabeled',
                labeledAt: 0,
            }),
        ).toBe(false);
    });
});

describe('extractNewLabels', () => {
    const record = (label: string) => ({
        tokenMint: label,
        label,
        confidence: 'high' as const,
        source: 'llm' as const,
        labeledAt: 0,
    });

    it('admits at most one new label per batch even when the model ignores the instruction', () => {
        const fresh = extractNewLabels(
            [record('dog'), record('quantum'), record('banana'), record('tariff')],
            new Set(['dog']),
        );
        expect(fresh).toEqual(['quantum']);
    });

    it('never admits the unlabeled sentinel as a vocabulary entry', () => {
        expect(extractNewLabels([record(UNLABELED)], new Set())).toEqual([]);
    });

    it('returns nothing when every label is already known', () => {
        expect(extractNewLabels([record('dog'), record('cat')], new Set(['dog', 'cat']))).toEqual([]);
    });
});
