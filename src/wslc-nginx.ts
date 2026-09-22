import Docker from 'dockerode';
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';

/**
 * Converts Windows paths (e.g., C:\path\to\dir) to POSIX Docker API paths (/c/path/to/dir).
 * Fixes "invalid volume specification" errors caused by drive letters and backslashes.
 */
function toDockerPath(winPath: string): string {
  let posixPath = winPath.replace(/\\/g, '/');

  return posixPath;
}

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

/**
 * Creates a sample website directory and index.html file locally.
 */
function prepareLocalWebsiteDir(): string {
  const websiteDir = path.resolve(process.cwd(), 'website');
  if (!fs.existsSync(websiteDir)) {
    fs.mkdirSync(websiteDir, { recursive: true });
  }

  const htmlPath = path.join(websiteDir, 'index.html');
  const sampleHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>WSLC Mounted Server</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 2rem 3rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; }
    h1 { color: #38bdf8; margin-bottom: 0.5rem; }
    p { color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🚀 Hello from Mounted Host Directory!</h1>
    <p>This content is served directly from your local Windows folder via WSLC & Nginx.</p>
  </div>
</body>
</html>`;

  fs.writeFileSync(htmlPath, sampleHtml, 'utf-8');
  return websiteDir;
}

async function main() {
  let bridgeServer: net.Server | undefined;

  try {
    // 1. Prepare local folder to mount
    const localWebsiteDir = prepareLocalWebsiteDir();
    console.log(`📁 Local site folder prepared at: ${localWebsiteDir}`);

    // 2. Start local TCP bridge
    console.log('Starting local WSLC Docker bridge...');
    const { port, server } = await createWslcDockerBridge();
    bridgeServer = server;

    // 3. Point Dockerode to proxy port
    const docker = new Docker({
      host: '127.0.0.1',
      port: port,
    });

    const imageName = 'nginx:alpine';
    const containerName = 'wslc-mounted-web';
    const hostPort = '8080';
    const containerTargetDir = '/usr/share/nginx/html';

    // 4. Pull Nginx image
    console.log(`Pulling image '${imageName}'...`);
    await pullImage(docker, imageName);

    // 5. Cleanup container if it already exists
    try {
      const existing = docker.getContainer(containerName);
      await existing.remove({ force: true });
      console.log(`Cleaned up existing container '${containerName}'.`);
    } catch {
      // Container didn't exist
    }

    // 6. Convert Windows path to Docker POSIX path
    const dockerFormattedPath = toDockerPath(localWebsiteDir);

    // 7. Create container with volume mount and port binding
    console.log(`Creating container '${containerName}' with mount '${dockerFormattedPath}'...`);
    const container = await docker.createContainer({
      Image: imageName,
      name: containerName,
      ExposedPorts: {
        '80/tcp': {},
      },
      HostConfig: {
        PortBindings: {
          '80/tcp': [{ HostIp: '0.0.0.0', HostPort: hostPort }],
        },
        // Bind syntax: "/c/path/to/folder:/container/path:mode"
        Binds: [
          `${dockerFormattedPath}:${containerTargetDir}:ro`,
        ],
      },
    });

    // 8. Start container
    console.log('Starting container...');
    await container.start();

    // 9. Output status
    console.log('\n==================================================');
    console.log(`🚀 Server successfully started!`);
    console.log(`🌐 Open in your browser: http://localhost:${hostPort}`);
    console.log(`📂 Host Folder: ${localWebsiteDir}`);
    console.log(`🐳 Mount Path:  ${dockerFormattedPath}`);
    console.log('==================================================\n');

  } catch (err) {
    console.error('Execution Error:', err);
    if (bridgeServer) {
      bridgeServer.close();
    }
  }
}

main();