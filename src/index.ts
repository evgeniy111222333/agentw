import { ApiServer } from './layer5_agent_interface/ApiServer';

const server = new ApiServer();

server.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await server.stop();
  process.exit(0);
});
