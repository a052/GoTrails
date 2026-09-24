import { base } from '$app/paths';
import { languages } from '$lib/languages';
import { getURLForLanguage } from '$lib/utils';

export async function handle({ event, resolve }) {
    const language = event.params.language ?? 'en';
    const strings = await import(`./locales/${language}.json`);

    const path = event.url.pathname;
    const page = event.route.id?.replace('/[[language]]', '').split('/')[1] ?? 'home';

    let title = strings.metadata[`${page}_title`];
    const description = strings.metadata[`description`];

    if (page === 'help' && event.params.guide) {
        const [guide, subguide] = event.params.guide.split('/');
        const guideModule = subguide
            ? await import(`./lib/docs/${language}/${guide}/${subguide}.mdx`)
            : await import(`./lib/docs/${language}/${guide}.mdx`);
        title = `${title} | ${guideModule.metadata.title}`;
    }

    const htmlTag = `<html lang="${language}" translate="no">`;

    let headTag = `<head>
    <title>GoTrails — ${title}</title>
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": "GoTrails",
        "url": "https://gotrails.vercel.app"
    }
    </script>
    <meta name="description" content="${description}" />
    <meta property="og:title" content="GoTrails — ${title}" />
    <meta property="og:description" content="${description}" />
    <meta name="twitter:title" content="GoTrails — ${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta property="og:image" content="https://gotrails.vercel.app${base}/og_logo.png" />
    <meta property="og:url" content="https://gotrails.vercel.app/" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="GoTrails" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="https://gotrails.vercel.app${base}/og_logo.png" />
    <meta name="twitter:url" content="https://gotrails.vercel.app/" />
    <link rel="alternate" hreflang="x-default" href="https://gotrails.vercel.app${getURLForLanguage('en', path)}" />
    <link rel="manifest" href="/${language}.manifest.webmanifest" />`;

    if (page !== '404') {
        for (let lang of Object.keys(languages)) {
            headTag += `   <link rel="alternate" hreflang="${lang}" href="https://gotrails.vercel.app${getURLForLanguage(lang, path)}" />
`;
        }
    }

    const response = await resolve(event, {
        transformPageChunk: ({ html }) =>
            html.replace('<html>', htmlTag).replace('<head>', headTag),
    });

    return response;
}
