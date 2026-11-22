import { type FileTask, runFileTask, transferablesOf } from "./file-tasks.ts";

declare const self: Worker;

self.onmessage = (event: MessageEvent<FileTask>) => {
  let result;
  try {
    result = runFileTask(event.data);
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  postMessage({ result }, transferablesOf(result));
};
