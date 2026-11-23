/**
 * The page a note is written out as: the rendered note between the app's own styles, so it
 * looks as it does in the app, with what makes it a page of its own.
 */

/** A name that is safe as a file's, from a note's title. */
export function fileName(title: string): string {
  const name = title
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name || 'Note';
}

/** The ending for a file of this media type (as browsers name them). */
export function extensionFor(type: string, fallback = 'bin'): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/ogg': 'ogv',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/flac': 'flac',
    'application/pdf': 'pdf',
    'font/woff2': 'woff2',
    'font/woff': 'woff',
    'font/ttf': 'ttf',
  };
  return known[type.split(';')[0]!.trim().toLowerCase()] ?? fallback;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Styles of the page itself, after the app's (which lay out a window, not a page). */
const PAGE_CSS = `
html,body{height:auto!important;min-height:0!important;overflow:visible!important;position:static!important}
body{margin:0!important;padding:0!important;background:var(--bg)!important;color:var(--text);font-family:var(--font-text);-webkit-font-smoothing:antialiased}
/* As wide as the text is in the app (its page: 764px with 32px on each side, 700px of text), so that a
   picture or video given a width takes the same share of the line as it does there. */
.pm-export-page{container-type:inline-size;--pm-text-w:100cqw;box-sizing:border-box;background:transparent!important;max-width:764px;margin:0 auto;padding:40px 32px 96px;font-size:16px;line-height:1.6;user-select:text;-webkit-user-select:text}
.pm-export-title{font-size:30px;font-weight:700;letter-spacing:-0.01em;line-height:1.25;margin:0 0 18px}
.pm-export-page img,.pm-export-page video,.pm-export-page iframe{max-width:100%}
.pm-export-page video{display:block;border-radius:6px}
.pm-export-page iframe.pm-frame-view{display:block;width:100%;border:0}
.pm-export-page .pm-export-missing{color:var(--text-muted);font-style:italic}
.pm-export-video{display:block;aspect-ratio:16/9;border-radius:6px;background:var(--bg-panel)}
/* As in the note: a video without a size of its own is as wide as the text. */
.pm-export-page .pm-video{display:flex}
.pm-export-page .pm-video>.pm-video-picture:not([width]){width:100%}
.pm-export-theme{position:fixed;top:14px;right:14px;z-index:20;display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid var(--border);border-radius:8px;background:var(--bg-elevated);color:var(--text-muted);cursor:pointer;opacity:.75}
.pm-export-theme:hover{opacity:1;color:var(--text)}
@media print{
  @page{size:A4;margin:18mm 16mm}
  html,body{background:#fff!important}
  .pm-export-page{max-width:none;padding:0}
  .pm-export-theme{display:none}
  h1,h2,h3,h4,h5,h6{break-after:avoid}
  figure,img,video,iframe,pre,table,blockquote,.pm-frame,.katex-display,.callout{break-inside:avoid}
  a{color:inherit;text-decoration:none}
}
`;

/** Frames tell their height as they are drawn; and the page tells when it is all there. */
const PAGE_SCRIPT = `
addEventListener('message',function(e){
  if(!e.data||e.data.type!=='pumice-frame-size')return;
  var frames=document.querySelectorAll('iframe.pm-frame-view');
  for(var i=0;i<frames.length;i++)
    if(frames[i].contentWindow===e.source&&!frames[i].hasAttribute('data-fixed'))
      frames[i].style.height=Math.max(40,Math.ceil(e.data.height))+'px';
});
addEventListener('load',function(){setTimeout(function(){window.__pumiceExportReady=true},1500)});
`;

export function pageHtml(opts: {
  title: string;
  /** The rendered note. */
  body: string;
  /** The app's styles (with what they load written out). */
  css: string;
  /** Attributes of the app's root that the styles go by (the theme). */
  rootAttributes: Record<string, string>;
  /**
   * The script that makes the page behave as the note does in the app (the player, the
   * enlarged view, the theme switch), with what it is told and the media kept for it.
   */
  runtime?: {
    script: string;
    config: unknown;
    media: { id: string; type: string; base64: string }[];
  };
}): string {
  const safe = (text: string) => text.replace(/<\/(script)/gi, '<\\/$1');
  const runtime = opts.runtime
    ? `${opts.runtime.media
        .map(
          (m) =>
            `<script type="application/octet-stream" id="${escapeHtml(m.id)}" data-type="${escapeHtml(m.type)}">${m.base64}</script>`,
        )
        .join('\n')}
<script type="application/json" id="pm-export-config">${safe(JSON.stringify(opts.runtime.config))}</script>
<script>${safe(opts.runtime.script)}</script>`
    : '';
  const attributes = Object.entries(opts.rootAttributes)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
  return `<!doctype html>
<html lang="en"${attributes}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Pumice">
<title>${escapeHtml(opts.title)}</title>
<style>${opts.css.replace(/<\/style/gi, '<\\/style')}</style>
<style>${PAGE_CSS}</style>
</head>
<body>
<main class="pm-export-page pm-rendered">
${opts.body}
</main>
<script>${PAGE_SCRIPT}</script>
${runtime}
</body>
</html>
`;
}

/**
 * The addresses in a piece of CSS (`url(…)`), each handed to `replace`, which gives the
 * address to write instead (or undefined to leave it).
 */
export async function rewriteCssUrls(
  css: string,
  replace: (url: string) => Promise<string | undefined>,
): Promise<string> {
  const found = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/g)];
  let out = '';
  let at = 0;
  for (const match of found) {
    const url = match[1] ?? match[2] ?? match[3] ?? '';
    out += css.slice(at, match.index);
    at = match.index + match[0].length;
    const next = /^(data:|#|about:)/i.test(url) ? undefined : await replace(url);
    out += next === undefined ? match[0] : `url("${next}")`;
  }
  return out + css.slice(at);
}
