import { expect, it } from "bun:test";
import { promptHasCursor, promptSet, secretPrompt, validSecret } from "./secret-prompt.ts";

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
  "Password for 'https://alice@example.com/team-y/n/repo.git':",
  "Enter passphrase for /srv/team-y/n/key:",
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
    // with a third option too, in brackets or bare, and in quotes
    "Password for alice (y/n/q):",
    "Enter passphrase for key [Y/n/skip]:",
    "Password for alice y/n/a:",
    "Enter passphrase for key y/n/q:",
    "Password for alice 'y/n':",
    'Password for alice "y/n":',
    // ssh-keygen's asks, not anything that mentions a passphrase
    "Enter the passphrase again:",
  ]) {
    expect(secretPrompt(screen)).toBeNull();
  }
});

it("reads the password asks of an interactive ssh sign-in, doas, sudo in any language, sudo-rs, passwd, mysql, gpg and openssl", () => {
  for (const prompt of [
    // OpenSSH keyboard-interactive: "(%s@%s) %s", the server's own prompt after it; doas the same way
    "(alice@mac.local) Password:",
    "(alice@fe80::1) Password:",
    "doas (alice@host) password:",
    // sudo names the user in the session's language, and some of them end with a full-width colon; sudo-rs
    "[sudo] alice의 암호:",
    "[sudo] Passwort für alice:",
    "[sudo] alice 的密码：",
    "[sudo: authenticate] Password:",
    // passwd (pam_unix)
    "Current password:",
    "New password:",
    "Retype new password:",
    // mysql and mariadb; restic and pass name what the password is for
    "Enter password:",
    "enter password for repository:",
    // gpg's pinentry on a terminal
    "Passphrase:",
    // openssl, which asks twice for a new key
    "Enter PEM pass phrase:",
    "Verifying - Enter PEM pass phrase:",
    "Enter pass phrase for server.key:",
  ]) {
    expect(secretPrompt(`$ make deploy\n${prompt} `)).toBe(prompt);
    // read by no server released before this set: neither one from before secret-prompts-2 nor one that lists it
    expect([secretPrompt(prompt, Infinity, 1), secretPrompt(prompt, Infinity, 2), promptSet(prompt)]).toEqual([null, null, 3]);
  }
  for (const screen of [
    // what sudo-rs and an ssh server ask in the clear
    "[sudo: input needed] Username:",
    "(alice@host) Verification code:",
    "(alice@host) Password: ok",
    // prose that mentions one
    "Enter the password:",
    "The new password:",
    "A passphrase:",
    "[sudo] alice의 암호: 틀림",
  ]) {
    expect(secretPrompt(screen)).toBeNull();
  }
});

it("counts a prompt only while the cursor is on its line", () => {
  // lines as the page reads them, each with its first screen row: a wrapped row belongs to the line above it
  const lines = ["$ git push", "Password for 'https://alice@github.com':", "", ""];
  const starts = [10, 11, 12, 13];
  expect(promptHasCursor(lines, starts, 11, 41, 80)).toBe(true);
  // git read the answer and printed a line break: it asks no more, though its prompt is still the last text
  expect(promptHasCursor(lines, starts, 12, 0, 80)).toBe(false);
  expect(promptHasCursor(lines, starts, 10, 10, 80)).toBe(false);
  // The same prompt in 40 columns, which its colon fills: the space after it wraps, and the cursor is on the next
  // row past that space. herdr draws each row at its own place, so the page has two lines here, the second blank
  expect(promptHasCursor(lines, starts, 12, 1, 40)).toBe(true);
  // not after the answer (the program's line break leaves the cursor at the row's start, or two rows down), nor
  // below a prompt that did not reach the right edge
  expect(promptHasCursor(lines, starts, 12, 0, 40)).toBe(false);
  expect(promptHasCursor(lines, starts, 13, 1, 40)).toBe(false);
  expect(promptHasCursor(lines, starts, 12, 1, 42)).toBe(false);
  // As the page has them: herdr writes every cell of a row, so each line is as wide as the pane, spaces and all.
  // The prompt's row is measured without those: a short prompt with the cursor below it, past the row's start
  // (a reader in raw mode ends its line with a line feed alone), has been answered
  const padded = (width: number, ...rows: string[]): string[] => rows.map((row) => row.padEnd(width));
  expect(promptHasCursor(padded(80, "$ git push", "Password for 'https://alice@github.com':", "", ""), starts, 12, 41, 80)).toBe(false);
  expect(promptHasCursor(padded(80, "$ sudo ls", "Password: ", ""), [0, 1, 2], 2, 10, 80)).toBe(false);
  expect(promptHasCursor(padded(80, "$ sudo ls", "Password: ", ""), [0, 1, 2], 1, 10, 80)).toBe(true);
  // and one that fills its row still asks from the row below: its colon in the last column, or in the one before it
  // with the space after it in the last
  expect(promptHasCursor(padded(40, "$ git push", "Password for 'https://alice@github.com':", "", ""), starts, 12, 1, 40)).toBe(true);
  expect(promptHasCursor(padded(41, "$ git push", "Password for 'https://alice@github.com':", "", ""), starts, 12, 1, 41)).toBe(true);
  expect(promptHasCursor(padded(42, "$ git push", "Password for 'https://alice@github.com':", "", ""), starts, 12, 1, 42)).toBe(false);
  // a line that xterm wrapped over two rows itself holds its space: the row below it is past the answer's line feed
  expect(promptHasCursor(["$ git push", "Password for 'https://alice@github.com': ", ""], [0, 1, 3], 3, 11, 30)).toBe(false);
  expect(promptHasCursor(["$ git push", "Password for 'https://alice@github.com': ", ""], [0, 1, 3], 2, 11, 30)).toBe(true);
  // two full rows of it in 20 columns, and a row of text below is no blank row
  expect(promptHasCursor(["Password for 'https:", "//alice@github.com':", ""], [0, 1, 2], 2, 1, 20)).toBe(true);
  expect(promptHasCursor(["Password for 'https://alice@github.com':", "x"], [0, 1], 1, 1, 40)).toBe(true);
  expect(promptHasCursor(["Password for 'https://alice@github.com':", "x", ""], [0, 1, 2], 2, 1, 40)).toBe(false);
  // a prompt wrapped over three rows, the last holding only its final space: the cursor is on any of them
  const wrapped = ["$ ssh-add", "Enter passphrase for /home/alice/.ssh/id_ed25519: ", ""];
  for (const row of [21, 22, 23]) expect(promptHasCursor(wrapped, [20, 21, 24], row, 1, 17)).toBe(true);
  expect(promptHasCursor(wrapped, [20, 21, 24], 24, 0, 17)).toBe(false);
  // the prompt on the screen's last row, and a screen with no text
  expect(promptHasCursor(["Password:"], [0], 0, 9, 80)).toBe(true);
  expect(promptHasCursor(["", ""], [0, 1], 0, 0, 80)).toBe(false);
  expect(promptHasCursor([], [], 0, 0, 80)).toBe(false);
});

it("reads the prompts of a server that lists secret-prompts-2 as that server does", () => {
  // what #3566 added: read by such a server and by this one, not by one from before it
  for (const prompt of NEWER) expect([secretPrompt(prompt, Infinity, 2), secretPrompt(prompt), secretPrompt(prompt, Infinity, 1), promptSet(prompt)]).toEqual([prompt, prompt, null, 2]);
  // its yes/no test, where the two differ: a bare three-way choice was a prompt to it
  expect([secretPrompt("Password for alice y/n/a:", Infinity, 2), secretPrompt("Password for alice y/n/a:")]).toEqual(["Password for alice y/n/a:", null]);
  // and every server reads these
  for (const prompt of ["Password:", "[sudo] password for alice:", "alice@server's password:", "Enter passphrase for key '/tmp/key':"]) {
    expect([secretPrompt(prompt, Infinity, 2), promptSet(prompt)]).toEqual([prompt, 1]);
  }
});

it("reads only the prompts an earlier server takes when asked to, and each of those either way", () => {
  // what a page sends as a `secret` to a server without secret-prompts-2, which refuses one for any newer prompt
  for (const prompt of NEWER) expect(secretPrompt(`$ git push\n${prompt} `, Infinity, 1)).toBeNull();
  for (const prompt of ["[sudo] password for alice:", "alice@server's password:", "Password:", "Password for alice:", "Enter passphrase:", "Enter passphrase for key '/tmp/key':", "Enter PIN:", "Enter PIN for token:", "Repeat password:", "Verify password:", "Confirm password:"]) {
    expect(secretPrompt(prompt, Infinity, 1)).toBe(prompt);
    expect(secretPrompt(prompt)).toBe(prompt);
  }
  expect(secretPrompt("Enter passph\nrase for key\n '/tmp/a-ver\ny-long-priva\nte-key':", 12, 1)).toBe("Enter passphrase for key '/tmp/a-very-long-private-key':");
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
