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
      // Spawn a new wslc process for each incoming connection/HTTP request
      const child = spawn('wslc.exe', ['system', 'session', 'run', 'docker', 'system', 'dial-stdio'], {
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      });

      // Pipe data bidirectionally between Dockerode TCP socket and WSL stdio
      clientSocket.pipe(child.stdin);
      child.stdout.pipe(clientSocket);

      // Handle socket teardown and process cleanup
      clientSocket.on('error', () => child.kill());
      clientSocket.on('close', () => child.kill());
      child.on('error', () => clientSocket.destroy());
    });

    // Listen on a random available local port
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, server });
    });

    server.on('error', reject);
  });
}

/**
 * Promisified helper to pull Docker images with correct TypeScript signatures.
 */
function pullImage(docker: Docker, imageName: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);

      docker.modem.followProgress(
        stream,
        (onFinishedErr: Error | null, output: any[]) => {
          if (onFinishedErr) return reject(onFinishedErr);
          resolve(output);
        }
      );
    });
  });
}

async function main() {
  let bridgeServer: net.Server | undefined;

  try {
    // Start the local TCP bridge
    console.log('Starting local WSLC Docker bridge...');
    const { port, server } = await createWslcDockerBridge();
    bridgeServer = server;

    // Point Dockerode to local TCP proxy port
    const docker = new Docker({
      host: '127.0.0.1',
      port: port,
    });

    const imageName = 'alpine:latest';
    const containerName = 'wslc-test-alpine';

    // 3. Pull image using helper
    console.log(`Pulling image '${imageName}'...`);
    await pullImage(docker, imageName);
    console.log('Image pulled successfully.');

    // Create container
    console.log(`Creating container '${containerName}'...`);
    const container = await docker.createContainer({
      Image: imageName,
      name: containerName,
      Cmd: ['echo', 'Hello from Dockerode inside WSLC!'],
      Tty: false,
    });
    console.log(`Container created with ID: ${container.id.substring(0, 12)}`);

    // 5. Start container
    console.log('Starting container...');
    await container.start();

   // Collect logs stream into a Buffer
    const logStream = (await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
    })) as unknown as NodeJS.ReadableStream;

    const logsText = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      
      logStream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      logStream.on('end', () => {
        // Concatenate all binary chunks and convert to string
        const fullBuffer = Buffer.concat(chunks);
        resolve(fullBuffer.toString('utf-8'));
      });

      logStream.on('error', (err) => reject(err));
    });

    console.log('\n--- Container Output ---');
    // Docker multiplexes stream headers (first 8 bytes per chunk). 
    // Cleaning non-printable control characters gives clean console output:
    console.log(logsText.replace(/[\x00-\x0F]/g, '').trim());
    console.log('------------------------\n');

    // List containers
    console.log('\n--- Container List ---');
    const containers = await docker.listContainers({ all: true });
    console.table(
    containers.map((c) => ({
        ID: c.Id.substring(0, 12),
        Names: c.Names.join(', '),
        Image: c.Image,
        State: c.State,
        Status: c.Status,
    }))
    );
    console.log('----------------------\n');

    // Clean up container
    console.log('Cleaning up container...');
    await container.remove({ force: true });
    console.log('Container removed.');

  } catch (err) {
    console.error('Execution Error:', err);
  } finally {
    if (bridgeServer) {
      bridgeServer.close();
      console.log('Bridge closed.');
    }
  }
}

main();