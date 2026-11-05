/**
 * Decides whether a plain HTTP fetch produced real content or an empty SPA shell.
 * This heuristic is what keeps the scraper fast: most pages never need a browser.
 */
const SHELL_IDS = [
  'root',
  '__next',
  '__nuxt',
  'app',
  'app-root',
  'q-app',
  'svelte',
  'gatsby-focus-wrapper',
];

const FRAMEWORK_MARKERS = [
  '__NEXT_DATA__',
  'window.__NUXT__',
  'ng-version',
  'data-reactroot',
  'window.__INITIAL_STATE__',
  'window.__APOLLO_STATE__',
  '__remixContext',
];

export interface JsVerdict {
  needsJs: boolean;
  reason: string;
  /** 0..1, how sure we are. */
  confidence: number;
}

function hasEmptyMount(html: string): string | null {
  for (const id of SHELL_IDS) {
    const re = new RegExp(
      '<(div|main|section)[^>]+id=["\']' +
        id +
        '["\'][^>]*>\\s*(<!--[\\s\\S]*?-->)?\\s*</(div|main|section)>',
      'i',
    );
    if (re.test(html)) return id;
  }
  return null;
}

export function needsJavaScript(html: string, extractedText: string): JsVerdict {
  const text = extractedText.trim();
  const lower = html.toLowerCase();

  // A real article always leaves a decent amount of text behind.
  if (text.length >= 600) return { needsJs: false, reason: 'enough-text', confidence: 0.95 };

  // Hard signal: an empty mount node means a client-rendered app.
  const mount = hasEmptyMount(html);
  if (mount) return { needsJs: true, reason: 'empty-mount-' + mount, confidence: 0.95 };

  if (/<noscript>[^<]*(enable|turn on)\s+javascript/i.test(html)) {
    return { needsJs: true, reason: 'noscript-warning', confidence: 0.9 };
  }

  const hasFramework = FRAMEWORK_MARKERS.some((m) => html.includes(m));
  const scriptBytes = (lower.match(/<script[\s\S]*?<\/script>/g) ?? []).join('').length;
  const scriptRatio = scriptBytes / Math.max(html.length, 1);

  if (text.length < 200) {
    // A small page that ships almost no JavaScript is simply a small page.
    // Rendering it in a browser would cost seconds and change nothing.
    if (!hasFramework && scriptRatio < 0.2 && html.length < 20_000) {
      return { needsJs: false, reason: 'small-static-page', confidence: 0.8 };
    }
    return {
      needsJs: true,
      reason: hasFramework ? 'thin-text+framework' : 'thin-text+scripts',
      confidence: hasFramework ? 0.9 : 0.7,
    };
  }

  // Lots of script, barely any prose: likely hydrated client-side.
  if (scriptRatio > 0.5 && text.length < 400) {
    return { needsJs: true, reason: 'script-heavy', confidence: 0.75 };
  }

  return { needsJs: false, reason: 'acceptable-text', confidence: 0.6 };
}
