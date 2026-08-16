export interface SocialLink {
    type: string;
    url: string;
}

export interface Website {
    label?: string;
    url: string;
}

export interface DexScreenerPair {
    chainId?: string;
    dexId?: string;
    pairAddress?: string;
    liquidity?: { usd?: number };
    fdv?: number;
    priceUsd?: string;
    pairCreatedAt?: number;
    priceChange?: { m5?: number; m15?: number; h1?: number; h6?: number; h24?: number };
    volume?: { m5?: number; h1?: number; h24?: number };
    txns?: {
        m5?: { buys?: number; sells?: number };
        h1?: { buys?: number; sells?: number };
    };
    info?: {
        socials?: SocialLink[];
        websites?: Website[];
    };
    baseToken?: { address?: string; symbol?: string; name?: string };
}

export interface TokenMetadata {
    liquidity: number;
    pairAddress?: string;
    marketCap: number;
    mcap?: number;
    pairCreatedAt?: number;
    /** Only pair so far is the pump.fun bonding curve, whose liquidity DexScreener never reports. */
    awaitingAmmPair?: boolean;
    symbol?: string;
    tokenName?: string;
    volumeSurge?: number;
    volScore?: number;
    zScore?: number;
    priceChange1h?: number;
    priceChange5m?: number;
    priceUsd?: number;
    buys5m?: number;
    sells5m?: number;
    isPumpFun?: boolean;
    isCTO?: boolean;
    isCommunityTakeover?: boolean;
    creatorExited?: boolean;
    hasWebsite?: boolean;
    hasTwitter?: boolean;
    hasTelegram?: boolean;
    isDexPaidUpdated?: boolean;
    whaleSignalScore?: number;
    route?: 'MICIN' | 'WHALE';
    positionSizeMultiplier?: number;
    aiDecisionSnapshotId?: number;
    socials?: {
        twitter?: string;
        telegram?: string;
        website?: string;
    };
    creator?: string;
    topHolder?: string;
}

export interface RugCheckHolder {
    address: string;
    amount: number;
    share: number;
    isInPool: boolean;
    isBurned: boolean;
}

export interface RugCheckResponse {
    mint: string;
    score: number;
    meta: {
        topHoldersPercentage: number;
        totalHolders: number;
        lpBurned: boolean;
        lpLocked: boolean;
    };
    holders: RugCheckHolder[];
    dangerReasons?: string[];
    /** RugCheck's bounded 0-100 rating. `score` is an unbounded raw sum and must not be thresholded. */
    scoreNormalised?: number;
}

export interface RugCheckApiHolder {
    address: string;
    amount: number;
    pct: number;
    owner: string;
}

export interface RugCheckKnownAccount {
    name: string;
    type: string;
}

export interface RugCheckMarketLp {
    lpLocked?: number;
    lpUnlocked?: number;
    lpLockedPct?: number;
    lpLockedUSD?: number;
    lpTotalSupply?: number;
}

export interface RugCheckMarket {
    pubkey?: string;
    marketType?: string;
    lp?: RugCheckMarketLp;
    // Legacy flat flags. The current RugCheck v1 report does not send these; the lock state
    // lives in `lp.lpLockedPct`. Kept optional so older/cached payloads still resolve.
    lpType?: string;
    lpStatus?: string;
}

export interface RugCheckRisk {
    level: string;
    name: string;
}

export interface RugCheckApiResponse {
    mint?: string;
    score?: number;
    score_normalised?: number;
    creator?: string;
    topHolders?: RugCheckApiHolder[];
    knownAccounts?: Record<string, RugCheckKnownAccount | undefined>;
    markets?: RugCheckMarket[];
    risks?: RugCheckRisk[];
}

export interface CreatorOwnershipResult {
    creatorPct: number | null;
    isCTO: boolean;
    creatorExited?: boolean;
    reliable: boolean;
}

export interface TradeExecutionPayload {
    tokenMint: string;
    amountSol: number;
    slippage: number;
    priorityFee: number;
    skipPreflight: boolean;
}
