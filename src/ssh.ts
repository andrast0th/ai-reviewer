import { execFile } from "node:child_process";

export interface SshResult {
  code: number;
  output: string;
}

/** Runs ssh with an argument array; resolves with exit code and combined output, never rejects. */
export type SshRunner = (args: readonly string[]) => Promise<SshResult>;

export const runSsh: SshRunner = (args) =>
  new Promise((resolve) => {
    execFile("ssh", [...args], { timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 255) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });

/**
 * `ssh -T git@host` in batch mode: never prompts, never accepts unknown host keys. GitLab
 * answers "Welcome to GitLab, @user!" when the key is accepted.
 */
export async function probeGitlabSsh(
  host: string,
  run: SshRunner = runSsh,
): Promise<{ ok: boolean; message: string }> {
  const r = await run([
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    `git@${host}`,
  ]);
  const welcome = /Welcome to GitLab,?\s*@?([^\s!]+)?/i.exec(r.output);
  if (welcome)
    return { ok: true, message: `SSH ok (git@${host}${welcome[1] ? ` as ${welcome[1]}` : ""})` };
  const first = r.output.split("\n").find((l) => l.trim()) ?? `exit code ${r.code}`;
  let hint = "";
  if (/Host key verification failed|No .* host key is known/i.test(r.output)) {
    hint = `; connect once with \`ssh git@${host}\` to verify and accept the host key`;
  } else if (/Permission denied/i.test(r.output)) {
    hint = "; is your key added to GitLab and loaded in ssh-agent (`ssh-add -l`)?";
  }
  return { ok: false, message: `SSH to git@${host} failed: ${first}${hint}` };
}
