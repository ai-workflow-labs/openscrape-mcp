/**
 * SEO tools over a finished crawl.
 *
 * None of these make a network request. They read what the crawl already
 * stored, so an audit costs nothing and can be re-run with different
 * thresholds as often as you like.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getJob } from '../../core/crawl/store.js';
import {
  hasSeoData,
  seoRowCount,
  inlinkCounts,
  anchorsFor,
  outlinksFrom,
  brokenLinks,
  redirectedPages,
  duplicateGroups,
  allSeoRows,
} from '../../core/seo/store.js';
import { auditCrawl, type Severity } from '../../core/seo/audit.js';

const SEVERITY_MARK: Record<Severity, string> = {
  error: '✗',
  warning: '!',
  notice: '·',
};

/**
 * Every tool here needs a crawl that was run with SEO collection on. Saying so
 * plainly, with the fix, beats returning an empty report that reads like a
 * clean bill of health.
 */
function requireSeoJob(jobId: string): string | null {
  const job = getJob(jobId);
  if (!job) return `No job with id ${jobId}. Use crawl_jobs to list them.`;
  if (!hasSeoData(jobId)) {
    return (
      `Job ${jobId} has no SEO data stored, so there is nothing to report.\n\n` +
      `That happens when the crawl ran with seo:false, or before SEO collection existed. ` +
      `Re-run it with crawl_control { action: "recrawl", jobId: "${jobId}" }, or start a new crawl ` +
      `(seo is on by default).`
    );
  }
  return null;
}

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError };
}

export function registerSeoTools(server: McpServer): void {
  server.registerTool(
    'seo_audit',
    {
      title: 'Audit a crawl for on-page SEO issues',
      description:
        'On-page and structural SEO issues across a finished crawl: titles, meta descriptions, headings, canonicals, indexability, thin and near-duplicate content, image alt text, orphan pages, broken internal links and redirect chains. Reads stored crawl data only — no new requests, so it is free to re-run. Thresholds are conventions, not rules, and every one is adjustable here.',
      inputSchema: {
        jobId: z.string().describe('Crawl job id, from crawl or crawl_jobs.'),
        severity: z
          .enum(['error', 'warning', 'notice'])
          .optional()
          .describe('Report only this severity and worse. Default: everything.'),
        codes: z
          .array(z.string())
          .optional()
          .describe('Only these issue codes, e.g. ["title-duplicate","orphan-page"].'),
        maxTitle: z.number().optional().describe('Title length to flag above. Default 60.'),
        minTitle: z.number().optional().describe('Title length to flag below. Default 30.'),
        maxDescription: z.number().optional().describe('Description length to flag above. Default 160.'),
        minDescription: z.number().optional().describe('Description length to flag below. Default 70.'),
        minWords: z.number().optional().describe('Word count below which a page is thin. Default 300.'),
        maxRedirectHops: z.number().optional().describe('Hops to flag at or above. Default 2.'),
        duplicateDistance: z.number().optional().describe('Simhash distance treated as duplicate. Default 4.'),
        sampleSize: z.number().optional().describe('URLs listed per issue. Default 10.'),
      },
    },
    async (args) => {
      const jobId = args.jobId as string;
      const refusal = requireSeoJob(jobId);
      if (refusal) return text(refusal, true);

      const report = auditCrawl(jobId, {
        maxTitle: args.maxTitle as number | undefined,
        minTitle: args.minTitle as number | undefined,
        maxDescription: args.maxDescription as number | undefined,
        minDescription: args.minDescription as number | undefined,
        minWords: args.minWords as number | undefined,
        maxRedirectHops: args.maxRedirectHops as number | undefined,
        duplicateDistance: args.duplicateDistance as number | undefined,
        sampleSize: args.sampleSize as number | undefined,
      });

      const rank: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };
      const floor = args.severity ? rank[args.severity as Severity] : 2;
      const wanted = args.codes as string[] | undefined;
      const issues = report.issues.filter(
        (i) => rank[i.severity] <= floor && (!wanted?.length || wanted.includes(i.code)),
      );

      const out: string[] = [];
      out.push(`# SEO audit · ${report.pages} pages · job ${jobId}`);
      out.push(
        `${report.totals.error} error · ${report.totals.warning} warning · ${report.totals.notice} notice`,
      );
      const s = report.stats;
      out.push(
        `\nIndexable ${s.indexable} · noindex ${s.noindex} · error pages ${s.errorPages} · ` +
          `orphans ${s.orphans} · avg ${s.avgWords} words · with schema ${s.withSchema}`,
      );

      if (!issues.length) {
        out.push(
          `\nNo issues at this filter. That is not the same as "no issues": ` +
            `${report.issues.length} were found overall before filtering.`,
        );
        return text(out.join('\n'));
      }

      for (const i of issues) {
        out.push(`\n## ${SEVERITY_MARK[i.severity]} ${i.title} — ${i.count}`);
        out.push(`\`${i.code}\` · ${i.detail}`);
        for (const sample of i.samples) out.push(`- ${sample}`);
        if (i.count > i.samples.length) {
          out.push(`- …and ${i.count - i.samples.length} more`);
        }
      }

      const t = report.thresholds;
      out.push(
        `\n---\nThresholds used: title ${t.minTitle}-${t.maxTitle}, description ` +
          `${t.minDescription}-${t.maxDescription}, thin under ${t.minWords} words, ` +
          `redirect chains at ${t.maxRedirectHops}+ hops, duplicate distance ${t.duplicateDistance}. ` +
          `These are conventions, not published rules — pass your own to change them.`,
      );
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'link_graph',
    {
      title: 'Internal link structure of a crawl',
      description:
        'The internal link graph: how many internal links point at each page, which anchor text they use, click depth, orphans and dead ends. Call with a url for one page\'s inlinks, anchors and outlinks. This is the data an internal-linking or siloing decision needs.',
      inputSchema: {
        jobId: z.string().describe('Crawl job id.'),
        url: z
          .string()
          .optional()
          .describe('Report one page in detail: who links to it, with what anchor text, and where it links.'),
        orphansOnly: z.boolean().optional().describe('List only pages with no internal inlinks.'),
        limit: z.number().optional().describe('Rows to show. Default 40.'),
        sort: z
          .enum(['least-linked', 'most-linked', 'depth'])
          .optional()
          .describe('Row order. Default least-linked, because that is where the problems are.'),
      },
    },
    async (args) => {
      const jobId = args.jobId as string;
      const refusal = requireSeoJob(jobId);
      if (refusal) return text(refusal, true);

      const limit = (args.limit as number | undefined) ?? 40;

      // One page in detail.
      if (args.url) {
        const url = args.url as string;
        const anchors = anchorsFor(jobId, url);
        const outs = outlinksFrom(jobId, url, limit);
        const inlinkRow = inlinkCounts(jobId).find((r) => r.url === url);

        const out: string[] = [`# ${url}`];
        if (!inlinkRow) {
          out.push(
            `\nThis URL is not among the crawled pages of job ${jobId}. ` +
              `It may have been linked but never fetched (out of scope, or past the depth limit).`,
          );
        } else {
          out.push(`\nDepth ${inlinkRow.depth} · ${inlinkRow.inlinks} internal inlinks (${inlinkRow.followed} followed)`);
        }

        const totalAnchorUses = anchors.reduce((n, a) => n + a.uses, 0);
        out.push(`\n## Anchor text pointing here (${totalAnchorUses} links)`);
        if (!anchors.length) out.push('- none: nothing on the site links to this page');
        for (const a of anchors.slice(0, limit)) {
          out.push(`- ${a.uses}× ${a.anchor ? JSON.stringify(a.anchor) : '(empty anchor — image or bare link)'}`);
        }

        out.push(`\n## Links from this page (${outs.length} shown)`);
        if (!outs.length) out.push('- none: this page is a dead end');
        for (const o of outs) {
          const flags = [o.internal ? 'internal' : 'external', o.nofollow ? 'nofollow' : null]
            .filter(Boolean)
            .join(', ');
          out.push(`- [${flags}] ${o.anchor ? JSON.stringify(o.anchor.slice(0, 40)) : '(no anchor)'} -> ${o.to_url}`);
        }
        return text(out.join('\n'));
      }

      // Whole-site view.
      let rows = inlinkCounts(jobId);
      const total = rows.length;
      if (args.orphansOnly) rows = rows.filter((r) => r.inlinks === 0 && (r.depth ?? 0) > 0);

      const sort = (args.sort as string | undefined) ?? 'least-linked';
      if (sort === 'most-linked') rows = [...rows].sort((a, b) => b.inlinks - a.inlinks);
      else if (sort === 'depth') rows = [...rows].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));

      const shown = rows.slice(0, limit);
      const orphans = inlinkCounts(jobId).filter((r) => r.inlinks === 0 && (r.depth ?? 0) > 0).length;
      const deadEnds = allSeoRows(jobId).filter((r) => (r.links_internal ?? 0) === 0).length;

      const out: string[] = [`# Link graph · ${total} pages · job ${jobId}`];
      out.push(`${orphans} orphan page(s) · ${deadEnds} dead end(s) · sorted by ${sort}`);
      out.push('\n| inlinks | followed | depth | url |');
      out.push('|---|---|---|---|');
      for (const r of shown) {
        out.push(`| ${r.inlinks} | ${r.followed} | ${r.depth ?? 0} | ${r.url} |`);
      }
      if (rows.length > shown.length) out.push(`\n…and ${rows.length - shown.length} more rows.`);
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'broken_links',
    {
      title: 'Broken internal links and redirect chains',
      description:
        'Internal links whose target was crawled and answered 400 or above, with how many pages link to each, plus pages reached through redirect chains. Only visited URLs are judged, so a depth limit does not turn into a wall of false positives.',
      inputSchema: {
        jobId: z.string().describe('Crawl job id.'),
        limit: z.number().optional().describe('Rows per section. Default 50.'),
      },
    },
    async (args) => {
      const jobId = args.jobId as string;
      const refusal = requireSeoJob(jobId);
      if (refusal) return text(refusal, true);

      const limit = (args.limit as number | undefined) ?? 50;
      const broken = brokenLinks(jobId);
      const chains = redirectedPages(jobId);

      const out: string[] = [`# Broken links and redirects · job ${jobId}`];
      out.push(`${broken.length} broken internal target(s) · ${chains.length} redirected page(s)`);

      out.push(`\n## Broken internal links`);
      if (!broken.length) {
        out.push('None. Every internal link target that was crawled answered below 400.');
      }
      for (const b of broken.slice(0, limit)) {
        out.push(`\n- **${b.to_url}** — HTTP ${b.status}, linked from ${b.sources} page(s)`);
        out.push(`  e.g. ${b.example_from}${b.example_anchor ? ` (anchor: ${JSON.stringify(b.example_anchor)})` : ''}`);
      }

      out.push(`\n## Redirects`);
      if (!chains.length) out.push('None. Every page answered without a redirect.');
      for (const c of chains.slice(0, limit)) {
        const hops = c.chain.map((h) => `${h.status} -> ${h.to}`).join('\n    ');
        out.push(`\n- **${c.url}** — ${c.chain.length} hop(s), ${c.inlinks} internal link(s) point at the start`);
        out.push(`    from ${c.chain[0]?.from}`);
        out.push(`    ${hops}`);
      }
      if (chains.some((c) => c.chain.length >= 2)) {
        out.push(
          `\nA chain of two or more hops costs a round trip per hop. Point the internal links at the final URL.`,
        );
      }
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'duplicate_content',
    {
      title: 'Near-identical pages in a crawl',
      description:
        'Groups of pages whose text is nearly the same, found with a simhash fingerprint of the extracted text. Exact duplicates are already skipped during the crawl, so these are the harder case: templated pages that differ only in a name or a number, competing with each other in search.',
      inputSchema: {
        jobId: z.string().describe('Crawl job id.'),
        distance: z
          .number()
          .optional()
          .describe('Bits of difference allowed. 0 is identical text, 4 is the default, 8 is loose.'),
        minWords: z.number().optional().describe('Ignore pages shorter than this. Default 120.'),
        limit: z.number().optional().describe('Groups to show. Default 25.'),
      },
    },
    async (args) => {
      const jobId = args.jobId as string;
      const refusal = requireSeoJob(jobId);
      if (refusal) return text(refusal, true);

      const distance = (args.distance as number | undefined) ?? 4;
      const minWords = (args.minWords as number | undefined) ?? 120;
      const limit = (args.limit as number | undefined) ?? 25;
      const groups = duplicateGroups(jobId, distance, minWords);
      const pages = seoRowCount(jobId);

      const out: string[] = [`# Near-duplicate content · job ${jobId}`];
      out.push(`${groups.length} group(s) across ${pages} pages · distance <= ${distance} · min ${minWords} words`);

      if (!groups.length) {
        out.push(
          `\nNo near-duplicates at this threshold. Try a larger distance (6-8) to catch looser similarity, ` +
            `or a lower minWords if the site has many short pages.`,
        );
        return text(out.join('\n'));
      }

      for (const g of groups.slice(0, limit)) {
        out.push(`\n## ${g.urls.length} pages · distance ${g.distance} · ~${g.words} words`);
        for (const u of g.urls) out.push(`- ${u}`);
      }
      if (groups.length > limit) out.push(`\n…and ${groups.length - limit} more group(s).`);
      return text(out.join('\n'));
    },
  );
}
