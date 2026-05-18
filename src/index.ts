import { ApiServer } from './layer5_agent_interface/ApiServer';

const server = new ApiServer();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtExceptionMonitor', (error) => {
  console.error('Uncaught exception:', error);
});

server.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await server.stop();
  process.exit(0);
});
