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

it("rejects multiline and terminal-control secrets while preserving spaces and Unicode", () => {
  expect(validSecret("  한글🔒  ")).toBe(true);
  for (const value of [null, "", "x".repeat(4097), "one\ntwo", "one\rtwo", "\u001b[200~", "\u0003", "\u007f", "\u009b"]) expect(validSecret(value)).toBe(false);
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
