if (process.env.CI) process.exit(0);
const { execSync } = require("child_process");
const { arch, platform } = process;
const pkg = `@tpsdev-ai/cli-${platform}-${arch}`;
const version = require("../package.json").version;

try {
  execSync(`npm install -g ${pkg}@${version}`, { stdio: "inherit" });
} catch {
  console.warn(`Optional: install ${pkg}@${version} for native binary performance.`);
}
