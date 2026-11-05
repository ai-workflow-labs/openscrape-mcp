/**
 * Operator policy, visible to the caller.
 *
 * A limit nobody can see is a limit people work around by accident, so the
 * active lockdown is readable through a tool. It is read-only on purpose: a
 * restriction a model could lift from inside would not be a restriction. To
 * change it, edit the file.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  lockdownActive,
  lockdownConfig,
  lockdownPath,
  lockdownSummary,
  reloadLockdown,
  privateTargetsAllowed,
} from '../../core/policy/lockdown.js';
import { DATA_DIR } from '../../core/util/paths.js';

const EXAMPLE = `{
  "allowedDomains": ["example.com", "docs.example.org"],
  "allowedFormats": ["markdown", "links", "query"],
  "maxChars": 20000,
  "maxCrawlPages": 200,
  "allowExecuteJavascript": false,
  "allowFileParse": false,
  "requireRobots": true,
  "note": "Research workstation. Ask ops to widen."
}`;

export function registerPolicyTools(server: McpServer): void {
  server.registerTool(
    'lockdown_status',
    {
      title: 'Show the active operator policy',
      description:
        'What this server is currently allowed to do: permitted domains and formats, caps on output and crawl size, and whether the browser, proxies, local file reads and the web archive are enabled. Read-only — the policy lives in a config file and cannot be changed through any tool.',
      inputSchema: {
        reload: z
          .boolean()
          .optional()
          .describe('Re-read the config file from disk first, after editing it.'),
      },
    },
    async (args) => {
      if (args.reload) reloadLockdown();

      const out: string[] = ['# Lockdown status', '', lockdownSummary()];

      if (!lockdownActive()) {
        out.push(
          '',
          'Nothing is restricted. Every tool can reach any public host, in any format, with no caps.',
          '',
          `To lock it down, write a config to \`${DATA_DIR}\\lockdown.json\` (or point \`OPENSCRAPE_LOCKDOWN\` at one):`,
          '',
          '```json',
          EXAMPLE,
          '```',
          '',
          'Absent keys mean "no restriction". Private, loopback and link-local',
          'addresses are refused once any lockdown file exists, unless',
          '`allowPrivateTargets` is explicitly true.',
          '',
          'A file that exists but is not valid JSON refuses every request, by design:',
          'a security control that disabled itself on a typo would be worse than none.',
        );
        return { content: [{ type: 'text' as const, text: out.join('\n') }] };
      }

      const config = lockdownConfig();
      out.push('', `Config file: ${lockdownPath()}`);
      out.push(`Private/loopback targets: ${privateTargetsAllowed() ? 'ALLOWED' : 'denied'}`);

      if (config) {
        out.push('', '## Rules as written', '', '```json', JSON.stringify(config, null, 2), '```');
        out.push(
          '',
          'Anything not listed is unrestricted. Edit the file and call this tool with',
          '`reload: true` to pick up changes without restarting.',
        );
      } else {
        out.push(
          '',
          'The file could not be read, so **every request is being refused**. Fix the',
          'JSON, then call this tool with `reload: true`.',
        );
      }

      return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    },
  );
}
