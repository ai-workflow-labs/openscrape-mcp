import type { ScrapeResult } from '../core/types.js';

/**
 * How results are rendered back to the model.
 *
 * This is deliberately terse. A scraping tool that returns a pretty-printed
 * JSON envelope spends thousands of tokens on punctuation and field names
 * before the model reads a single word of the page. We send a one-line header,
 * then the content.
 */
function human(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function headerLine(r: ScrapeResult): string {
  const m = r.metadata;
  const bits = [
    `${m.statusCode}`,
    m.renderedWith,
    `${m.elapsedMs}ms`,
  ];
  if (m.cached) bits.push('cached');
  if (m.revalidated) bits.push('revalidated-304');
  // An archived copy says so in the header as well as the warning, so it is
  // visible even when the reader skims.
  if (m.archive) bits.push(`ARCHIVED ${m.archive.capturedOn} (${m.archive.ageText} old)`);
  if (m.escalationReason) bits.push(`escalated:${m.escalationReason}`);
  if (m.blockReason) bits.push(`blocked:${m.blockReason}`);
  if (m.pages) bits.push(`${m.pages}p`);
  if (m.prunedChars) bits.push(`pruned:${human(m.prunedChars)}`);
  if (m.queryMatch) bits.push(`match:${m.queryMatch.matched}/${m.queryMatch.total}`);
  if (m.redactedCount) bits.push(`redacted:${m.redactedCount}`);
  if (m.truncatedChars) bits.push(`truncated:${human(m.truncatedChars)}`);
  return bits.join(' · ');
}

export function formatScrape(r: ScrapeResult, maxListed = 100): string {
  if (!r.success && r.error) {
    return `FAILED ${r.url}\n${r.error}`;
  }

  const out: string[] = [];
  const title = r.metadata.title ?? '(untitled)';
  out.push(`# ${title}`);
  out.push(`<${r.metadata.url}> · ${headerLine(r)}`);
  if (r.metadata.description) out.push(`> ${r.metadata.description}`);
  if (r.warning) out.push(`\n⚠ ${r.warning}`);
  if (r.metadata.archive) {
    out.push(`\nSnapshot: <${r.metadata.archive.snapshotUrl}>`);
  }
  // When the ladder had to climb, show the rungs: the reader should be able to
  // see why this took as long as it did, and what the live site actually said.
  if (r.metadata.ladder?.length) {
    out.push(`\nFetch ladder: ${r.metadata.ladder.join(' → ')}`);
  }

  if (r.query) {
    out.push(`\n## Query match\n\n${r.query}`);
  }
  if (r.markdown) {
    out.push(`\n## Content\n\n${r.markdown}`);
  }
  if (r.summary && !r.markdown) {
    out.push(`\n## Summary\n\n${r.summary}`);
  } else if (r.summary && r.markdown) {
    out.push(`\n## Summary\n\n${r.summary}`);
  }
  if (r.text && !r.markdown) {
    out.push(`\n## Text\n\n${r.text}`);
  }
  if (r.html) {
    out.push(`\n## HTML\n\n\`\`\`html\n${r.html}\n\`\`\``);
  }
  if (r.rawHtml) {
    out.push(`\n## Raw HTML\n\n\`\`\`html\n${r.rawHtml}\n\`\`\``);
  }
  if (r.json) {
    out.push(`\n## Structured data\n\n\`\`\`json\n${JSON.stringify(r.json, null, 2)}\n\`\`\``);
  }
  if (r.branding) {
    const b = r.branding;
    const lines: string[] = ['\n## Branding'];
    if (b.name) lines.push(`**Name:** ${b.name}`);
    if (b.themeColor) lines.push(`**Theme colour:** \`${b.themeColor}\` (declared, not inferred)`);

    if (b.colours.length) {
      lines.push(`\n**Colours**, most brand-like first:`);
      for (const c of b.colours) {
        lines.push(`- \`${c.value}\` — ${c.count} declaration(s), weight ${c.weight} [${c.sources.join(', ')}]`);
      }
    }
    if (b.fonts.length) {
      lines.push(`\n**Fonts**`);
      for (const f of b.fonts) {
        lines.push(`- ${f.family}${f.linked ? ' (web font, explicitly linked)' : ''} — ${f.count} use(s)`);
      }
    }
    if (b.logos.length) {
      lines.push(`\n**Logo candidates**`);
      for (const l of b.logos) lines.push(`- ${l.url} — ${l.kind}`);
    }
    if (b.icons.length) {
      lines.push(`\n**Icons**`);
      for (const i of b.icons) lines.push(`- ${i.url}${i.sizes ? ` (${i.sizes})` : ''} — ${i.rel}`);
    }
    if (b.manifest) lines.push(`\n**Manifest:** ${b.manifest}`);

    lines.push(
      `\nStylesheets: ${b.stylesheets.found} found, ${b.stylesheets.read} read.`,
    );
    // The notes say what was NOT looked at, which decides how much to trust
    // the palette above.
    for (const n of b.notes) lines.push(`- ${n}`);
    out.push(lines.join('\n'));
  }
  if (r.links?.length) {
    const shown = r.links.slice(0, maxListed);
    out.push(
      `\n## Links (${r.links.length}${r.links.length > shown.length ? `, showing ${shown.length}` : ''})\n\n` +
        shown.map((l) => `- ${l}`).join('\n'),
    );
  }
  if (r.images?.length) {
    const shown = r.images.slice(0, maxListed);
    out.push(
      `\n## Images (${r.images.length}${r.images.length > shown.length ? `, showing ${shown.length}` : ''})\n\n` +
        shown.map((l) => `- ${l}`).join('\n'),
    );
  }
  if (r.references?.length) {
    out.push(`\n_${r.references.length} references inlined above._`);
  }
  if (r.metadata.spilledTo) {
    out.push(`\n_Full text on disk: ${r.metadata.spilledTo}_`);
  }
  if (r.actionResults?.length) {
    out.push(`\n_${r.actionResults.length} action result(s) captured._`);
  }

  return out.join('\n');
}
