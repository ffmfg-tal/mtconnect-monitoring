export type Env = {
  DB: D1Database;
  EDGE_SHARED_SECRET: string;
  EDGE_TUNNEL_HOSTNAME?: string;
  SLACK_WEBHOOK_URL?: string;
};
