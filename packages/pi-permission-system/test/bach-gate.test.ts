import { describe, expect, it } from "vitest";
import {
  isDestructiveCommand,
  isExternalNetworkCommand,
  requiresBachPrompt,
} from "#src/bach-gate";

describe("requiresBachPrompt — wrangler mutating subcommands prompt", () => {
  const cases: Array<[string, boolean]> = [
    ["wrangler deploy", true],
    ["wrangler deploy --name my-worker", true],
    ["wrangler delete", true],
    ["wrangler undeploy", true],
    ["wrangler secret put API_KEY", true],
    ["wrangler versions upload", true],
    ["wrangler versions deploy", true],
    ["wrangler deployments rollback", true],
    ["wrangler secret delete API_KEY", true],
    ["wrangler secret bulk put secrets.json", true],
    ["wrangler secret bulk delete secrets.json", true],
    ["wrangler r2 object put bucket/key --file ./x", true],
    ["wrangler r2 bucket create my-bucket", true],
    ["wrangler r2 bucket delete my-bucket", true],
    ["wrangler kv key put MY_KEY value", true],
    ["wrangler kv namespace create my-ns", true],
    ["wrangler kv namespace delete my-ns", true],
    ["wrangler d1 execute mydb --command 'SELECT 1'", true],
    ["wrangler d1 execute mydb --command 'DROP TABLE x'", true],
    ["wrangler d1 execute mydb --file ./seed.sql", true],
    ["wrangler triggers create", true],
    ["npx wrangler deploy", true],
    ["bunx wrangler deploy", true],
    ["cd ./worker && wrangler deploy", true],
    ["cd ./worker && wrangler secret put KEY", true],
    ["npm exec wrangler deploy", true],
    ["CLOUDFLARE_ACCOUNT_ID=123 wrangler deploy", true],
    ["wrangler tail", false],
    ["wrangler tail my-worker", false],
    ["wrangler secret list", false],
    ["wrangler deployments list", false],
    ["wrangler kv key list", false],
    ["wrangler kv namespace list", false],
    ["wrangler r2 bucket list", false],
    ["wrangler r2 object list bucket", false],
    ["wrangler d1 list", false],
    ["wrangler d1 export mydb", false],
    ["wrangler triggers list", false],
    ["wrangler versions list", false],
    ["wrangler whoami", false],
    ["wrangler dev", false],
    ["wrangler types", false],
    ["wrangler init my-app", false],
  ];

  it.each(cases)("%s → requiresBachPrompt=%s", (command, expected) => {
    expect(requiresBachPrompt("bash", command)).toBe(expected);
  });
});

describe("requiresBachPrompt — pinned-version wrangler invocations", () => {
  // `npx wrangler@3.10.0 deploy` / `bunx wrangler@latest secret put KEY` etc.
  // The `@version` specifier separates the binary name from the subcommand;
  // the bare `\bwrangler\s+` anchor misses it and would silently auto-approve.
  const cases: Array<[string, boolean]> = [
    ["npx wrangler@3.10.0 deploy", true],
    ["npx wrangler@latest deploy", true],
    ["bunx wrangler@3 deploy", true],
    ["wrangler@1.0.0 secret put KEY", true],
    ["npx wrangler@3.10.0 versions upload", true],
    ["bunx wrangler@latest r2 object put b/k --file ./x", true],
    ["npx wrangler@3.10.0 d1 execute db --command 'SELECT 1'", true],
    // pure version spec with no subcommand is not itself a mutating call
    ["npx wrangler@3.10.0", false],
    // pinned-version reads stay auto-approved
    ["npx wrangler@latest tail", false],
    ["wrangler@3 whoami", false],
    ["npx wrangler@3.10.0 secret list", false],
    ["wrangler@latest d1 export mydb", false],
  ];

  it.each(cases)("%s → requiresBachPrompt=%s", (command, expected) => {
    expect(requiresBachPrompt("bash", command)).toBe(expected);
  });
});

describe("requiresBachPrompt — d1 execute SQL-wrapping fix", () => {
  const cases: Array<[string, boolean]> = [
    ["wrangler d1 execute mydb --command 'DROP TABLE users'", true],
    ['wrangler d1 execute mydb --command "DROP DATABASE app"', true],
    ["wrangler d1 execute mydb --command=DROP", true],
    ["wrangler d1 execute mydb --file ./migration.sql", true],
    ["wrangler d1 execute mydb --command 'SELECT 1'", true],
  ];

  it.each(cases)("%s → requiresBachPrompt=%s", (command, expected) => {
    expect(requiresBachPrompt("bash", command)).toBe(expected);
  });
});

describe("requiresBachPrompt — non-wrangler destructive patterns", () => {
  const cases: Array<[string, boolean]> = [
    ["rm -rf /", true],
    ["rm -r ./node_modules", true],
    ["rm -Rf ./build", true],
    ["rm --recursive ./log", true],
    ["git push", true],
    ["git push origin main", true],
    ["git push --force", true],
    ["sudo apt-get update", true],
    ["sudo rm -rf /", true],
    ["shutdown -h now", true],
    ["reboot", true],
    ["halt", true],
    ["poweroff", true],
    ["docker rm abc", true],
    ["docker rmi img", true],
    ["docker system prune", true],
    ["docker volume prune", true],
    ["docker network prune", true],
    ["kubectl delete pod foo", true],
    ["kubectl delete ns bar", true],
    ["echo 'DROP TABLE users'", true],
    ["psql -c 'DROP DATABASE prod'", true],
    ["echo 'TRUNCATE table log'", true],
    ["rm ./file.txt", false],
    ["git status", false],
    ["git log", false],
    ["docker ps", false],
    ["docker images", false],
    ["kubectl get pods", false],
    ["echo 'SELECT 1'", false],
  ];

  it.each(cases)("%s → requiresBachPrompt=%s", (command, expected) => {
    expect(requiresBachPrompt("bash", command)).toBe(expected);
  });
});

describe("requiresBachPrompt — edge cases", () => {
  it("returns false when toolName is not 'bash'", () => {
    expect(requiresBachPrompt("read", "rm -rf /")).toBe(false);
    expect(requiresBachPrompt("mcp", "wrangler deploy")).toBe(false);
  });

  it("returns false when command is undefined", () => {
    expect(requiresBachPrompt("bash", undefined)).toBe(false);
  });

  it("returns false for an empty command string", () => {
    expect(requiresBachPrompt("bash", "")).toBe(false);
  });

  it("returns false for a whitespace-only command string", () => {
    expect(requiresBachPrompt("bash", "   ")).toBe(false);
  });

  it("returns false for a benign command", () => {
    expect(requiresBachPrompt("bash", "ls -la")).toBe(false);
    expect(requiresBachPrompt("bash", "echo hello")).toBe(false);
    expect(requiresBachPrompt("bash", "npm install")).toBe(false);
  });

  it("does not flag curl/wget to localhost", () => {
    expect(
      requiresBachPrompt("bash", "curl http://localhost:3000/health"),
    ).toBe(false);
    expect(requiresBachPrompt("bash", "curl http://127.0.0.1:8080/api")).toBe(
      false,
    );
    expect(requiresBachPrompt("bash", "wget http://[::1]/metrics")).toBe(false);
  });

  it("flags curl/wget to non-localhost URLs", () => {
    expect(requiresBachPrompt("bash", "curl https://example.com/webhook")).toBe(
      true,
    );
    expect(requiresBachPrompt("bash", "wget http://10.0.0.1/admin")).toBe(true);
  });

  it("flags Cloudflare CLI push/deploy", () => {
    expect(requiresBachPrompt("bash", "cf push my-app")).toBe(true);
    expect(requiresBachPrompt("bash", "cf deploy")).toBe(true);
  });
});

describe("isExternalNetworkCommand — curl/wget localhost vs remote", () => {
  const localhostCases = [
    "curl http://localhost:3000/health",
    "curl http://127.0.0.1:8080/api",
    "curl http://[::1]/metrics",
    "wget http://localhost/file",
    "wget http://127.0.0.1/file",
  ];

  it.each(localhostCases)("does not flag localhost target: %s", (command) => {
    expect(isExternalNetworkCommand(command)).toBe(false);
  });

  const remoteCases: Array<[string, boolean]> = [
    ["curl https://example.com/webhook", true],
    ["curl http://10.0.0.1/admin", true],
    ["wget http://example.com/file", true],
    ["wrangler deploy", true],
    ["wrangler versions upload", true],
    ["wrangler secret put KEY", true],
    ["cf push my-app", true],
    ["cf deploy", true],
    ["wrangler tail", false],
    ["wrangler secret list", false],
    ["wrangler whoami", false],
    ["wrangler d1 export mydb", false],
  ];

  it.each(remoteCases)(
    "%s → isExternalNetworkCommand=%s",
    (command, expected) => {
      expect(isExternalNetworkCommand(command)).toBe(expected);
    },
  );
});

describe("isDestructiveCommand — wrangler mutating subcommands", () => {
  const cases: Array<[string, boolean]> = [
    ["wrangler deploy", true],
    ["wrangler versions upload", true],
    ["wrangler deployments rollback", true],
    ["wrangler secret delete API_KEY", true],
    ["wrangler secret bulk put secrets.json", true],
    ["wrangler r2 object put bucket/key", true],
    ["wrangler r2 bucket create my-bucket", true],
    ["wrangler r2 bucket delete my-bucket", true],
    ["wrangler kv key put MY_KEY value", true],
    ["wrangler kv namespace create my-ns", true],
    ["wrangler kv namespace delete my-ns", true],
    ["wrangler d1 execute mydb --command 'SELECT 1'", true],
    ["wrangler triggers create", true],
    ["wrangler tail", false],
    ["wrangler secret list", false],
    ["wrangler kv key list", false],
    ["wrangler r2 bucket list", false],
    ["wrangler d1 list", false],
    ["wrangler d1 export mydb", false],
    ["wrangler whoami", false],
    ["wrangler dev", false],
  ];

  it.each(cases)("%s → isDestructiveCommand=%s", (command, expected) => {
    expect(isDestructiveCommand(command)).toBe(expected);
  });
});
