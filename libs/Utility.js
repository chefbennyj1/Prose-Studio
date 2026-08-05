/**
 * Shared client helpers.
 *
 * This file was mostly panel plumbing: image mask reveals, scene and media
 * fetchers, media URL resolution, and palette extraction from artwork. All of
 * it went with the comic viewer.
 *
 * loadCSS and loadScript survive because the dashboard shell and the login page
 * load their stylesheets through them. The `appendSecret` wrapper they used to
 * carry went too — it existed so Puppeteer could bypass auth while rendering
 * pages for print export, and there is no such export any more.
 */

export async function loadCSS(href, forceReload = false) {
    if (!forceReload && [...document.styleSheets].some(sheet => sheet.href && sheet.href.includes(href))) return;
    return new Promise((resolve, reject) => {
        const finalHref = forceReload ? `${href}${href.includes('?') ? '&' : '?'}t=${Date.now()}` : href;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = finalHref;
        link.onload = resolve;
        link.onerror = () => reject(new Error(`Failed: ${href}`));
        document.head.appendChild(link);
    });
}

export function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.type = 'module';
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed: ${src}`));
        document.body.appendChild(script);
    });
}
