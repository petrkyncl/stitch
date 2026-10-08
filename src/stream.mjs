// Live phone video for the studio: scrcpy server (raw H.264) -> ffmpeg -> MJPEG frames, shared by all viewers.
// scrcpy repeats the last frame on a still screen, so the picture never waits for the next change.
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';

const ADB = process.env.ADB || 'adb';
const SERIAL = process.env.ANDROID_SERIAL || '';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SERVER_JAR = process.env.SCRCPY_SERVER || '/opt/homebrew/share/scrcpy/scrcpy-server';
const SERVER_VERSION = process.env.SCRCPY_VERSION || '4.0';
const LOCAL_PORT = Number(process.env.SCRCPY_PORT || 27183); // one per device when several engines run
const SCID = '0000abcd';

const viewers = new Set();
let pipeline = null;
let lastFrame = null;
let idleTimer = null;
let prepared = false;

const adbArgs = args => (SERIAL ? ['-s', SERIAL, ...args] : args);
const adb = args => new Promise((resolve, reject) => execFile(ADB, adbArgs(args), (e, out) => (e ? reject(e) : resolve(out))));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 20; i++) {
    const sock = await new Promise(resolve => {
      const s = net.connect(LOCAL_PORT, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(null));
    });
    if (sock) return sock;
    await sleep(150);
  }
  throw new Error('scrcpy server did not open its socket');
}

async function start() {
  if (pipeline) return;
  pipeline = { starting: true };
  try {
    if (!prepared) {
      if (!existsSync(SERVER_JAR)) throw new Error(`scrcpy server not found at ${SERVER_JAR}`);
      await adb(['push', SERVER_JAR, '/data/local/tmp/stitch-scrcpy.jar']);
      prepared = true;
    }
    await adb(['forward', `tcp:${LOCAL_PORT}`, `localabstract:scrcpy_${SCID}`]);
    const server = spawn(ADB, adbArgs(['shell', 'CLASSPATH=/data/local/tmp/stitch-scrcpy.jar', 'app_process', '/', 'com.genymobile.scrcpy.Server', SERVER_VERSION,
      `scid=${SCID}`, 'tunnel_forward=true', 'audio=false', 'control=false', 'raw_stream=true', 'max_size=0', 'video_bit_rate=20000000', 'max_fps=30', 'cleanup=false']),
    { stdio: 'ignore' });
    await sleep(600);
    const sock = await connect();
    const ff = spawn(FFMPEG, ['-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0', '-f', 'mjpeg', '-q:v', '3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    sock.pipe(ff.stdin);
    ff.stdin.on('error', () => {});
    sock.on('error', () => {});

    let buf = Buffer.alloc(0);
    ff.stdout.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (soi < 0) { buf = Buffer.alloc(0); break; }
        const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
        if (eoi < 0) { buf = buf.subarray(soi); break; }
        const frame = buf.subarray(soi, eoi + 2);
        buf = buf.subarray(eoi + 2);
        lastFrame = frame;
        for (const res of viewers) send(res, frame);
      }
    });

    pipeline = { server, sock, ff };
    const restart = () => {
      if (!pipeline || pipeline.sock !== sock) return;
      stop();
      if (viewers.size) setTimeout(start, 500);
    };
    sock.on('close', restart);
    server.on('exit', restart);
  } catch (e) {
    console.error('stream:', e.message);
    pipeline = null;
    if (viewers.size) setTimeout(start, 2000);
  }
}

function stop() {
  if (!pipeline || pipeline.starting) return;
  const { server, sock, ff } = pipeline;
  pipeline = null;
  sock.destroy();
  ff.kill('SIGTERM');
  server.kill('SIGTERM');
}

function send(res, frame) {
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write('\r\n');
}

// The newest decoded frame, or null when nobody is watching (the stream only runs for viewers).
export const latestFrame = () => lastFrame;

export function serveStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  viewers.add(res);
  clearTimeout(idleTimer);
  if (lastFrame) send(res, lastFrame);
  start();
  req.on('close', () => {
    viewers.delete(res);
    if (!viewers.size) idleTimer = setTimeout(stop, 5000);
  });
}
