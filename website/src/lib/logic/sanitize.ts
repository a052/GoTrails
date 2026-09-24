// Allowlists for values that come from untrusted content — GPX file contents and OpenStreetMap tags
// — and are about to be written into a DOM sink (an `href`, an `src`, a `style` attribute). Svelte
// escapes text and attribute values, but it does not restrict URL schemes: a dynamic
// `href={value}` accepts `javascript:` and executes it on click.

// `mailto:`/`tel:` are allowed for links because GPX <link> and OSM contact tags legitimately use
// them; images may only be fetched over http(s).
const LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];
const IMAGE_SCHEMES = ['http:', 'https:'];

// Parsing with `new URL()` rather than string matching is deliberate: the URL parser strips tabs,
// newlines and leading control characters exactly like the browser does when it resolves an
// attribute, so obfuscated schemes such as `java\nscript:alert(1)` are rejected instead of being
// smuggled past a `startsWith()` check. The normalized `href` is returned (never the raw input) so
// the browser cannot re-parse the value into a different scheme than the one checked here.
function safeUrl(
    value: string | undefined | null,
    allowedSchemes: string[],
    fallbackToHttps: boolean
): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    const trimmed = value.trim();
    if (trimmed === '') {
        return undefined;
    }

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        // Values without a scheme are common in OSM `website` tags ("www.example.com"). Retrying
        // them as https keeps the link pointing at the intended host, instead of emitting a
        // relative href that resolves against GoTrails itself. Anything with a scheme — including
        // `javascript:` — parses above and is rejected below, so it never reaches this branch.
        if (!fallbackToHttps) {
            return undefined;
        }
        try {
            url = new URL(`https://${trimmed.replace(/^\/+/, '')}`);
        } catch {
            return undefined;
        }
    }

    if (!allowedSchemes.includes(url.protocol)) {
        return undefined;
    }

    return url.href;
}

// Returns a URL safe to use as a link target, or undefined when the value is missing or uses a
// scheme that is not on the allowlist. Callers must render the value as plain text in that case.
export function safeLinkUrl(value: string | undefined | null): string | undefined {
    return safeUrl(value, LINK_SCHEMES, true);
}

// Returns a URL safe to use as an image source, or undefined when it is missing or not http(s).
export function safeImageUrl(value: string | undefined | null): string | undefined {
    return safeUrl(value, IMAGE_SCHEMES, true);
}

// GPX `gpx_style:color` values are arbitrary strings from the file, and end up interpolated into a
// `style` attribute. Only plain hex colors are let through; anything else could close the
// declaration and inject further CSS (e.g. an external `background-image` that leaks the visitor's
// IP address).
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: string | undefined | null): boolean {
    return typeof value === 'string' && HEX_COLOR.test(value);
}
