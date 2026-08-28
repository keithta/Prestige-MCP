/** Runs the mock Graph server standalone, for manual end-to-end walkthroughs. */
import { startMockGraph } from './server.js';

const port = Number(process.env.MOCK_GRAPH_PORT ?? 3002);
startMockGraph(port)
  .then((mock) => {
    console.log(`mock Microsoft Graph listening on ${mock.baseUrl}`);
    console.log(`  GRAPH_BASE_URL=${mock.graphBaseUrl}`);
    console.log(`  GRAPH_AUTHORITY_HOST=${mock.baseUrl}`);
    console.log(`  inject a fault:  curl -XPOST ${mock.baseUrl}/__control/fault -H 'content-type: application/json' -d '{"fault":"throttle_429","count":2}'`);
    console.log(`  inspect:         curl ${mock.baseUrl}/__control/state`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
