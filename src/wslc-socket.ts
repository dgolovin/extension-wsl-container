import Docker from 'dockerode';
import { spawn, ChildProcessByStdio } from 'child_process';
import { Duplex, Writable, Readable } from 'stream';
import net from 'net';

/**
 * Creates a socket backed by `wslc system session run docker system dial-stdio`.
 */
export function createWslcDockerSocket(): net.Socket {
  // Command arguments matching: wslc system session run docker system dial-stdio
  const args: string[] = [
    'system',
    'session',
    'run',
    'docker',
    'system',
    'dial-stdio',
  ];

  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn('wslc.exe', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stderr.on('data', (data: Buffer) => {
    console.error(`[wslc stderr]: ${data.toString()}`);
  });

  // Create a Duplex stream around child process stdio
  const socketStream = new Duplex({
    read() {
      // Flow controlled via stdout 'data' listener
    },
    write(chunk, encoding, callback) {
      child.stdin.write(chunk, encoding, callback);
    },
    final(callback) {
      child.stdin.end(callback);
    },
  });

  child.stdout.on('data', (chunk: Buffer) => {
    socketStream.push(chunk);
  });

  child.stdout.on('end', () => {
    socketStream.push(null);
  });

  child.on('error', (err) => {
    socketStream.destroy(err);
  });

  child.on('close', () => {
    socketStream.destroy();
  });

  return socketStream as unknown as net.Socket;
}

export function createWslcDockerDockerode(): Docker {
  // 1. Initialize Dockerode with dummy socket path (modem requires a protocol layout)
  const docker = new Docker({ socketPath: '/var/run/docker.sock' });

  // 2. Override modem's `dial` to return your wslc stream
  (docker.modem as any).dial = (_: any, handler: Function) => {
    const stream = createWslcDockerSocket();
    handler(null, stream);
  };
  return docker;
}