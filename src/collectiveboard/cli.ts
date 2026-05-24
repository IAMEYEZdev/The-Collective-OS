#!/usr/bin/env node
/**
 * CollectiveBoard CLI - Agent-facing command interface
 *
 * Usage:
 *   collectiveboard create "Task title" --agent melanie --priority high --track delivery
 *   collectiveboard status <cardId> active|blocked|done|review
 *   collectiveboard reassign <cardId> --agent james
 *   collectiveboard list [--agent melanie] [--status active]
 *   collectiveboard view [--agent melanie] [--track delivery] [--status active] [--priority high]
 *   collectiveboard dashboard
 *   collectiveboard delete <cardId>
 */

import { CollectiveBoardClient, AgentName, TaskStatus, TaskPriority, TaskTrack } from './client.js';
import { initDatabase } from '../db.js';

// Init DB so audit logging works
initDatabase();

const AGENTS: AgentName[] = ['melanie', 'james', 'annika', 'sean', 'melissa', 'jackson'];
const STATUSES: TaskStatus[] = ['backlog', 'active', 'blocked', 'review', 'done'];
const PRIORITIES: TaskPriority[] = ['critical', 'high', 'normal', 'low'];
const TRACKS: TaskTrack[] = ['authority', 'delivery', 'internal'];

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

function usage(): void {
  console.log(`CollectiveBoard CLI

Commands:
  create <title>    Create task card
    --agent <name>     Agent: ${AGENTS.join(', ')}
    --status <s>       Status: ${STATUSES.join(', ')} (default: active)
    --priority <p>     Priority: ${PRIORITIES.join(', ')} (default: normal)
    --track <t>        Track: ${TRACKS.join(', ')}
    --layer <L1-L6>    RecursiveMAS layer
    --goal <id>        Link to goal ID
    --mission <id>     Link to mission ID

  status <cardId> <status>    Update task status
    --approver <name>          Required when review→done (approval gate)
  reassign <cardId> --agent <name>    Reassign to agent
  complete <cardId>           Mark done (--approver required if in review)
  block <cardId>              Mark blocked
  delete <cardId>             Delete task

  list                        List all tasks
    --agent <name>            Filter by agent
    --status <s>              Filter by status

  view                        Filtered view (human-readable)
    --agent <name>            Filter by agent
    --status <s>              Filter by status
    --track <t>               Filter by track: ${TRACKS.join(', ')}
    --priority <p>            Filter by priority

  dashboard                   Show team overview
  board                       Show board info
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
    process.exit(0);
  }

  const { positional, flags } = parseArgs(args);
  const command = positional[0];
  const client = new CollectiveBoardClient();

  try {
    switch (command) {
      case 'create': {
        const title = positional.slice(1).join(' ');
        if (!title) { console.error('Error: title required'); process.exit(1); }
        const agent = (flags.agent || 'melanie') as AgentName;
        if (!AGENTS.includes(agent)) { console.error(`Error: invalid agent "${agent}"`); process.exit(1); }

        const card = await client.createTask({
          title,
          agent,
          status: (flags.status as TaskStatus) || 'active',
          priority: (flags.priority as TaskPriority) || 'normal',
          track: flags.track as TaskTrack | undefined,
          layer: flags.layer,
          goalId: flags.goal,
          missionId: flags.mission,
        });

        console.log(JSON.stringify({ id: card.id, title: card.title, agent }, null, 2));
        break;
      }

      case 'status': {
        const cardId = positional[1];
        const status = positional[2] as TaskStatus;
        if (!cardId || !status) { console.error('Error: cardId and status required'); process.exit(1); }
        if (!STATUSES.includes(status)) { console.error(`Error: invalid status "${status}"`); process.exit(1); }

        await client.updateTaskStatus(cardId, status, {
          approver: flags.approver,
        });
        console.log(JSON.stringify({ cardId, status, approver: flags.approver || null }));
        break;
      }

      case 'reassign': {
        const cardId = positional[1];
        const agent = flags.agent as AgentName;
        if (!cardId || !agent) { console.error('Error: cardId and --agent required'); process.exit(1); }

        await client.reassignTask(cardId, agent);
        console.log(JSON.stringify({ cardId, agent }));
        break;
      }

      case 'complete': {
        const cardId = positional[1];
        if (!cardId) { console.error('Error: cardId required'); process.exit(1); }
        await client.updateTaskStatus(cardId, 'done', {
          approver: flags.approver,
        });
        console.log(JSON.stringify({ cardId, status: 'done', approver: flags.approver || null }));
        break;
      }

      case 'block': {
        const cardId = positional[1];
        if (!cardId) { console.error('Error: cardId required'); process.exit(1); }
        await client.blockTask(cardId);
        console.log(JSON.stringify({ cardId, status: 'blocked' }));
        break;
      }

      case 'delete': {
        const cardId = positional[1];
        if (!cardId) { console.error('Error: cardId required'); process.exit(1); }
        await client.deleteTask(cardId);
        console.log(JSON.stringify({ cardId, deleted: true }));
        break;
      }

      case 'list': {
        let tasks;
        if (flags.agent) {
          tasks = await client.getAgentTasks(flags.agent as AgentName);
        } else if (flags.status === 'active') {
          tasks = await client.getActiveTasks();
        } else if (flags.status === 'blocked') {
          tasks = await client.getBlockedTasks();
        } else {
          tasks = await client.getAllTasks();
        }

        const summary = tasks.map(t => ({
          id: t.id,
          title: t.title,
          icon: t.fields?.icon,
          properties: t.fields?.properties || {},
        }));

        console.log(JSON.stringify(summary, null, 2));
        break;
      }

      case 'dashboard': {
        const dash = await client.getDashboard();
        console.log(`\nCollectiveBoard Dashboard`);
        console.log(`${'='.repeat(40)}`);
        console.log(`Total tasks: ${dash.total}`);
        console.log(`\nBy Status:`);
        for (const [s, n] of Object.entries(dash.byStatus)) {
          if (n > 0) console.log(`  ${s}: ${n}`);
        }
        console.log(`\nBy Agent:`);
        for (const [a, n] of Object.entries(dash.byAgent)) {
          if (n > 0) console.log(`  ${a}: ${n}`);
        }
        if (dash.blocked.length > 0) {
          console.log(`\nBlocked:`);
          for (const b of dash.blocked) {
            console.log(`  - ${b.title} (${b.id})`);
          }
        }
        break;
      }

      case 'view': {
        // Filtered view with human-readable output
        const tasks = await client.getFilteredTasks({
          agent: flags.agent as AgentName | undefined,
          status: flags.status as TaskStatus | undefined,
          track: flags.track as TaskTrack | undefined,
          priority: flags.priority as TaskPriority | undefined,
        });

        if (tasks.length === 0) {
          console.log('No tasks match filters.');
          break;
        }

        // Build filter label
        const filterParts: string[] = [];
        if (flags.agent) filterParts.push(`agent=${flags.agent}`);
        if (flags.status) filterParts.push(`status=${flags.status}`);
        if (flags.track) filterParts.push(`track=${flags.track}`);
        if (flags.priority) filterParts.push(`priority=${flags.priority}`);
        const label = filterParts.length > 0 ? filterParts.join(', ') : 'all';

        console.log(`\n${tasks.length} task${tasks.length === 1 ? '' : 's'} (${label}):\n`);

        for (const t of tasks) {
          const p = client.resolveCardProps(t);
          const icon = t.fields?.icon || '';
          console.log(`${icon} ${t.title}`);
          console.log(`  ID: ${t.id}`);
          console.log(`  Status: ${p.status} | Agent: ${p.agent} | Priority: ${p.priority}`);
          if (p.track !== '-') console.log(`  Track: ${p.track}`);
          if (p.layer !== '-') console.log(`  Layer: ${p.layer}`);
          const goalId = t.fields?.properties?.['prop-goal-id'] as string || '';
          const missionId = t.fields?.properties?.['prop-mission-id'] as string || '';
          if (goalId) console.log(`  Goal: ${goalId}`);
          if (missionId) console.log(`  Mission: ${missionId}`);
          console.log();
        }
        break;
      }

      case 'board': {
        const board = await client.getBoard();
        console.log(JSON.stringify(board, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        usage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

main();
