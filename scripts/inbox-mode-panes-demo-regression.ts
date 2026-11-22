process.env["INBOX_MODE_PART"] = "panes";
// set before the script loads, so the import is dynamic
await import("./inbox-mode-demo-regression.ts");
export {};
