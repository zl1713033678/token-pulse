import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const DEPLOY_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'token-pulse');
const MAX_HTML_BYTES = 10 * 1024 * 1024;

async function build() {
  const bundleResult = await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/ui/app.js')],
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    minify: true,
    write: false,
  });

  if (!bundleResult.outputFiles || bundleResult.outputFiles.length === 0) {
    throw new Error('esbuild produced no output');
  }

  const rawJs = bundleResult.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(__dirname, 'src/ui/styles.css'), 'utf8');
  const template = fs.readFileSync(path.join(__dirname, 'src/ui/template.html'), 'utf8');

  const html = template
    .replace('/*__INLINE_CSS__*/', () => css)
    .replace('/*__INLINE_JS__*/', () => rawJs);

  const htmlBytes = Buffer.byteLength(html, 'utf8');
  if (htmlBytes >= MAX_HTML_BYTES) {
    throw new Error(`Bundled dashboard.html exceeds 10 MiB limit: ${htmlBytes} bytes`);
  }

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST_DIR, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(DIST_DIR, 'ui/dashboard.html'), html, 'utf8');

  const filesToCopy = [
    'plugin.json',
    'mcp_config.json',
    'assets/logo.svg',
    'skills/telemetry/SKILL.md',
    'scripts/server.mjs',
    'scripts/sqlite-reader.mjs',
  ];

  for (const rel of filesToCopy) {
    const src = path.join(__dirname, rel);
    const dst = path.join(DIST_DIR, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  // Deploy zero-dependency plugin bundle to ~/.gemini/config/plugins/token-pulse/
  fs.rmSync(DEPLOY_DIR, { recursive: true, force: true });
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  fs.cpSync(DIST_DIR, DEPLOY_DIR, { recursive: true });

  console.log(`Built dist/ui/dashboard.html (${(htmlBytes / 1024).toFixed(1)} KB)`);
  console.log(`Deployed plugin bundle to ${DEPLOY_DIR}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
