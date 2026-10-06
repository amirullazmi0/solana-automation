/**
 * Normalises a dashboard base into an origin, or returns nothing.
 *
 * Accepts a bare hostname as well as a full URL, because `msoulmation.apps.arulize.com` is what a
 * person actually has in hand and forgetting the scheme would otherwise silence the button. A bare
 * value is assumed to be https.
 *
 * Returns undefined for anything it cannot be sure of, and that caution is the point rather than a
 * detail: Telegram validates every button url it is handed and rejects the WHOLE message with a 400
 * when one is malformed, so a half-configured base does not produce one dead button -- it silently
 * deletes every token alert the bot sends.
 */
export function resolveDashboardBase(raw: string | undefined): string | undefined {
    const value = String(raw ?? '').trim();
    if (!value) return undefined;
    // A space can never appear in a host and is the shape of a sentence typed into the field.
    if (/\s/.test(value)) return undefined;

    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`;

    let parsed: URL;
    try {
        parsed = new URL(withScheme);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;

    // A hostname with no dot is either localhost or a typo, and a typo here is an outage.
    const host = parsed.hostname;
    if (!host || (!host.includes('.') && host !== 'localhost')) return undefined;

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}
