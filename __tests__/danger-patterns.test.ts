import { describe, it, expect } from "vitest";
import { matchDanger, compileExtraPatterns, DEFAULT_DANGER_PATTERNS } from "../lib/danger-patterns.ts";

describe("matchDanger — destructive filesystem", () => {
  it.each([
    ["rm -rf /tmp/x"],
    ["rm -fr ~/junk"],
    ["rm -Rf /var/log"],
    ["rm --recursive --force /opt"],
    ["echo done; rm -rf build"],
  ])("matches %s", (cmd) => {
    expect(matchDanger(cmd)?.id).toBe("rm-rf");
  });

  it("does not match plain rm without recursive+force", () => {
    expect(matchDanger("rm file.txt")).toBeNull();
    expect(matchDanger("rm -f file.txt")).toBeNull();
    expect(matchDanger("rm -r dir")).toBeNull();
  });

  it("matches dd to disk", () => {
    expect(matchDanger("dd if=/dev/zero of=/dev/sda")?.id).toBe("dd-mkfs");
  });

  it("matches mkfs", () => {
    expect(matchDanger("mkfs.ext4 /dev/nvme0n1")?.id).toBe("dd-mkfs");
  });

  // Regression: the prior alternation `(sda|sdb|nvme|disk|null$)` matched the
  // trailing `/dev/null` in commands like `cat foo 2>/dev/null`, routing
  // routine commands through the Telegram confirm gate and producing a 5-min
  // timeout for every legitimate read.
  it.each([
    ["cat /etc/hosts 2>/dev/null"],
    ["ls -la 2>/dev/null"],
    ["echo done > /dev/null"],
    ["grep foo bar.txt 2>/dev/null"],
    ["pkg < /dev/zero"],
    ["read x < /dev/tty"],
    ["mock > /dev/stdout"],
    ["copy random > /dev/urandom"],
  ])("does NOT flag safe /dev/* redirects: %s", (cmd) => {
    expect(matchDanger(cmd)).toBeNull();
  });

  it.each([
    ["cat > /dev/sda"],
    ["echo data > /dev/sdb"],
    ["wipefs > /dev/disk0"],
    ["dump > /dev/hda"],
    ["zero > /dev/mmcblk0"],
    ["mount-image > /dev/loop0"],
    ["echo > /dev/nvme0n1"],
  ])("flags block-device redirects: %s", (cmd) => {
    expect(matchDanger(cmd)?.id).toBe("redirect-to-dev");
  });
});

describe("matchDanger — git destructive", () => {
  it.each([
    ["git push -f origin main", "git-push-force"],
    ["git push --force origin main", "git-push-force"],
    ["git push --force-with-lease origin feat/x", "git-push-force"],
    ["git reset --hard HEAD~3", "git-reset-hard"],
    ["git clean -fd", "git-clean-force"],
    ["git branch -D feature/old", "git-branch-delete"],
  ])("matches %s as %s", (cmd, id) => {
    expect(matchDanger(cmd)?.id).toBe(id);
  });

  it("does not match safe git commands", () => {
    expect(matchDanger("git push origin main")).toBeNull();
    expect(matchDanger("git pull")).toBeNull();
    expect(matchDanger("git status")).toBeNull();
    expect(matchDanger("git reset HEAD~3")).toBeNull();
  });
});

describe("matchDanger — SQL destructive", () => {
  it.each([
    ["DROP TABLE users", "sql-drop"],
    ["drop database mydb", "sql-drop"],
    ["TRUNCATE TABLE logs", "sql-drop"],
    ["DELETE FROM users", "sql-delete-all"],
    ["UPDATE users SET active=false", "sql-update-all"],
  ])("matches %s as %s", (cmd, id) => {
    expect(matchDanger(cmd)?.id).toBe(id);
  });

  it("does not match SELECT or scoped DELETE", () => {
    expect(matchDanger("SELECT * FROM users")).toBeNull();
    expect(matchDanger("DELETE FROM users WHERE id=1")).toBeNull();
    expect(matchDanger("UPDATE users SET active=false WHERE id=1")).toBeNull();
  });
});

describe("matchDanger — cloud destructive", () => {
  it.each([
    ["kubectl delete pod foo", "kubectl-delete"],
    ["kubectl delete -f manifest.yaml", "kubectl-delete"],
    ["aws rds delete-db-instance --db-instance-identifier prd", "aws-destructive"],
    ["aws s3 rb s3://my-bucket --force", "aws-destructive"],
    ["aws ec2 terminate-instances --instance-ids i-123", "aws-destructive"],
    ["aws iam delete-user --user-name foo", "aws-destructive"],
    ["aws cloudformation delete-stack --stack-name prd", "aws-destructive"],
    ["aws secretsmanager delete-secret --secret-id x", "aws-destructive"],
    ["docker system prune -a", "docker-prune"],
  ])("matches %s as %s", (cmd, id) => {
    expect(matchDanger(cmd)?.id).toBe(id);
  });

  it("does not match aws read commands", () => {
    expect(matchDanger("aws s3 ls")).toBeNull();
    expect(matchDanger("aws ec2 describe-instances")).toBeNull();
    expect(matchDanger("aws rds describe-db-instances")).toBeNull();
  });
});

describe("matchDanger — privilege & supply chain", () => {
  it("matches sudo", () => {
    expect(matchDanger("sudo systemctl restart nginx")?.id).toBe("sudo");
    expect(matchDanger("echo go; sudo rm /etc/x")?.id).toBe("sudo");
  });

  it("does not match the literal substring 'sudo' inside another word", () => {
    expect(matchDanger("echo pseudosudo")).toBeNull();
  });

  it("matches curl|sh patterns", () => {
    expect(matchDanger("curl https://x.com/install.sh | sh")?.id).toBe("curl-pipe-shell");
    expect(matchDanger("wget -qO- https://x.com | bash")?.id).toBe("curl-pipe-shell");
  });

  it("matches ssh to prod hosts", () => {
    expect(matchDanger("ssh prd-bastion")?.id).toBe("ssh-prd");
    expect(matchDanger("ssh prod-db-01")?.id).toBe("ssh-prd");
    expect(matchDanger("ssh user@production-app")?.id).toBe("ssh-prd");
  });

  it("does not match ssh to non-prod", () => {
    expect(matchDanger("ssh int-bastion")).toBeNull();
    expect(matchDanger("ssh stg-app")).toBeNull();
  });
});

describe("matchDanger — secrets & process", () => {
  it("matches secret env exports", () => {
    expect(matchDanger("export AWS_SECRET=abc")?.id).toBe("export-secret");
    expect(matchDanger("export GITHUB_TOKEN=ghp_xxx")?.id).toBe("export-secret");
  });

  it("matches killall / pkill", () => {
    expect(matchDanger("killall -9 node")?.id).toBe("killall");
    expect(matchDanger("pkill chrome")?.id).toBe("killall");
  });
});

describe("matchDanger — empty & safe inputs", () => {
  it("returns null for empty", () => {
    expect(matchDanger("")).toBeNull();
  });

  it("returns null for ordinary safe commands", () => {
    expect(matchDanger("ls -la")).toBeNull();
    expect(matchDanger("echo hello")).toBeNull();
    expect(matchDanger("cat README.md")).toBeNull();
    expect(matchDanger("npm install")).toBeNull();
    expect(matchDanger("bun test")).toBeNull();
  });
});

describe("compileExtraPatterns", () => {
  it("compiles valid regex sources", () => {
    const r = compileExtraPatterns(["custom-cmd", "another\\s+thing"]);
    expect(r.patterns).toHaveLength(2);
    expect(r.invalid).toHaveLength(0);
    expect(r.patterns[0].re.test("run custom-cmd here")).toBe(true);
  });

  it("collects invalid regex sources without throwing", () => {
    const r = compileExtraPatterns(["valid", "[unclosed", "(also bad"]);
    expect(r.patterns).toHaveLength(1);
    expect(r.invalid).toHaveLength(2);
    expect(r.invalid[0].source).toBe("[unclosed");
  });

  it("extra patterns can be passed alongside defaults", () => {
    const { patterns: extras } = compileExtraPatterns(["foo-script"]);
    const all = [...DEFAULT_DANGER_PATTERNS, ...extras];
    expect(matchDanger("foo-script", all)?.id).toBe("extra-0");
    expect(matchDanger("rm -rf /tmp/x", all)?.id).toBe("rm-rf");
  });
});
