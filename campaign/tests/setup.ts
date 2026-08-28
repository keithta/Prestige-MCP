// Loaded before every test file. Keeps test runs from ever touching a real
// tenant or a production database by accident.
import { config } from 'dotenv';

config({ path: '.env.test', override: false });
config({ path: '.env', override: false });

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://campaign:campaign@127.0.0.1:55432/campaign_test';

// A test run must never be able to reach the real Graph endpoint.
if (!process.env.GRAPH_BASE_URL || process.env.GRAPH_BASE_URL.includes('graph.microsoft.com')) {
  process.env.GRAPH_BASE_URL = 'http://127.0.0.1:3002/v1.0';
}
process.env.GRAPH_TENANT_ID ??= 'test-tenant-id';
process.env.GRAPH_CLIENT_ID ??= 'test-client-id';
process.env.GRAPH_CLIENT_SECRET ??= 'test-client-secret';
process.env.GRAPH_AUTHORITY_HOST ??= 'http://127.0.0.1:3002';
process.env.UNSUBSCRIBE_HMAC_SECRET ??= 'test-hmac-secret-not-for-production';
process.env.WORKER_TICK_TOKEN ??= 'test-tick-token';
process.env.COMPLIANCE_POSTAL_ADDRESS ??= '123 Test Street, Testville, ON A1A 1A1, Canada';
process.env.COMPLIANCE_ORG_NAME ??= 'Test Org';
