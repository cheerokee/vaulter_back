import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AgentToolDef } from '../../src/agents/domain/agent-tool.js';
import { hubClient } from './hub-client.js';
import type { ClaimedHub } from './hubs-kit.js';

/**
 * The agent (a `pc` hub) as seen from the HTTP: publishes its tool catalog with its own hub token. Shared by the agents
 * e2e specs (ACL, policy, brain) that need a catalog to exist.
 */
export function agentsKit(getApp: () => INestApplication) {
  const h = hubClient(getApp);
  const http = () => request(getApp().getHttpServer());

  /** One tool of each category, valid by `assertAgentTools`. */
  const defaultTools = (): AgentToolDef[] => [
    {
      name: 'mcp:github/create_issue',
      title: 'Create issue',
      description: 'Creates an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
      },
      category: 'mcp',
    },
    {
      name: 'browser:open',
      title: 'Open page',
      description: 'Opens a page in the browser.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
      },
      category: 'browser',
    },
    {
      name: 'folder:read',
      title: 'Read file',
      description: 'Reads a file of the shared folder.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
      category: 'folder',
    },
  ];

  return {
    defaultTools,
    /** `PUT /hub/agent/tools` with the hub's token (authenticates the device first); returns the raw response. */
    publishTools: async (
      hub: ClaimedHub,
      tools: unknown[] = defaultTools(),
    ): Promise<request.Response> => {
      const token = await h.authenticate(hub);
      return http()
        .put('/hub/agent/tools')
        .set('Authorization', `Bearer ${token}`)
        .send({ tools });
    },
  };
}

export type AgentsKit = ReturnType<typeof agentsKit>;
