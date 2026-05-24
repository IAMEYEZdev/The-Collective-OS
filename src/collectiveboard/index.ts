export {
  CollectiveBoardClient,
  getClient,
  BOARD_PROPERTIES,
} from './client.js';

export type {
  BoardConfig,
  Board,
  Card,
  CardFields,
  BoardProperty,
  AgentName,
  TaskStatus,
  TaskPriority,
  TaskTrack,
  WebhookPayload,
} from './client.js';

export type {
  AgentHealthMetrics,
  StatusHistoryEntry,
} from '../db.js';
