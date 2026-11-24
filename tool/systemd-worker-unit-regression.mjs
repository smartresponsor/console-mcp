import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const unit = "ops/ubuntu/systemd/console-mcp-repository-write.service";
const source = readFileSync(unit, "utf8");
assert.match(source, /EnvironmentFile=\/opt\/console-mcp-deploy\/repository-write-release\.env/);
assert.match(source, /ExecStart=.*\$\$CONSOLE_MCP_REPO_WRITE_RELEASE_DIR/);
assert.match(source, /User=console-mcp/);
assert.match(source, /NoNewPrivileges=true/);
const binary = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
if (binary.error?.code === "ENOENT") {
  console.log("systemd unit static checks PASS; systemd-analyze unavailable");
} else {
  assert.equal(binary.status, 0, binary.stderr);
  const result = spawnSync("systemd-analyze", ["verify", unit], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  console.log("systemd-analyze verify PASS (worker unit)");
}
