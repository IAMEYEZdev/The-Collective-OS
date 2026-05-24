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
    --revenue <amt>    Revenue value (e.g. 500)
    --depends-on <id>  Depends on card ID

  status <cardId> <status>    Update task status
    --approver <name>          Required when review→done (approval gate)
  reassign <cardId> --agent <name>    Reassign to agent
  complete <cardId>           Mark done (--approver required if in review)
  block <cardId>              Mark blocked
  delete <cardId>             Delete task

  revenue <cardId> <amount>   Set revenue value on task
  depend <cardId> <depId>     Set dependency (cardId depends on depId)
  dependents <cardId>         Show cards that depend on this card
  history <cardId>            Show status transition history
  cycletime <cardId>          Show cycle time (active→done)

  list                        List all tasks
    --agent <name>            Filter by agent
    --status <s>              Filter by status

  view                        Filtered view (human-readable)
    --agent <name>            Filter by agent
    --status <s>              Filter by status
    --track <t>               Filter by track: ${TRACKS.join(', ')}
    --priority <p>            Filter by priority

  pipeline                    Revenue pipeline summary
    --agent <name>            Filter by agent
    --track <t>               Filter by track

  health                      Agent health metrics (velocity, cycle time)
    --agent <name>            Single agent detail

  dashboard                   Show team overview (includes revenue + health)
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
          revenue: flags.revenue ? parseFloat(flags.revenue) : undefined,
          dependsOn: flags['depends-on'],
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
        console.log(`${'='.repeat(50)}`);
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
        if (dash.pipelineValue > 0) {
          console.log(`\nPipeline Value: $${dash.pipelineValue.toLocaleString()}`);
          for (const [a, v] of Object.entries(dash.revenueByAgent)) {
            console.log(`  ${a}: $${v.toLocaleString()}`);
          }
        }
        if (dash.health.length > 0) {
          console.log(`\nAgent Health:`);
          for (const h of dash.health) {
            const cycle = h.avg_cycle_seconds ? `${Math.round(h.avg_cycle_seconds / 60)}min` : '-';
            console.log(`  ${h.agent_id}: ${h.completed}/${h.total_tasks} done (${h.completion_rate}%) | active: ${h.active_count} | blocked: ${h.blocked_count} | avg cycle: ${cycle}`);
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

      case 'revenue': {
        const cardId = positional[1];
        const amount = parseFloat(positional[2]);
        if (!cardId || isNaN(amount)) { console.error('Error: cardId and amount required'); process.exit(1); }
        await client.setRevenue(cardId, amount);
        console.log(JSON.stringify({ cardId, revenue: amount }));
        break;
      }

      case 'depend': {
        const cardId = positional[1];
        const depId = positional[2];
        if (!cardId || !depId) { console.error('Error: cardId and depId required'); process.exit(1); }
        await client.setDependency(cardId, depId);
        console.log(JSON.stringify({ cardId, dependsOn: depId }));
        break;
      }

      case 'dependents': {
        const cardId = positional[1];
        if (!cardId) { console.error('Error: cardId required'); process.exit(1); }
        const deps = await client.getDependents(cardId);
        if (deps.length === 0) {
          console.log('No cards depend on this task.');
        } else {
          console.log(`${deps.length} dependent(s):`);
          for (const d of deps) {
            const p = client.resolveCardProps(d);
            console.log(`  ${d.title} (${d.id}) [${p.status}]`);
          }
        }
        break;
      }

      case 'history': {
        const cardId = positional[1];
        if (!cardId) { console.error('Error: cardId required'); process.exit(1); }
        const history = client.getTaskHistory(cardId);
        if (history.length === 0) {
          console.log('No status history for this card.');
        } else {
          console.log(`Status history (${history.length} transitions):\n`);
          for (const h of history) {
            const time = new Date(h.created_at * 1000).toLocaleString();
            console.log(`  ${time} | ${h.old_status || '(new)'} -> ${h.new_status} | @${h.agent_id}`);
          }
        }
        break;
      }

      case 'cycletime': {
        const cardId = positional[1];
        if (!cardId) { console.error('Error: cardId required'); process.exit(1); }
        const secs = client.getTaskCycleTime(cardId);
        if (secs === null) {
          console.log('No cycle time available (needs both active and done transitions).');
        } else {
          const mins = Math.round(secs / 60);
          const hours = Math.round(secs / 3600 * 10) / 10;
          console.log(`Cycle time: ${secs}s (${mins}min / ${hours}h)`);
        }
        break;
      }

      case 'pipeline': {
        const pv = await client.getPipelineValue({
          agent: flags.agent as AgentName | undefined,
          track: flags.track as TaskTrack | undefined,
        });
        console.log(`\nPipeline Value: $${pv.total.toLocaleString()}`);
        if (Object.keys(pv.byAgent).length > 0) {
          console.log(`\nBy Agent:`);
          for (const [a, v] of Object.entries(pv.byAgent)) {
            console.log(`  ${a}: $${v.toLocaleString()}`);
          }
        }
        if (Object.keys(pv.byTrack).length > 0) {
          console.log(`\nBy Track:`);
          for (const [t, v] of Object.entries(pv.byTrack)) {
            console.log(`  ${t}: $${v.toLocaleString()}`);
          }
        }
        if (Object.keys(pv.byStatus).length > 0) {
          console.log(`\nBy Status:`);
          for (const [s, v] of Object.entries(pv.byStatus)) {
            console.log(`  ${s}: $${v.toLocaleString()}`);
          }
        }
        break;
      }

      case 'health': {
        const agentFilter = flags.agent;
        const metrics = client.getAgentHealthReport(agentFilter);
        if (metrics.length === 0) {
          console.log('No agent health data yet. Status transitions generate health metrics.');
        } else {
          console.log(`\nAgent Health Report`);
          console.log(`${'='.repeat(50)}`);
          for (const m of metrics) {
            const cycle = m.avg_cycle_seconds ? `${Math.round(m.avg_cycle_seconds / 60)}min` : 'n/a';
            console.log(`\n${m.agent_id}:`);
            console.log(`  Tasks: ${m.total_tasks} | Completed: ${m.completed} (${m.completion_rate}%)`);
            console.log(`  Active: ${m.active_count} | Blocked: ${m.blocked_count}`);
            console.log(`  Avg Cycle Time: ${cycle}`);
          }
        }
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
