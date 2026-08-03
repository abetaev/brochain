import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: webcrypto,
});

afterEach(cleanup);
