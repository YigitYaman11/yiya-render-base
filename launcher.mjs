import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, rmSync, symlinkSync, appendFileSync, lstatSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const E = process.env;
const ROOT = E.YIYA_ROOT || "/tmp/yiya";
const RT = E.YIYA_RUNTIME_MODULES || "/opt/yiya-rt/node_modules";
const FFMPEG = E.YIYA_FFMPEG_PATH || "ffmpeg";
const WIN = process.platform === "win32";
const t0 = Date.now();
const say = (ev, kv = {}) => process.stdout.write(`YIYA|${new Date().toISOString()}|${ev}|t=${((Date.now() - t0) / 1000).toFixed(1)}${Object.entries(kv).map(([k, v]) => `|${k}=${String(v).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64)}`).join("")}\n`);
const die = (code, n) => { say("cikis", { kod: code, cikisKodu: n }); process.exit(n); };

function env() {
  let u;
  try { u = new URL(E.YIYA_API_BASE || ""); } catch { die("ENV_INVALID", 14); }
  const loop = E.YIYA_TEST_LOOPBACK === "1" && u.protocol === "http:" && u.hostname === "127.0.0.1";
  if ((u.protocol !== "https:" && !loop) || u.pathname.length > 1 || u.search || u.username) die("ENV_INVALID", 14);
  if (!/^[0-9a-f-]{36}$/i.test(E.YIYA_JOB_ID || "") || !/^cj1\./.test(E.YIYA_JOB_TOKEN || "") || !/^[A-Za-z0-9_-]{8,100}$/.test(E.YIYA_INSTANCE_TAG || "") ||
    !/^[0-9a-f]{64}$/.test(E.YIYA_BUNDLE_SHA256 || "") || !["nvenc", "x264", "auto"].includes(E.YIYA_ENCODER || "")) die("ENV_INVALID", 14);
  return { base: u.origin, job: E.YIYA_JOB_ID, auth: { "x-cloud-job-token": E.YIYA_JOB_TOKEN, "x-worker-id": E.YIYA_INSTANCE_TAG } };
}

const PAGE = `<html><body style="margin:0"><canvas id=c width=1080 height=1920></canvas><script>
const gl=c.getContext("webgl2",{preserveDrawingBuffer:false,antialias:false});
window.R=(()=>{if(!gl)return {renderer:"none"};const x=gl.getExtension("WEBGL_debug_renderer_info");return {renderer:String(x?gl.getParameter(x.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER))};})();
window.B=(n)=>{if(!gl)return 0;const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);return o;};
const p=gl.createProgram();gl.attachShader(p,sh(gl.VERTEX_SHADER,"#version 300 es\\nin vec2 a;void main(){gl_Position=vec4(a,0,1);}"));
gl.attachShader(p,sh(gl.FRAGMENT_SHADER,"#version 300 es\\nprecision highp float;uniform float t;out vec4 o;void main(){vec2 u=gl_FragCoord.xy/vec2(1080.,1920.);vec3 c=vec3(0);for(int i=0;i<48;i++){float f=float(i);c+=0.02*vec3(sin(u.x*f+t),cos(u.y*f-t),sin((u.x+u.y)*f*0.5+t));}o=vec4(abs(c),1);}"));
gl.linkProgram(p);gl.useProgram(p);const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
const l=gl.getAttribLocation(p,"a");gl.enableVertexAttribArray(l);gl.vertexAttribPointer(l,2,gl.FLOAT,false,0,0);const tu=gl.getUniformLocation(p,"t");const px=new Uint8Array(1080*1920*4);
const s=performance.now();for(let i=0;i<n;i++){gl.uniform1f(tu,i*0.016);gl.drawArrays(gl.TRIANGLES,0,3);gl.readPixels(0,0,1080,1920,gl.RGBA,gl.UNSIGNED_BYTE,px);}return n/((performance.now()-s)/1000);};
</script></body></html>`;

async function gpu() {
  const { chromium } = await import(pathToFileURL(join(RT, "playwright", "index.mjs")).href);
  const args = WIN ? ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu"] : ["--use-angle=gl-egl", "--ignore-gpu-blocklist", "--disable-gpu-sandbox", "--enable-gpu"];
  const br = await chromium.launch({ headless: true, args });
  try {
    const pg = await br.newPage({ viewport: { width: 1080, height: 1920 } });
    await pg.setContent(PAGE);
    const r = await pg.evaluate(() => window.R);
    if (/swiftshader|llvmpipe|softpipe|software|none/i.test(r.renderer)) return { renderer: r.renderer, fps: 0, soft: true };
    await pg.evaluate(() => window.B(10));
    return { renderer: r.renderer, fps: Math.round(await pg.evaluate(() => window.B(120))), soft: false };
  } finally { await br.close(); }
}

function enc(codec) {
  const a = ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=60", "-frames:v", "300"];
  const c = codec === "nvenc" ? ["-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-bf", "0"] : ["-c:v", "libx264", "-preset", "medium", "-crf", "12", "-bf", "0"];
  const s = Date.now();
  const r = spawnSync(FFMPEG, [...a, ...c, "-pix_fmt", "yuv420p", "-f", "null", "-"], { stdio: "ignore", timeout: 120000 });
  return r.status === 0 ? Math.round(300 / ((Date.now() - s) / 1000)) : 0;
}

async function req(u, init, ms) {
  return fetch(u, { redirect: "error", cache: "no-store", ...init, signal: AbortSignal.timeout(ms) });
}

async function main() {
  const c = env();
  say("basla");
  try { if (lstatSync(join(ROOT, "node_modules")).isSymbolicLink()) unlinkSync(join(ROOT, "node_modules")); } catch {}
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  let g;
  try { g = await gpu(); } catch { g = { renderer: "launch-failed", fps: 0, soft: true }; }
  const nvencFps = g.soft ? 0 : enc("nvenc");
  const x264Fps = g.soft ? 0 : enc("x264");
  const body = { renderer: g.renderer.slice(0, 200), nvencOk: nvencFps > 0, nvencFps, x264Fps, cesiumFps: g.fps };
  say("ozdenetim", { soft: g.soft, cizim: g.fps, nvenc: nvencFps, x264: x264Fps });
  let v;
  try {
    const r = await req(`${c.base}/api/cloud/jobs/${c.job}/selfcheck`, { method: "POST", headers: { ...c.auth, "content-type": "application/json" }, body: JSON.stringify(body) }, 20000);
    v = await r.json();
    if (!r.ok || v?.ok !== true) die("SELFCHECK_API", 10);
  } catch { die("SELFCHECK_API", 10); }
  if (g.soft) die("SOFTWARE_RENDERER", 11);
  if (v.pass !== true) die("SELFCHECK_FAILED", 10);
  let encoder = E.YIYA_ENCODER === "auto" ? v.encoder : E.YIYA_ENCODER;
  if (encoder !== "nvenc" && encoder !== "x264") die("SELFCHECK_FAILED", 10);
  if (encoder === "nvenc" && !body.nvencOk) encoder = "x264";
  say("kodlayici", { secilen: encoder });

  const tgz = join(ROOT, "bundle.tgz");
  const h = createHash("sha256");
  try {
    const r = await req(`${c.base}/api/cloud/bundle`, { headers: c.auth }, 10 * 60000);
    if (!r.ok || !r.body) die("BUNDLE_DOWNLOAD_FAILED", 13);
    const s = Readable.fromWeb(r.body);
    s.on("data", (d) => h.update(d));
    await pipeline(s, createWriteStream(tgz));
  } catch { die("BUNDLE_DOWNLOAD_FAILED", 13); }
  if (h.digest("hex") !== E.YIYA_BUNDLE_SHA256) die("BUNDLE_SHA_MISMATCH", 12);
  const pkg = join(ROOT, "pkg");
  mkdirSync(pkg, { recursive: true });
  const tar = WIN ? join(E.SystemRoot || "C:/Windows", "System32", "tar.exe") : "tar";
  if (spawnSync(tar, ["-xzf", tgz, "-C", pkg], { stdio: "ignore" }).status !== 0) die("BUNDLE_EXTRACT_FAILED", 13);
  rmSync(tgz, { force: true });
  if (!existsSync(join(ROOT, "node_modules"))) symlinkSync(RT, join(ROOT, "node_modules"), WIN ? "junction" : "dir");
  say("paket", { tamam: true });

  const logf = join(ROOT, "run.log");
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(pkg, "runtime", "cloudGuard.mjs")).href, join(pkg, "video-orchestrator", "agent.cjs")], {
    env: { ...E, YIYA_CLOUD: "1", YIYA_ENCODER_RESOLVED: encoder, YIYA_ROOT: ROOT, YIYA_PKG_ROOT: pkg, YIYA_PLAYWRIGHT_ENTRY: join(RT, "playwright", "index.mjs"), YIYA_FFMPEG_PATH: FFMPEG, YIYA_FFPROBE_PATH: E.YIYA_FFPROBE_PATH || "ffprobe", NODE_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe"], cwd: ROOT, windowsHide: true,
  });
  let buf = "";
  child.stdout.on("data", (d) => {
    appendFileSync(logf, d);
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); if (l.startsWith("YIYA|")) process.stdout.write(l + "\n"); }
  });
  child.stderr.on("data", (d) => appendFileSync(logf, d));
  let code = await new Promise((r) => child.on("close", (n) => r(n ?? 40)));
  try { const x = JSON.parse(readFileSync(join(ROOT, "exit.json"), "utf8")); if (Number.isInteger(x.exitCode)) code = x.exitCode; } catch {}
  say("ajan-bitti", { cikisKodu: code });
  process.exit(code);
}

main().catch(() => die("LAUNCHER_INTERNAL", 40));
