import { createWslcDockerSocket } from './wslc-socket.js';

import http from 'http';

// The URL path only needs the endpoint since the stream is passed via `createConnection`
const req = http.request({
  method: 'GET',
  path: '/v1.45/info', // Docker API Endpoint
  createConnection: () => createWslcDockerSocket(),
}, (res) => {
  res.pipe(process.stdout);
});

req.end();