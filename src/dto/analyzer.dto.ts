export interface SocialLink {
    type: string;
    url: string;
}

export interface Website {
    label?: string;
    url: string;
}

export interface DexScreenerPair {
    liquidity?: { usd?: number };
    fdv?: number;
    pairCreatedAt?: number;
    priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
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
    marketCap: number;
    mcap?: number;
    pairCreatedAt?: number;
    symbol?: string;
    volumeSurge?: number;
    volScore?: number;
    zScore?: number;
    priceChange1h?: number;
    isPumpFun?: boolean;
    isCTO?: boolean;
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

export interface RugCheckMarket {
    lpType: string;
    lpStatus: string;
}

export interface RugCheckRisk {
    level: string;
    name: string;
}

export interface RugCheckApiResponse {
    mint?: string;
    score?: number;
    creator?: string;
    topHolders?: RugCheckApiHolder[];
    knownAccounts?: Record<string, RugCheckKnownAccount | undefined>;
    markets?: RugCheckMarket[];
    risks?: RugCheckRisk[];
}

export interface CreatorOwnershipResult {
    creatorPct: number | null;
    isCTO: boolean;
    reliable: boolean;
}

export interface TradeExecutionPayload {
    tokenMint: string;
    amountSol: number;
    slippage: number;
    priorityFee: number;
    skipPreflight: boolean;
}
