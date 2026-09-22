import Docker from 'dockerode';
import { spawn } from 'child_process';
import net from 'net';

/**
 * Starts a local TCP bridge server that pipes incoming socket traffic 
 * to `wslc system session run docker system dial-stdio`.
 */
function createWslcDockerBridge(): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      const child = spawn('wslc.exe', ['system', 'session', 'run', 'docker', 'system', 'dial-stdio'], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });

      clientSocket.pipe(child.stdin);
      child.stdout.pipe(clientSocket);

      clientSocket.on('error', () => child.kill());
      clientSocket.on('close', () => child.kill());
      child.on('error', () => clientSocket.destroy());
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, server });
    });

    server.on('error', reject);
  });
}

/**
 * Event payload interface returned by Docker Engine API /events endpoint.
 */
interface DockerEvent {
  Type: 'container' | 'image' | 'volume' | 'network' | 'daemon';
  Action: string;
  Actor: {
    ID: string;
    Attributes: Record<string, string>;
  };
  time: number;
  timeNano: number;
}

async function main() {
  let bridgeServer: net.Server | undefined;
  let eventStream: NodeJS.ReadableStream | undefined;

  try {
    // 1. Start TCP bridge proxy
    console.log('Starting local WSLC Docker bridge...');
    const { port, server } = await createWslcDockerBridge();
    bridgeServer = server;

    // 2. Initialize Dockerode
    const docker = new Docker({
      host: '127.0.0.1',
      port: port,
    });

    console.log('Connecting to Docker events stream...');

    // 3. Request events stream from Docker Engine API
    // You can pass options to filter by type (container, image, etc.) or specific events
    eventStream = (await docker.getEvents({
      filters: {
        type: ['container', 'image', 'volume'],
      },
    })) as unknown as NodeJS.ReadableStream;

    console.log('\n==================================================');
    console.log('📡 Listening for Docker events... (Press Ctrl+C to exit)');
    console.log('==================================================\n');

    // 4. Handle incoming event stream chunks
    eventStream.on('data', (chunk: Buffer) => {
      try {
        // Events are sent as newline-delimited JSON
        const rawString = chunk.toString('utf-8').trim();
        if (!rawString) return;

        // Split by lines in case multiple event payloads arrive in one TCP chunk
        const lines = rawString.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          
          const event: DockerEvent = JSON.parse(line);
          const timestamp = new Date(event.time * 1000).toLocaleTimeString();
          const name = event.Actor.Attributes?.name || event.Actor.ID.substring(0, 12);

          console.log(`[${timestamp}] [${event.Type.toUpperCase()}] Action: ${event.Action} | Name/ID: ${name}`);
        }
      } catch (err) {
        console.error('Error parsing event chunk:', err);
      }
    });

    eventStream.on('error', (err) => {
      console.error('Event stream error:', err);
    });

    eventStream.on('end', () => {
      console.log('Event stream ended by server.');
    });

  } catch (err) {
    console.error('Failed to initialize events listener:', err);
    if (bridgeServer) bridgeServer.close();
  }

  // Handle graceful exit on Ctrl+C
  process.on('SIGINT', () => {
    console.log('\nStopping event listener and shutting down bridge...');
    if (eventStream && (eventStream as any).destroy) {
      (eventStream as any).destroy();
    }
    if (bridgeServer) {
      bridgeServer.close();
    }
    process.exit(0);
  });
}

main();