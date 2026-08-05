// views/dashboard/components/Editor/EditorRender.js

/**
 * Escaping and a minimal Markdown renderer for critique output.
 *
 * Everything here escapes first. The critic quotes the manuscript back, and a
 * manuscript legitimately contains angle brackets and ampersands — treating
 * that text as markup would be both a rendering bug and an injection route.
 */

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function renderMarkdown(text) {
    if (!text) return '';

    const html = [];
    let inList = false;
    const closeList = () => { if (inList) { html.push('</ul>'); inList = false; } };

    for (const raw of escapeHtml(text).split('\n')) {
        const line = raw.trimEnd();
        if (!line.trim()) { closeList(); continue; }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            closeList();
            html.push(`<h${Math.min(heading[1].length + 2, 6)}>${inline(heading[2])}</h${Math.min(heading[1].length + 2, 6)}>`);
            continue;
        }

        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
            if (!inList) { html.push('<ul class="editor__list">'); inList = true; }
            // "- &gt; text" marks a fragment quoted from the manuscript.
            const quoted = bullet[1].match(/^&gt;\s*(.*)$/);
            html.push(quoted
                ? `<li><blockquote>${inline(quoted[1])}</blockquote></li>`
                : `<li>${inline(bullet[1])}</li>`);
            continue;
        }

        if (inList) { html.push(`<p class="text-muted">${inline(line.trim())}</p>`); continue; }
        html.push(`<p>${inline(line.trim())}</p>`);
    }
    closeList();
    return html.join('\n');
}

function inline(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|\s)_(.+?)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');
}
