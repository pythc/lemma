import { AsyncLocalStorage } from "node:async_hooks";
// Binds child model usage to its actual parent run without matching role names.
export const executionContext = new AsyncLocalStorage();
