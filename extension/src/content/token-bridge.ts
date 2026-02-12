import { tryReadToken, startObserver } from "./token-bridge-lib";

if (typeof document !== "undefined") {
  if (!tryReadToken()) {
    startObserver();
  }
}
