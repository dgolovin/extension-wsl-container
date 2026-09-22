import Docker from 'dockerode';
import { spawn } from 'child_process';
import net from 'net';

/**
 * Local TCP proxy bridge connecting Node.js to `wslc system session run docker system dial-stdio`.
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
 * Promisified helper to pull Docker images.
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

/**
 * Helper to safely recreate a container by name.
 */
async function ensureContainer(docker: Docker, config: Docker.ContainerCreateOptions): Promise<Docker.Container> {
  if (config.name) {
    try {
      const existing = docker.getContainer(config.name);
      await existing.remove({ force: true });
    } catch {
      // Container didn't exist, proceed
    }
  }
  const container = await docker.createContainer(config);
  await container.start();
  return container;
}

async function main() {
  let bridgeServer: net.Server | undefined;

  try {
    const { port, server } = await createWslcDockerBridge();
    bridgeServer = server;

    const docker = new Docker({ host: '127.0.0.1', port });
    const imageName = 'nginx:alpine';

    // 1. Ensure required image is available
    await pullImage(docker, imageName);

    // 2. Create and start Container 1 (Port 8081)
    await ensureContainer(docker, {
      Image: imageName,
      name: 'web-app-1',
      ExposedPorts: { '80/tcp': {} },
      HostConfig: {
        PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8081' }] },
      },
      Labels: { 'com.project.app': 'service-a' },
    });

    // 3. Create and start Container 2 (Port 8082)
    await ensureContainer(docker, {
      Image: imageName,
      name: 'web-app-2',
      ExposedPorts: { '80/tcp': {} },
      HostConfig: {
        PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8082' }] },
      },
      Labels: { 'com.project.app': 'service-b' },
    });

    // 4. Fetch all containers and output as JSON
    const containers = await docker.listContainers({ all: true });
    console.log(JSON.stringify(containers, null, 2));

  } catch (err) {
    console.error(JSON.stringify({ error: (err as Error).message }, null, 2));
  } finally {
    if (bridgeServer) {
      bridgeServer.close();
    }
  }
}

main();