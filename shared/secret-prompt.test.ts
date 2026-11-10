import { expect, it } from "bun:test";
import { secretPrompt, validSecret } from "./secret-prompt.ts";

it("recognizes only a short secret request on the last nonempty line", () => {
  for (const prompt of ["[sudo] password for alice:", "alice@server's password:", "Password:", "Password for alice:", "Enter passphrase:", "Enter passphrase for key '/tmp/key':", "Enter PIN:", "Enter PIN for token:", "Repeat password:", "Verify password:", "Confirm password:"]) {
    expect(secretPrompt(`previous output\r\n ${prompt} \r\n\n`)).toBe(prompt);
  }
  for (const screen of ["", "Password?", "Password: y/n", "Enter PIN for y/n:", "Please enter your password:", "Example: Password:", "Password:\n$ ", `Password for ${"x".repeat(120)}:`]) {
    expect(secretPrompt(screen)).toBeNull();
  }
});

// git: "Password for '%s': ", the remote as git describes it (read from git 2.53 through an askpass helper)
// ssh: "%s@%s's password: "
// ssh-add: "Enter passphrase for %s%s: " and "Bad passphrase, try again for %s%s: ", a path or the key's comment
// ssh-keygen: 'Enter passphrase for "%s": ' (OpenSSH 10), "Enter passphrase (empty for no passphrase): " (9.6),
// "Enter same passphrase again: ", and -p's "Enter old passphrase: " and "Enter new passphrase (empty for no passphrase): "
const NEWER = [
  "Password for 'https://alice@github.com':",
  "Password for 'https://alice@git.example.com:8443':",
  "Password for 'https://alice%40example.com@github.com':",
  "Password for 'https://alice smith@github.com':",
  "Password for 'https://alice@[fe80::1]:8443':",
  "Password for 'https://org@dev.azure.com/org/My%20Project/_git/repo':",
  "Password for 'smtp://alice%40example.com@smtp.example.com:587':",
  "alice@fe80::1's password:",
  "alice@2001:db8::7%eth0's password:",
  "Enter passphrase for /home/alice/.ssh/id_ed25519:",
  "Enter passphrase for /home/alice/.ssh/id_ed25519 (will confirm each use):",
  "Enter passphrase for alice@laptop:",
  "Bad passphrase, try again for /home/alice/.ssh/id_ed25519:",
  "Enter passphrase for C:\\Users\\alice/.ssh/id_ed25519:",
  "Enter passphrase for PKCS#11:",
  // a key's file name or comment may hold colons: the prompt ends at the last one
  "Enter passphrase for /home/alice/.ssh/id:work:",
  "Enter passphrase for alice@laptop: work key:",
  "Bad passphrase, try again for /home/alice/keys/my:key:",
  'Enter passphrase for "/home/alice/.ssh/id_ed25519":',
  'Enter passphrase for "C:\\Users\\alice\\.ssh\\id_ed25519":',
  'Enter passphrase for "/home/alice/.ssh/id_ed25519" (empty for no passphrase):',
  "Enter passphrase (empty for no passphrase):",
  "Enter same passphrase again:",
  "Enter old passphrase:",
  "Enter new passphrase (empty for no passphrase):",
  // the letters around a path's slash are no yes/no choice, nor are two of its folders
  "Enter passphrase for key '/home/andy/notes/id_ed25519':",
  "Enter passphrase for /home/andy/notes/id_ed25519:",
  "Enter passphrase for /home/y/n/id_ed25519:",
  "Password for 'https://alice@example.com/team-y/n-tools.git':",
  "Enter passphrase for key 'C:/y/n/id_ed25519':",
];

it("recognizes git's HTTPS password, a passphrase asked by ssh-add or ssh-keygen and an IPv6 host's password", () => {
  for (const prompt of NEWER) expect(secretPrompt(`$ git push\n${prompt} `)).toBe(prompt);
  // wrapped at the right edge, inside the remote's name
  expect(secretPrompt("$ git push\nPassword for 'https:\n//alice@github.com':", 20)).toBe("Password for 'https://alice@github.com':");
  // a row that begins `y/n` is the rest of a name, read with the row above it
  expect(secretPrompt("Enter passphrase for /home/alice/keys/compan\ny/n-prod:", 44)).toBe("Enter passphrase for /home/alice/keys/company/n-prod:");
  // a line separator in a key's name, which the earlier patterns take too
  expect(secretPrompt("Enter passphrase for key '/keys/a\u2028b':")).toBe("Enter passphrase for key '/keys/a\u2028b':");
  for (const screen of [
    // git's other question is no secret
    "Username for 'https://github.com':",
    "Password for 'https://alice@github.com': ok",
    "Password for 'https://alice@github.com' and 'b':",
    "Enter passphrase for /home/alice/.ssh/id:work: ok",
    "Bad passphrase, try again:",
    "see alice@fe80::1's password:",
    // a yes/no choice, however it is written
    "Enter passphrase for key [y/n]:",
    "Password for alice (y/N):",
    "Password for alice y / n:",
    "Password for alice, y/n:",
    // after a dash or a comma, with no space
    "Password for alice -y/n:",
    "Enter passphrase for key,y/n:",
    // with a third option too
    "Password for alice (y/n/q):",
    "Enter passphrase for key [Y/n/skip]:",
    // ssh-keygen's asks, not anything that mentions a passphrase
    "Enter the passphrase again:",
  ]) {
    expect(secretPrompt(screen)).toBeNull();
  }
});

it("reads only the prompts an earlier server takes when asked to, and each of those either way", () => {
  // what a page sends as a `secret` to a server without secret-prompts-2, which refuses one for any newer prompt
  for (const prompt of NEWER) expect(secretPrompt(`$ git push\n${prompt} `, Infinity, true)).toBeNull();
  for (const prompt of ["[sudo] password for alice:", "alice@server's password:", "Password:", "Password for alice:", "Enter passphrase:", "Enter passphrase for key '/tmp/key':", "Enter PIN:", "Enter PIN for token:", "Repeat password:", "Verify password:", "Confirm password:"]) {
    expect(secretPrompt(prompt, Infinity, true)).toBe(prompt);
    expect(secretPrompt(prompt)).toBe(prompt);
  }
  expect(secretPrompt("Enter passph\nrase for key\n '/tmp/a-ver\ny-long-priva\nte-key':", 12, true)).toBe("Enter passphrase for key '/tmp/a-very-long-private-key':");
});

it("rejects multiline and terminal-control secrets while preserving spaces and Unicode", () => {
  expect(validSecret("  한글🔒  ")).toBe(true);
  for (const value of [null, "", "x".repeat(4097), "one\ntwo", "one\rtwo", "\u001b[200~", "\u0003", "\u007f", "\u009b"]) expect(validSecret(value)).toBe(false);
  // no passphrase is an answer where ssh-keygen offers it, and where it asks for the same again
  for (const prompt of ["Enter passphrase (empty for no passphrase):", 'Enter passphrase for "/home/alice/.ssh/id_ed25519" (empty for no passphrase):', "Enter new passphrase (empty for no passphrase):", "Enter same passphrase again:"]) {
    expect(validSecret("", prompt)).toBe(true);
    expect(validSecret("one\ntwo", prompt)).toBe(false);
  }
  for (const prompt of ["Password:", "Enter old passphrase:", "Password for 'https://alice@github.com':", "Enter passphrase for /home/alice/.ssh/id_ed25519:"]) expect(validSecret("", prompt)).toBe(false);
});

it("joins only right-edge continuations of a narrow prompt", () => {
  expect(secretPrompt("Enter passphrase for key '/tmp/my private key for testing\n':\n", 57)).toBe("Enter passphrase for key '/tmp/my private key for testing':");
  expect(secretPrompt("Enter passphrase for key\n'/tmp/key':", "Enter passphrase for key ".length)).toBe("Enter passphrase for key '/tmp/key':");
  expect(secretPrompt("Enter passphrase for key\n '/tmp/key':", "Enter passphrase for key".length)).toBe("Enter passphrase for key '/tmp/key':");
  // #3175: a joined row that starts with a space keeps it
  expect(secretPrompt("Enter passph\nrase for key\n '/tmp/a-ver\ny-long-priva\nte-key':", 12)).toBe("Enter passphrase for key '/tmp/a-very-long-private-key':");
  expect(secretPrompt("$ ssh-add\nEnter pass\nphrase for\n key '/tmp\n/key':", 10)).toBe("Enter passphrase for key '/tmp/key':");
  // rows are full by display width: a wide character takes two columns
  expect(secretPrompt("$ ssh-add\nEnter passphrase for key '/home/u/프로젝트/비밀키/아주긴디렉터리이름입니다/한국\n어경로/id_ed25519':", 80))
    .toBe("Enter passphrase for key '/home/u/프로젝트/비밀키/아주긴디렉터리이름입니다/한국 어경로/id_ed25519':");
  expect(secretPrompt("$ ssh-add\nEnter passphrase for\n key '密钥密钥密钥密\n钥':", 20)).toBe("Enter passphrase for key '密钥密钥密钥密钥':");
  // a wide character that did not fit leaves the last cell empty, read as a space as xterm does
  expect(secretPrompt("Enter passphrase for key '/tmp/\n키':", 32)).toBe("Enter passphrase for key '/tmp/ 키':");
  // an emoji takes two columns, a joined emoji sequence too
  expect(secretPrompt("Enter passphrase for key '🫠🫠x\nfoo':", 31)).toBe("Enter passphrase for key '🫠🫠xfoo':");
  expect(secretPrompt("Enter passphrase for key '👨‍👩‍👧x\nfoo':", 29)).toBe("Enter passphrase for key '👨‍👩‍👧xfoo':");
  expect(secretPrompt("Enter passphrase for key '/home/u/프로젝트\n':", 80)).toBeNull();
  expect(secretPrompt("Enter passphrase for key\n'/tmp/key':", 80)).toBeNull();
  expect(secretPrompt("This is prose that ends\nPassword?", 24)).toBeNull();
});
